# The PiperNet Build Plan
### From Charter to Working Network — a staged path for a first-time builder
*Derived from and governed by the PiperNet Magna Carta v1.0.*

---

## How to read this plan

Each phase is a self-contained arc that ends in **something you can see working** — not an abstract exercise, but a real capability you can demonstrate. Every phase names four things: what you'll **learn**, what you'll **build**, the **milestone** that proves it works, and the **charter article and Technical Bible finding** it makes real. That last column is the point: this plan doesn't invent features, it executes the charter.

The phases are ordered so that the network is *always working* — later phases replace the internals of earlier ones without ever taking the whole thing down. This also makes the plan interruption-proof: step away for a month between phases and you return to a finished checkpoint, not a half-dug tunnel.

A guiding rule, straight from the charter (Article 6): **build nothing you can't eventually understand.** We start on mature open-source rails so you see results fast, then replace pieces with our own as your understanding grows — the hybrid path. This is, fittingly, exactly how Pied Piper itself operated: build on what exists, then replace it with your own as you get stronger.

---

## A note on tools (a Phase 0 decision, not a lock-in)

**Recommended language: JavaScript (Node.js).** Reasons that fit *you* specifically: the two best decentralized-networking libraries in existence — **libp2p** (peer-to-peer transport) and **Helia** (IPFS in JavaScript) — are first-class here; and JavaScript lets you build a **simple web page to actually watch your network work**, which matters when you love seeing ideas become real. The same code runs in a browser and on a server.

**Gentle alternative: Python**, if you'd prefer friendlier syntax to start. It's a fine choice; the P2P libraries are just less mature, so we'd lean more on IPFS's ready-made tools. The plan below is written to work either way — the language only starts to matter at Phase 1.

Nothing here requires you to decide forever on day one. You decide once, at Phase 0, and can revisit.

---

## The modern stack (a 2026 update)

The show ended in 2019. Since then, nearly every hard problem PiperNet faced has acquired a mature, off-the-shelf solution. We don't build these from scratch — we stand on them, and replace pieces with our own only where it teaches us something (the hybrid path). Each architecture layer now maps to a current best tool:

| Layer (from the charter) | What we use now | Why it's the right foundation |
|---|---|---|
| **1. Compression** | **Zstandard (zstd)** as the practical default; **OpenZL** (Meta, 2025) and neural/learned compression as the frontier to explore later | Excellent ratio *and* speed; the real, bounded version of "middle-out." Neural compression is the safe real-world echo of the show's optimizer — powerful, and incapable of breaking encryption. |
| **2. Encrypted sharding** | Client-side encryption + **erasure coding (Reed-Solomon)** — the exact pattern **Storj** runs in production (files split into 80+ pieces, any ~29 rebuild the whole, no node holds a readable fraction) | This *is* the Bible's core mechanism (S3E9), now proven at scale. Erasure coding is the efficient upgrade over plain duplication. |
| **3. Redundant distribution & integrity** | Erasure-coded shards spread across nodes; **BLAKE3 content-addressing / Merkle verification** (as in iroh-blobs) so tampering is detectable and retrieval is verified | Survives mass node loss (the Melcher / phone-recall test) and guarantees you get back exactly what you stored. |
| **4. Peer-to-peer transport** | **Iroh** (dial a device by its public key, direct QUIC connections, ~90% hole-punch success, stays alive across Wi-Fi↔cellular, phone-friendly, Node.js/Python/Swift/Kotlin bindings) — *or* **Helia + js-libp2p** for a pure-JavaScript, browser-first path | The 2019 "how do phones find each other with no server" problem is now largely solved. Iroh is close to a ready-made PiperNet transport; Helia is the most approachable if you want everything in one language with a browser demo. |
| **5. Bounded self-improvement** | Rules + telemetry first; ML-driven shard placement/routing as a genuine (and safe) frontier later | Improving *where shards live and how traffic routes* is real research — and stays safe because entropy forbids the one dangerous outcome. |

**One recommendation to make Phase 1 concrete:** start with **Helia + js-libp2p** if you picked JavaScript (gentlest on-ramp, best examples, you get a browser view for free), and keep **Iroh** in your pocket for when you want the most robust phone-to-phone connections — it has TypeScript bindings, so you won't have to abandon your language to reach for it.

---

## Phase 0 — Foundations ✅
*You can run code, and nothing you build can ever be lost.*

| | |
|---|---|
| **Learn** | The absolute basics: install your language, run a first script, use a code editor. And **version control (git)** from the very first line — the charter's answer to bus-factor-of-one. |
| **Build** | A working development environment. A "hello, network" script that prints something. Your project folder under git, with your first commit. |
| **Milestone** | You change one line, run it, see the change, and save that version to git history. That loop — *edit, run, see, save* — is the heartbeat of everything after. |
| **Charter / Bible** | Article 6 (understood by its builder); Bible §5.5, §10 (never again a codebase only one person can touch, never again work that vanishes when a machine dies). |

---

## Phase 1 — One file, two devices ✅
*The PiperNet embryo: a file crosses between two machines with no server in the middle.*

| | |
|---|---|
| **Learn** | What a peer is, how two peers find and greet each other, how data moves directly between them. Your first real taste of peer-to-peer. |
| **Build** | Using **libp2p / Helia**: a tiny program where **device A** offers a file and **device B** retrieves it directly — no cloud, no central server. (Two laptops, or a laptop and a phone, or even two windows on one machine to start.) |
| **Milestone** | You drop a file on A, and it appears on B, and you can prove nothing central was involved. This is the moment the "new internet" stops being a metaphor. |
| **Charter / Bible** | Articles 1, 7 (no central owner; right of retrieval); Layer 4 of the covenant (Article 15). Bible §3.1, §8.1 — the P2P delivery the show quietly ran on. |

