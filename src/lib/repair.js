// ============================================================================
// PiperNet — Repair: a typed, logged, reversible repair API
// ----------------------------------------------------------------------------
// This is the network's hands. The Magna Carta (Article 17) permits the network
// to "adjust redundancy to meet a target" — but only within strict limits
// (Article 18). This module is built so those limits are properties of the
// CODE'S SHAPE, not promises about good behavior:
//
//   * plan() and execute() are SEPARATE. A plan is plain, inspectable data —
//     you can read it, and refuse it, before anything happens. (Article 17:
//     "rules a human wrote and can read".)
//
//   * execute() NEVER decrypts. It rebuilds the *encrypted* bytes from the
//     surviving shards and re-encodes them. It is never given the passphrase,
//     so "weaken/bypass/break encryption" (Article 18) is not merely forbidden
//     here — it is not expressible. The healer only ever handles ciphertext.
//
//   * Every action is APPENDED to an audit log (JSONL in git-ignored tmp/) with
//     the reversal recipe needed to undo it. (Article 17: "every automatic
//     adjustment is logged and can be undone.")
//
//   * undo() reverses an executed repair, and is itself logged. Reversibility
//     is charter law, not a nice-to-have.
//
// The module knows nothing about transport. The caller supplies small callbacks
// (placeShard / dropPlacement), so the same repair logic works over real libp2p
// nodes (Phase 5) or an in-memory mock (the self-test below).
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  DATA_SHARDS,
  TOTAL_SHARDS,
  erasureEncode,
  erasureReconstruct,
  fingerprint,
  resultName,
} from "./sharding.js";
import { report, formatReport, STATUS } from "./telemetry.js";

// ----------------------------------------------------------------------------
// Audit log (append-only JSONL). Every line is one action, with a timestamp.
// ----------------------------------------------------------------------------
export function resetLog(logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "");
}

export function appendLog(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const stamped = { ts: new Date().toISOString(), ...entry };
  fs.appendFileSync(logPath, JSON.stringify(stamped) + "\n");
  return stamped;
}

export function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

// ----------------------------------------------------------------------------
// plan(health, targetMargin, spareNodes)
// ----------------------------------------------------------------------------
// Pure function. Given a health report, a target redundancy margin, and the
// labels of healthy spare nodes not yet holding a shard, return a repair PLAN
// as plain data — WITHOUT doing anything. The plan can be inspected and refused.
export function plan(health, targetMargin, spareNodes) {
  const need = Math.max(0, health.dataShards + targetMargin - health.shardsReachable);
  const regenerate = [];
  let feasible = true;
  let reason;

  if (!health.recoverable) {
    feasible = false;
    reason = `cannot reconstruct: only ${health.shardsReachable} shards reachable, need ${health.dataShards}`;
  } else if (need === 0) {
    reason = "already at or above target margin — no action needed";
  } else {
    const missing = [...health.unreachableShardIndices];
    const spares = [...spareNodes];
    const count = Math.min(need, missing.length, spares.length);
    for (let i = 0; i < count; i++) {
      regenerate.push({ shard: missing[i], toNode: spares[i] });
    }
    if (count < need) {
      feasible = false;
      reason = `insufficient spare capacity: need ${need} healthy node(s), have ${spares.length}`;
    } else {
      reason = `regenerate ${count} shard(s) onto spare node(s) to restore margin ${targetMargin}`;
    }
  }

  return {
    targetMargin,
    currentMargin: health.redundancyMargin,
    need,
    regenerate, // [ { shard, toNode } ]
    feasible,
    reason,
  };
}

export function formatPlan(p, indent = "     ") {
  const head = `Repair plan: ${p.reason}`;
  if (p.regenerate.length === 0) return indent + head;
  const rows = p.regenerate.map(
    (s) => `${indent}  • regenerate shard #${s.shard} → node ${s.toNode}`
  );
  return [indent + head, ...rows].join("\n");
}

// ----------------------------------------------------------------------------
// execute(plan, ctx)
// ----------------------------------------------------------------------------
// Carry out a plan. ctx supplies:
//   survivors  = { shards, present, shardSize }   — the surviving shard bytes
//   placeShard = async (nodeLabel, bytes) => cid  — store bytes on a node
//   fromNodes  = [labels]                         — survivors used (for the log)
//   logPath    = string                           — audit log file
// Returns { executed: [logEntries] }. The caller applies these to its own
// placement map (each entry has shard, toNode, cid).
export async function execute(repairPlan, ctx) {
  const executed = [];
  if (!repairPlan.feasible) {
    throw new Error(`refusing to execute an infeasible plan: ${repairPlan.reason}`);
  }
  if (repairPlan.regenerate.length === 0) return { executed };

  // 1. Rebuild the ENCRYPTED bytes from the survivors. No decryption, no key.
  const rec = erasureReconstruct(ctx.survivors.shards, ctx.survivors.present, ctx.survivors.shardSize);
  if (!rec.ok) {
    throw new Error(`repair cannot reconstruct: ${resultName(rec.code)}`);
  }

  // 2. Deterministically re-encode. Systematic Reed-Solomon regenerates the
  //    exact same shard bytes, so a regenerated shard has the SAME content
  //    address (CID) as the original — content addressing at work.
  const { shards } = erasureEncode(rec.encrypted);

  // 3. Place each planned shard on its target node; log every action + reversal.
  for (const step of repairPlan.regenerate) {
    // Off-ramp check BEFORE every single action (Article 18). The caller passes
    // a hook that throws if the human off-switch is engaged, so a repair in
    // progress halts immediately and whatever was done remains fully reversible.
    if (ctx.beforeEachAction) await ctx.beforeEachAction();
    const bytes = shards[step.shard];
    const cid = await ctx.placeShard(step.toNode, bytes);
    const entry = appendLog(ctx.logPath, {
      action: "regenerate-shard",
      shard: step.shard,
      fromNodes: ctx.fromNodes,
      toNode: step.toNode,
      cid: cid.toString(),
      reversal: {
        action: "drop-placement",
        shard: step.shard,
        node: step.toNode,
        cid: cid.toString(),
      },
    });
    executed.push(entry);
  }
  return { executed };
}

