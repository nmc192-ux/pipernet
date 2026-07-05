// ============================================================================
// PiperNet — Phase 3: Redundancy & Self-Healing
// ----------------------------------------------------------------------------
// Phase 2 proved we can compress, encrypt, and split a file into shards. But it
// had a hidden weakness: it split the data into 5 *contiguous* pieces, so losing
// even ONE piece lost the whole file. That's the opposite of what we want. On a
// real network, devices go offline all the time — phones die, laptops close,
// nodes leave. The network must survive that.
//
// This is the famous "Melcher test" from the Bible: store a file across many
// devices, switch off a big chunk of them, and STILL get your file back, whole.
//
// The tool that makes this possible is ERASURE CODING (Reed-Solomon) — the same
// technique Storj, CDs, DVDs, and QR codes use. The idea:
//
//   * Split the data into k "data shards".
//   * Compute n-k extra "parity shards" from them (clever math).
//   * Now you have n shards total, and ANY k of them rebuild the original.
//   * You can lose any (n - k) shards and still recover everything.
//
// We use n = 5, k = 3:  five shards, any three rebuild the file, so you can lose
// ANY TWO shards and still be fine.
//
// WHY THIS IS EFFICIENT (the redundancy-vs-overhead tradeoff):
//   To survive losing 2 copies by plain duplication, you'd store the whole file
//   THREE times (3x overhead). Erasure coding gives the same "survive any 2
//   losses" guarantee while storing only n/k = 5/3 ≈ 1.67x the data. More parity
//   shards (raising n) = more resilience but more storage; fewer = the opposite.
//   That knob is the whole game in real distributed storage.
//
// The pipeline reuses Phase 2 and adds the erasure step:
//   COMPRESS (zstd) -> ENCRYPT (AES-256-GCM) -> ERASURE-CODE into n shards.
//
// Reed-Solomon library: @subspace/reed-solomon-erasure.wasm — a WebAssembly
// build, so there is no C/C++ compiler needed to install it.
//
// Run it with:            PIPERNET_PASSPHRASE='my secret words' npm run redundancy
// Or on your own file:    PIPERNET_PASSPHRASE='...' node src/04-redundancy.js /path/to/file
// ============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The compress → encrypt → erasure-code pipeline now lives in one shared module
// (src/lib/sharding.js), used by BOTH this phase and Phase 4. This file adds
// only the disk-specific part: writing shards to tmp/shards/ and reading back.
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
  resultName,
  erasureEncode,
  erasureReconstruct,
} from "./lib/sharding.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SHARD_DIR = path.join(PROJECT_ROOT, "tmp", "shards");

// ----------------------------------------------------------------------------
// Disk storage for shards (this phase keeps them as files in tmp/shards/).
// The compress/encrypt/erasure logic all comes from ./lib/sharding.js above.
// ----------------------------------------------------------------------------

// Write each shard to its own file, e.g. tmp/shards/shard-0.bin.
function writeShards(shards, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith("shard-")) fs.unlinkSync(path.join(dir, f)); // clear old run
  }
  const paths = [];
  for (let i = 0; i < shards.length; i++) {
    const p = path.join(dir, `shard-${i}.bin`);
    fs.writeFileSync(p, shards[i]);
    paths.push(p);
  }
  return paths;
}

// Rebuild the encrypted blob from whatever shard files currently exist on disk.
// Reads the surviving shard files into memory, then hands them to the shared
// erasureReconstruct(). As long as at least k shards survive, the missing ones
// are regenerated and we get the original encrypted bytes back.
function erasureReconstructFromDisk(dir) {
  const shards = new Array(TOTAL_SHARDS).fill(null);
  const present = new Array(TOTAL_SHARDS).fill(false);
  let shardSize = 0;
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    const p = path.join(dir, `shard-${i}.bin`);
    if (fs.existsSync(p)) {
      shards[i] = fs.readFileSync(p);
      present[i] = true;
      shardSize = shards[i].length;
    }
  }
  const presentCount = present.filter(Boolean).length;
  const result = erasureReconstruct(shards, present, shardSize);
  return { ...result, presentCount };
}