---

## Phase 2 — Encrypted sharding ✅
*The single most important mechanism in the entire system.*

| | |
|---|---|
| **Learn** | Four ideas, each on its own, then chained: **compress** a file, **encrypt** it, **split** it into fragments, and reassemble the original perfectly on the way back. Plus the physics the charter respects: properly encrypted data can't be compressed — so we compress *first*, then encrypt. |
| **Build** | A "chunker" that turns any file into compressed, encrypted fragments where **no single fragment reveals anything**, and a reassembler that reverses it exactly. |
| **Milestone** | You store a file as scattered encrypted shards, open any one shard and confirm it's meaningless noise, then reassemble the whole file intact. The Bible's grandmother-explanation, made real. |
| **Charter / Bible** | Articles 2, 3 (ownership; unreadable by design); Layer 2 (Article 15). Bible §8.3 — *encrypted sharding*, the exact term the show used and the heart of PiperNet. |

---

## Phase 3 — Redundancy and self-healing ✅
*Turn devices off, and the data survives anyway.*
*Built: `npm run redundancy` — erasure-codes into 5 shards, any 3 rebuild the file; proven by deleting 2 shards and recovering byte-for-byte, and by confirming 2 shards cannot.*

| | |
|---|---|
| **Learn** | How to spread fragments across several nodes **with duplication**, so the network can lose pieces and still rebuild every file. (Start with simple replication; later, learn erasure coding for efficiency.) |
| **Build** | A distributor that places redundant shards across multiple nodes, and a retriever that reassembles a file even when some nodes are missing. |
| **Milestone** | **The Melcher test.** Store a file across several devices, then switch off a chunk of them — and retrieve the file perfectly regardless. This is the exact proof the show staged with the phone recall. |
| **Charter / Bible** | Articles 4, 13 (resilient by design; a node may leave harmlessly); Layer 3 (Article 15). Bible §9.4 — ~half the network lost, zero data lost. |

---

## Phase 4 — A living network
*Several real devices that find each other, organize, and report their own health.*

| | |
|---|---|
| **Learn** | How many peers discover one another (not just two), and how to measure the network's true health — the count of nodes **actually online and serving**. |
| **Build** | A small real network — say a laptop, a phone, and a single-board computer like a Raspberry Pi — that self-organizes, distributes shards among themselves, and shows you a live picture of who's online. (A simple web dashboard here pays off your love of *seeing* it work.) |
| **Milestone** | A running PiperNet of several heterogeneous devices you can watch on a screen: nodes joining, leaving, and healing, with a live health readout. |
| **Charter / Bible** | Articles 11, 14 (voluntary contribution; health over headcount); Layers 3–4. Bible §8.2 (any connected device is a node — even, eventually, a fridge), §9.3 (DAU, not installs). |

---

## Phase 5 — Bounded self-improvement
*The network gets better on its own — inside the fence the charter built.*

| | |
|---|---|
| **Learn** | The difference, in practice, between adaptation-within-rules and unbounded optimization. How to write rules the network follows automatically, log every move, and keep every move reversible. |
| **Build** | A control layer that reads the network's telemetry (from Phase 4) and **automatically re-balances shards, re-routes around dead nodes, and tops up redundancy toward a target** — every action bounded, logged, and undoable, with a hard off-switch you hold. |
| **Milestone** | You knock the network out of balance; it notices and restores itself toward its redundancy and latency targets **without you** — and you can read exactly what it did and reverse it. Self-improving, provably inside the limits. |
| **Charter / Bible** | Article 17 in full (permitted self-improvement); Article 18 as the fence around it; Layer 5 (Article 15). This is the safe version of the show's neural-net optimizer — the good 90%, deliberately without the dangerous 10%. |

---

## Phase 6 — The contribution economy *(optional, later)*
*The honest incentive layer, without the speculative coin.*

| | |
|---|---|
| **Learn** | How to fairly account for what each node gives and takes, so contribution can be credited. |
| **Build** | A transparent ledger of storage/bandwidth contributed and consumed — "compute credits" as a unit of fair exchange, not an investment vehicle. |
| **Milestone** | A node that stores for others accrues credit and can spend it to store its own data elsewhere. |
| **Charter / Bible** | Article 12 (fair accounting). Bible §13.1 — compute credits as the honest core; the ICO/coin is explicitly left out of founding scope per the charter. |

---

## What we are deliberately **not** building

Per Articles 16 and 18, the founding network stops at bounded self-improvement. We do **not** build an unconstrained self-optimizing AI, we do **not** let any component rewrite its own goals or the network's rules, and we permit **no** capability that operates by defeating encryption. These aren't limitations of skill or ambition; they are the charter working as designed. The network without that final unbounded layer is complete, useful, and safe — and it is the whole of what the founding mission asked for.

---

## The shape of the journey

Phases 0–1 get you from *nothing* to *a file crossing between two machines with no server* — the idea made real, fast. Phases 2–3 build the irreducible core: encrypted sharding and survivable redundancy. Phase 4 turns that core into a living, watchable network. Phase 5 makes it improve itself, safely. Phase 6, if you want it, adds the fair economy.

At every checkpoint you have a working thing, understood by its builder, faithful to the charter. That is how an entire network gets built by someone new to code: not in one heroic leap, but as a sequence of real, finished, visible steps — each one an idea turned into reality.

*Next step: Phase 0. When you're ready, we set up your environment and write the first line together.*
