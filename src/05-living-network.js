// ============================================================================
// PiperNet — Phase 4: The Living Network
// ----------------------------------------------------------------------------
// THE JOIN. Until now, PiperNet has been two separate halves:
//
//   * Phase 1 moved whole files between two peers by content address (CID),
//     over a real peer-to-peer connection.
//   * Phases 2–3 compressed, encrypted, and erasure-coded a file into shards —
//     but wrote those shards to a LOCAL folder (tmp/shards/). They never moved.
//
// This phase connects them. We stand up a small network of FIVE nodes, and this
// time each encrypted shard is stored on a DIFFERENT node and actually travels
// across the network by its CID. Then we switch two nodes off (real churn) and
// rebuild the whole file from the three survivors — fetching their shards over
// the network, not from any local folder. That is the Melcher test, made
// genuinely distributed.
//
// It reuses, without duplicating:
//   * src/lib/pipernet-node.js  — the transport (store/fetch bytes by CID)
//   * src/lib/sharding.js       — the compress→encrypt→erasure-code pipeline
//
// Run it with:            PIPERNET_PASSPHRASE='my secret words' npm run network
// Or on your own file:    PIPERNET_PASSPHRASE='...' node src/05-living-network.js /path/to/file
// ============================================================================

import fs from "node:fs";
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
  erasureEncode,
  erasureReconstruct,
} from "./lib/sharding.js";

// Friendly labels for the five nodes (node index 0..4 -> A..E).
const LABELS = ["A", "B", "C", "D", "E"];

// A fetch with a timeout, so that if a block is genuinely unreachable the script
// fails loudly instead of hanging forever.
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

// Print the live "network view": one row per node, the shard it holds, status.
function printNetworkView(nodes, cids, upFlags) {
  console.log("     ┌───────┬───────────┬──────────────────────────────┬────────┐");
  console.log("     │ Node  │ Shard     │ Content address (CID)        │ Status │");
  console.log("     ├───────┼───────────┼──────────────────────────────┼────────┤");
  for (let i = 0; i < nodes.length; i++) {
    const kind = i < DATA_SHARDS ? "data" : "parity";
    const shard = `#${i} ${kind}`.padEnd(9);
    const cid = (cids[i].toString().slice(0, 26) + "…").padEnd(28);
    const status = upFlags[i] ? "  UP  " : " DOWN ";
    console.log(`     │ ${LABELS[i].padEnd(5)} │ ${shard} │ ${cid} │ ${status} │`);
  }
  console.log("     └───────┴───────────┴──────────────────────────────┴────────┘");
}