// ----------------------------------------------------------------------------
// Main
// ----------------------------------------------------------------------------
async function main() {
  console.log("");
  console.log("  PiperNet — Phase 3: Redundancy & Self-Healing");
  console.log("  ---------------------------------------------");

  const passphrase = getPassphrase();

  // --- The data to protect: your file, or a built-in sample. -----------------
  const userFile = process.argv[2];
  let original;
  let sourceLabel;
  if (userFile) {
    original = fs.readFileSync(userFile);
    sourceLabel = `your file: ${userFile}`;
  } else {
    const sample =
      "PiperNet survives the loss of devices. This file is compressed, " +
      "encrypted, and erasure-coded into shards spread across many nodes — " +
      "and any three of the five rebuild it perfectly. Turn two nodes off and " +
      "the file is still here. This sentence is repeated to give the " +
      "compressor something to chew on.\n";
    original = Buffer.from(sample.repeat(30), "utf8");
    sourceLabel = "built-in sample text";
  }

  const originalPrint = fingerprint(original);
  console.log(`\n  Source: ${sourceLabel}`);
  console.log(`  Original size: ${original.length} bytes`);
  console.log(`  Original fingerprint (SHA-256): ${originalPrint.slice(0, 24)}...`);

  // --- 1. COMPRESS -----------------------------------------------------------
  const compressed = compress(original);
  console.log(`\n  1. COMPRESS (zstd): ${original.length} -> ${compressed.length} bytes`);

  // --- 2. ENCRYPT ------------------------------------------------------------
  const encrypted = encrypt(compressed, passphrase);
  console.log(`  2. ENCRYPT (AES-256-GCM): ${compressed.length} -> ${encrypted.length} bytes sealed`);

  // --- 3. ERASURE-CODE -------------------------------------------------------
  const { shards, shardSize } = erasureEncode(encrypted);
  const shardPaths = writeShards(shards, SHARD_DIR);
  console.log(
    `  3. ERASURE-CODE: ${DATA_SHARDS} data + ${PARITY_SHARDS} parity = ${TOTAL_SHARDS} shards ` +
      `(${shardSize} bytes each) -> tmp/shards/`
  );
  for (let i = 0; i < shardPaths.length; i++) {
    const kind = i < DATA_SHARDS ? "data  " : "parity";
    console.log(`     ${path.basename(shardPaths[i])}  (${kind})`);
  }
  const overhead = (TOTAL_SHARDS / DATA_SHARDS).toFixed(2);
  console.log(
    `\n     Storage overhead: ${overhead}x the encrypted size, and it can survive` +
      `\n     losing any ${PARITY_SHARDS} of the ${TOTAL_SHARDS} shards. (Plain 3 copies would be 3.00x.)`
  );

  // ==========================================================================
  // THE PROOFS
  // ==========================================================================
  console.log(`\n  ── Proofs ────────────────────────────────────────────────`);

  // PROOF (a): lose 2 shards, rebuild anyway, byte-for-byte identical.
  console.log(`\n  (a) Lose any ${PARITY_SHARDS} shards and the file still rebuilds exactly.`);
  const killed = [1, 3]; // one data shard (1) and one parity shard (3)
  for (const i of killed) {
    fs.unlinkSync(path.join(SHARD_DIR, `shard-${i}.bin`));
    console.log(`      ✗ Simulating a dead node: deleted shard-${i}.bin`);
  }
  const survivors = TOTAL_SHARDS - killed.length;
  console.log(`      ${survivors} of ${TOTAL_SHARDS} shards remain. Rebuilding from those...`);

  const rebuilt = erasureReconstructFromDisk(SHARD_DIR);
  if (!rebuilt.ok) {
    console.log(`      ✗ Unexpected: reconstruction failed (${resultName(rebuilt.code)}).`);
    process.exitCode = 1;
    return;
  }
  const decrypted = decrypt(rebuilt.encrypted, passphrase);
  const recovered = decompress(decrypted);
  const recoveredPrint = fingerprint(recovered);
  const identical = recoveredPrint === originalPrint;
  console.log(`      original  fingerprint: ${originalPrint.slice(0, 24)}...`);
  console.log(`      recovered fingerprint: ${recoveredPrint.slice(0, 24)}...`);
  console.log(
    `      Rebuilt from just ${rebuilt.presentCount} shards, byte-for-byte identical: ` +
      `${identical ? "✓ YES" : "✗ NO"}`
  );

  // PROOF (b): with fewer than k shards, recovery is correctly impossible.
  console.log(`\n  (b) With fewer than ${DATA_SHARDS} shards, the file correctly CANNOT be rebuilt.`);
  fs.unlinkSync(path.join(SHARD_DIR, `shard-0.bin`)); // now only 2 remain (2, 4)
  console.log(`      ✗ A third node dies: deleted shard-0.bin`);
  const remaining = fs
    .readdirSync(SHARD_DIR)
    .filter((f) => f.startsWith("shard-")).length;
  console.log(`      Only ${remaining} shards remain (need ${DATA_SHARDS}). Trying to rebuild...`);
  const tooFew = erasureReconstructFromDisk(SHARD_DIR);
  const correctlyFailed = !tooFew.ok;
  console.log(
    `      Rebuild attempt: ${
      correctlyFailed
        ? `✓ REJECTED (${resultName(tooFew.code)}) — as it must be`
        : "✗ unexpectedly succeeded"
    }`
  );

  // --- Verdict ---------------------------------------------------------------
  const allPassed = identical && correctlyFailed;
  console.log(`\n  ──────────────────────────────────────────────────────────`);
  if (allPassed) {
    console.log(`  ✓ Both proofs passed. This is redundancy & self-healing, working.`);
    console.log(`\n  Phase 3 complete. A file now survives the loss of nodes: scattered`);
    console.log(`  as ${TOTAL_SHARDS} encrypted shards, any ${DATA_SHARDS} rebuild it, and no single shard`);
    console.log(`  reveals anything. This is the Melcher test — passed.`);
    console.log(`  Next: Phase 4 — a living network of several devices that find each`);
    console.log(`  other and heal on their own.\n`);
  } else {
    console.log(`  ✗ Something did not hold. See the proof lines above.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n  Something went wrong:\n", err);
  process.exit(1);
});
