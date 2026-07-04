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

import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Load the Reed-Solomon WebAssembly module. We read its .wasm file directly and
// hand the bytes to the library (the simplest, most reliable way in Node).
const require = createRequire(import.meta.url);
const { ReedSolomonErasure } = require("@subspace/reed-solomon-erasure.wasm");
const wasmPath = path.join(
  path.dirname(require.resolve("@subspace/reed-solomon-erasure.wasm")),
  "reed_solomon_erasure_bg.wasm"
);
const reedSolomon = ReedSolomonErasure.fromBytes(fs.readFileSync(wasmPath));

// --- The shape of our redundancy -------------------------------------------
const DATA_SHARDS = 3; // k — how many shards actually carry the data
const PARITY_SHARDS = 2; // n - k — extra shards for recovery
const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS; // n = 5
// => any DATA_SHARDS (3) of the TOTAL_SHARDS (5) can rebuild the file,
//    so we can lose any PARITY_SHARDS (2) and still recover.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SHARD_DIR = path.join(PROJECT_ROOT, "tmp", "shards");

// ----------------------------------------------------------------------------
// Passphrase (never hard-coded — read from the environment, see Phase 2).
// ----------------------------------------------------------------------------
function getPassphrase() {
  const p = process.env.PIPERNET_PASSPHRASE;
  if (!p) {
    console.error(
      "\n  ✗ No passphrase provided." +
        "\n    PiperNet needs a passphrase to derive your encryption key." +
        "\n    Set it in your environment and re-run, for example:" +
        "\n" +
        "\n      PIPERNET_PASSPHRASE='my secret words' npm run redundancy" +
        "\n" +
        "\n    (Passing it as an environment variable keeps your passphrase out" +
        "\n     of the command itself and out of your shell history.)\n"
    );
    process.exit(1);
  }
  return p;
}

// ----------------------------------------------------------------------------
// Phase 2 pipeline, reused: fingerprint + compress/encrypt helpers.
// ----------------------------------------------------------------------------
function fingerprint(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32); // 256-bit key
}

// Encrypt with AES-256-GCM, packing salt + iv + auth-tag + ciphertext together.
function encrypt(compressed, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

// Reverse of encrypt(). Throws on wrong key or tampering (GCM auth check).
function decrypt(packed, passphrase) {
  const salt = packed.subarray(0, 16);
  const iv = packed.subarray(16, 28);
  const authTag = packed.subarray(28, 44);
  const ciphertext = packed.subarray(44);
  const key = deriveKey(passphrase, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// A readable name for the library's numeric result codes.
function resultName(code) {
  for (const key of Object.keys(ReedSolomonErasure)) {
    if (key.startsWith("RESULT_") && ReedSolomonErasure[key] === code) return key;
  }
  return `code ${code}`;
}

// ----------------------------------------------------------------------------
// ERASURE CODING
// ----------------------------------------------------------------------------
// Reed-Solomon needs every shard to be the same size, and needs to know the
// original length so we can trim the zero-padding on the way back. So we frame
// the encrypted blob as:  [ 4-byte length header | encrypted bytes | padding ].
// The framed data fills the k data shards; the library computes the parity.
function erasureEncode(encrypted) {
  const framedLength = 4 + encrypted.length;
  const shardSize = Math.ceil(framedLength / DATA_SHARDS);

  // One contiguous buffer holds all n shards back to back. Buffer.alloc()
  // zero-fills, which is exactly the padding we want.
  const buffer = Buffer.alloc(TOTAL_SHARDS * shardSize);
  buffer.writeUInt32BE(encrypted.length, 0); // the length header
  encrypted.copy(buffer, 4); // the encrypted bytes right after it

  // The library fills the parity region (the last PARITY_SHARDS) in place.
  const code = reedSolomon.encode(buffer, DATA_SHARDS, PARITY_SHARDS);
  if (code !== ReedSolomonErasure.RESULT_OK) {
    throw new Error(`Erasure encoding failed: ${resultName(code)}`);
  }

  // Slice the big buffer into TOTAL_SHARDS equal shards.
  const shards = [];
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    shards.push(buffer.subarray(i * shardSize, (i + 1) * shardSize));
  }
  return { shards, shardSize };
}

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
// This is the self-healing step: as long as at least k shards survive, Reed-
// Solomon regenerates the missing ones and hands us back the original data.
function erasureReconstructFromDisk(dir) {
  // Which shards are present? Read one to learn the shard size.
  const present = new Array(TOTAL_SHARDS).fill(false);
  let shardSize = 0;
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    const p = path.join(dir, `shard-${i}.bin`);
    if (fs.existsSync(p)) {
      present[i] = true;
      shardSize = fs.statSync(p).size;
    }
  }
  const presentCount = present.filter(Boolean).length;

  // Rebuild the contiguous buffer, dropping each surviving shard into its slot.
  const buffer = Buffer.alloc(TOTAL_SHARDS * shardSize);
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    if (present[i]) {
      fs.readFileSync(path.join(dir, `shard-${i}.bin`)).copy(buffer, i * shardSize);
    }
  }

  const code = reedSolomon.reconstruct(buffer, DATA_SHARDS, PARITY_SHARDS, present);
  if (code !== ReedSolomonErasure.RESULT_OK) {
    return { ok: false, code, presentCount };
  }

  // The first k shards are the data region: [length header | encrypted | pad].
  const dataRegion = buffer.subarray(0, DATA_SHARDS * shardSize);
  const encryptedLength = dataRegion.readUInt32BE(0);
  const encrypted = dataRegion.subarray(4, 4 + encryptedLength);
  return { ok: true, encrypted, presentCount };
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
  const compressed = zlib.zstdCompressSync(original);
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
  const recovered = zlib.zstdDecompressSync(decrypted);
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
