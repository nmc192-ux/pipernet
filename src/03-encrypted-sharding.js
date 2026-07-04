// ============================================================================
// PiperNet — Phase 2: Encrypted Sharding
// ----------------------------------------------------------------------------
// This is the single most important mechanism in the whole system. It's the
// "grandmother explanation" from the Bible, made real: take a file, and turn it
// into a pile of scattered fragments where NO SINGLE FRAGMENT reveals anything —
// then reassemble the original, perfectly, on the way back.
//
// We chain four ideas, in this exact order:
//
//   1. COMPRESS   — squeeze the file smaller (with zstd).
//   2. ENCRYPT    — scramble it with a key derived from your passphrase, so the
//                   bytes become meaningless noise to anyone without the key.
//   3. SPLIT      — cut the encrypted blob into 5 shards, saved as separate
//                   files. On a real network these would live on different
//                   devices; here they live in tmp/shards/.
//   4. REASSEMBLE — glue the shards back, decrypt, decompress, and confirm the
//                   result is byte-for-byte identical to what we started with.
//
// WHY COMPRESS BEFORE ENCRYPT? A bit of physics the charter respects: properly
// encrypted data looks completely random, and random data cannot be compressed.
// So if you encrypt first, compression afterwards does nothing. Compress FIRST,
// while there's still structure to exploit, THEN encrypt. Order matters.
//
// This file uses ONLY Node's own built-in tools — nothing to install:
//   node:zlib   (zstd compression)   node:crypto (encryption)
//   node:fs     (reading/writing)    node:path   (file paths)
//
// Run it with:            npm run shard
// Or on your own file:    node src/03-encrypted-sharding.js /path/to/your/file
// ============================================================================

import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where the shards get written. This lives under tmp/, which is git-ignored,
// so your scattered fragments never get committed to the repo.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const SHARD_DIR = path.join(PROJECT_ROOT, "tmp", "shards");

const SHARD_COUNT = 5; // how many fragments to split into

// A fixed passphrase for the demo. In real life this would be YOURS, and never
// written down in code. Everything encrypted with it can only be opened with it.
const PASSPHRASE = "correct-horse-battery-staple";

// ----------------------------------------------------------------------------
// Small helpers
// ----------------------------------------------------------------------------

// A short, human-readable fingerprint of some bytes (SHA-256). We use this to
// PROVE the recovered file is identical to the original: same bytes => same
// fingerprint, one byte different => a totally different fingerprint.
function fingerprint(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Turn a passphrase into a real 256-bit encryption key. scrypt is deliberately
// slow and salted, so guessing passphrases by brute force is painfully hard.
// The SAME passphrase + SAME salt always yields the SAME key — that's how the
// reader re-derives the key to decrypt.
function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32); // 32 bytes = 256 bits
}

// ----------------------------------------------------------------------------
// The pipeline, one step per function.
// ----------------------------------------------------------------------------

// STEP 2 (compress happens inline in main). Encrypt compressed bytes with
// AES-256-GCM. GCM doesn't just hide the data, it also stamps it with an
// "authentication tag" — a seal that breaks if anyone tampers with the bytes
// OR if the wrong key is used. We pack everything the reader will need to
// reverse this — salt, iv, tag — right alongside the ciphertext:
//
//   [ salt (16) | iv (12) | authTag (16) | ciphertext (the rest) ]
//
// None of salt/iv/tag are secret; only the passphrase is. Bundling them means
// a shard-holder still learns nothing, but the rightful owner can rebuild.
function encrypt(compressed, passphrase) {
  const salt = crypto.randomBytes(16); // makes the key unique to this file
  const iv = crypto.randomBytes(12); // GCM's standard 96-bit nonce
  const key = deriveKey(passphrase, salt);

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag(); // the tamper-evident seal

  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

// The reverse of encrypt(). Unpacks salt/iv/tag, re-derives the key from the
// passphrase, and decrypts. If the passphrase is wrong OR any byte was altered,
// GCM's .final() THROWS — decryption fails loudly rather than returning garbage.
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

// STEP 3. Split a blob into SHARD_COUNT roughly-equal pieces and write each to
// its own file. Returns the list of file paths written.
function splitIntoShards(blob, count, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // Clear any shards from a previous run so we don't mix old and new.
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith("shard-")) fs.unlinkSync(path.join(dir, f));
  }

  const shardSize = Math.ceil(blob.length / count);
  const paths = [];
  for (let i = 0; i < count; i++) {
    const piece = blob.subarray(i * shardSize, (i + 1) * shardSize);
    const p = path.join(dir, `shard-${i}.bin`);
    fs.writeFileSync(p, piece);
    paths.push(p);
  }
  return paths;
}

// STEP 4 (part 1). Read the shard files back — in order — and glue them into
// one blob again. We sort by the number in the filename so order is guaranteed.
function reassembleFromShards(dir) {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("shard-"))
    .sort((a, b) => {
      const na = parseInt(a.match(/shard-(\d+)/)[1], 10);
      const nb = parseInt(b.match(/shard-(\d+)/)[1], 10);
      return na - nb;
    });
  return Buffer.concat(files.map((f) => fs.readFileSync(path.join(dir, f))));
}

