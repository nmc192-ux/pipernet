// ============================================================================
// PiperNet — Phase 5: Bounded Self-Improvement (the network heals itself)
// ----------------------------------------------------------------------------
// This is the Magna Carta's signature capability, and its most carefully fenced
// one. The network watches its own health and, when a file's redundancy drops,
// REPAIRS ITSELF back to target — with no human triggering the repair. But it
// does so strictly inside the charter's Part V limits:
//
//   * It acts ONLY through a fixed, human-written ruleset (below), expressed as
//     inspectable data. It cannot invent new kinds of action. (Article 17/18)
//   * A human-held OFF-SWITCH is checked before every action. Engaged, the
//     healer observes but will not touch anything. (Article 18)
//   * Every action is logged with its reversal recipe, and can be undone.
//     (Article 17: reversibility)
//   * The healer operates only on ENCRYPTED shards — it never decrypts, never
//     sees the passphrase. (Article 18: never weaken/bypass encryption)
//
// It reuses, without duplicating:
//   src/lib/pipernet-node.js  — transport (store/fetch by CID)
//   src/lib/sharding.js       — compress → encrypt → erasure-code pipeline
//   src/lib/telemetry.js      — the health report
//   src/lib/repair.js         — plan / execute / undo + the audit log
//
// Run it with:  PIPERNET_PASSPHRASE='my secret words' npm run heal
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PiperNetNode } from "./lib/pipernet-node.js";
import {
  DATA_SHARDS,
  PARITY_SHARDS,
  TOTAL_SHARDS,
  getPassphrase,
  fingerprint,
  compress,
  decompress,
  encrypt,
  decrypt,
  erasureReconstruct,
  erasureEncode,
} from "./lib/sharding.js";
import { report, formatReport, STATUS } from "./lib/telemetry.js";
import { plan, execute, undo, formatPlan, appendLog, readLog, resetLog } from "./lib/repair.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const TMP = path.join(PROJECT_ROOT, "tmp");
const LOG_PATH = path.join(TMP, "self-healing-audit.jsonl");
const STOP_FILE = path.join(TMP, "STOP"); // the human off-switch
const LABELS = ["A", "B", "C", "D", "E", "F", "G", "H"];

// ----------------------------------------------------------------------------
// THE RULES — the bounded "brain", as inspectable data (Article 17: rules a
// human wrote and can read). The control loop takes NO action not described
// here. Each rule cites the charter article it serves.
// ----------------------------------------------------------------------------
const RULESET = {
  targetMargin: TOTAL_SHARDS - DATA_SHARDS, // 2 — restore full redundancy
  maxRepairsPerCycle: 2, // bounded action: never more than this per cycle
  // The ONLY action types allowed to appear in the audit log:
  permittedActions: [
    "observe",
    "plan",
    "regenerate-shard",
    "undo-regenerate-shard",
    "refused-offswitch",
  ],
  rules: [
    { id: "R1", when: "off-switch engaged", then: "observe only; take no action", charter: "Art. 18 — off-ramp, never delegated" },
    { id: "R2", when: "margin < targetMargin AND spare capacity exists", then: "plan + execute repair toward targetMargin", charter: "Art. 17 — adaptive operation to a target" },
    { id: "R3", when: "margin < targetMargin AND no spare capacity", then: "observe; surface the weakness; do not act", charter: "Art. 17 — telemetry/self-diagnosis" },
    { id: "R4", always: "never exceed maxRepairsPerCycle; never emit an action outside permittedActions", charter: "Art. 18 — bounded; no self-modification" },
    { id: "R5", always: "operate only on encrypted shards; never decrypt", charter: "Art. 18 — never weaken/bypass encryption" },
  ],
};

// --- Off-switch helpers (a human holds this; the loop never removes it). ------
function offSwitchEngaged() {
  return fs.existsSync(STOP_FILE);
}
function engageOffSwitch() {
  fs.mkdirSync(TMP, { recursive: true });
  fs.writeFileSync(STOP_FILE, "stop\n");
}
function releaseOffSwitch() {
  if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE);
}

// --- Small helpers: a pause, and a dial that retries transient resets. -------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function dialWithRetry(node, addr, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      return await node.connect(addr);
    } catch (err) {
      if (t === tries - 1) throw err;
      await sleep(200); // transient churn (e.g. ECONNRESET while peers settle)
    }
  }
}