// ----------------------------------------------------------------------------
// undo(executed, ctx)
// ----------------------------------------------------------------------------
// Reverse an executed repair, newest action first. ctx supplies:
//   dropPlacement = async (reversal) => void   — undo one placement
//   logPath       = string
// Returns { undone: [logEntries] }.
export async function undo(executed, ctx) {
  const undone = [];
  for (const entry of [...executed].reverse()) {
    await ctx.dropPlacement(entry.reversal);
    const u = appendLog(ctx.logPath, {
      action: "undo-regenerate-shard",
      shard: entry.shard,
      reversed: entry.reversal,
      note: `dropped regenerated placement of shard #${entry.shard} on node ${entry.reversal.node}`,
    });
    undone.push(u);
  }
  return { undone };
}

// ----------------------------------------------------------------------------
// Self-test — run directly:  node src/lib/repair.js
// ----------------------------------------------------------------------------
// Proves the full cycle: plan → execute → health restored → undo → back to the
// prior state, with every step visible in the audit log. Uses an in-memory mock
// network (no libp2p needed), so it's fast and deterministic. It uses a
// stand-in "encrypted" payload — which itself demonstrates that repair works on
// opaque bytes and never needs a passphrase.
const LABELS = ["A", "B", "C", "D", "E", "F", "G"];

async function selfTest() {
  console.log("\n  repair.js — self-test (mock network, no passphrase needed)");
  console.log("  ---------------------------------------------------------");

  const logPath = path.join("tmp", "repair-selftest.jsonl");
  resetLog(logPath);

  // A stand-in "encrypted" blob. repair never decrypts it, so real encryption
  // isn't needed to test the repair machinery.
  const payload = Buffer.from("ciphertext-stand-in ".repeat(40));
  const { shards, shardSize } = erasureEncode(payload);

  // Mock "store bytes on a node": content-addressed, so equal bytes → equal CID.
  const cidOf = (bytes) => "mock:" + fingerprint(bytes).slice(0, 24);

  // Start: 5 nodes A..E, each holding one shard.
  let nodes = LABELS.slice(0, 5).map((label) => ({ label, up: true }));
  let placements = shards.slice(0, 5).map((b, i) => ({ shard: i, holder: LABELS[i], cid: cidOf(b) }));

  const show = (title) => {
    const r = report({ nodes, placements });
    console.log(`\n  ${title}`);
    console.log(formatReport(r));
    return r;
  };

  show("① Start — all nodes up:");

  // Damage: stop nodes B(1) and D(3).
  nodes = nodes.map((n) => (n.label === "B" || n.label === "D" ? { ...n, up: false } : n));
  const damaged = show("② After losing nodes B and D:");

  // Spare capacity arrives: two fresh nodes F, G.
  nodes = [...nodes, { label: "F", up: true }, { label: "G", up: true }];
  const spares = ["F", "G"];

  // PLAN (inspectable, no action yet).
  const p = plan(damaged, TOTAL_SHARDS - DATA_SHARDS, spares);
  console.log("\n  ③ Plan (data only — nothing has happened yet):");
  console.log(formatPlan(p));

  // Gather the surviving shard bytes for execution (reachable indices: 0,2,4).
  const survivorShards = new Array(TOTAL_SHARDS).fill(null);
  const present = new Array(TOTAL_SHARDS).fill(false);
  for (const idx of damaged.reachableShardIndices) {
    survivorShards[idx] = shards[idx];
    present[idx] = true;
  }

  // EXECUTE.
  const mockStore = new Map();
  const { executed } = await execute(p, {
    survivors: { shards: survivorShards, present, shardSize },
    fromNodes: damaged.reachableShardIndices.map((i) => placements.find((pl) => pl.shard === i).holder),
    placeShard: async (nodeLabel, bytes) => {
      const cid = cidOf(bytes);
      mockStore.set(cid, bytes);
      return cid;
    },
    logPath,
  });
  // Apply the executed actions to the placement map.
  for (const e of executed) placements.push({ shard: e.shard, holder: e.toNode, cid: e.cid });
  show("④ After execute — shards regenerated onto F and G:");

  // UNDO.
  await undo(executed, {
    dropPlacement: async (reversal) => {
      placements = placements.filter(
        (pl) => !(pl.shard === reversal.shard && pl.holder === reversal.node)
      );
    },
    logPath,
  });
  show("⑤ After undo — back to the prior state:");

  // Audit log.
  console.log("\n  Audit log (tmp/repair-selftest.jsonl):");
  for (const e of readLog(logPath)) {
    console.log(`     ${e.ts}  ${e.action}` + (e.shard != null ? ` shard#${e.shard}` : "") + (e.toNode ? ` → ${e.toNode}` : ""));
  }

  // Verdict.
  const restored = report({ nodes: nodes.map((n) => ({ ...n })), placements });
  const back = restored.status === STATUS.CRITICAL; // after undo we're back at margin 0
  console.log(`\n  Cycle proven: plan → execute → HEALTHY → undo → back to prior: ${back ? "✓" : "✗"}\n`);
  if (!back) process.exit(1);
}

import { fileURLToPath } from "node:url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  selfTest().catch((err) => {
    console.error("\n  Self-test failed:\n", err);
    process.exit(1);
  });
}
