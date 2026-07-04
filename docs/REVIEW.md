# PiperNet — Repository Verification Review
*Date: 2026-07-05 · Scope: all docs in `docs/`, all code in `src/`, runtime verification of every script · Reviewer: automated four-pass audit requested by the founder*

---

## Verdict

**What's solid.** The core is real and it runs: all four scripts execute successfully and do what they claim (verified live, not assumed). The Phase 2 crypto pipeline uses the right primitives in the right order (compress → scrypt-derived key → AES-256-GCM → split), and all three of its proofs pass on both the built-in sample and a real file. Nothing anywhere violates the Magna Carta's hard limits (Part V): no code weakens or bypasses encryption, no self-optimizing behavior exists yet, and the docs are honest that resilience and self-improvement are future phases.

**What needs fixing before Phase 3.**
1. The repo promises Node 20 but Phase 2 requires Node ≥22.15 — the promise is now false (S1).
2. `src/02-two-nodes.js` imports two packages that `package.json` never declares — it runs on borrowed luck (S2).
3. Two documents each claim to be *the* build plan and disagree on phase numbering from Phase 5 onward (S3), and the charter and envisioning doc number the architecture layers differently (S4). Reconcile before more phases pile onto the confusion.
4. The demo passphrase is hard-coded in source; make it an input before Phase 3 builds on this file (S5).

**Fine to defer.** Erasure coding (Phase 3 by design), the metadata/size leak from shard files, scrypt cost tuning, friendlier error messages, and assorted doc staleness — all logged below so nothing is silently dropped.

| Severity | Count |
|---|---|
| Blocker | 0 |
| Should-fix (before/at Phase 3) | 5 |
| Nice-to-have | 8 |

---

## Pass 1 — Do the docs agree with each other?

### S3 (should-fix) · Two competing phase plans
`docs/ENVISIONING.md` §E (line 195) states it **"Supersedes the prior plan"** and defines phases 0–8, inserting *Phase 5 · Mutable state & identity* and renumbering self-improvement to 6, economy to 7, and adding PQ hardening as 8. `docs/BUILD_PLAN.md` still defines phases 0–6 (self-improvement = 5, economy = 6), and `README.md` (lines 17–25) follows BUILD_PLAN. **"Phase 5" currently means two different things depending on the document.** Phase 3 is identical in both, so this doesn't block the next milestone — but from Phase 4 onward, work will be mislabeled unless one plan is made canonical (and the README follows it).

### S4 (should-fix) · Charter and envisioning doc number the layers differently
`docs/MAGNA_CARTA.md` Article 15 (lines 63–68): Layer 1 = compression, 2 = encrypted sharding, 3 = redundant distribution, 4 = P2P transport, 5 = bounded self-improvement. `docs/ENVISIONING.md` §C.1 (lines 69–81): Layer 1 = **P2P transport**, 2 = encrypted sharding, 3 = redundancy, 4 = **incentives** (a layer the charter's covenant doesn't have), 5 = self-improvement, plus new layers 6 (mutable state) and 7 (applications). `BUILD_PLAN.md`'s phase table cites "Layer 4 of the covenant" meaning P2P — the charter's numbering. Article 24 says the charter prevails; ENVISIONING should either add a mapping note or the charter should be deliberately amended (Article 25 allows it).

### N5 (nice-to-have) · ENVISIONING is stale about progress
`docs/ENVISIONING.md` line 201 marks Phase 2 "⬅ next" and line 22 says "we are two milestones in"; the README says Phase 2 is done. A one-line update keeps the "living document" claim true.

### N6 (nice-to-have) · The Technical Bible breaks its own ground rule and its arithmetic is off
- Line 3 claims "no dialogue is reproduced," yet §7.3 and §16.4 contain direct quotes.
- Episode math: batches of 20 + 20 + 14 = 54, but S05E03→series end is 13 episodes (S5 has 8, S6 has 7; series total is 53, not 54), and "S06E90" is a nonstandard label for the finale.
Neither affects the build; both dent the document's "rigorous extraction" claim.