// ----------------------------------------------------------------------------
// Main: run the whole pipeline and prove the three properties that matter.
// ----------------------------------------------------------------------------
async function main() {
  console.log("");
  console.log("  PiperNet — Phase 2: Encrypted Sharding");
  console.log("  --------------------------------------");

  // --- Get the data to protect: either the user's file, or a built-in sample.
  const userFile = process.argv[2];
  let original;
  let sourceLabel;
  if (userFile) {
    original = fs.readFileSync(userFile); // shard a real file of your own
    sourceLabel = `your file: ${userFile}`;
  } else {
    const sample =
      "PiperNet stores your data compressed, encrypted, and split into " +
      "fragments across ordinary devices — retrievable by you from anywhere, " +
      "and readable by no one else. This sample sentence is repeated so there " +
      "is something for the compressor to actually chew on.\n";
    original = Buffer.from(sample.repeat(40), "utf8");
    sourceLabel = "built-in sample text";
  }

  const originalPrint = fingerprint(original);
  console.log(`\n  Source: ${sourceLabel}`);
  console.log(`  Original size: ${original.length} bytes`);
  console.log(`  Original fingerprint (SHA-256): ${originalPrint.slice(0, 24)}...`);

  // --- STEP 1: COMPRESS ------------------------------------------------------
  const compressed = zlib.zstdCompressSync(original);
  console.log(`\n  1. COMPRESS (zstd)`);
  console.log(`     ${original.length} bytes  ->  ${compressed.length} bytes compressed`);

  // --- STEP 2: ENCRYPT -------------------------------------------------------
  const encrypted = encrypt(compressed, PASSPHRASE);
  console.log(`\n  2. ENCRYPT (AES-256-GCM, key from your passphrase via scrypt)`);
  console.log(`     ${compressed.length} bytes  ->  ${encrypted.length} bytes sealed`);
  console.log(`     (packed as: salt + iv + auth-tag + ciphertext)`);

  // --- STEP 3: SPLIT ---------------------------------------------------------
  const shardPaths = splitIntoShards(encrypted, SHARD_COUNT, SHARD_DIR);
  console.log(`\n  3. SPLIT into ${SHARD_COUNT} shards -> tmp/shards/`);
  for (const p of shardPaths) {
    const size = fs.statSync(p).size;
    console.log(`     ${path.basename(p)}  (${size} bytes)`);
  }

  // --- STEP 4: REASSEMBLE ----------------------------------------------------
  const gluedBack = reassembleFromShards(SHARD_DIR);
  const decrypted = decrypt(gluedBack, PASSPHRASE);
  const decompressed = zlib.zstdDecompressSync(decrypted);
  console.log(`\n  4. REASSEMBLE  (glue shards -> decrypt -> decompress)`);
  console.log(`     ${gluedBack.length} bytes glued  ->  ${decompressed.length} bytes recovered`);

  // ==========================================================================
  // THE THREE PROOFS
  // ==========================================================================
  console.log(`\n  ── Proofs ────────────────────────────────────────────────`);

  // PROOF (a): a single shard alone is meaningless and cannot be decrypted.
  console.log(`\n  (a) A single shard alone cannot be decrypted.`);
  const oneShard = fs.readFileSync(shardPaths[0]);
  const preview = oneShard.subarray(0, 16).toString("hex");
  console.log(`      Opening ${path.basename(shardPaths[0])} raw, first 16 bytes look like:`);
  console.log(`      ${preview}   <- meaningless noise`);
  let shardAloneFailed = false;
  try {
    // Try to decrypt just one shard, as an attacker who stole it might.
    decrypt(oneShard, PASSPHRASE);
  } catch {
    shardAloneFailed = true; // expected: it has no valid tag / is incomplete
  }
  console.log(
    `      Attempt to decrypt that lone shard: ${
      shardAloneFailed ? "✓ REJECTED (as it must be)" : "✗ unexpectedly succeeded"
    }`
  );

  // PROOF (b): the recovered file is byte-for-byte identical to the original.
  const recoveredPrint = fingerprint(decompressed);
  const identical = recoveredPrint === originalPrint;
  console.log(`\n  (b) The recovered file is byte-for-byte identical to the original.`);
  console.log(`      original  fingerprint: ${originalPrint.slice(0, 24)}...`);
  console.log(`      recovered fingerprint: ${recoveredPrint.slice(0, 24)}...`);
  console.log(`      Match: ${identical ? "✓ YES — identical" : "✗ NO — mismatch"}`);

  // PROOF (c): the wrong passphrase is rejected.
  console.log(`\n  (c) The wrong passphrase is rejected.`);
  let wrongFailed = false;
  try {
    decrypt(gluedBack, "not-the-real-passphrase");
  } catch {
    wrongFailed = true; // expected: GCM's authentication check fails
  }
  console.log(
    `      Decrypt with a wrong passphrase: ${
      wrongFailed ? "✓ REJECTED (data stays sealed)" : "✗ unexpectedly succeeded"
    }`
  );

  // --- Verdict ---------------------------------------------------------------
  const allPassed = shardAloneFailed && identical && wrongFailed;
  console.log(`\n  ──────────────────────────────────────────────────────────`);
  if (allPassed) {
    console.log(`  ✓ All three proofs passed. This is encrypted sharding, working.`);
    console.log(`\n  Phase 2 complete. A file is now compressed, encrypted, and`);
    console.log(`  scattered into fragments that reveal nothing alone — yet`);
    console.log(`  reassemble perfectly for its owner.`);
    console.log(`  Next: Phase 3 — spread these shards across devices with`);
    console.log(`  redundancy, so the file survives even when nodes go dark.\n`);
  } else {
    console.log(`  ✗ Something did not hold. See the proof lines above.\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("\n  Something went wrong:\n", err);
  process.exit(1);
});
