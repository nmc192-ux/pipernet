# PiperNet

*A decentralized network for the public good — building the "new internet" as a sequence of real, working steps.*

PiperNet stores a person's data — compressed, encrypted, and split into fragments — across ordinary devices that people already hold, retrievable by its owner from anywhere and readable by no one else. No central server owns it, spies on it, or can switch it off.

This repository is built by a first-time coder, one working milestone at a time. Every step produces something you can run and see.

## The three founding documents (`docs/`)

- **`MAGNA_CARTA.md`** — what we are building and the principles that govern it. The charter.
- **`BUILD_PLAN.md`** — how we build it, phase by phase, on a modern stack.
- **`TECHNICAL_BIBLE.md`** — the research foundation (extracted from the source material that inspired the project).

## The build, in phases

| Phase | Goal | Status |
|-------|------|--------|
| 0 | Foundations: environment, git, first script | ✅ done |
| 1 | One file, two devices — content-addressed storage and retrieval | ✅ done |
| 2 | Encrypted sharding | ⬜ next |
| 3 | Redundancy & self-healing | ⬜ |
| 4 | A living multi-device network | ⬜ |
| 5 | Bounded self-improvement | ⬜ |
| 6 | Contribution economy (optional) | ⬜ |

## Running the code on your machine

You need **Node.js 20 or newer** (check with `node --version`).

```bash
# 1. Install dependencies (only needed once)
npm install

# 2. Phase 0 — prove your setup works
npm run hello

# 3. Phase 1a — content addressing: store data, get its address, retrieve it
npm run content

# 4. Phase 1b — two nodes, one file: a file crosses between two peers with no server
npm run twonodes
```

Each script prints what it's doing as it goes, so you can watch the idea become real.

## The stack

- **Transport:** Helia + js-libp2p (JavaScript IPFS) — chosen for approachability. Iroh is our option for robust phone-to-phone connections later.
- **Content addressing:** every piece of data is named by a hash of its contents, so you always get back exactly what you stored.
- **Language:** JavaScript (Node.js).

See `docs/BUILD_PLAN.md` → "The modern stack" for why each piece was chosen.

## Pushing this repo to your own GitHub

This repository already has its full commit history. To put it on *your* GitHub
account and push future work, you sign in as yourself (only you can do that):

```bash
# 1. Create an empty repo on github.com (no README/license — this repo has them).
#    Say it gives you a URL like: https://github.com/YOUR-USERNAME/pipernet.git

# 2. From inside this project folder, point it at your new repo and push:
git remote add origin https://github.com/YOUR-USERNAME/pipernet.git
git branch -M main
git push -u origin main
```

From then on, the loop for every new piece of work is:

```bash
git add -A
git commit -m "Describe what you built"
git push
```

## License

MIT — see `LICENSE`.
