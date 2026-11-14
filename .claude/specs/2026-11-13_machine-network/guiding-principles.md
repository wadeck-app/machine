# Guiding Principles -- Machine Network

Any option that conflicts with a principle must be raised as an open question, never silently accepted.

### P-1: Security first, minimal attack surface
Every feature is weighed against the attack surface it adds; deny by default.
**Why:** User request: the network "must be very secure"; this design exposes personal machines, including a work laptop.

### P-2: Fail loudly, actionable errors
No silent fallback; every error names the cause and the fix.
**Why:** User CLAUDE.md (UX/DX first; silent fallbacks caused past incidents).

### P-3: Reuse sibling patterns
Follow task/queue/orch/project conventions (stack, daemon, CLI UX, plugin model) unless a documented reason says otherwise.
**Why:** User request.

### P-4: Home-scale network
Design for a handful of machines owned by one person.
**Why:** User request: "not hundreds of machines".

### P-5: Only the human administers the policy
Allowing, blocking and limiting commands is done by the human; agents, peers and the relay can never approve, widen or create rights.
**Why:** User requirement; agents run as the same OS user and can read daemon tokens ([V] `health_token` files are readable), so a local channel alone proves nothing.
**Scope:** protects against agents (including prompt-injected ones) and remote peers; it does not claim to stop malware already running as the user, which has the user's OS rights anyway.

### P-7: Test first, every layer testable in isolation
All code is written test first (TDD); each capability (signing, handshake, allowlist, policy, enrollment) is a library function with unit tests, and the daemon, the CLI and the admin page are thin front-ends over it.
**Why:** User: "everything must be TDD"; the CLI path of the admin unlock exists mainly to test the signing core without a browser (decision 36).

### P-6: No master machine
All machines are symmetric: any of them can administer, none is required for the others to work; the only central element is the relay, which is an untrusted transport.
**Why:** User: the admin key on every machine "makes the machines agnostic, without a master" (decision 23). Consequence: signed documents must tolerate concurrent edits from different machines (decision 27).
