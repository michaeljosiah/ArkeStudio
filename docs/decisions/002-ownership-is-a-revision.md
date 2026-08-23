# ADR-002: Ownership moves from the format to the deployment — and what that actually costs

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

## What the engine actually has

An earlier draft of this ADR claimed the engine was already most of the way there, and was wrong
about four of the five things it counted — each time in the direction of making this decision look
smaller than it is. The corrected inventory matters more than the argument
it was supporting, so it goes first.

| Claimed | Actually |
|---|---|
| Compare-and-swap on every write | **A check, not a swap.** `commit()` verifies base hashes, then stages asynchronously, and `rollForward()` renames the live files later. The window between check and rename is wide, and the code names its own precondition: *"verify bases under the lock (R-27)"*. |
| Client-chosen `commitId`, so retries are idempotent | **Server-generated.** `commit.ts` does `newId("cm")` per invocation. `hasCommitLine()` deduplicates roll-forward of *that same journal* — crash recovery, not a client replaying a lost response. |
| Takes are content-addressed | **ULID-addressed.** `TakeIdSchema` is `tk_<ULID>`; a take stores a media *filename*, not a digest. Identical bytes get different addresses. |
| One journalled commit primitive, crash-safe | **True.** `prepared → committing → done`, rolling back or forward on recovery (R-15). |
| Every mutation goes through it | **No.** `WorldStore.ownedWrite()` is *"one app-owned filesystem write outside the commit/proposal machinery"* — take media landing, reference images copied and removed. It serialises in-process, which is a lock's job, not a fence's. |

One thing the earlier draft under-credited: `world.json` already carries `canonRevision`, a
monotonic world-level counter, and `rollForward()` writes world.json **last**, commenting that
*"its revision advancing is the world-level signal the commit landed."* A world-level head is
therefore less novel than it looked — but see the consequences, because it is not yet the thing a
remote client could ask one question of.

## The argument that does not work

The earlier draft claimed a lease needs no fencing token, because a deposed writer's write would be
stale by construction: its successor would have committed, so the base hash would no longer match
and R-27 would refuse it.

**That is false, for two independent reasons.**

**A successor need not touch the same files.** It may take the lease and commit nothing, or commit
a different entity entirely. Every base the deposed writer targeted is then unchanged, R-27 passes,
and a coordinator that lost ownership writes anyway. The base hash fences a writer only against
whoever happened to overwrite the same paths — which is not a fence, it is a coincidence.

**And the check is not atomic with the write.** Even where the successor *does* touch the same
files, both commits can read the same base, both pass verification, and both proceed to rename.
Time-of-check to time-of-use. Under the lock this cannot arise, which is precisely why the lock is
load-bearing today.

So R-27 is not a concurrency primitive. It is a staleness check for proposals that went cold while
a human deliberated, and it is correct for that, and it was written for that.

## Decision

**Ownership becomes a property of the deployment rather than of the format — and the single-writer
guarantee is retained, not replaced.**

1. **Every path that mutates a world is fenced**, not only the committer. R-27 stays exactly as it
   is: a staleness check, defence in depth, explicitly *not* the thing that makes concurrent
   writers safe.
   - `commit.ts` is the sole path for **authored records**. It is not the sole path for the world.
     `WorldStore.ownedWrite()` exists, in its own words, as *"one app-owned filesystem write
     outside the commit/proposal machinery"* — take media landing from a job, reference images
     copied and removed. It serialises within one process, which is sufficient under a lock and
     nothing at all across two.
   - A fence that covers only the committer would leave a deposed coordinator landing take media
     into a world it no longer owns.

2. **Serialization is preserved.** Exactly one writer holds a world at a time in every deployment.
   What changes is how that writer is identified and how its liveness is established, not whether
   it is alone. This is what SPEC-025 §2.9 said originally, and it was right.

3. **Local keeps the lock file, unchanged.** One machine can answer whether a pid is alive, and a
   clear error beats a silent race between two Electron windows.

4. **Hosted takes a lease** held by a coordinator instance under an opaque per-run id — never a
   machine identifier (R-24). The heartbeat already exists; the identity and the liveness test
   change.

5. **A mutation is fenced, and this ADR does not say how.** The requirement is stated below; the
   mechanism is deliberately left to a spec, because three candidates have now been proposed here
   and refuted here (§*Three fences that do not hold*).

   **The requirement.** Deciding that ownership is current and claiming the write SHALL be a single
   indivisible operation *in one store*. Any design that establishes ownership in one system and
   writes in another leaves a window, and every mechanism below died in that window.

6. **Divergence is reported, never merged.** Unchanged from §2.9, and this remains true whatever
   the mechanism.

## Three fences that do not hold

Each of these was proposed in an earlier revision of this document and refuted in review. They are
recorded because the next person to pick this up will think of them in roughly this order.

**1. The base hash is the fence.** *Refuted:* a successor may take ownership and commit nothing, or
commit elsewhere, leaving every base the deposed writer targeted unchanged. R-27 passes and a
writer that lost ownership writes anyway. The base hash fences against whoever overwrote the same
paths, which is a coincidence rather than a guarantee.

