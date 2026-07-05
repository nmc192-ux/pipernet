// ============================================================================
// PiperNet — Telemetry: the network measuring its own health
// ----------------------------------------------------------------------------
// This is the "telemetry and self-diagnosis" the Magna Carta permits and asks
// for (Article 17): the network measures its own redundancy and node health and
// SURFACES where it is weak. It only reports facts as data — it never acts.
// Acting is the repair module's job (src/lib/repair.js), and only ever through
// rules a human wrote (src/06-self-healing.js).
//
// The one number that matters most is the REDUNDANCY MARGIN: how many more
// nodes can fail before a file becomes unrecoverable. With k=3 data shards out
// of n=5, a file needs any 3 shards to rebuild, so:
//   all 5 shards reachable → margin 2 (can lose 2 more)  → HEALTHY
//   4 reachable            → margin 1 (can lose 1 more)  → DEGRADED
//   3 reachable            → margin 0 (zero slack)       → CRITICAL
//   fewer than 3           → margin < 0 (cannot rebuild) → LOST
// ============================================================================

import { DATA_SHARDS, TOTAL_SHARDS } from "./sharding.js";

export const STATUS = {
  HEALTHY: "HEALTHY",
  DEGRADED: "DEGRADED",
  CRITICAL: "CRITICAL",
  LOST: "LOST",
};

// Compute a health report from a plain snapshot of the network:
//   snapshot.nodes      = [ { label, up } ]              — each node's status
//   snapshot.placements = [ { shard, holder, cid } ]     — who holds which shard
// A shard is "reachable" only if the node holding it is currently up.
export function report(snapshot) {
  const upLabels = new Set(snapshot.nodes.filter((n) => n.up).map((n) => n.label));
  const nodesUp = upLabels.size;
  const nodesDown = snapshot.nodes.length - nodesUp;

  const reachable = snapshot.placements.filter((p) => upLabels.has(p.holder));
  const reachableShardIndices = [...new Set(reachable.map((p) => p.shard))].sort((a, b) => a - b);
  const allShardIndices = [...new Set(snapshot.placements.map((p) => p.shard))];
  const unreachableShardIndices = allShardIndices
    .filter((i) => !reachableShardIndices.includes(i))
    .sort((a, b) => a - b);

  const shardsReachable = reachableShardIndices.length;
  const redundancyMargin = shardsReachable - DATA_SHARDS; // how many more can fail

  let status;
  if (shardsReachable >= TOTAL_SHARDS) status = STATUS.HEALTHY;
  else if (redundancyMargin >= 1) status = STATUS.DEGRADED;
  else if (redundancyMargin === 0) status = STATUS.CRITICAL;
  else status = STATUS.LOST;

  return {
    nodesUp,
    nodesDown,
    shardsReachable,
    shardsTotal: TOTAL_SHARDS,
    dataShards: DATA_SHARDS,
    redundancyMargin,
    canLoseMore: Math.max(0, redundancyMargin),
    reachableShardIndices,
    unreachableShardIndices,
    recoverable: shardsReachable >= DATA_SHARDS,
    status,
  };
}

// A short human-readable rendering of a report.
export function formatReport(r, indent = "     ") {
  const lines = [
    `Network health: ${r.status}`,
    `nodes:  ${r.nodesUp} up / ${r.nodesDown} down`,
    `shards: ${r.shardsReachable} of ${r.shardsTotal} reachable (need ${r.dataShards} to rebuild)`,
    `margin: can lose ${r.canLoseMore} more node(s) before data loss` +
      (r.redundancyMargin < 0 ? "  — ALREADY BELOW RECOVERY THRESHOLD" : ""),
    `file recoverable now: ${r.recoverable ? "yes" : "NO"}`,
  ];
  return lines.map((l) => indent + l).join("\n");
}
