# Local H3 adapter library

Issue #1248 adds the catalogue and control boundary from SPEC-021 and SPEC-033.
Settings → Content & safety owns the device's explicit adult-content acknowledgement.
Its three required choices default to off. Enabling access reveals the catalogue; it neither
approves an artifact nor installs weights. The setting is stored outside worlds.

## Current status

The inventory covers all **14 safetensors artifacts (4,061,177,176 bytes)** in
`Hearmeman/minimax-h3-loras` at `de4c3bc6122e68b88407c03dfecf521c803f098d`.
Every recipe pairing is **unverified**. Passing unit tests does not establish GPU compatibility.
Other Hearmeman repositories, H3's existing acceleration adapters and Gemma remain separate.

**The default desktop composition has no connected compliance agent.** Supply the user's real
interface through `CoordinatorOptions.adapterCompliance`. Until then assessments remain pending
and installation/dispatch are refused. That connection and actual GPU evidence are remaining
prerequisites for activating a pairing; this is not an end-to-end verified adapter release.

## Inventory and immutable identity

`node scripts/sync-hearmeman-adapters.mjs --check` compares the pinned publisher tree.
Use `--revision=<40-character-commit> --write` to stage a new revision for review. The script
follows pagination and records exact LFS SHA-256 digests and sizes. It downloads no weights,
grants no approval and changes no user settings. Review `hearmeman.generated.ts` before commit.

Release IDs include the full digest. Existing records/evidence survive refresh; missing files
remain as withdrawn releases. Explicit named publisher versions have stable family identities
and supersession links. Saved choices are never replaced. Decisions and removal tombstones are
keyed by digest, so renaming a file cannot evade them. The pinned README is the recorded license
source; its label is not a legal or compatibility approval.

## Compliance interface and persistence

The coordinator exports `AdapterComplianceClient`, implemented by the trusted host:

```ts
interface AdapterComplianceClient {
  assess(releases: readonly AdapterRelease[], signal: AbortSignal): Promise<readonly AdapterDecision[]>;
}
```

Each decision supplies `sha256`, `decision` (`allowed`, `disabled`, `removal-requested`), `reason`,
`policyRevision`, `assessedAt`, and optional `expiresAt`. Return at most one decision per known
digest. Duplicates, unknown hashes, future assessments and invalid expiry windows fail validation;
missing entries stay pending. Renderer commands cannot submit verdicts, paths, URLs or nodes.

A scan retires approvals before contacting the agent, has a 30-second deadline, and cannot
overwrite a concurrent user decision. Failure never restores an old approval. The flushed,
append-only `<appRoot>/adapters/decisions.jsonl` records full revisioned states: acknowledgements,
decisions, user overrides, removal tombstones and ownership receipts. A damaged journal fails
closed without being overwritten. Refresh/scan never undo a user override; Request fresh review
explicitly clears it and leaves assessment pending again.

Removal verdicts revoke work and attempt to delete only owned, idle, unchanged files. Ownership
requires a successful verified setup transfer and matching filesystem identity, not discovery.
User files, active files and files outside the selected model folder are kept, with a reason.

## Setup and execution

Optional downloads use the existing setup service's disk checks, progress, resumable receipts
and SHA-256 verification. Files go to the selected local ComfyUI model folder at
`loras/arke/<sha256>.safetensors`. Existing files are reused without claiming ownership. A file
appearing at the destination during transfer is not overwritten. Generic Downloads controls
pass the same policy boundary; permission is rechecked before transfer and publication.

A selection extends a shipped H3 recipe only at its declared model slot. No selection returns
the original recipe unchanged. Combinations are refused until separately validated. A verified
pairing requires evidence, bounded strength, engine versions and measured total/free RAM/VRAM.
Effective recipes use the stricter floors. Admission checks permission, compatibility, locality,
memory and bytes; permission/bytes are checked again before submission and immediately before
`/prompt`. Changed frozen identities are refused rather than substituted.

Quotes, jobs, take records and re-runs preserve adapter IDs, hashes, order, strengths and effective
graph/dependency identity. Disabling access revokes queued/active adapter work through existing
cancellation and stops downloads. Bench previews are hidden; authenticated media serving checks
persisted provenance for Bench, production takes and generated artifacts. Accepted work/files
remain on disk. This is not a classifier for arbitrary imported media.

## Validation and promotion

Focused tests: contracts `test/adapters.test.ts`; providers `test/comfyui-adapters.test.ts`;
coordinator `test/local-ai/adapter-library.test.ts`, `adapter-media.test.ts`,
`test/setup/local-setup.test.ts`, `test/queue/dispatcher.test.ts`; client `test/adapters.test.tsx`
and `test/bench.test.tsx`. Run client tests from its package directory. After building, run
`node --import tsx apps/desktop/scripts/smoke-adapters.mjs` for acknowledgement/reload checks.

Promotion needs exact artifact/base/recipe/node/engine versions, a neutral input and seed,
decoded output, observed RAM/VRAM, strength bounds, reference transport where applicable, and
cancellation evidence for each pairing. Keep untested/incompatible pairings visible with a
reason. Windows packaged startup and Linux CI are separate from source-level unit tests.
