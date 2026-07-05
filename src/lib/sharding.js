// ============================================================================
// PiperNet — Shared sharding pipeline
// ----------------------------------------------------------------------------
// The compress → encrypt → erasure-code pipeline, extracted so BOTH Phase 3
// (src/04-redundancy.js, which stores shards on local disk) and Phase 4
// (src/05-living-network.js, which stores shards on separate network nodes)
// use the exact same, single implementation. One source of truth for the
// cryptography and the erasure math; the two phases differ only in WHERE the
// shards live.
//
// The order matters and is deliberate (see the Magna Carta, Article 18):
//   COMPRESS first (while the data still has structure), then ENCRYPT
//   (encrypted data is random noise and cannot be compressed), then
//   ERASURE-CODE the encrypted bytes into shards.
//
// Erasure coding (Reed-Solomon): split into k data shards + (n-k) parity
// shards; ANY k of the n rebuild the original. We use k=3, n=5.
//
// Reed-Solomon library: @subspace/reed-solomon-erasure.wasm — WebAssembly, so
// no C/C++ compiler is needed to install it.
// ============================================================================

import zlib from "node:zlib";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// --- Load the Reed-Solomon WebAssembly module (read the .wasm, hand it over). -
const require = createRequire(import.meta.url);
const { ReedSolomonErasure } = require("@subspace/reed-solomon-erasure.wasm");
const wasmPath = path.join(
  path.dirname(require.resolve("@subspace/reed-solomon-erasure.wasm")),
  "reed_solomon_erasure_bg.wasm"
);
const reedSolomon = ReedSolomonErasure.fromBytes(fs.readFileSync(wasmPath));

// --- The shape of our redundancy --------------------------------------------
export const DATA_SHARDS = 3; // k — shards that carry the data
export const PARITY_SHARDS = 2; // n - k — extra shards for recovery
export const TOTAL_SHARDS = DATA_SHARDS + PARITY_SHARDS; // n = 5
// => any DATA_SHARDS (3) of TOTAL_SHARDS (5) rebuild the file, so we can lose
//    any PARITY_SHARDS (2) shards and still recover.

// ----------------------------------------------------------------------------
// Passphrase — never hard-coded; read from the environment. Exits with a clear
// message if missing.
// ----------------------------------------------------------------------------
export function getPassphrase() {
  const p = process.env.PIPERNET_PASSPHRASE;
  if (!p) {
    console.error(
      "\n  ✗ No passphrase provided." +
        "\n    PiperNet needs a passphrase to derive your encryption key." +
        "\n    Set it in your environment and re-run, for example:" +
        "\n" +
        "\n      PIPERNET_PASSPHRASE='my secret words' npm run redundancy" +
        "\n      PIPERNET_PASSPHRASE='my secret words' npm run network" +
        "\n" +
        "\n    (An environment variable keeps your passphrase out of the command" +
        "\n     itself and out of your shell history.)\n"
    );
    process.exit(1);
  }
  return p;
}

// A short SHA-256 fingerprint, used to PROVE recovered bytes equal the original.
export function fingerprint(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// --- Compression -------------------------------------------------------------
export function compress(bytes) {
  return zlib.zstdCompressSync(bytes);
}
export function decompress(bytes) {
  return zlib.zstdDecompressSync(bytes);
}

// --- Encryption (AES-256-GCM, key derived from the passphrase via scrypt) -----
function deriveKey(passphrase, salt) {
  return crypto.scryptSync(passphrase, salt, 32); // 256-bit key
}

// Packs salt + iv + auth-tag + ciphertext together so the owner can reverse it.
export function encrypt(compressed, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(passphrase, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, authTag, ciphertext]);
}

// Reverse of encrypt(). Throws on wrong passphrase or tampering (GCM auth check).
export function decrypt(packed, passphrase) {
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
export function resultName(code) {
  for (const key of Object.keys(ReedSolomonErasure)) {
    if (key.startsWith("RESULT_") && ReedSolomonErasure[key] === code) return key;
  }
  return `code ${code}`;
}

// ----------------------------------------------------------------------------
// ERASURE CODING
// ----------------------------------------------------------------------------
// We frame the encrypted blob as [ 4-byte length header | encrypted | padding ]
// so we can trim the zero-padding after rebuilding. The framed data fills the k
// data shards; the library computes the parity shards. Returns the shards as
// standalone Buffers plus the shard size (every shard is the same size).
export function erasureEncode(encrypted) {
  const framedLength = 4 + encrypted.length;
  const shardSize = Math.ceil(framedLength / DATA_SHARDS);

  // One contiguous buffer holds all n shards; Buffer.alloc() zero-fills (= pad).
  const buffer = Buffer.alloc(TOTAL_SHARDS * shardSize);
  buffer.writeUInt32BE(encrypted.length, 0); // length header
  encrypted.copy(buffer, 4); // encrypted bytes right after it

  const code = reedSolomon.encode(buffer, DATA_SHARDS, PARITY_SHARDS);
  if (code !== ReedSolomonErasure.RESULT_OK) {
    throw new Error(`Erasure encoding failed: ${resultName(code)}`);
  }

  // Slice into TOTAL_SHARDS standalone shards (copied, so each stands alone).
  const shards = [];
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    shards.push(Buffer.from(buffer.subarray(i * shardSize, (i + 1) * shardSize)));
  }
  return { shards, shardSize };
}

// Rebuild the encrypted blob from a partial set of in-memory shards.
//   shards   — array of length TOTAL_SHARDS; present entries are Buffers,
//              missing entries may be null/undefined
//   present  — boolean array of length TOTAL_SHARDS (true = shard available)
//   shardSize— the size every shard has
// Returns { ok: true, encrypted } on success, or { ok: false, code } if fewer
// than k shards are present (recovery is correctly impossible).
export function erasureReconstruct(shards, present, shardSize) {
  const buffer = Buffer.alloc(TOTAL_SHARDS * shardSize);
  for (let i = 0; i < TOTAL_SHARDS; i++) {
    if (present[i] && shards[i]) {
      Buffer.from(shards[i]).copy(buffer, i * shardSize);
    }
  }

  const code = reedSolomon.reconstruct(buffer, DATA_SHARDS, PARITY_SHARDS, present);
  if (code !== ReedSolomonErasure.RESULT_OK) {
    return { ok: false, code };
  }

  // First k shards are the data region: [ length header | encrypted | pad ].
  const dataRegion = buffer.subarray(0, DATA_SHARDS * shardSize);
  const encryptedLength = dataRegion.readUInt32BE(0);
  const encrypted = dataRegion.subarray(4, 4 + encryptedLength);
  return { ok: true, encrypted };
}