**2. An exclusive-create at the moment of the rename.** *Refuted:* exclusivity tests **path
absence**, not whether the creator still owns the lease. It serialises whoever is contending at
that instant and proves nothing about currency, so an expired holder that gets there first still
wins — the same failure as (1), reintroduced by the mechanism meant to fix it.

**3. An exclusive-create carrying a lease epoch.** *Refuted:* where the lease authority and the
filesystem are separate stores, an epoch in the payload is data, not a check. If the epoch-N holder
expires but creates its claim before the epoch-N+1 holder records the takeover, the create still
succeeds, because nothing at claim time compares N against the current lease.

The common thread is that **mutual exclusion is not fencing**, and that a fence spanning two stores
is not atomic however it is dressed. A mechanism that works will either make the storage itself the
lease authority, or use a storage primitive that conditions the write on the epoch it is given.
That is a spec, and it wants someone who will test it rather than reason about it — this document
has now reasoned about it wrongly three times.

## Consequences

**This is a real piece of work, as §2.9 said.** The earlier draft's claim that it was nearly free
rested on the fencing argument above, which does not hold. The honest scope:

- **A fence, on every mutation path.** Covering `ownedWrite()` as well as the committer, and
  satisfying the atomicity requirement above rather than approximating it. This is the substance of
  the work, none of it exists today, and this ADR no longer claims to know its shape.
- **Client-supplied `commitId`.** Required before any claim about retry idempotency is true. A
  client whose success response is lost must be able to replay and be told *"already done"* —
  today it would generate a second id and either duplicate or spuriously fail.
- **Blob negotiation needs less than it looked.** `scanWorld()` already streams every media file
  through SHA-256 and returns a path-to-digest `mediaManifest`, which is enough for a peer to
  answer *"which of these hashes are you missing"* without touching take identity. Content
  addressing as *identity* would deduplicate identical bytes and make a take's reference its
  version; that is a separate benefit, not a prerequisite. An earlier draft of this ADR claimed the
  reverse.
- **Wherever ownership state lands, it is a format change.** An epoch, a claim record, a head —
  any of them is new on-disk state with no location, no initialisation or migration rule, and no
  schema-version boundary today, and `WorldMetaSchema` is `.strict()`, so adding fields to
  `world.json` makes it unreadable to every existing build. A separate claim file avoids that and
  needs its own format and its own place in R-2's scan. None of this is decided here.
- **A specified head.** Item 5's fence and any cheap *"has anything moved?"* both want a world-level
  revision a remote client can name. `canonRevision` is close but advances only for canon, and
  `WorldMetaSchema` is `.strict()` — adding fields to `world.json` makes the file unreadable to
  every existing build. It needs an acceptance criterion in SPEC-002, a format location, an
  initialisation and migration rule, and a schema-version bump. It does not belong in an ADR bullet,
  and this ADR no longer pretends otherwise.

**What is genuinely cheaper than it looks** is only this: the *shape* of the change. Nothing above
forks the commit primitive, changes the accept gate, or asks the format to support two writers at
once. One writer at a time remains true in every deployment; the question is only how that writer
is chosen and how a stale one is stopped.

**The desktop gains nothing today.** Local behaviour is unchanged by design. This is groundwork,
and should be judged as groundwork.

## On Aonik, and why this is not a dependency

Aonik's Workspaces capability models the same problem independently: revisions carrying a
`ParentRevisionId` and a monotonic `Sequence`, a **client-chosen** `CommitId` for idempotency,
commits resolving to `FastForward | Diverged | Replayed`, complete manifests rather than deltas,
and divergence ended by a human as `Accept | Reject` — where accepting *"advances the head through
a new revision parented on the current head — never by rewriting history."*

Two of the prerequisites listed above are things Aonik already got right and Arke has not: the
client-chosen commit id, and content addressing. That is worth reading as evidence about which
parts are load-bearing, rather than as an integration plan.

**Two cautions.** The engine takes no dependency on Aonik, at build time or run time (ADR-001,
SPEC-025 §2.11) — the AGPL promise depends on that. And Workspaces **is not landed**: it exists in
an unmerged Aonik worktree, absent from that repository's `main`. A design to align with, not an
API to call.

## What this does not decide

- **How the atomic fence is implemented**, which is the actual work and wants its own spec.
- **How a lease is granted or renewed** over a network, and by whom. **Not** `IdentityProvider`:
  SPEC-025 R-4 and §2.2 define that port as resolving the current human actor and their
  capabilities, while a lease is about which coordinator *instance* owns a world — it must stay
  valid across a change of actor, and while no actor is present at all. Conflating the two would
  make ownership depend on who is signed in. It wants its own port, or its own spec.
- **Blob sync.** `scanWorld()`'s path-to-digest manifest is enough to negotiate against; what a
  transfer protocol looks like is open. Content addressing as take *identity* is not required for
  it, per the consequences above.
- **Whether divergence can be resolved in-app**, or only reported.
- **Any change to the accept gate.** A proposal is still gated; this is about what happens
  underneath one when it lands.
