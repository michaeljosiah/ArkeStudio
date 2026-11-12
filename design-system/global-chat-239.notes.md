# Global chat · the Studio assistant in a rounded dialog

Design turn **239**, revision 2, approved by the owner on 26 October 2026. The owner requested a quick
design-master update: global chat should differ from World Chat and production build chat, and
use the notification dialog's rounded window. The owner approved the rendered design and authorized commit, push and merge. Application
implementation and its acceptance remain separate.

## Existing sources

The page is the current writing-room master, not a replacement workspace: 227a on desktop,
227k on tablet and 227m on phone. The notification comparison is the actual 206b drawing.
The composer comes from the approved 225 drawComposer, including its generated native
ModelChip. Icons are rendered from the current client icon components; the send glyph is
rendered from Composer. The existing lowercase a remains the Arke welcome mark.
Reference snapshots carry source names and the native-icon source hash.

## Approved design

- Use Activity's current desktop geometry from turn 206: 440px floating card, 12px corners,
  full border, existing shadow and gaps around the outside. Leave the underlying page at its
  original width. Header and composer stay put while messages scroll.
- Name the conversation **Arke · Studio assistant**. Keep **Studio / Setup, local AI & help**
  visible so opening a world never silently changes the assistant's scope.
- Keep World Chat and Builder Chat as their existing task-specific workspaces. A global request
  about creative content offers a named handoff, carrying an editable draft without sending it.
- Arke presents operational findings from the dedicated diagnostic capability. A measured
  storage card can open a cleanup plan; a separate action approves it. Example measurements and successful cleanup are illustrative, not live product evidence.
- Proactive incidents use Activity and quiet attention indicators. They never force chat open.
- On tablet use a modal overlay; on phone keep all four corners rounded and 12px outer gaps,
  44px controls and a composer above the keyboard's visual viewport. Respect safe areas and
  return focus to the opener when dismissed. Closing keeps the draft and leaves work running.

## Frames

| Frame | State |
|---|---|
| 239a | Activity/notification shell reference |
| 239b | Global Studio assistant welcome |
| 239c | Diagnosis and storage remedy |
| 239d | Explicit cleanup approval |
| 239e | Named handoff to World Chat |
| 239f | Phone, 390 × 844 |
| 239g | Tablet, 834 × 900 |
| 239h | Phone keyboard's reduced visible area, 390 × 550 |

## Maintenance and verification

From the repository root:

```powershell
node design-system/global-chat-239.references-build.mjs
node design-system/global-chat-239.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/check-master.mjs
node design-system/global-chat-239.check.mjs
node design-system/build-review.mjs --check
```

The generator touches only turn 239, its stylesheet registration and its generated review
entries. Earlier turns remain historical record. The standalone review includes a bounded
interactive fixture: close/reopen draft retention and Activity return, canned diagnostics, review/approve/deny and
an explicit handoff. It performs no host/model/media operations. Verify light/dark, desktop,
tablet, phone and reduced visible height; inspect clipping, independently scrolling messages,
touch targets, keyboard reachability and focus. A fixture is not application acceptance.

Backend operational authority belongs to proposed SPEC-061/062 and epic #2194. Before native
implementation, qualify how the existing contextual global-chat host is separated into the
Studio dialog and existing World/Builder surfaces, retaining one mounted owner per conversation.
The optional specialist remains behind Arke's visible conversation and the host's repair gates.

Browser policy blocked automated local-file preview in this session. Structural/source checks
are recorded separately from rendered visual and native-device acceptance.

Implementation acceptance requires matched-state captures of the native app and approved master
at desktop, tablet, phone and reduced keyboard viewport, in light and dark. Compare shell geometry,
icons, fonts, composer, cards and controls; correct discrepancies until 1:1 parity is demonstrated.
Owner visual approval of this design does not establish that the implementation matches it.
