# ADR-003: Child mode is a capability subset and one thing capability cannot express

**Status:** Proposed
**Date:** 2026-08-23
**Related:** [SPEC-025](../specifications/025.the-host-ports.md) (the host ports, R-4, R-7, §2.3) · [SPEC-018](../specifications/018.voice-mode.md) (R-4c, R-5) · [SPEC-026](../specifications/026.the-page-medium.md) (R-13a) · [SPEC-027](../specifications/027.the-childs-drawing.md) (R-6) · [ADR-001](001-one-gate-per-thing.md) (one gate per thing)

## Context

Arke Kidz puts a four-year-old in front of the engine. The obvious question — *what is child
mode?* — has mostly already been answered, and the remaining part has been answered three times
independently without anyone naming it.

**Most of it is capability, and SPEC-025 has that.** An actor resolves to an id, a display name and
a set of held capabilities from a closed enumeration: `accept`, `administer`, `author`, `configure`,
`dispatch`, `publish`, `review`. A child holds `author` and not `accept`; a parent holds `accept`.
The engine refuses a gated accept by an actor lacking the capability, in the coordinator rather than
by hiding a button (R-6), and no implementation can grant its way past the gate (R-7). Nothing about
a child needs a new mechanism there.

**And it is not a new gate.** ADR-001 settled that: the engine gates what a family sees and keeps,
the host gates money and the outside world, and nothing is gated twice. A parent approving their
child's page is the accept gate doing its job, not a second approval path.

So the question is what is left over, and there is exactly one thing.

## The thing capability cannot express

**Capability says what an actor may *do*. Nothing says what an actor can be *asked*.**

A child holding `author` may author. But every remedy in this product that routes through reading is
unavailable to them, and the actor model has no way to say so. Three specs hit this and each solved
it locally:

| Spec | The remedy that assumed reading | What it did instead |
|---|---|---|
| SPEC-018 R-5 | *"A partial transcript … editable before it is sent"* — the fix for a misheard proper noun, and for a turn that silence cut in half | R-4c added spoken repair, because *"a four-year-old cannot"* |
| SPEC-027 R-6 | approving a painted derivation on an overall impression | trait-by-trait review, so the question is *"are the purple feet still there"* — which has an answer a small child can give |
| SPEC-026 R-13a | a legibility finding, reported as text | recorded that the person who otherwise discovers it is *"a child who cannot read it"* |

Three specs, three workarounds, no shared rule. The fourth requirement to offer a text-based remedy
will have the same hole, and will not know it.

## Decision

**An actor carries whether it can be asked to read, and that is not a capability.**

1. **It is a property of the actor, resolved alongside capabilities** (SPEC-025 R-4), not a member
   of the capability enumeration. Capabilities are *permissions* — grantable, revocable, refusable
   in the coordinator. This is a *fact about a person*, and R-7's rule that unknown capability
   strings are discarded is exactly right for permissions and wrong for this.

2. **A requirement offering a remedy that requires reading SHALL offer an equivalent that does
   not**, wherever the actor it serves cannot be asked to read. Spoken, shown, or answerable by
   pointing — SPEC-018 R-4c is the worked example.

3. **It SHALL NOT gate anything.** It changes how a thing is asked, never whether it may happen. An
   actor who cannot read still holds whatever capabilities they hold, and an actor who can read
   gains nothing by it.

4. **Absent, it reads as "can be asked to read"** — today's behaviour, one adult author, exactly as
   SPEC-025 R-5 makes an absent `actorId` read as the sole author.

## Consequences

**It is small, and it is the kind of small that gets skipped.** One field, one rule, and no new
gate. The cost of skipping it is not a bug in any one spec — each of the three above is correct —
it is that the fourth author has to rediscover it, and will discover it late, because the failure
is invisible to everyone who can read.

**It has no enforcement, and that is the honest weakness.** Nothing computes whether a remedy is
readable. A requirement that offers only an edit box will pass every check the repository has, and
the rule is a thing a reviewer applies rather than a thing a test proves. That is worse than
SPEC-026 R-13a's computed findings and better than the current situation, which is nothing.

**A trait review is the shape to copy.** SPEC-027 R-6 did not simplify the question for a child, it
made the question *specific* — *"are the purple feet still there"* rather than *"is this good"*. The
specific question is answerable by someone with no reading and no vocabulary for what they are
looking at, and it is also a better question for the parent. The accommodation improved the
requirement for everyone, which is the argument for doing this rather than building a separate
simplified surface.

## What this deliberately does not decide

**The surface itself.** Target sizes, how a session looks while it is live, what a child's compare
screen shows, how a helper speaks — that is design, it belongs in the Kids canvas beside the art
direction, and writing requirements for it here would produce a specification of screenshots. The
art direction already carries `kidcmp-*`, `kid-canvas` and the six helpers.

**Who may see a child's work.** Host territory (SPEC-025 `ContentPolicy`, ADR-001), and Aonik spec
095/096 covers guardian consent and child-facing safety.

**Whether a child is an actor at all**, or acts through a parent's actor with a marker. Both work
against SPEC-025 R-4; the difference is attribution in the change log, and the answer follows from
how the host models a family rather than from anything here.
