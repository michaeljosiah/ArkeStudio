# System · a glance at the Arke host

Design turn **240**, revision 1, **approved by the owner** on 26 October 2026. The owner requested a design
turn replacing the top-right proposal shortcut with a system icon showing resources and
performance. The owner subsequently authorized implementation of the System panel. The proposal screen and its workflows remain.

## Current sources and scope

- At the design checkpoint, `packages/client/src/components/chrome.tsx` ordered Chat, Proposals, Activity,
  Settings and Account. Proposals is world-scoped; the new System entry is application-scoped.
- `packages/client/src/screens/proposals.tsx` is an unattended-proposal queue with review and
  decisions. Its route and capabilities remain. `activity-panel.tsx` has the existing
  `open-proposal` → Review action; audit complete alternate access before any later screen removal.
- Page sources are current master **227a**, **227k**, **227m**. Only utility chrome changes.
  The phone drawing is content-only, so the mock supplies the actual current phone AppChrome
  grammar from `home.css`/`productions.css`: 52px bar, back control, no centred brand,
  five 44px utility targets. Body content is retained.
- Shell geometry uses Activity **206b** and approved assistant **239**: 440px desktop width,
  12px corners, full border, popover surface, token shadow, 10px right gap. System is a compact
  overview bounded by the available viewport; it has no composer.
- Icons are rendered from current `icons.tsx`, with a source hash in the generated reference
  receipt. The System glyph is native **Cpu**. No new path or icon family is introduced.
- Typography, surfaces, spacing and status colours use current token files. Resource bars
  and local-service rows reuse the restrained facts/rows vocabulary, not a dashboard redesign.

## Proposed behaviour

System shows CPU utilisation, used/total memory, GPU utilisation and GPU memory, plus free
space on each registered destination. Service checks are separate: Ready/Working/Not running
are not performance readings. Configured cloud providers explicitly say **Not checked**.
No cloud hardware telemetry is implied.

Every value, status and time in the design frames is **example data**. The design-only checkpoint
did not implement CPU/RAM/GPU collection; the authorized implementation is recorded separately below.
The label **This desktop** keeps host readings distinct from a connected phone or tablet.
Production must resolve the host label from authenticated host context and retain disconnection
and unsupported-data states.

The warning example names a waiting export, 6 GiB available, 9 GiB required including reserve
and a 3 GiB deficit. **Review in Diagnostics** opens the existing finding. No repair, cleanup,
restart, provider switch or approval runs from this overview. The quiet warning dot indicates
a current finding; opening it does not dismiss an incident.

The unavailable example retains CPU/RAM readings only as **Last** values with explicit stale
time and no live bars. Unsupported GPU data and failed capacity checks say **Unavailable**.
Refresh requests bounded host collection; old data does not become healthy by being displayed.
Utilisation numbers introduce no universal RAM/GPU capacity gate.

Desktop is nonmodal. Tablet and phone use modal focus containment and inert backgrounds.
Close/Escape returns focus to System; work continues. Header/footer remain reachable while
the content scrolls. Phone uses 12px outer gaps, four rounded corners and 44px controls.
The retained page owns a stacking context so its original Write/Listen bar stays below the
System overlay. The scroll area uses the existing token-coloured thumb and transparent track,
with the appropriate light/dark native colour scheme.
The fixture's Diagnostics and Refresh controls explain intended handoffs without host effects.

## Frames

| Frame | State |
|---|---|
| 240a | New native System shortcut in existing chrome, closed |
| 240b | Desktop overview, CPU/RAM/GPU/storage/services |
| 240c | Measured storage warning with Diagnostics handoff |
| 240d | Stale CPU/RAM, unsupported GPU and unavailable storage |
| 240e | Tablet modal, 834 × 900 |
| 240f | Phone warning, 390 × 844 |
| 240g | Reduced visible height, 390 × 550 |

All frames and interactive states use the same markup and support light/dark tokens.

## Specs and implementation follow-up

Read current **SPEC-032** (draft), **SPEC-061 revision 12** and **SPEC-062 revision 7** (both
proposed). SPEC-061 R-2/R-5 and SPEC-062 R-5/R-21 support evidence/freshness and measured
warning presentation. These proposed capabilities are not implementation guarantees.

