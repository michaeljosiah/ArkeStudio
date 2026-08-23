# ADR-002: Ownership is a fact about a revision, not about a process

**Status:** Proposed
**Date:** 2026-08-23
**Related:** [SPEC-002](../specifications/002.the-world-on-disk.md) (the world on disk, R-3, R-15, R-24, R-27) · [SPEC-004](../specifications/004.the-accept-gate.md) (proposals carry a base) · [SPEC-025](../specifications/025.the-host-ports.md) §2.9 (what it deliberately left broken) · [ADR-001](001-one-gate-per-thing.md) (the engine takes no dependency on a host)

## Context

**A world is owned by one process at a time** (SPEC-002 R-3). A `world.lock` file records a pid
and a start time, a heartbeat refreshes it every 20 seconds, and a lock that names a dead pid or
has gone cold for 90 seconds is reclaimed — because the alternative is a user locked out of their
own work by a crash.

That is correct, cheap, and exactly right for a desktop application where the world is a folder on
the user's own disk.

It does not survive the product going to the web. A family product is multi-client by definition —
a parent approving on a phone while a child draws on a tablet — and a pid is a fact about one
machine. `process.kill(pid, 0)` cannot answer a question about a process somewhere else. SPEC-025
§2.9 saw this coming and deferred it:

> *"A hosted application binding several people to one world must still route them through one
> coordinator instance, and the lock becomes a lease on that instance rather than a file on a disk.
> That is a real piece of work and it is not this one."*

It read as a large piece of work because the lock reads as the thing that keeps a world correct.
It is not, and the code already says so.

## What is already true

Every mutation to a world goes through **one commit primitive** (SPEC-002 §2.5 D1,
`packages/coordinator/src/world/commit.ts`). It is a journalled transaction — `prepared`,
`committing`, `done` — that rolls back or rolls forward on recovery (R-15). Three properties of it
matter here, and all three are already built, tested, and in the hot path:

| | What it does | Where |
|---|---|---|
| **Compare-and-swap** | Every target carries `baseHash`, the hash of the content the change was drafted against. A commit verifies it and refuses when it has moved. | R-27, `CommitStaleError` |
| **Idempotent commits** | The change log carries a client-chosen `commitId`, and `hasCommitLine()` makes a retry a no-op rather than a double-apply. | §2.8 |
| **Content addressing** | Takes are immutable and addressed by id; the reference *is* the version. | §2.7 |

Compare-and-swap, idempotent commits, content addressing. Those are the three things a store needs
before more than one writer can safely touch it, and Arke has had all three since SPEC-002 — built
for proposals that go stale while a human thinks, which is the same problem at a different
timescale.

The refusal even uses the vocabulary this decision needs:

> `commit refused: base moved for … — staleness is detected, never merged`

## Decision

**Ownership is a property of a revision, not of a process.** A writer does not ask *"may I write?"*
It writes what it drafted, says what it drafted against, and the store decides.

1. **`commit.ts` is the correctness mechanism and does not change.** Nothing below weakens R-27; it
   is what everything else leans on.

2. **The lock is reclassified as an optimisation.** It makes conflicts *rare*. It never made them
   *safe* — R-27 did. A deployment may therefore run without it, and R-3 stops being a property of
   the format and becomes a property of a deployment.

3. **Local keeps the lock file, unchanged.** One user, one machine, one folder: it is the cheapest
   possible answer and it gives a good error instead of a silent race between two Electron windows.

4. **Hosted replaces it with a lease** held by a coordinator instance, identified by an **opaque
   per-run id** — never a hostname, a machine id, or anything else R-24 forbids from a world file.
   The heartbeat already exists; only the identity and the liveness test change.

5. **A world gains a head** — a monotonic sequence and the hash of the last commit — so *"has
   anything moved?"* is one question instead of one per file. Per-file `baseHash` stays as the
   thing that decides; the head is what makes asking cheap over a network.

6. **Divergence is reported, never merged.** Unchanged from §2.9, and now load-bearing rather than
   incidental.

### The lease does not need fencing, because the base hash is the fence

The standard objection to replacing a lock with a time-based lease is split-brain: a lease expires,
a new owner takes it, and the old owner — merely slow, not dead — completes a write it began
before it was deposed. Locks do not solve this; that is why distributed systems reach for fencing
tokens.

Arke does not need one. **A deposed writer's write is stale by construction**: whatever it drafted
against has since been committed by the new owner, so `baseHash` no longer matches and R-27 refuses
it. The fencing token is the content hash, it is per-file rather than per-lease, and it was already
there.

This is the whole reason this decision is small.

## Consequences

**A guard becomes a load-bearing path.** Today the lock is so effective that R-27 almost never
fires — it exists for proposals that went stale while a human deliberated, which is rare and slow.
Under this decision it is the thing standing between two writers and a lost edit, at machine speed.
It needs tests that exercise genuine concurrency, which it does not have; the current ones exercise
a stale proposal, not a race.

**A head is new state that can lie.** A world-level sequence and hash is precisely the kind of
stored summary this codebase refuses elsewhere — SPEC-026 R-8 derives the book rather than storing
it, R-3 derives spreads rather than pairing them. It is justified here only because a network round
trip per file is not viable, and it is safe only if the journalled commit writes it, in the same
transaction, as the evidence a commit completed. A head written anywhere else becomes a second
source of truth about what a world contains.

**Binaries are still unsolved.** Takes are large, immutable and content-addressed, which makes them
the *tractable* part of a sync — negotiate hashes, transfer what is missing — but nothing here
designs that, and a family product moves a lot of pixels. This decision covers the authored record.

**The desktop gains nothing today.** Local behaviour is unchanged by design. This is groundwork,
and it should be judged as groundwork: it is worth landing before the page medium, the drawing
operations and hands-free voice are built on top of a store whose ownership model would have had to
change underneath them.

## On Aonik, and why this is not a dependency

Aonik's Workspaces capability models the same shape independently: revisions carrying a
`ParentRevisionId` and a monotonic `Sequence`, a client-chosen `CommitId` for idempotency, commits
resolving to `FastForward | Diverged | Replayed`, and divergence ended by a human as
`Accept | Reject` — where accepting *"advances the head through a new revision parented on the
current head — never by rewriting history."* Its manifests are complete rather than deltas, for the
stated reason that a delta requires trusting a client's account of what changed.

That is the same design, arrived at separately, which is good evidence it is the right one. Aligning
the vocabulary costs nothing and makes a future host's job small.

**Two cautions.** The engine takes no dependency on Aonik, at build time or run time (ADR-001,
SPEC-025 §2.11) — the AGPL promise depends on that, and this decision must not become the exception.
And Workspaces **is not landed**: it exists in an unmerged Aonik worktree, absent from that
repository's `main`. It is a design to align with, not an API to call.

## What this does not decide

- **How a lease is granted or renewed** over a network, and by whom. That is SPEC-025's
  `IdentityProvider` territory and wants its own spec.
- **Blob sync** for takes and other media.
- **Whether divergence can be resolved in-app**, or only reported. §2.9 currently says report;
  Aonik's `DivergenceResolution` suggests a third tree is the honest answer, and SPEC-026 §2.12's
  compare surface is the same surface again.
- **Any change to the accept gate.** A proposal is still gated; this is about what happens
  underneath one when it lands.
