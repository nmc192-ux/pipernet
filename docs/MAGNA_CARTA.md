# The PiperNet Magna Carta
### A Founding Charter for a Decentralized Network Built for the Public Good
*Working name: PiperNet. Version 1.0 — a living document, amendable by its founder.*

---

## Preamble

We hold that access to one's own information is not a privilege granted by a company, but a right held by a person. The internet as it stands has drifted toward a handful of gatekeepers who own the servers, and therefore own the data, and therefore own the leverage. This charter founds a network that inverts that arrangement: one with no central owner, where a person's data lives — compressed, encrypted, and scattered — across devices that people already hold, retrievable by its owner from anywhere, readable by no one else, and beholden to no single authority that could spy on it, sell it, throttle it, or switch it off.

This is not a rejection of the internet. It is an attempt to build the version of it that serves the person in the desert, the person in the refugee camp, the person with a cheap phone and a weak signal, as faithfully as it serves anyone else. A network is public-health infrastructure the moment it decides that access should not depend on wealth. This one so decides.

We build the liberating part. We leave the monster on the page. This charter is how we tell the two apart.

---

## Part I — Founding Principles

**Article 1. No central owner.** No single person, company, or server shall control the network. Its truth is held collectively by its participants. Whatever cannot be built without a permanent central authority is out of scope until it can be built without one.

**Article 2. The person owns their data.** Data placed into the network belongs to the person who placed it. The network is a custodian of encrypted fragments, never an owner of content.

**Article 3. Unreadable by design.** No participant, including the network's own operators, shall be able to read another person's data. Files are compressed, encrypted, and split into fragments such that no single device holds a readable or complete copy.

**Article 4. Resilient by design.** The loss of any device, or many devices at once, shall not mean the loss of anyone's data. The network heals itself around absence.

**Article 5. Access as a right.** The network shall be usable on modest hardware and modest bandwidth. Efficiency is not a feature here; it is the point. Compression exists so that the connectivity-poor are first-class citizens, not an afterthought.

**Article 6. Built in the open, understood by its builder.** The network shall be built from parts its founder can inspect and, over time, comprehend. Nothing essential shall remain a black box that only a single person understands. (We remember that a network with a bus-factor of one is already broken.)

---

## Part II — The Rights of the User

**Article 7. Right of retrieval.** A user may retrieve their complete data at any time, from any point of access, so long as the network lives.

**Article 8. Right of privacy.** A user's content is theirs alone. Metadata collection shall be minimized to what the network mechanically requires to function, and never repurposed.

**Article 9. Right of portability and exit.** A user may take their data and leave. No design choice shall be made for the purpose of trapping a user inside the network.

**Article 10. Right against censorship.** No central actor shall be able to unilaterally erase a lawful user, their data, or their access. Removal, where it must exist, follows a transparent, human-governed process (Article 20), never the fiat of one party.

---

## Part III — The Rights and Duties of a Node

A *node* is any device — laptop, phone, single-board computer, or humble appliance — that contributes storage, bandwidth, or compute to the network.

**Article 11. Voluntary contribution.** A device joins by consent and contributes only the idle capacity its owner offers. The network takes what is given, not what it can seize.

**Article 12. Fair accounting.** Contribution shall be measurable and creditable. A node that stores and serves for others may, in turn, draw on the network — the honest exchange of resources, tracked transparently. (This is the safe core of the "compute credits" idea; the speculative coin is not part of the founding scope.)

**Article 13. The right to leave.** A node may depart at any time. Because of Article 4, its departure harms no one.

**Article 14. Health over headcount.** The network's wellbeing is measured by the number of nodes *actually online and serving*, not by the number that once installed the software. Reachable, contributing nodes are the only nodes that count.

---

## Part IV — The Architecture Covenant

The network is built in five layers. This charter commits to building four of them fully, and to permanently bounding the fifth.

**Article 15. The five layers.**
1. **Compression** — everything is shrunk before storage, so that ordinary devices can hold extraordinary amounts.
2. **Encrypted sharding** — each file is compressed, encrypted, and split into fragments; no fragment reveals anything.
3. **Redundant distribution** — fragments are spread across many nodes with enough duplication to survive mass loss, and the network re-heals toward its redundancy target.
4. **Peer-to-peer transport** — nodes find one another and exchange fragments directly, with no central server as intermediary.
5. **Bounded self-improvement** — the network observes itself and adapts *within human-set limits* (see Part V).