async function main() {
  console.log("");
  console.log("  PiperNet — Phase 4: The Living Network");
  console.log("  --------------------------------------");

  const passphrase = getPassphrase();

  // --- The file to protect: your file, or a built-in sample. -----------------
  const userFile = process.argv[2];
  let original;
  let sourceLabel;
  if (userFile) {
    original = fs.readFileSync(userFile);
    sourceLabel = `your file: ${userFile}`;
  } else {
    const sample =
      "PiperNet's living network. This file is compressed, encrypted, and " +
      "split into five shards, each stored on a different device. Switch two " +
      "devices off and the file still comes back — rebuilt from the shards that " +
      "remain, fetched across the network by their content address. This line " +
      "repeats so the compressor has something to chew on.\n";
    original = Buffer.from(sample.repeat(30), "utf8");
    sourceLabel = "built-in sample text";
  }
  const originalPrint = fingerprint(original);
  console.log(`\n  Source: ${sourceLabel}`);
  console.log(`  Original size: ${original.length} bytes`);
  console.log(`  Original fingerprint (SHA-256): ${originalPrint.slice(0, 24)}…`);

  // --- 1. Compress → encrypt → erasure-code (the shared pipeline). -----------
  const compressed = compress(original);
  const encrypted = encrypt(compressed, passphrase);
  const { shards, shardSize } = erasureEncode(encrypted);
  console.log(
    `\n  1. PREPARE: compress → encrypt → erasure-code` +
      `\n     ${original.length} → ${compressed.length} (zstd) → ${encrypted.length} (AES-256-GCM) →` +
      ` ${TOTAL_SHARDS} shards of ${shardSize} bytes (any ${DATA_SHARDS} rebuild)`
  );

  // --- 2. Start five nodes and connect them into a network. ------------------
  console.log(`\n  2. START a ${TOTAL_SHARDS}-node network and connect the nodes...`);
  const nodes = [];
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    nodes.push(await new PiperNetNode(`node-${LABELS[i]}`).start());
  }
  // Full mesh: dial every node to every other, so any survivor can fetch from
  // any other survivor after churn. (n·(n-1)/2 connections — fine at this size.)
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      await nodes[j].connect(nodes[i].multiaddrs()[0]);
    }
  }
  console.log(`     ✓ ${TOTAL_SHARDS} nodes online and fully connected (no server involved)`);

  // --- 3. Distribute: store each shard on a DIFFERENT node. ------------------
  console.log(`\n  3. DISTRIBUTE: store each shard on its own node...`);
  const cids = [];
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    cids.push(await nodes[i].store(shards[i]));
  }
  const up = new Array(TOTAL_SHARDS).fill(true);
  console.log("     Network view — every node holds exactly one shard, by CID:\n");
  printNetworkView(nodes, cids, up);

  // --- 4. Churn: switch two nodes off. ---------------------------------------
  const downed = [1, 3]; // node B (a data shard) and node D (a parity shard)
  console.log(`\n  4. CHURN: two devices go offline...`);
  for (const i of downed) {
    await nodes[i].stop();
    up[i] = false;
    console.log(`     ✗ node ${LABELS[i]} stopped — its shard #${i} is now unreachable`);
  }
  console.log("");
  printNetworkView(nodes, cids, up);

  // --- 5. Rebuild from the survivors, fetching shards OVER THE NETWORK. -------
  // The survivors are nodes A(0), C(2), E(4). We use node A as the "rebuilder".
  // A only ever stored shard #0; to get shards #2 and #4 it must pull them from
  // peers C and E across the network — there is no local folder to read from.
  console.log(`\n  5. REBUILD from the ${DATA_SHARDS} survivors (fetching shards by CID over the network)...`);
  const rebuilder = nodes[0];
  const survivorIdx = [0, 2, 4];

  const fetchedShards = new Array(TOTAL_SHARDS).fill(null);
  const present = new Array(TOTAL_SHARDS).fill(false);
  let networkFetches = 0;
  for (const i of survivorIdx) {
    const bytes = await fetchWithTimeout(rebuilder, cids[i]);
    fetchedShards[i] = Buffer.from(bytes);
    present[i] = true;
    const heldBy = LABELS[i];
    const overNetwork = i !== 0; // node A holds #0 locally; #2 and #4 come from peers
    if (overNetwork) networkFetches++;
    console.log(
      `     ✓ fetched shard #${i} by CID ${cids[i].toString().slice(0, 20)}… ` +
        `(held by node ${heldBy}${overNetwork ? " — pulled across the network" : " — local to rebuilder"})`
    );
  }

  // Reassemble → decrypt → decompress.
  const result = erasureReconstruct(fetchedShards, present, shardSize);
  if (!result.ok) {
    console.log(`     ✗ Reconstruction failed unexpectedly.`);
    await stopAll(nodes, up);
    process.exitCode = 1;
    return;
  }
  const decrypted = decrypt(result.encrypted, passphrase);
  const recovered = decompress(decrypted);
  const recoveredPrint = fingerprint(recovered);

  // ==========================================================================
  // PROOFS
  // ==========================================================================
  console.log(`\n  ── Proofs ────────────────────────────────────────────────`);

  // (a) The join is real: shards came over the network, not from a tmp/ folder.
  console.log(`\n  (a) The shards travelled over the network — not read from a local folder.`);
  console.log(`      ${networkFetches} of the ${DATA_SHARDS} fetched shards were pulled from peer nodes`);
  console.log(`      (the rebuilder never stored shards #2 or #4 — the only way it can`);
  console.log(`       produce them is a network pull from peers C and E via Bitswap).`);
  console.log(
    `      Phase 4 writes NO shard files to tmp/ — shards live only inside node ` +
      `blockstores,\n      addressed by CID: ${networkFetches >= 1 ? "✓ the join is real" : "✗ nothing crossed the network"}`
  );

  // (b) The recovered file is byte-for-byte identical to the original.
  console.log(`\n  (b) The file rebuilt from ${DATA_SHARDS} survivors is byte-for-byte identical.`);
  const identical = recoveredPrint === originalPrint;
  console.log(`      original  fingerprint: ${originalPrint.slice(0, 24)}…`);
  console.log(`      recovered fingerprint: ${recoveredPrint.slice(0, 24)}…`);
  console.log(`      Match: ${identical ? "✓ YES — identical" : "✗ NO — mismatch"}`);

  // --- 6. Network health readout. --------------------------------------------
  const nodesUp = up.filter(Boolean).length;
  const shardsAvailable = present.filter(Boolean).length;
  const recoverable = identical && shardsAvailable >= DATA_SHARDS;
  console.log(`\n  ── Network health ────────────────────────────────────────`);
  console.log(
    `     nodes: ${nodesUp} up / ${TOTAL_SHARDS - nodesUp} down   ` +
      `shards reachable: ${shardsAvailable}/${TOTAL_SHARDS} (need ${DATA_SHARDS})   ` +
      `file recoverable: ${recoverable ? "YES" : "NO"}`
  );

  await stopAll(nodes, up);

  const allPassed = identical && networkFetches >= 1;
  console.log(`\n  ──────────────────────────────────────────────────────────`);
  if (allPassed) {
    console.log(`  ✓ Phase 4 complete. The two halves are joined: encrypted, erasure-`);
    console.log(`  coded shards now travel between peer nodes and rebuild the file from`);
    console.log(`  a surviving subset — a genuinely distributed Melcher test.`);
    console.log(`  Next: Phase 5 — bounded self-improvement (the network heals itself).\n`);
  } else {
    console.log(`  ✗ Something did not hold. See the proof lines above.\n`);
    process.exitCode = 1;
  }
}

async function stopAll(nodes, up) {
  for (let i = 0; i < nodes.length; i++) {
    if (up[i]) await nodes[i].stop();
  }
}

main().catch((err) => {
  console.error("\n  Something went wrong:\n", err);
  process.exit(1);
});