**Checked and found consistent:** the charter's Article 23 build order matches BUILD_PLAN phases 1–5; both plans map Phase 2 to Articles 2–3; the compress-before-encrypt physics is stated identically in MAGNA_CARTA (Art. 18), BUILD_PLAN (Phase 2), ENVISIONING (§B), and TECHNICAL_BIBLE (§1.7, §16.1); nothing in the plan or code builds anything Part V forbids.

---

## Pass 2 — Does the code do what the docs claim?

### S2 (should-fix) · `02-two-nodes.js` imports undeclared packages ("phantom dependencies")
`src/02-two-nodes.js` lines 19–20 import `@helia/libp2p` and `@helia/bitswap`, but neither appears in `package.json` dependencies. They currently resolve only because they're installed as sub-dependencies of `helia`. Plain language: the script borrows tools from a box npm doesn't promise to keep open — a future `helia` update can remove or move them and Phase 1b breaks with no change to this repo. Fix: declare both explicitly (a two-line `package.json` change).

### N8 (nice-to-have) · Phase 1's "two devices" are two nodes inside one process
BUILD_PLAN's milestone allows "two windows on one machine to start," but the code is more minimal still: both "devices" live in a single Node process, and the listen address is `127.0.0.1` only (line 43) — no second machine could dial it as written. The in-file comment ("you'd just swap the address") is roughly honest; keep the README's claims calibrated ("two peers," not "two machines") until a real cross-device run happens.