// --- A fetch with a timeout, so an unreachable block fails loudly. -----------
async function fetchWithTimeout(node, cid, ms = 15000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`fetch timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([node.fetch(cid), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ----------------------------------------------------------------------------
// A tiny network state object + helpers.
// ----------------------------------------------------------------------------
function snapshot(net) {
  return {
    nodes: net.members.map((m) => ({ label: m.label, up: m.up })),
    placements: net.placements.map((p) => ({ shard: p.shard, holder: p.holder, cid: p.cid })),
  };
}
function healthOf(net) {
  return report(snapshot(net));
}
function spareLabels(net) {
  return net.members
    .filter((m) => m.up && m.isSpare && !net.placements.some((p) => p.holder === m.label))
    .map((m) => m.label);
}

// Fetch the currently-reachable shards by CID, via one up "coordinator" node.
// Returns { shards, present, shardSize } — ciphertext only, ready for repair.
async function fetchReachableShards(net, coordinatorLabel, health) {
  const coord = net.members.find((m) => m.label === coordinatorLabel && m.up);
  const shards = new Array(TOTAL_SHARDS).fill(null);
  const present = new Array(TOTAL_SHARDS).fill(false);
  for (const idx of health.reachableShardIndices) {
    const pl = net.placements.find(
      (p) => p.shard === idx && net.members.find((m) => m.label === p.holder)?.up
    );
    const bytes = await fetchWithTimeout(coord.node, pl.cid);
    shards[idx] = Buffer.from(bytes);
    present[idx] = true;
  }
  return { shards, present, shardSize: net.shardSize };
}

// ----------------------------------------------------------------------------
// THE CONTROL LOOP — one tick. Reads telemetry, applies the RULESET, and acts
// only if the rules (and the off-switch) allow. Returns what it did.
// ----------------------------------------------------------------------------
async function controlLoopTick(net, coordinatorLabel) {
  // R1 — OFF-SWITCH is checked before anything else (Article 18).
  if (offSwitchEngaged()) {
    const h = healthOf(net);
    appendLog(LOG_PATH, {
      action: "refused-offswitch",
      note: "human off-switch engaged — observing only, taking no action",
      observed: { status: h.status, margin: h.redundancyMargin },
    });
    return { acted: false, reason: "off-switch engaged", health: h };
  }

  const h = healthOf(net);

  // Already at target → observe only (R2 does not fire).
  if (h.redundancyMargin >= RULESET.targetMargin) {
    appendLog(LOG_PATH, { action: "observe", note: "at target margin; no action needed", observed: { status: h.status, margin: h.redundancyMargin } });
    return { acted: false, reason: "at target", health: h };
  }

  // R2/R3 — need repair; is there spare capacity?
  const spares = spareLabels(net);
  const repairPlan = plan(h, RULESET.targetMargin, spares);
  appendLog(LOG_PATH, { action: "plan", reason: repairPlan.reason, feasible: repairPlan.feasible, regenerate: repairPlan.regenerate });

  if (!repairPlan.feasible || repairPlan.regenerate.length === 0) {
    appendLog(LOG_PATH, { action: "observe", note: `cannot act: ${repairPlan.reason}` });
    return { acted: false, reason: repairPlan.reason, health: h, plan: repairPlan };
  }

  // R4 — bounded: never exceed maxRepairsPerCycle.
  if (repairPlan.regenerate.length > RULESET.maxRepairsPerCycle) {
    repairPlan.regenerate = repairPlan.regenerate.slice(0, RULESET.maxRepairsPerCycle);
  }

  // Fetch survivors (ciphertext) and execute the plan.
  const survivors = await fetchReachableShards(net, coordinatorLabel, h);
  const { executed } = await execute(repairPlan, {
    survivors,
    fromNodes: h.reachableShardIndices.map((i) => net.placements.find((pl) => pl.shard === i).holder),
    placeShard: async (label, bytes) => {
      const m = net.members.find((mm) => mm.label === label);
      return m.node.store(bytes);
    },
    // Off-ramp re-checked before EVERY placement (Article 18).
    beforeEachAction: async () => {
      if (offSwitchEngaged()) throw new Error("off-switch engaged mid-repair");
    },
    logPath: LOG_PATH,
  });
  for (const e of executed) net.placements.push({ shard: e.shard, holder: e.toNode, cid: e.cid });

  return { acted: true, executed, plan: repairPlan, health: healthOf(net) };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  console.log("");
  console.log("  PiperNet — Phase 5: Bounded Self-Improvement");
  console.log("  --------------------------------------------");

  const passphrase = getPassphrase();
  resetLog(LOG_PATH);
  releaseOffSwitch(); // start from a known state

  // Show the bounded brain.
  console.log(`\n  THE RULES (the bounded brain — the loop does nothing not listed here):`);
  console.log(`     target margin: ${RULESET.targetMargin}   max repairs/cycle: ${RULESET.maxRepairsPerCycle}`);
  for (const r of RULESET.rules) {
    const cond = r.when ? `if ${r.when}` : `always`;
    const act = r.then || r.always;
    console.log(`     ${r.id}: ${cond} → ${act}   [${r.charter}]`);
  }

  // --- The file: your file, or a built-in sample. ----------------------------
  const userFile = process.argv[2];
  let original, sourceLabel;
  if (userFile) {
    original = fs.readFileSync(userFile);
    sourceLabel = `your file: ${userFile}`;
  } else {
    const sample =
      "PiperNet heals itself. This file is compressed, encrypted, and split " +
      "into five shards across five devices. When devices fail, the network " +
      "notices and regenerates the missing shards onto spare capacity — inside " +
      "the charter's fence, logged and reversible. Repeated for the compressor.\n";
    original = Buffer.from(sample.repeat(30), "utf8");
    sourceLabel = "built-in sample text";
  }
  const originalPrint = fingerprint(original);

  // --- Prepare + distribute across 5 nodes (reusing Phase 4's flow). ---------
  const compressed = compress(original);
  const encrypted = encrypt(compressed, passphrase);
  const { shards, shardSize } = erasureEncode(encrypted);
  console.log(`\n  Source: ${sourceLabel}  (${original.length} bytes, fingerprint ${originalPrint.slice(0, 16)}…)`);

  const net = { members: [], placements: [], shardSize };

  // Start the 5 active nodes plus 2 spare nodes, and mesh EVERYONE together now,
  // while all are healthy (dialing is reliable when nothing is churning). The
  // spares stand by — online and connected, but holding no shard and not yet
  // counted as part of the network — until spare capacity is called for.
  const active = [];
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    const node = await new PiperNetNode(`node-${LABELS[i]}`).start();
    active.push({ label: LABELS[i], node, multiaddr: node.multiaddrs()[0], up: true, isSpare: false });
  }
  const sparePool = [];
  for (const label of ["F", "G"]) {
    const node = await new PiperNetNode(`node-${label}`).start();
    sparePool.push({ label, node, multiaddr: node.multiaddrs()[0], up: true, isSpare: true });
  }
  const everyone = [...active, ...sparePool];
  // Star topology centered on the coordinator (node A): A dials every other node.
  // Only the coordinator ever fetches shards, so this is all the connectivity we
  // need — and keeping the dial count low (6, not a 21-link full mesh) avoids the
  // connection resets that a burst of simultaneous dials can trigger.
  const coordinator = active[0]; // node A
  for (const m of everyone) {
    if (m !== coordinator) await dialWithRetry(coordinator.node, m.multiaddr);
  }

  // Only the 5 active nodes are part of the network for now; store shard i on i.
  net.members = [...active];
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    const cid = await active[i].node.store(shards[i]);
    net.placements.push({ shard: i, holder: LABELS[i], cid });
  }
  console.log(`\n  ① BEFORE — 5 nodes, each holding one shard:`);
  console.log(formatReport(healthOf(net)));

  // ==========================================================================
  // OFF-SWITCH SUPREMACY (proof c): engage the switch, damage the network,
  // and show the healer OBSERVES but refuses to act.
  // ==========================================================================
  console.log(`\n  ── Off-switch test (Article 18) ──────────────────────────`);
  engageOffSwitch();
  console.log(`     ✋ Human engaged the off-switch (tmp/STOP present).`);

  // Damage: stop nodes B(1) and D(3).
  for (const label of ["B", "D"]) {
    const m = net.members.find((mm) => mm.label === label);
    await m.node.stop();
    m.up = false;
  }
  await sleep(300); // let the remaining peers settle after the disconnections
  console.log(`\n  ② DAMAGE — nodes B and D fail (switch still engaged):`);
  console.log(formatReport(healthOf(net)));

  // Spare capacity becomes available: the two standing-by spare nodes (already
  // online and meshed in) are now put into service. No dialing after the failure.
  for (const s of sparePool) net.members.push(s);
  console.log(`     ➕ Two spare nodes (F, G) are available — spare capacity ready for use.`);

  // Control loop tick WITH the switch engaged — must refuse.
  const blocked = await controlLoopTick(net, "A");
  const regenBeforeRelease = readLog(LOG_PATH).filter((e) => e.action === "regenerate-shard").length;
  console.log(`\n  ③ Control loop ran with the switch engaged:`);
  console.log(`     healer decision: ${blocked.acted ? "ACTED ✗" : "observed only, refused to act ✓"} (${blocked.reason})`);
  console.log(`     regenerations performed while stopped: ${regenBeforeRelease}`);
  console.log(formatReport(healthOf(net)));

  // ==========================================================================
  // RELEASE + SELF-HEAL (the demo, proof a): no human triggers the repair.
  // ==========================================================================
  console.log(`\n  ── Self-heal (Article 17) ────────────────────────────────`);
  releaseOffSwitch();
  console.log(`     ✅ Human released the off-switch (tmp/STOP removed).`);
  console.log(`     The control loop now runs on its own rules — no human tells it what to fix.`);

  const healed = await controlLoopTick(net, "A");
  console.log(`\n     Plan the loop chose for itself:`);
  console.log(formatPlan(healed.plan));
  console.log(`\n  ④ AFTER — the network repaired itself:`);
  console.log(formatReport(healthOf(net)));

  // ==========================================================================
  // INTEGRITY (proof b): fetch the healed shards over the network, rebuild,
  // decrypt, decompress, and compare fingerprints.
  // ==========================================================================
  const healthAfter = healthOf(net);
  const survivors = await fetchReachableShards(net, "A", healthAfter);
  const rec = erasureReconstruct(survivors.shards, survivors.present, survivors.shardSize);
  const recovered = decompress(decrypt(rec.encrypted, passphrase));
  const recoveredPrint = fingerprint(recovered);
  const identical = recoveredPrint === originalPrint;

  // ==========================================================================
  // REVERSIBILITY (proof d): undo the repair; state returns; log shows it.
  // ==========================================================================
  await undo(healed.executed, {
    logPath: LOG_PATH,
    dropPlacement: async (reversal) => {
      net.placements = net.placements.filter(
        (p) => !(p.shard === reversal.shard && p.holder === reversal.node)
      );
      const m = net.members.find((mm) => mm.label === reversal.node);
      if (m && m.up) {
        await m.node.stop();
        m.up = false;
      }
    },
  });
  const afterUndo = healthOf(net);

  // ==========================================================================
  // BOUNDED ACTION (proof e): every logged action is permitted by the ruleset.
  // ==========================================================================
  const log = readLog(LOG_PATH);
  const actionTypes = [...new Set(log.map((e) => e.action))];
  const allPermitted = actionTypes.every((a) => RULESET.permittedActions.includes(a));

  // --- The audit log --------------------------------------------------------
  console.log(`\n  Audit log (tmp/self-healing-audit.jsonl):`);
  for (const e of log) {
    const extra =
      e.shard != null ? ` shard#${e.shard}${e.toNode ? ` → ${e.toNode}` : ""}` :
      e.reason ? ` (${e.reason})` :
      e.note ? ` (${e.note})` : "";
    console.log(`     ${e.ts.slice(11, 23)}  ${e.action}${extra}`);
  }

  // ==========================================================================
  // PROOFS
  // ==========================================================================
  const selfHealed = healed.acted && healthAfter.redundancyMargin === RULESET.targetMargin;
  const offSwitchHeld = !blocked.acted && regenBeforeRelease === 0;
  const reversed = afterUndo.redundancyMargin < RULESET.targetMargin &&
    log.some((e) => e.action === "undo-regenerate-shard");

  console.log(`\n  ── Proofs ────────────────────────────────────────────────`);
  console.log(`  (a) self-healing: margin restored to ${RULESET.targetMargin} with NO human action:  ${selfHealed ? "✓ YES" : "✗ NO"}`);
  console.log(`  (b) file integrity: rebuilt file byte-for-byte identical (SHA-256): ${identical ? "✓ YES" : "✗ NO"}`);
  console.log(`  (c) off-switch supremacy: engaged switch → 0 actions taken:          ${offSwitchHeld ? "✓ YES" : "✗ NO"}`);
  console.log(`  (d) reversibility: undo returned the network to its prior state:     ${reversed ? "✓ YES" : "✗ NO"}`);
  console.log(`  (e) bounded action: log contains ONLY permitted actions:             ${allPermitted ? "✓ YES" : "✗ NO"}`);
  console.log(`      (action types seen: ${actionTypes.join(", ")})`);

  // --- Shut everything down. -------------------------------------------------
  for (const m of net.members) if (m.up) await m.node.stop();
  releaseOffSwitch();

  const allPassed = selfHealed && identical && offSwitchHeld && reversed && allPermitted;
  console.log(`\n  ──────────────────────────────────────────────────────────`);
  if (allPassed) {
    console.log(`  ✓ Phase 5 complete. The network improves itself — restoring redundancy`);
    console.log(`  toward target on its own — and stays inside the charter's fence: it acts`);
    console.log(`  only by human-written rules, obeys a human off-switch, logs and can undo`);
    console.log(`  every move, and never touches encryption. Article 17, done; Article 18, held.\n`);
  } else {
    console.log(`  ✗ Something did not hold. See the proof lines above.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n  Something went wrong:\n", err);
  process.exit(1);
});
