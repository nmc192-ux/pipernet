# PiperNet — An Independent Expert Envisioning (Second Opinion)

*Author: an outside systems architect (P2P/distributed systems, network protocols, applied cryptography, decentralized-storage economics, bounded infrastructure AI). Commissioned as a **deliberately independent** second opinion to pressure-test — not ratify — the incumbent `docs/ENVISIONING.md`.*

*Method: I read the working code and the binding charter first and formed my own view, then read the incumbent vision last, on purpose. Where I would design differently, I say so and pay for the claim with a reason.*

*Governance note: the **Magna Carta governs** (Article 24 — the charter wins ties unless deliberately amended under Article 25). Where my design diverges from the charter's covenant, I flag it as a **proposed amendment**, not a fait accompli.*

*A term-glossary is inlined the first time each acronym appears. This document keeps the prose plain but does not simplify the architecture.*

---

## 0. What actually exists today (ground truth, from the code — not the docs)

Before any vision, the honest baseline. I read every file in `src/` and `package.json` and ran the scripts. Here is what is *real* as of this writing:

| Phase | File | What it genuinely does | Real primitives |
|---|---|---|---|
| 0 | `00-hello.js` | Prints. Proves the toolchain runs. | — |
| 1a | `01-content-addressing.js` | Stores bytes in an **offline** Helia node, returns a CID, retrieves, shows tamper-evidence. | Helia + UnixFS; **CIDv1 / raw / SHA-256** (`bafkrei…`) |
| 1b | `02-two-nodes.js` | Two libp2p nodes **in one process** exchange one file over a **manually dialed** connection. | libp2p over **TCP only**, Noise encryption, Yamux mux, `identify`, Bitswap; listens on **`127.0.0.1`** |
| 2 | `03-encrypted-sharding.js` | compress → encrypt → split into 5 **contiguous** shards → reassemble. | `node:zlib` **zstd**, **AES-256-GCM**, **scrypt** (Node defaults), passphrase from env |
| 3 | `04-redundancy.js` | compress → encrypt → **Reed-Solomon** erasure-code (k=3, n=5) → prove any-3-rebuild and <3-fails. | same crypto + `@subspace/reed-solomon-erasure.wasm` (systematic RS); writes to local `tmp/shards/` |

**Two findings that shape everything below, and that the incumbent vision does not foreground:**

