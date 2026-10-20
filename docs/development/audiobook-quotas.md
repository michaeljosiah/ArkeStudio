# Audiobook daily quotas

Paid Google speech has a model-specific daily quota separate from Arke's spend budget.
The provider's refusal already records its reported limit and reset. The audiobook runners
preserve those details and the selected reader in their final status (issue #1934,
SPEC-049 R-43–R-45).

Contracts `provider-plans.ts` projects the latest matching paid refusal from retained jobs.
It ignores other providers/models and failures older than the current Google key save.
The original reset wins; an older failure without one uses midnight Pacific after that
failure, never a fresh tomorrow every time the app opens. After reset it stops refusing;
the last reported limit remains evidence, not a remaining balance.

Coordinator injects this projection into chapter and book preparation. A known exhausted
day stops before casting, confirmation or synthesis. Otherwise the existing price confirmation
names each paid Google model's planned request count and says its remaining daily allowance
is unknown. A larger spending budget does not imply more provider capacity.

Completed takes and the book narrator remain unchanged. A later explicit read uses ordinary
preparation to skip current takes and resume missing work. Nothing resumes automatically,
switches voices or invents a quota balance. Saving the provider key again clears older evidence;
Arke cannot observe a remote quota increase in advance of another provider response.

The status and confirmation reuse the existing presentation from design master turns 182d,
185a and 199; no new panel or persisted schema is introduced.

## Verification

- Contracts: `test/provider-plans.test.ts` checks model/key scoping, original resets, request
  counts, unknown capacity and the status labels.
- Coordinator: `test/productions/audiobook-grouped.test.ts` checks grouped and solo refusals,
  whole-book preflight, preserved takes and missing-only resume after reset.
- Client: `test/audiobook-door.test.tsx` checks paid-quota copy and retained narrator choice.
- Native acceptance: with an actual retained daily refusal, press Read in the built app,
  reopen and repeat. Verify no synthesis jobs were submitted and existing recordings are
  unchanged. Inspect phone, tablet and desktop screenshots against the design master.

Run tests from the owning package and typecheck after the final test edits. Tests do not
need a live speech credential; native quota verification must not erase or fabricate a
provider refusal to force a purchase.

On Windows, use the existing desktop profile when checking saved cloud credentials. An
isolated Electron `--user-data-dir` may not decrypt the installed app's credential store;
that produces a catalogue failure before the quota workflow is reached. Close the other
app instance before opening that profile with a validation build.
