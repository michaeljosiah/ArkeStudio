# System status

The System control replaces the former proposal shortcut (approved design turn 240). It is
available before a world is opened. Proposal routes, in-context review and Activity's existing
proposal decisions remain available.

The rounded panel reports the Arke **host**, including when viewed from a connected phone.
It shows CPU use, physical RAM, supported GPU use/memory, registered storage destinations,
reported local-service state and configured cloud providers. Opening it, refreshing it or
following Diagnostics does not approve cleanup, restart a runtime, stop work, change providers
or make a model request.

## Measurements

Contracts `src/system-resources.ts` defines a bounded, enumerated observation projection.
Every reading has its own source, state and time. It contains no hostname, device identifier,
executable path or world content. Missing readings stay unavailable; retained values say Last
and have no live bar. Samples expire after 15 seconds. A measurement ahead of the local wall
clock is not fresh; the UI does not clamp its clock to a host sample.

- CPU is a 250ms delta over the host OS's per-core idle/total counters. Missing, changed or
  reversed counters produce an unavailable reading.
- RAM is host total minus free physical memory. It does not replace Windows commit headroom,
  GPU admission or an operation's resource gate.
- Electron supplies NVIDIA counters only when a fixed native executable is present. It asks
  only for utilisation and used/total memory. Up to eight separate GPUs are retained; the
  overview shows the first and states when others exist. Memory is never added across cards.
  Unsupported platforms, drivers and failed counters remain unavailable.
- Storage reuses the existing collector and diagnostic finding rule. Mappings of one proven
  volume share a row even when their root mapping revisions differ. The display uses the
  minimum fresh caller-available reading, preserving quota restrictions. Partial stale or
  unavailable destinations stay explicit. Separate volume capacities are never added; a
  volume warning does not invent an affected export or job count.
- Service states come from existing owners/read models. Missing check times are stated rather
  than replaced with the panel's opening time. Ming's observed running state does not prove
  inference quality. Cloud configuration and earlier validation do not prove current provider
  availability. Refresh does not revalidate credentials or spend money.

## Ownership and transport

Coordinator `src/system-resources.ts` coalesces requests and retains observations in memory.
The shared Studio host enables OS collection; Electron injects the GPU reader and Ming owner's
running observation. Resource-only polling uses authenticated `refresh-system-resources`;
opening/manual Refresh also asks existing Diagnostics/storage to refresh. While visible
and connected it requests resource collection every five seconds; hidden, covered and closed panels
stop requesting it. Concurrent callers share one collection and a one-second cooldown.

Observation waits have an eight-second ceiling. Shutdown aborts observation and waits at most
250ms for presentation work. Late native results cannot publish after shutdown; an unconfirmed
native request prevents another collection. A timeout does not prove native process exit.

The fixed GPU reader uses existing `SetupProcessRunner` job/parent-leash/ledger ownership with
identity `system-probe`, a six-second command deadline and an 8KiB output ceiling.
`StartupRuntimeOwners` retains it through normal shutdown, failed initialization and cleanup
retry. Failed native cleanup remains owned; a later read must confirm cleanup before launch.
It has no inference process, GPU reservation or service-repair authority. The media process
runner remains unchanged.

`system.resources` folds into coordinator/client snapshots for authenticated sessions. It is
excluded from the change journal and the existing enumerated support export. Resource polling
is classified as a human/UI observation, and makes no upload or cloud explanation call. Storage admission remains with SPEC-062's
owning service and each operation's fresh gates.

## UI and validation

Client `components/system-panel.tsx` uses PageSheet's overlay owner. Desktop is modeless;
tablet/phone use native modal dialogs with inert backgrounds. Header/footer remain visible
while the body scrolls. Close/Escape returns focus; navigation closes the overview. Warning
links carry their existing finding reference to Diagnostics, where that row receives focus
without executing a remedy.

The closed System shortcut expires its current storage-warning dot/title with a one-shot
timeout tied to the existing measurement/forecast deadlines, plus a visibility wake. This is
presentation invalidation only: it does not poll the chrome or request another host sample.

Focused coverage: contracts/coordinator/desktop `system-resources.test.ts`, coordinator
`system-resources-application.test.ts`, client `system-panel.test.tsx` and `chrome.test.tsx`.
The integration fixture checks authenticated delivery/reconnect and journal/export exclusion
without opening a world or running a model. The real fixed native reader was exercised three
times through Windows ownership: 1.96s, 1.72s and 1.86s. CPU/RAM were measured; the NVIDIA
command returned exit 255, so GPU remained unavailable. Disposal confirmed an empty child
ledger. Successful real GPU counters remain hardware-dependent.

Build the actual-component comparison with
`node design-system/system-status-240.native-build.mjs`, run
`node design-system/system-status-240.serve.mjs`, and open
`http://127.0.0.1:4240/system-status-240.native-review.html`. This uses actual AppChrome,
SystemPanel, PageSheet and the full current client CSS with a local command recorder and
explicit deterministic test data. The server refuses the master and previous turns. Component
comparison, live transport, packaged Electron and physical-phone keyboard acceptance are
separate checks.

Browser component review on 26 October 2026 covered direct desktop 1280 × 720 light/dark,
tablet 834 × 900 overview top/footer light/dark, phone 390 × 844 light overview top/footer and
dark storage warning, and reduced-height 390 × 550 stale light/dark. Card geometry, body
scroll and fixed footer were visible. Pointer-open/Escape returned focus to System; Tab reached
the body, Refresh and Diagnostics and the modal background remained inert. The desktop
modeless background remained live. The outer 1360px iframe was clipped, so direct desktop
captures were used instead. Browser/outer-fixture focus remains reachable; this does not prove
physical-device keyboard acceptance or matched-pixel equivalence with example service copy.
Captures are gitignored `.dev/recovery-design/system240-native-*.png` and concern turn 240 only.
