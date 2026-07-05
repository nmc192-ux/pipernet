// ============================================================================
// PiperNet — Transport module: a PiperNet node behind a clean interface
// ----------------------------------------------------------------------------
// This is THE SEAM. Everything else in PiperNet talks to the network only
// through the small interface below — never by importing Helia or libp2p
// directly. That matters because the transport is the part of the system most
// likely to change: today it's TCP + Helia/libp2p; tomorrow it might be QUIC
// (for surviving Wi-Fi↔cellular hand-offs), or iroh (for robust phone-to-phone
// connections). Because all of that lives HERE, behind these six methods, we
// can swap it out later without touching the sharding, erasure-coding, or
// application code that sits on top.
//
// The interface, deliberately tiny:
//   start()          — bring the node online
//   multiaddrs()     — the addresses other nodes can dial
//   connect(addr)    — dial another node, peer-to-peer, no server
//   store(bytes)     — save bytes, get back a content address (CID)
//   fetch(cid)       — get bytes back by their CID, pulling from peers if needed
//   stop()           — shut the node down cleanly
//
// The node-building itself is the same recipe proven in src/02-two-nodes.js:
// a libp2p peer (TCP transport, Noise encryption, Yamux stream multiplexing)
// with Helia's content-addressed storage and Bitswap (the protocol that fetches
// blocks a node doesn't have from peers that do) layered on top.
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
import { fileURLToPath } from "node:url";

export class PiperNetNode {
  // `name` is just a human-readable label for logs (e.g. "node-A").
  constructor(name = "node") {
    this.name = name;
    this.libp2p = null;
    this.helia = null;
    this.fs = null;
  }

  // Bring the node online. Returns `this` so you can write:
  //   const node = await new PiperNetNode("A").start();
  async start() {
    // ---- The one place transport is configured. Change TCP→QUIC here. -------
    this.libp2p = await createLibp2p({
      addresses: {
        // Listen on any free port on localhost. (0 = "pick a free port".)
        // A real multi-machine deployment would listen on a routable address;
        // swapping that is a change to THIS line only.
        listen: ["/ip4/127.0.0.1/tcp/0"],
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      services: { identify: identify() },
    });

    // Helia (content-addressed storage) + Bitswap (fetch blocks from peers),
    // wrapped around exactly the libp2p peer we just built.
    this.helia = await withBitswap(withLibp2p(createHeliaLight(), this.libp2p)).start();
    this.fs = unixfs(this.helia);
    return this;
  }

  // A short peer id, handy for logs.
  get peerId() {
    return this.libp2p.peerId.toString();
  }

  // The addresses other nodes can dial to reach this one.
  multiaddrs() {
    return this.libp2p.getMultiaddrs();
  }

  // Dial another node directly, peer-to-peer. `addr` is one of its multiaddrs.
  async connect(addr) {
    return this.libp2p.dial(addr);
  }

  // Store bytes and get back their content address (CID) — the fingerprint of
  // the exact bytes. Anyone connected can later fetch these bytes by this CID.
  async store(bytes) {
    return this.fs.addBytes(bytes);
  }

  // Fetch bytes back by CID. If this node doesn't already hold them, Bitswap
  // pulls the blocks from connected peers that do — this is the data actually
  // travelling across the network.
  async fetch(cid) {
    const chunks = [];
    for await (const chunk of this.fs.cat(cid)) {
      chunks.push(chunk);
    }
    return concat(chunks);
  }

  // Shut the node down cleanly (stops Helia and the underlying libp2p peer).
  async stop() {
    if (this.helia) await this.helia.stop();
  }
}

// Join an array of byte-chunks into one Uint8Array.
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

// ----------------------------------------------------------------------------
// Tiny self-test: run this file directly to prove the interface works.
//   node src/lib/pipernet-node.js
// Starts two nodes, connects them, stores bytes on one, fetches on the other,
// and confirms the bytes match — the whole point of the module, end to end.
// ----------------------------------------------------------------------------
async function selfTest() {
  console.log("\n  PiperNetNode — self-test");
  console.log("  ------------------------");

  const a = await new PiperNetNode("A").start();
  const b = await new PiperNetNode("B").start();
  console.log(`  ✓ Two nodes online (A: ${a.peerId.slice(0, 16)}…, B: ${b.peerId.slice(0, 16)}…)`);

  await b.connect(a.multiaddrs()[0]);
  console.log("  ✓ B dialed A directly (peer-to-peer, no server)");

  const message = new TextEncoder().encode("PiperNet transport seam works.");
  const cid = await a.store(message);
  console.log(`  ✓ A stored bytes → CID ${cid.toString().slice(0, 24)}…`);

  const got = await b.fetch(cid);
  const match =
    got.length === message.length && got.every((byte, i) => byte === message[i]);
  console.log(`  ✓ B fetched that CID over the network`);
  console.log(`  Bytes identical on B? ${match ? "✓ YES" : "✗ NO"}`);

  await a.stop();
  await b.stop();

  if (!match) process.exit(1);
  console.log("  Self-test passed.\n");
}

// Only run the self-test when this file is executed directly, not when imported.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  selfTest().catch((err) => {
    console.error("\n  Self-test failed:\n", err);
    process.exit(1);
  });
}
