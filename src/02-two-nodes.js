// ============================================================================
// PiperNet — Phase 1b: Two Nodes, One File
// ----------------------------------------------------------------------------
// THE MILESTONE. This is the moment the "new internet" stops being a metaphor.
//
// We start two completely independent PiperNet nodes — think of them as two
// different devices, a laptop and a phone. There is no server anywhere. One
// node stores a file; the other asks for it by its content address and pulls
// it directly across a peer-to-peer connection.
//
// Here they run as two nodes on one machine, talking over your computer's local
// network (localhost). The exact same code works across real machines — you'd
// just swap the address. That's the promise: no middleman, no gatekeeper.
//
// Run it with:   npm run twonodes
// ============================================================================

import { createHeliaLight } from "helia";
import { withLibp2p } from "@helia/libp2p";
import { withBitswap } from "@helia/bitswap";
import { unixfs } from "@helia/unixfs";
import { createLibp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Build one PiperNet node in two clear parts:
//   1. a libp2p peer — the networking layer that talks to other peers over TCP,
//      encrypts connections with Noise, and multiplexes streams with Yamux; and
//   2. Helia wrapped around it — content-addressed storage plus "bitswap", the
//      protocol that lets a node fetch blocks it doesn't have from peers it does.
//
// We compose Helia by hand (createHeliaLight -> withLibp2p -> withBitswap) so we
// can hand it exactly the libp2p we built — a lean, TCP-only peer.
async function makeNode(name) {
  const libp2p = await createLibp2p({
    addresses: {
      // Listen on any free port on localhost. (0 = "pick a free port for me".)
      listen: ["/ip4/127.0.0.1/tcp/0"],
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  });

  const helia = await withBitswap(withLibp2p(createHeliaLight(), libp2p)).start();
  console.log(`  ✓ Node ${name} is online. Its peer ID: ${libp2p.peerId.toString().slice(0, 16)}...`);
  // Return both: the libp2p peer (for addresses/dialing) and helia (for storage).
  return { helia, libp2p };
}

async function main() {
  console.log("");
  console.log("  PiperNet — Phase 1b: Two Nodes, One File");
  console.log("  ----------------------------------------");
  console.log("  Starting two independent nodes (no server involved)...\n");

  // --- Two separate "devices" ------------------------------------------------
  const laptop = await makeNode("A (laptop)");
  const phone = await makeNode("B (phone) ");

  // --- Connect them directly, peer to peer -----------------------------------
  // The phone dials one of the laptop's listening addresses. In the real world
  // this address might be across the internet; here it's across localhost.
  const laptopAddr = laptop.libp2p.getMultiaddrs()[0];
  console.log(`\n  Phone dials the laptop directly at:\n    ${laptopAddr.toString()}`);
  await phone.libp2p.dial(laptopAddr);
  console.log(`  ✓ Direct peer-to-peer connection established. No server in between.`);

  // --- The laptop stores a file ----------------------------------------------
  const laptopFs = unixfs(laptop.helia);
  const fileContents =
    "PiperNet says hello. This file lives on no server — only on the " +
    "devices of the people who hold it. You are reading it because a phone " +
    "asked a laptop for it directly, by name.";
  const cid = await laptopFs.addBytes(encoder.encode(fileContents));
  console.log(`\n  Laptop stored a file. Its content address:\n    ${cid.toString()}`);

  // --- The phone fetches it, by address, straight from the laptop -------------
  console.log(`\n  Phone requests that address from the network...`);
  const phoneFs = unixfs(phone.helia);
  const chunks = [];
  for await (const chunk of phoneFs.cat(cid)) {
    chunks.push(chunk);
  }
  const received = decoder.decode(concat(chunks));

  console.log(`  ✓ Phone received the file, pulled directly from the laptop:\n`);
  console.log(`    "${received}"`);

  // --- Prove it really crossed and is intact ---------------------------------
  const intact = received === fileContents;
  console.log(`\n  Did the file arrive byte-for-byte intact? ${intact ? "✓ YES." : "✗ NO."}`);
  console.log(`  Two devices. One file. No server. This is PiperNet, in miniature.`);

  // --- Clean shutdown --------------------------------------------------------
  await phone.helia.stop();
  await laptop.helia.stop();
  console.log(`\n  Phase 1 complete. Next: Phase 2 — encrypted sharding.\n`);
}

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
