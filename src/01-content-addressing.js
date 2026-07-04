// ============================================================================
// PiperNet — Phase 1a: Content Addressing
// ----------------------------------------------------------------------------
// This is the single most important idea in the whole network, so we build it
// first, on its own, where it's easy to see.
//
// On today's internet, data is found by WHERE it lives: a file lives at a URL,
// on some company's server. If they move it, rename it, or switch off the
// server, the link breaks and the data is gone.
//
// PiperNet finds data by WHAT IT IS instead. When you store something, the
// network runs it through a hash function and gives you back a "content
// identifier" (a CID) — a short fingerprint of the exact bytes. Ask the network
// for that CID and you get back those exact bytes, from wherever they happen to
// live, and you can PROVE they weren't tampered with, because if even one byte
// changed, the fingerprint wouldn't match.
//
// No servers appear in this file. We're just meeting the core idea.
//
// Run it with:   npm run content
// ============================================================================

import { createHelia } from "helia";
import { unixfs } from "@helia/unixfs";
import { createLibp2p } from "libp2p";

// A helper to turn text into bytes and back, since the network stores bytes.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function main() {
  console.log("");
  console.log("  PiperNet — Phase 1a: Content Addressing");
  console.log("  ---------------------------------------");

  // ---------------------------------------------------------------------------
  // Create a minimal PiperNet node. For this demo it needs no network at all —
  // just somewhere to keep data. So we give it a libp2p with no transports.
  // (In later phases, this same node grows the ability to talk to peers.)
  // ---------------------------------------------------------------------------
  const libp2p = await createLibp2p({
    // No transports, no listening addresses: this node is offline on purpose.
    start: false,
  });
  const helia = await createHelia({ libp2p });
  const fs = unixfs(helia);
  console.log("  ✓ A PiperNet node is running (offline, storage only)");

  // ---------------------------------------------------------------------------
  // Store a piece of data. We get back its content address (CID).
  // ---------------------------------------------------------------------------
  const message = "The internet we deserve — owned by no one, open to everyone.";
  console.log(`\n  Storing this data:\n    "${message}"`);

  const cid = await fs.addBytes(encoder.encode(message));
  console.log(`\n  ✓ Stored. Its content address (CID) is:`);
  console.log(`    ${cid.toString()}`);
  console.log(`    (This fingerprint comes from the DATA ITSELF — not from`);
  console.log(`     where it's kept. That's the whole trick.)`);

  // ---------------------------------------------------------------------------
  // Retrieve it back, purely by asking for that address.
  // ---------------------------------------------------------------------------
  const chunks = [];
  for await (const chunk of fs.cat(cid)) {
    chunks.push(chunk);
  }
  const retrieved = decoder.decode(concat(chunks));
  console.log(`\n  Retrieving the data by its address alone...`);
  console.log(`  ✓ Got back:\n    "${retrieved}"`);

  // ---------------------------------------------------------------------------
  // Prove it: the retrieved data is identical to what we stored.
  // ---------------------------------------------------------------------------
  const identical = retrieved === message;
  console.log(`\n  Integrity check — is it byte-for-byte what we stored?`);
  console.log(`  ${identical ? "✓ YES." : "✗ NO."} The address guarantees you get exactly the right data.`);

  // ---------------------------------------------------------------------------
  // Show WHY it's tamper-evident: the same data always gives the same address,
  // and different data always gives a different one.
  // ---------------------------------------------------------------------------
  const sameAgain = await fs.addBytes(encoder.encode(message));
  const tampered = await fs.addBytes(encoder.encode(message + " "));
  console.log(`\n  Why this is tamper-evident:`);
  console.log(`    Same data again  -> ${sameAgain.toString().slice(0, 20)}...  (identical address)`);
  console.log(`    One byte changed -> ${tampered.toString().slice(0, 20)}...  (completely different)`);
  console.log(`    Same equals same? ${cid.equals(sameAgain) ? "yes" : "no"}. Changed equals original? ${cid.equals(tampered) ? "yes" : "no"}.`);

  await helia.stop();
  console.log(`\n  Phase 1a complete. Data is now addressed by what it is.`);
  console.log(`  Next: \`npm run twonodes\` — send a file between two peers,`);
  console.log(`  with no server in the middle.\n`);
}

// Small helper: join an array of byte-chunks into one.
function concat(chunks) {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

main().catch((err) => {
  console.error("\n  Something went wrong:\n", err);
  process.exit(1);
});
