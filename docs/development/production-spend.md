# Lifetime production spend

Issue #250 and approved design turn 255 add lifetime spend, generated video candidates and
currently selected shot coverage to video productions, scenes and shots. A shared Spend
details sheet retains the originating scope and shows job receipts, cost sources, outcomes
and duration allocation. This is a read-only projection, separate from Activity's spend view.

## Authorities and scope

- The ledger owns money and cost source. Never total `take.cost`: pass containers and their
  segments, or Bench originals and filed copies, can describe the same purchase.
- The complete job journal, including Activity tombstones, owns targets and frozen plans.
  Production Bench requests supply their frozen filing identities. New Bench jobs also carry
  coordinator-only `productionWork` metadata so session removal cannot erase attribution.
- Retained production takes and completed Bench media own generated candidates. A pass counts
  once per produced shot segment; its container is excluded. Frozen filing IDs deduplicate
  Bench media and filed copies. Current selections, rather than acceptance history, own the
  selected count. Uploaded media does not become a generated candidate.
- Direct shot/scene-pass video, paid board-sheet image generation and production-owned Bench video/stills contribute spend,
  including failed and cancelled work. Stills do not contribute video candidates. Unrelated
  Bench, voice, music, performance, reference, authoring and export work is excluded when its
  target history is available.

Pass spend is allocated by frozen duration using exact rational arithmetic and integer
micro-dollars; the last member receives the remainder. Invalid or removed targets retain
money at the known parent, marked unallocated. Orphan ledger records with only a production
identity remain unassigned production receipts with partial coverage: their missing target
history cannot establish a more precise scope or exclusion.

Local unmetered work and free-plan/free-credit/included-plan attempts remain separate from
billed money. A plan's recorded zero does not establish its allowance consumption. Estimated,
provider-reported, usage-derived, mixed-measured, manifest-derived and unknown actual sources
remain distinguishable. Empty, complete, partial and unavailable accounting states are explicit;
candidate counts independently report partial evidence. Retained generated stills establish historical work even without their ledger/jobs; they never add video candidates. Provider reconciliation holds have unknown charges rather than pending zeroes. Missing history is not a complete zero.

## Implementation and lifecycle

Contracts `production-spend.ts` owns the wire schemas and frozen Bench attribution.
Coordinator `spend/read.ts` reads ledger/job JSONL and contained Bench session histories without
repairing or writing them. Its analytics fold retains deleted Bench media history without
changing the ordinary Bench wall's deletion behavior. `spend/rollups.ts` derives the projection.
Nothing is written into the portable world and legacy records are not rewritten.

Coordinator coalesces refreshes on world snapshots, relevant job/ledger and Bench events.
Reads are tracked through shutdown and discarded after a world/store change. The optional
`ClientState.productionSpend` snapshot field is never persisted in `WorldBundle`.
`production-spend-refresh` only repeats these reads; it does not dispatch work or refresh the
world from disk. The client uses `components/production-spend.tsx` and native `PageSheet` for
focus containment, Escape, scrolling and focus return.

## Validation

From `packages/coordinator`, run:

```
node --import tsx --test test/spend/rollups.test.ts test/spend/read.test.ts test/takes/takes.test.ts test/queue/dispatcher.test.ts test/bench/subject.test.ts
```

From `packages/client`, run:

```
node --import tsx --test test/production-spend.test.tsx test/scene-workspace-rows.test.tsx test/shot-page.test.tsx
```

From the repository root, `node --import tsx scripts/smoke-production-spend.mjs` renders the
actual App and PageSheet with a synthetic fixture, in both themes at desktop, phone and short
window sizes. It checks the hierarchy, source/coverage states, receipt scrolling, refresh,
horizontal fit, Escape and focus return. Outputs go under `output/production-spend-native/`.
It submits no provider work and reads no author world. Full repository gates still apply.

The implementation follows SPEC-008's lifetime production spend amendment (PR #2286),
SPEC-013's pass/segment accounting and SPEC-036's production Bench filing identities.
