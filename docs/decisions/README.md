# Architecture decision records

Decisions that span more than one specification, or more than one product, live here. Decisions
*inside* a capability live in that capability's spec, in its decision table — that convention is
unchanged and is still where most decisions belong.

The test for putting something here: **would a reader of one spec be surprised by it, because it
was settled somewhere they had no reason to look?** If so, it is an ADR.

## Format

- **Status** — Proposed, Accepted, Superseded
- **Date** — when it was settled
- **Related** — the specs and decisions it touches
- **Context** — the situation, and the forces that make it a real choice
- **Decision** — what was chosen
- **Consequences** — what is now true, including what got worse

## All ADRs

| ADR | Title | Date | Status |
|---|---|---|---|
| [001](001-one-gate-per-thing.md) | One gate per thing: the Arke/Aonik approval boundary | 2026-08-22 | Proposed |
| [002](002-ownership-is-a-revision.md) | Ownership moves from the format to the deployment | 2026-08-23 | Proposed |