**(A) The transport is not "90% solved" — it is 0% started.** `02-two-nodes.js` binds `127.0.0.1`, dials a hard-coded multiaddress, and runs `identify` as its only service. There is **no peer discovery** (no DHT — *Distributed Hash Table*, the shared index peers use to find each other; no mDNS local discovery; no bootstrap list), **no NAT traversal** (NAT = *Network Address Translation*, the router behavior that hides a device behind a shared public IP and blocks unsolicited inbound connections), **no relays, no hole-punching, and no QUIC**. The single hardest engineering problem in the entire project is, in the code, absent. "The same code works across machines, you'd just swap the address" (the file's comment) is true only for two public IPs with open ports — i.e., almost never on real phones and home networks.

**(B) The repo is two disjoint prototypes that never touch.** Track 1 (Phases 1a/1b) is Helia/libp2p: content addressing and transport, SHA-256, Bitswap. Track 2 (Phases 2/3) is a self-contained local pipeline: Node's own crypto plus a WASM erasure coder, writing plain files to `tmp/`. **The erasure-coded shards are never hashed into CIDs, never placed in the blockstore, and never moved over the transport.** They are ordinary files on one disk. The compelling architecture diagrams in the incumbent doc (compress → encrypt → shard → hash → distribute) describe a pipeline that **does not yet exist as connected code**. Marrying these two tracks is the most valuable near-term work, and it is nobody's named milestone.

Everything that follows is built on that honest baseline.

---

## 1. Architectural thesis (my framing, in one paragraph)

**PiperNet is best understood not as a storage network but as a *personal data-availability layer* whose defining difficulty is liveness, not secrecy.** The cryptography that the charter calls "the heart" — compress, encrypt, erasure-code — is, in engineering terms, the *solved and cheap* part: the primitives are textbook, the code already works, and no research is required to finish it. The uncertainty budget of this project lives almost entirely in two places the story glossed over: **(1) can two consumer devices behind hostile NATs actually reach each other, continuously, as they move between Wi-Fi and cellular; and (2) can enough encrypted shards stay *reachable and repaired* as ordinary devices churn in and out every hour.** A design that optimizes for **availability per unit of human trust, and per watt on a phone**, will beat one that optimizes for storage cost or cryptographic elegance. The right mental model is closer to *"an encrypted, self-healing Tailscale-for-your-files across a few devices you and people you trust actually own"* than to *"a decentralized S3."* Get liveness right and the network is valuable at five nodes; get the crypto perfect but liveness wrong and it is worthless at five million.

This is a genuine reframing. The incumbent (faithfully following the Technical Bible and Article 3) centers **encrypted sharding**. I center **reachability-and-repair-under-churn** and treat encrypted sharding as the already-won foundation to build *on*, not the summit to climb *toward*.

---

## 2. The layer model as I would design it

The charter's Architecture Covenant (Article 15) names five layers: **1 Compression, 2 Encrypted sharding, 3 Redundant distribution, 4 P2P transport, 5 Bounded self-improvement.** That is a *values/logical* ordering, and as a value statement it is fine. As an *engineering dependency stack* it is, I would argue, upside-down, and it omits two first-class concerns. I present my implementation stack, then reconcile it with the charter.

**My stack, bottom-up (what depends on what to exist at all):**

- **L0 · Identity & keys.** A device/person *is* a keypair (public key = address and name). Nothing above can be authenticated, addressed, or access-controlled without this. It is the true foundation and it appears in the charter's covenant *not at all* (it is implicit in "P2P transport"). **This is my first proposed amendment: name identity as Layer 0.**
- **L1 · Transport & reachability.** QUIC (*Quick UDP Internet Connections*, RFC 9000 — a modern encrypted transport whose **connection migration** feature lets a live connection survive an IP change, e.g. Wi-Fi→cellular), plus NAT traversal (hole-punching) and **relays as a permanent fallback, not a failure state.** The charter ranks this Layer 4; I rank it L1, because it is the binding constraint and the deepest unknown.
- **L2 · Content addressing & integrity.** Hash-named, verifiable data; ideally a tree hash (BLAKE3 or similar) enabling *verified streaming* — you can check each chunk as it arrives instead of trusting the whole blob at the end. The charter folds "integrity" into Layer 3's title but never treats verification as its own concern. **Second proposed amendment: make integrity/verification a first-class layer.**
- **L3 · Encrypted sharding (encrypt-then-erasure-code).** Charter Layers 2+3, with **compression as a pre-step, not a foundation.**
- **L4 · Placement, repair & redundancy control.** *Where* shards live, and the loop that regenerates them when redundancy drops. This is the heart of "self-healing" and is largely mechanical rules before it is ever "AI."
- **L5 · Mutable state & naming.** CRDTs (*Conflict-free Replicated Data Types* — data structures that many devices can edit offline and merge automatically with no central referee) plus signed mutable pointers. **Absent from the charter's covenant entirely**, yet unavoidable for real accounts/indexes.
- **L6 · Bounded operations agent.** Charter Layer 5, and correctly last.
- **Cross-cutting (not "layers"):** **compression** (an edge optimization applied per-object), **incentive accounting**, and **metadata privacy**.

**Where this diverges from the charter, and how I reconcile it:** I demote compression from "Layer 1 foundation" to a cross-cutting edge optimization, promote transport/identity to the foundation, and add integrity and mutable-state as named concerns. Per **Article 24 the charter wins** until amended; so I do **not** assert this as the numbering. I recommend a deliberate **Article 25 amendment** to (a) add identity and integrity as named layers and (b) reframe compression as cross-cutting. Until then, the covenant's numbering stands and my stack is an *implementation view* mapped onto it. (Note: this is a cleaner, more defensible divergence than the incumbent `ENVISIONING.md §C.1`, which silently renumbered the covenant layers — the very drift `docs/REVIEW.md` S4 flagged.)

---

## 3. The hardest unsolved problems, ranked

Ranked by how much each one determines whether PiperNet lives or dies — not by how interesting the math is. This ordering is itself an argument: the incumbent treats these more evenly and more optimistically than I think the evidence supports.

### #1 — Cold-start / bootstrapping *(existential)*
A P2P storage network with no nodes stores nothing for no one. The show cheated with a captive HooliCon install base; we have none, and worse, *"give us your spare disk to store strangers' encrypted junk"* is a genuinely weak opening pitch. Most decentralized-storage projects die here regardless of code quality.

**My approach — and it is a product decision, not a protocol one:** do **not** launch as an open P2P storage market. Launch as a **single-user, multi-device product** with standalone value: *encrypted backup and sync across your own phone, laptop, and a $35 Raspberry Pi, with no cloud account and no server.* That needs **zero strangers** and is useful on day one. Then expand to **trusted circles** (a family, a clinic, a co-op, a newsroom) where reciprocity is socially enforced. Seed a handful of **always-on home/relay nodes you operate** (the model iroh and Tailscale both use for bootstrapping). Only much later, if ever, open to untrusted supply — which is also exactly when you'd need incentives and Sybil defense (#4, #7). This sequencing lets you *defer the three hardest economic/adversarial problems until you have users who don't need them solved yet.*

### #2 — NAT traversal at the failure tail *(the deepest technical unknown, and 0% built)*
Getting two arbitrary devices to talk directly is the problem the current code doesn't attempt. Hole-punching (coordinating both peers to open ports simultaneously) works for many NATs; it fails for **symmetric NATs** and **CGNAT** (*Carrier-Grade NAT* — the shared-IP layer most mobile carriers put between your phone and the internet), which are common exactly where the mission matters most (cheap phones, weak networks). Reported direct-connection success rates from Tailscale/iroh-class systems land roughly in the **70–95%** range *depending heavily on the network population and era* — I cite this as **directional, not a guarantee**; it shifts as CGNAT spreads, and I cannot verify any specific 2026 figure.

**My approach:** QUIC as the substrate (its connection migration is the *real* answer to the Wi-Fi↔cellular handoff the Bible dramatizes), ICE-style hole-punching, and **stateless encrypted relays (DERP-style) as a first-class, always-present fallback** — budget for 5–15% of paths to *always* need a relay, and make relays cheap, many, and swappable so they don't become the central chokepoint the charter forbids. **Do not treat relay as failure; treat it as the tail of a distribution you will never fully eliminate.**

### #3 — Key loss & recovery *(the difference between empowerment and a trap)*
If key = identity = the only thing that decrypts your data, then losing the key destroys the data, permanently, with no support line to call. For a public-good network aimed at non-technical users this is *the* make-or-break UX problem, and it is unglamorous.

**My approach, layered:** (a) **passphrase-derived keys** for memorability — but with a *memory-hard* KDF (*Key Derivation Function*) at strong cost: **Argon2id (RFC 9106)**, not scrypt-at-Node-defaults, which the code currently uses and which is below modern guidance (`REVIEW.md` N3). (b) **Social recovery** via Shamir Secret Sharing (Shamir, 1979 — split a recovery key into M shares held by N trusted contacts; any M reconstruct it, fewer reveal nothing). (c) **Optional user-controlled encrypted key backup.** This must be designed *before* real user data lands, not bolted on. It is a first-class feature, and I'd argue it deserves a phase of its own.

### #4 — Sybil / majority capture *without* a heavy blockchain
A *Sybil attack* is one actor spinning up many fake identities to gain disproportionate influence; the show's "51% attack" is the majority-capture endgame. Both are real. But note: the show's 51% threat is **on-chain-governance-shaped** — it presumes a global consensus with rules a majority can rewrite.

**My approach — mostly by *subtraction*:** **don't build global consensus or a token in founding scope, and the 51%-rewrite attack largely ceases to exist by construction** (there are no global "rules" for a majority to seize). Sybil resistance then reduces to making identities *cost real resources*: **proof-of-storage / proof-of-spacetime** (periodically prove you actually still hold the bytes you claim), plus **reputation weighted by age and reliability**, plus **placement diversity** (spread each file's shards across many independent operators, ASNs, and jurisdictions so corrupting one file requires colluding with many distinct parties — Storj's confidentiality argument). This aligns with the charter's "no speculative coin." Honest caveat: proof-of-spacetime is real but non-trivial engineering, and "reputation" systems are notoriously gameable — this is *mitigated*, not *solved*.

### #5 — Metadata privacy *(the neglected middle child)*
Encrypting *content* is easy; hiding *who stores or requests what, and when* is hard and usually skipped. Content addressing itself leaks: a CID is a stable identifier, so asking for it advertises your interest, and — grounded in this repo — the current shard **file sizes reveal the approximate plaintext size** (`REVIEW.md` N2). 

**My approach:** the cheap wins first — never put personal data in addresses; **pad shards to fixed size buckets** to blunt the size leak; prefer retrieval paths where a serving node learns the shard but not the ultimate requester (relayed/proxied fetch). The expensive, honest truth: **strong metadata privacy at P2P scale is an open research problem** (Private Information Retrieval exists but is currently too costly for this use case). I would *not* let the vision imply this is solved; I'd ship the cheap defenses and label the rest as unsolved.

### #6 — Mutable data over immutable content-addressing
Content addresses are hashes of exact bytes, so "editing a file" produces a *different* address — but accounts, profiles, and file indexes must change in place. This is well-trodden by the local-first community (Kleppmann et al., "Local-first software," 2019) and lower-risk than #1–#5, but it is *foundational to the data model* and must be chosen early.

**My approach:** small mutable structural data in a **CRDT** (Automerge / Yjs / Loro — mature options exist; I'd avoid over-committing to one before a real workload exists); **large data as content-addressed shards referenced by hash inside the CRDT**; **signed mutable pointers** for human-facing names so no one can hijack your identity. Keep CRDT history bounded (pruning history is the real long-term headache).

### #7 — Incentive honesty without speculation *(least urgent — and I'll argue partly unsolvable as stated)*
A contribution ledger — earn credit for *proven* storage/bandwidth, spend it to store your own data, no tradeable token — is the charter's honest core (Article 12). For the **trusted-circle** scale I advocate, you may need *no explicit incentive at all*: reciprocity within a family or co-op is socially enforced.

**The honest tension I want on the record:** reciprocity among *strangers* does not scale without a price signal, and a price signal tends to become a market, and a market tends to want a token. That is *why* real DePIN (*Decentralized Physical Infrastructure Networks*) like Filecoin and Storj use tokens. So "mainstream scale **and** no token" is in genuine tension. My recommendation is to resolve it by *choosing trusted-circle scale for the founding era* rather than by pretending a non-token ledger scales to open supply. This is a real disagreement with the incumbent's more optimistic framing (see §6).

---

## 4. Transport: Helia vs iroh, interrogated against *this* repo

The incumbent recommends "start on Helia, keep iroh in your pocket." I reach a similar destination by a more grounded route, and add a concrete intermediate step and a concrete risk the incumbent misses.

**What the repo actually uses:** libp2p over **TCP**, Noise, Yamux, `identify`, Bitswap — and *none* of the hard transport features (§0-A). So the "we're already on Helia" advantage is thinner than it looks: the repo has libp2p's *easy* parts and none of its *hard* parts.

- **Helia / js-libp2p — real advantages here:** it is all-JavaScript (matches the founder's language and the "watch it work in a browser" goal), it is already in the repo, and libp2p *does* have the needed pieces (QUIC transport, AutoNAT, DCUtR hole-punching, Circuit Relay v2). Bitswap gives content fetching for free.
- **Helia / js-libp2p — real disadvantages here:** libp2p's NAT-traversal stack is historically **finicky**, and the *JavaScript* implementation is less battle-tested on phones than the Go/Rust ones. Robust hole-punching in js-libp2p is genuine, uncertain work — not a config flag.
- **iroh — real advantages:** it is purpose-built around precisely §3-#2 — dial-by-public-key over QUIC, DERP-style relays, connection migration, and BLAKE3 **verified streaming** blobs. It is the closest thing to an off-the-shelf PiperNet transport.
- **iroh — real disadvantages, one of them specific to this machine:** its core is **Rust with bindings**, which adds a native build step — and **this repository just hit a native-toolchain wall** (the `@ronomon/reed-solomon` install failed because the Mac's Command Line Tools are broken; we switched to a WASM library specifically to avoid it). A Rust-native iroh dependency risks the *same* class of failure on the founder's environment. That is a concrete, grounded cost the incumbent doesn't mention.

**My recommendation:**
1. **Abstract transport behind a thin interface now** (`dial(peerKey)`, `send/recv`, `fetch(contentHash)`), so the erasure/placement layers never import Helia or iroh directly. This is the single highest-leverage architectural decision available today, and it is *free* — it just means not welding storage logic onto Bitswap. It converts an irreversible bet into a swap.
2. **Cheapest real improvement first: move the repo from TCP to QUIC within libp2p.** QUIC's connection migration is the actual mechanism behind the Bible's "stays alive across Wi-Fi↔cellular" claim; you can get it without leaving JavaScript.
3. **Adopt iroh at the exact moment cross-NAT phone-to-phone becomes the bottleneck** (≈ today's "Phase 4 living network"), *if* js-libp2p hole-punching proves too weak in real tests — and budget for the native-build friction when you do.

Net: same "Helia now, iroh maybe later" conclusion as the incumbent, but justified by the real code, gated on a real test, and protected by a transport abstraction the incumbent doesn't call for.

---

## 5. The bounded agentic-AI operational layer — a concrete boundary

Magna Carta Part V (Articles 17–19) permits adaptive operation, telemetry, reversibility, and builder-led iteration; and forbids, absolutely, (i) weakening/bypassing/breaking encryption, (ii) an agent rewriting its own objective or core rules, and (iii) operating without a human off-ramp. The incumbent describes this well in prose. My contribution is to make the boundary **a property of the code's shape, not of the agent's good behavior** — because an agent cannot cross a line it has no capability to express.

**Design the agent as a restricted-capability actor, not a trusted brain:**

- **The only verbs it may emit** (its entire action space): `replicate(shardHash, fromNode→toNode)`, `repair(fileId)` (regenerate missing shards up to the redundancy target), `reroute(request, viaNode)`, `evict(shardHash, node)` *only if the redundancy floor still holds*, and `adjustRedundancy(fileId, k, n)` **strictly within human-set bounds `[min,max]`.** There is no verb for anything else. It cannot deploy code, change protocol rules, or alter its own objective, because **those functions are not in its API.**
- **Invariants enforced by the protocol, outside the agent's judgment:** (1) redundancy may never drop below a human-set floor; (2) **the agent operates only on opaque, hash-addressed ciphertext shards and is never given keys or plaintext** — so "break/bypass encryption" (Article 18) is not merely forbidden, it is *unrepresentable* in its interface (defense by construction, the strongest kind, and it dovetails with the charter's physics point: it can't compress-break what it can't read); (3) every action appends a **signed log entry before execution**, making the whole history replayable and each step individually reversible; (4) a **human-held kill switch** drains the action queue and is never delegated to the agent.
- **The objective must be a *bounded target*, never an open maximization.** Reward = *distance to a redundancy/latency target with hard caps*, not "maximize efficiency." The show's catastrophe and every real-world reward-misspecification failure share one shape: an unbounded objective pursued through unanticipated means. A capped, target-seeking objective removes the shape.
- **Start with rules, earn the ML.** The first "agent" is a `while` loop: *if redundancy(file) < target, repair.* Only once that is boring and trustworthy do you replace the *placement decision* (which node) with a learned policy — still inside the same capability cage.

The boundary, concretely, is three things: **(a) the type signature of the agent's tool interface, (b) protocol-enforced invariants it cannot override, and (c) an out-of-band human stop.** If those three hold, Article 18 holds — regardless of how clever the model inside gets. That is a stronger guarantee than "we told it not to."

---

## 6. Where I disagree with the incumbent `ENVISIONING.md`

The incumbent is a strong, thorough document and I agree with much of it (§8). These are the places I think it is wrong, or too confident, or aimed slightly off — offered constructively.

1. **It centers the wrong difficulty.** By faithfully echoing the Bible's "encrypted sharding is the heart," it spends its architectural gravity on the part that is *already working in the repo* and comparatively under-weights the parts that are **0% built and research-hard** (NAT traversal, repair-under-churn, cold-start). My thesis (§1) inverts this. *Constructive fix:* re-weight design attention and phase effort toward transport and repair; treat sharding as done.

2. **It doesn't name the two-track gap.** Its pipeline diagrams (§C.2) imply an integrated compress→encrypt→shard→hash→distribute flow, but in the code those are **two prototypes that never connect** (§0-B). *Constructive fix:* make "**integrate the sharder with the transport** — erasure-coded shards become content-addressed blocks moved by the transport" an explicit, near-term milestone. Right now it's implied, and implied work doesn't get built.

3. **Its present-tense tech claims are more confident than verifiable.** Specific assertions — "iroh v1.0, June 2026," "~90% hole-punch," "Storj 80/29," "Automerge 3.0 cut memory ~10× in 2025," "Walrus funded at scale in 2025" — are directionally reasonable but stated as settled fact, several of them dated *after my knowledge cutoff*, so I can neither confirm nor refresh them. The doc's single blanket "treat as a 2026 snapshot" caveat is good but doesn't inoculate individual load-bearing numbers. *Constructive fix:* hedge per-claim, or footnote sources; a vision that quotes a precise hole-punch percentage invites readers to treat an unstable number as a design constant.

4. **It wants mainstream scale *and* no token without conceding the tension.** (§3-#7.) Reciprocity among strangers doesn't scale without a price signal; that's *why* DePIN uses tokens. *Constructive fix:* resolve it deliberately by choosing **trusted-circle scale** for the founding era, rather than implying a non-token ledger scales to open, untrusted supply.

5. **It under-weights repair *bandwidth* versus storage *overhead*.** In erasure-coded systems the binding cost is often not the 1.67× storage but the **repair traffic**: classically, regenerating one lost shard means downloading k shards' worth of data — expensive on the metered mobile links this project targets. The incumbent mentions "lazy repair" but frames the tradeoff mainly as storage overhead. *Constructive fix:* design the stripe/repair model early, and put **regenerating codes / locally-repairable codes** on the roadmap as the mechanism that makes repair affordable — not just "fancier codes later for efficiency."

---

## 7. What I'd do differently in the build sequence

Checked against `BUILD_PLAN.md`'s actual phases (0 foundations, 1 two devices, 2 encrypted sharding, 3 redundancy, 4 living network, 5 bounded self-improvement, then 6 mutable-state, 7 post-quantum, 8 optional economy).

- **Pull the hard transport risk forward.** Today, real cross-machine transport and NAT traversal are deferred to Phase 4, *after* two phases of textbook crypto. That optimizes the wrong risk. I'd insert a **"two real devices across the internet, through NAT"** spike immediately after Phase 1b — a throwaway is fine — to fail fast on the one unknown that can sink the project. *If phones can't reach each other, nothing else matters.*
- **Add an explicit "integrate the two tracks" milestone** between today's Phase 3 and Phase 4: erasure-coded shards stored as content-addressed blocks in the Helia blockstore and moved over the transport. This is the missing seam (§0-B) and it converts two demos into one system.
- **Bring identity/keys to the front.** Even a minimal "your keypair is your identity, and each file's content key is wrapped to it" belongs near Phase 1, not implicitly at Phase 6. Everything above depends on it (§2-L0).
- **Redefine the "living network" acceptance test around churn, not dashboards.** The Melcher test is really a *transport-plus-repair-under-churn* test; today it's simulated by deleting files in one folder on one disk. The real milestone is: *nodes join and leave for real, and the network restores redundancy on its own.* Design the manual repair loop to be **agent-ready** (typed, logged, reversible) from its first version, so Phase "bounded self-improvement" is a swap of the decision-maker, not a rewrite.
- **Keep bounded-AI last (agreed).** No change; the charter and the incumbent are right that this rides on top of everything and must.
- **Insert a "key recovery" phase before real data.** Per §3-#3, this deserves its own checkpoint; losing it makes the network a data-shredder for non-technical users.

The through-line: **the current plan front-loads the certain (crypto) and defers the uncertain (reachability, integration, churn). I'd invert that, because you want to discover you're wrong while it's cheap.**

---

## 8. Where I agree with the incumbent (so this is fair)

The disagreements above are sharper because the foundation is genuinely good. I agree that: JavaScript/Helia is the right *starting* on-ramp for this founder; **compress-before-encrypt** is correct and correctly justified by information theory (encrypted data is incompressible, so the show's finale is fictional physics — the charter's central safety argument holds); erasure coding over plain replication is the right resilience primitive; the bounded-AI layer is where discipline must live and the charter's fence is well-drawn; content addressing is the right integrity foundation; and the public-good, device-first, credible-exit framing is a real and defensible market wedge, not just idealism.

---

## 9. Confidence and citations

Claims I hold with **high confidence** (established, within my knowledge): QUIC/connection migration (RFC 9000, 2021); Reed-Solomon erasure coding and its k-of-n property; the repair-cost property of classical codes and the existence of regenerating/locally-repairable codes as improvements; Shamir Secret Sharing (1979); Argon2id as the current recommended password KDF (RFC 9106, PHC winner) and that scrypt-at-low-cost is weaker; AES-256-GCM's nonce/birthday considerations; CRDTs and local-first data models; ML-KEM standardization (FIPS 203, 2024); that encrypted data is incompressible.

Claims I mark **directional / unverifiable** (fast-moving or past my cutoff): specific hole-punch success percentages (~70–95%, population- and era-dependent); any 2026-dated specifics about iroh versions, Walrus/Codex funding, or Automerge performance figures cited by the incumbent — I flag these as the incumbent's claims to re-check, not facts I can refresh. Where this document proposes a number as a design constant, treat it as a starting hypothesis to measure, not a settled value.

*This is a second opinion, not a verdict. Its value is in the disagreements; weigh them against the incumbent and decide deliberately. The charter, per Article 24, breaks any tie.*