The implementation requires a private amendment to record replacing
only the shortcut and preserving proposal decisions. Extend SPEC-032 R-17's enumerated source
contract (or a separately owned host-resource projection) for actual CPU/RAM/GPU utilisation,
with collector support, units, source identity and freshness budgets. Implement no universal
memory-fit threshold. Coordinate the System/Activity/Settings/Arke overlay owner and remote-host
identity. The design-only checkpoint changed no private spec or application source; its approved
drawings remain the visual baseline for the separately authorized implementation below.

## Maintenance and verification

```powershell
node design-system/system-status-240.references-build.mjs
node design-system/system-status-240.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/check-master.mjs
node design-system/system-status-240.check.mjs
node design-system/build-review.mjs --check
node design-system/system-status-240.serve.mjs
```

The last command serves **only new turn 240** and its existing CSS/assets at
`http://127.0.0.1:4240/system-status-240.review.html`; it refuses the master, consolidated review
and other turn previews. It is not a renderer for the previously denied master.

Source/DOM checks verify historical turns remain byte-identical, native icon provenance,
retained page content, slot order, explicit
example labels, evidence/absence states, no destructive controls and fixture focus behaviour.
They do not establish visual parity or physical-device behaviour.

Actual browser review of the isolated new-turn URL was completed on 26 October 2026 after
font, scrollbar and stacking corrections. Reviewed desktop 1360 × 820, tablet 834 × 900 with
top/footer captures, phone 390 × 844 and reduced height 390 × 550 in light and dark. Captures
show the inset rounded card, reachable header/footer, contained background controls and explicit
stale readings. This review concerns turn 240 only; it does not establish turn 239 parity.

Final captures in the gitignored `.dev/recovery-design/` folder: `system240-desktop-light.png`,
`system240-desktop-dark.png`, `system240-phone-light.png`, `system240-phone-dark.png`,
`system240-small-light.png`, `system240-small-dark.png`, `system240-tablet-light.png`,
`system240-tablet-footer-light.png`, `system240-tablet-dark.png` and
`system240-tablet-footer-dark.png`. Native keyboard acceptance and implementation comparisons
remain separate from this design review.

## Authorized implementation and component comparison

The owner approved implementation on 26 October 2026. `SystemPanel` now uses the current
AppChrome, native Cpu icon, PageSheet overlay owner, shared buttons and current client tokens.
It replaces only the shortcut; actual proposal routes and decisions remain. Real observations
are separate from the deterministic values in the design and component fixtures. Production
does not copy example readings, assume a waiting export or infer model fit from free memory.

The transient host-resource contract carries bounded CPU/RAM/GPU and Ming-owner observations,
with source and per-reading times. `refresh-system-resources` is an authenticated UI-only
observation; five-second visible-panel polling does not refresh storage. Opening/manual
Refresh additionally uses the existing Diagnostics/storage refresh. Observation waits are
bounded and shutdown suppresses late publication. The fixed NVIDIA reader uses the existing
native process owner, parent leash, child ledger and retained cleanup rather than a second
supervisor. See `docs/development/system-status.md` for the collector and lifecycle details.

The isolated `system-status-240.native-review.html` fixture bundles the actual AppChrome,
SystemPanel, PageSheet and full client CSS, with explicit deterministic test data and a local
command recorder. It renders no previously denied master or turn 239 target. Parent browser
review on 26 October confirmed phone 390 × 844 light overview top/footer, phone dark warning,
reduced-height 390 × 550 stale light/dark, and tablet 834 × 900 overview top/footer light/dark.
No card geometry or footer obstruction was found. Actual pointer-open followed by Escape
returned focus to System; Tab reached the scrollable body, Refresh and Diagnostics while the
background iframe content remained inert. Fixture auto-open intentionally focuses the heading;
pointer-open does not display that initial focus ring.

Direct native-page desktop captures at 1280 × 720 in light/dark show the whole 440px rounded
card, 50px top/10px right inset and pinned footer. Its modeless background remains live.
Component captures are in gitignored `.dev/recovery-design/system240-native-*.png`, including
`system240-native-desktop-light.png` and `system240-native-desktop-dark.png`. The outer browser
clipped the 1360px iframe fixture, so that iframe capture does not establish 1360px acceptance.
Actual component geometry/theme review does not establish matched-pixel equivalence: service
and evidence copy correctly differs from the example drawing. Tab can leave the iframe for the outer fixture/browser chrome; this review
does not establish physical-device keyboard acceptance. Packaged Electron, live transport and
successful hardware GPU counters are distinct qualifications. This is turn 240 component
comparison only and makes no claim of parity with turn 239.