### N7 (nice-to-have) · Stack drift between docs and code, unrecorded
The stack tables (BUILD_PLAN "modern stack"; ENVISIONING §D) recommend BLAKE3 addressing and libsodium (X25519 + AEAD); the code uses SHA-256 CIDs (Helia's default) and AES-256-GCM with scrypt (Node built-ins). These are reasonable, defensible choices — but no doc records the deviation or the reason (zero-dependency principle). One sentence in the README's stack section would close the gap.

**Checked and found faithful:** `00-hello.js` does exactly what Phase 0 requires. `01-content-addressing.js` demonstrates precisely the store→address→retrieve→tamper-evidence loop BUILD_PLAN describes. `03-encrypted-sharding.js` implements the full Phase 2 pipeline as specified (compress → encrypt → split → reassemble, with the three proofs and an optional real-file argument). Erasure coding ("any k of N rebuild") appears in ENVISIONING §C.2's diagram but is clearly scheduled for Phase 3 in both plans — future work, correctly labeled, not an overstatement.

---

## Pass 3 — Does it actually run? (verified live)

| Command | Result |
|---|---|
| `npm run hello` | ✓ passes |
| `npm run content` | ✗ crashed at first (`Cannot find package 'helia'`) → ✓ passes after `npm install` |
| `npm run twonodes` | ✓ passes — file crosses peer-to-peer, byte-identical |
| `npm run shard` | ✓ all three proofs pass |
| `node src/03-encrypted-sharding.js README.md` | ✓ all three proofs pass on a real file |
| `node src/03-encrypted-sharding.js does-not-exist.txt` | ✗ raw 20-line stack trace (see N4) |

**Observation (not a bug):** the working copy had no `node_modules` at review time, so every dependency-using script was in a can't-run state until `npm install` — which is README step 1, so a fresh clone recovers by following the docs. Worth knowing that "it worked when committed" and "it runs right now" are different states.

### S1 (should-fix) · The repo's Node version promise is false as of Phase 2
`package.json` line 14 declares `"node": ">=20"`; `README.md` line 29 says "Node.js 20 or newer." But `src/03-encrypted-sharding.js` uses `zlib.zstdCompressSync`/`zstdDecompressSync`, which **do not exist before Node v22.15 / v23.8** (zstd support landed in v23.8.0, backported to v22.15.0). On Node 20 or 21 — versions the repo explicitly claims to support — `npm run shard` throws `TypeError: zlib.zstdCompressSync is not a function`. It passes here only because this machine runs v24.14. Fix: raise `engines` to `>=22.15` (or `>=24`) and update the README line. *Honesty note: this regression arrived with the Phase 2 commit itself.*

### N4 (nice-to-have) · Unfriendly failure on a missing file argument
A wrong path produces a raw `ENOENT` stack trace. Handled (the script doesn't pretend to succeed), but a one-line "File not found: <path>" would fit the project's teach-as-you-go voice.

---

## Pass 4 — Health, safety, and honesty

**Magna Carta Part V: no violations found.** No code weakens, bypasses, or breaks encryption (Article 18); nothing self-modifies or self-optimizes — no such layer exists yet; the off-ramp requirement doesn't yet apply to run-and-exit scripts. Article 3's "no single device holds a readable or complete copy" is not yet literally true (all five shards sit in one folder on one disk), and Article 4's resilience is not yet built — both are exactly what Phases 3–4 are scheduled to deliver, and no doc claims otherwise.

### S5 (should-fix) · Hard-coded passphrase
`src/03-encrypted-sharding.js` line 49: `const PASSPHRASE = "correct-horse-battery-staple"`. The comment honestly labels it demo-only, but two real consequences: (1) anyone who can read the repo can decrypt any shards this script ever produced; (2) Phase 3 will build distribution on top of this file, and a hard-coded secret has a way of surviving into "temporary" production. Make it a prompt or environment variable before shards ever leave one machine. Why it matters in plain language: the lock is strong, but the key is taped to the door.

### N1 (important to internalize, deferred by design) · Today's sharder *reduces* survivability
A contiguous 5-way split means losing **any one** shard file loses the entire file: one point of failure has become five. This is the opposite of Article 4 — *until* Phase 3's erasure coding ("any k of N rebuild") flips it. The docs schedule this correctly; the practical rule until then: **do not store anything real with the current script.**

### N2 (nice-to-have) · Proof (a) is a demonstration, not a proof — and shard sizes leak
The "lone shard rejected" test shows `decrypt()` throws on shard-0, which is mostly AES-GCM's authentication check failing on truncated input. The actual security argument — a shard is ciphertext, unreadable without the key — rests on AES-256-GCM itself, not on that one failed call. Separately, shard file sizes reveal the approximate size of the original (a metadata leak of the kind Article 8 says to minimize). Both are acceptable at this phase; a code comment would keep future-you from over-trusting the test.

### N3 (nice-to-have) · scrypt cost at library default
`deriveKey` uses Node's default scrypt parameters (N=16384, r=8, p=1) — on the low side of current guidance for passphrase-derived keys. Fine while the passphrase is a demo constant; raise the cost when passphrases become real user input.

**Overstatement check.** README's claims are accurate for what exists, with one calibration point: the project description ("data … across ordinary devices … readable by no one else") describes the destination, not the current repo — normal for a project README, and the phase table right below it is honest about status. ENVISIONING's present-tense external claims (iroh v1.0 in June 2026, Storj 80/29 parameters, Automerge 3.0 memory gains, etc.) are attributed but were not independently verified in this review; the doc itself sensibly says to treat them as a 2026 snapshot to re-check.

---

## Suggested order of fixes

1. **S1** — `engines` + README Node version (2-line fix; the repo's promise is currently false).
2. **S2** — declare `@helia/libp2p` and `@helia/bitswap` (2-line fix; removes a silent time bomb).
3. **S3 + S4** — decide the canonical plan and layer numbering; update BUILD_PLAN/README or ENVISIONING accordingly (charter prevails per Article 24 unless amended).
4. **S5** — passphrase becomes input, no later than the start of Phase 3.
5. Nice-to-haves as they annoy you; none block Phase 3.

*This review changed no code and no existing documents; it only added this file.*