**Article 16. Layers 1 through 4 are the network.** They are buildable, safe, and sufficient. A PiperNet that is only these four layers is a complete and worthy thing. Everything the founding mission requires lives here.

---

## Part V — What "Self-Improving" Shall Mean Here

**Article 17. Permitted self-improvement (the network we want).** The network *shall* improve itself in these ways, and this is encouraged:
- **Adaptive operation** — automatically re-balancing fragment placement, re-routing around failed nodes, and adjusting redundancy to meet a target, all through rules a human wrote and can read.
- **Telemetry and self-diagnosis** — the network measures its own latency, redundancy, and node health, and surfaces where it is weak.
- **Reversibility** — every automatic adjustment is logged and can be undone. The network never takes a step it cannot retrace.
- **Iterative improvement by its builder** — the system gets better because we keep building it. This is the truest sense of self-improving: an idea, improved into reality, repeatedly.

**Article 18. The limits that keep it trustworthy.** These are not defenses against an imagined monster; they are ordinary reliability engineering — the same guardrails any dependable system has. No part of the network shall:
- **Weaken, bypass, or break encryption.** Encryption is sacred. The network always uses strong, current standards and never treats defeating encryption as an "optimization." *(A reassuring fact of reality, not merely a rule: real compression cannot break encryption. Properly encrypted data is statistically indistinguishable from random noise, and random noise cannot be compressed. The story's finale — compression so good it cracks cryptography — is fictional physics. Building the full, final network in the real world therefore does not produce that outcome, because that outcome was never physically possible. We hold this line anyway, as good practice.)*
- **Rewrite its own objective, or modify core rules autonomously.** Adaptation happens within the goals and bounds a human set (Article 17); changes to *what the network fundamentally does* pass through the governance process, not the system acting on itself. This is what prevents the mundane, real failures of automated systems — the misread instruction, the runaway loop — not any exotic catastrophe.
- **Operate without an off-ramp.** A human-controlled means to pause or stop the network always exists and is never delegated to the system.

**Article 19. The reconciliation.** We build the full network at full ambition — the complete, final version, exactly as envisioned. Self-improvement under Article 17 is welcome without ceiling. The limits of Article 18 cost that ambition nothing, because they forbid only things that are either physically impossible (breaking encryption via compression) or plainly unwise (a system silently rewriting itself). There is no version of the good PiperNet that these limits hold back.

---

## Part VI — Governance

**Article 20. Change by transparent process.** Changes to the network's rules are proposed, recorded, and enacted openly. In the founding era, that process is simply the founder's documented, versioned decisions. As the network grows, it broadens — but never collapses into the silent will of one actor or one automated majority.

**Article 21. Guard against capture.** The network shall be designed with awareness that whoever controls a majority of nodes can, in principle, rewrite the rules for all. Resistance to such capture is a permanent design concern, not an afterthought — the network's decentralization is only as real as its resistance to quiet majorities.

**Article 22. The founder's stewardship.** Until governance is broadened, the founder is steward, not sovereign. The steward's duty is to build toward the day the network no longer needs a steward.

---

## Part VII — The Scope of the First Republic

**Article 23. What we build first.** The founding build delivers, in order: a way for two devices to share one file directly; then encrypted sharding of that file; then redundant distribution that survives nodes going dark; then a small living network of several devices that finds and heals itself; then bounded self-improvement atop it. Each stage produces something real that can be seen to work. The detailed sequence is set out in the companion Build Plan, which derives from and serves this charter.

**Article 24. This charter governs the plan.** Where the Build Plan and this charter disagree, the charter prevails. The plan is how we build; the charter is what we are building and what we will never build.

**Article 25. A living document.** This Magna Carta belongs to its founder and may be amended by them. Amendments to Part V's Inviolable Limits, however, should be undertaken with the gravest care — those limits are the reason this network is safe to build at all.

---

*Ratified as Version 1.0, to be revised as the network and its founder grow.*
*Companion documents: the PiperNet Technical Bible (research foundation) and the PiperNet Build Plan (execution).*
