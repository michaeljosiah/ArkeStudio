# ADR-001: One gate per thing — the approval boundary between the engine and its host

**Status:** Proposed
**Date:** 2026-08-22
**Related:** [SPEC-004](../specifications/004.the-accept-gate.md) (the accept gate) · [SPEC-013](../specifications/013.takes-cut-audio-exports.md) (take review) · [SPEC-014](../specifications/014.activity-needs-you-and-spend.md) (the needs-you queue) · [SPEC-025](../specifications/025.the-host-ports.md) (the host ports) · master specification §3.1 (the mutation matrix)

## Context

Arke Studio's central mechanic is that **nothing enters the authored record without a human
accept**. Proposals are drafted, ripple-checked and wait; generated takes land immutable and a
human decides which is used. Master §0.1 calls this the first of the three mechanics that carry the
product, and SPEC-014 makes the resulting queue *computed* — a thing appears there because its
state says it is waiting on a person, never because a feature remembered to add it.

A hosted application built on the engine will sit on a platform that has independently arrived at
the same principle. Where the engine gates *facts and takes*, such a platform gates *agent
actions*: a tool that would mutate state is wrapped so that a human or a policy approves it before
it runs. The wording is nearly identical to our own — agents propose, systems apply, humans stay in
control.

Two correct implementations of one principle, in two systems, under one product.

There is a third. A platform that generates content for children will also hold content for a
guardian to see before a child does — not because an agent asked to mutate something, and not
because a take needs choosing, but because a safety check said so. That is a third thing that can
make a parent's screen say *"waiting for you."*

**The failure this invites is not a crash.** It is the product working, badly, in one of two ways:

- **Asked twice.** A parent approves page 4 in one queue and is asked about page 4 again in the
  other. Two lists that nearly agree is worse than one list, because a person cannot tell which one
  is the real one, and stops trusting both.
- **Asked by nobody.** Each system's design assumes the other one asked. Something reaches the
  child that no adult saw. This is the exact failure the whole product exists to prevent, and it
  arrives through diligence rather than neglect — two teams each building a careful gate.

The naïve resolutions both fail. *"Route everything through the engine's gate"* requires the engine
to learn about payments, invitations and publishing — the concerns master §0.3 keeps out of it, and
which SPEC-025 was written specifically to keep out. *"Route everything through the platform's"*
requires the platform to open a world file and understand what a canon entry is, breaking the seam
its own architecture depends on.

## Decision

**A thing passes through exactly one gate, chosen by what is being decided, not by which system
happens to hold the object.**

| What is being decided | Gate | Why it belongs there |
|---|---|---|
| Words, pictures, pages, characters, facts about the world — anything a family sees or keeps | **The engine's** | The engine is the only thing that knows what a sheet, a canon entry or a take *is*. A gate that cannot read the object cannot judge it. |
| Money, plan changes, publishing, invitations, anything reaching outside the family | **The host's** | The engine has no concept of any of these, and SPEC-025 exists to keep it that way. |

And one rule that makes the split hold:

**A safety hold is not a third queue.** When a host's content check holds something rather than
refusing it, that hold arrives as a **held take in the engine's review queue**, carrying the reason
it was held. It does not open a queue of its own. SPEC-025 R-13 and R-14 already specify this
shape; this ADR fixes it as the general rule rather than a detail of one port.

The consequence a user can see: **one list, one count, one place where things wait.**

## Consequences

**What gets better.** A parent has a single "waiting for you" queue, and every item in it came from
exactly one place. SPEC-014's rule that the queue is computed extends across the boundary rather
than competing with something on the other side of it. Neither system needs to know what the other
one is holding, because neither of them is holding the same thing.

**What gets harder.** Every new held-thing has to be classified before it is built, and the answer
is not always obvious. A printed book is content the family keeps *and* money leaving the account.
The rule resolves it — the pages go through the engine's gate, the order goes through the host's —
but only if somebody applies the rule while designing the flow rather than after. A misfiled hold
will not fail loudly; it will just make one of the two queues quietly wrong.

**What this does not settle.** The engine's gate and the host's gate remain separate mechanisms
with separate storage, and nothing here merges them. A single screen showing both is a client-side
composition over two sources, and building that screen is where the classification above stops
being theoretical.

**What would reopen this.** A host whose approval mechanism can carry a payload the engine
understands, or an engine that grows a concept of an account. Neither is on the table, and both
would be larger decisions than this one.

## The rule, in one line

*If a family will look at it, the engine gates it. If it touches money or the outside world, the
host does. Nothing is gated twice, and a safety hold joins the engine's queue rather than starting
another.*
