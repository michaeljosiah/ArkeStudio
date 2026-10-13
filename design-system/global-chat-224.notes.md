# Global Chat · design turn 224

Status: **revision 3 · proposed, awaiting author approval**, 13 October 2026. The author explicitly
requested a design turn before application implementation. No new Chat UI is implemented.

Open [the focused review](global-chat-224.review.html) for fourteen HTML drawings and an isolated
interactive example. The [master](Arke%20Studio.dc.html#t224) holds the binding proposed rules.
SPEC-051 records the proposal; acceptance depends on explicit author design approval.

Chat prepends to the titlebar's right-hand controls. Opening follows the current page;
an already open conversation stays attached to its subject. **Use this page** explicitly
resumes or creates the new subject's thread. Drafts belong to conversations. World changes
detach live access to the previous world and explain the boundary. Desktop uses a side panel;
phone uses a sheet. Existing Studio docks must reuse one conversation/card instance.

Revision 3 restores the existing shared composer from `components/composer.tsx` and
`dictation.tsx`: + picker, drop/paste, attachment kind/readability/refusal chips, explicit
filing and Stop referring to, microphone dictation, context-specific model control and
optional Read replies. World model display remains read-only; scene/shot docks retain
their existing model-control rule. Dictation appends editable words and never auto-sends.

The fixture demonstrates uploads through name-only chips and illustrative listening,
transcription and unavailable states; navigation, typing, send, draft retention, subject switching,
conversation history, closing, Escape, focus return, phone focus containment, Activity/Settings
coexistence, running indication, world boundary and no-world state. Replies, runs and dictated words are
illustrative. It never requests microphone access, reads selected file bytes or uploads them. It does not exercise real agents, coordinator ownership, refresh durability,
the on-screen keyboard or production proposals. No application imports or writes occur.

From the repository root:

```powershell
node design-system/global-chat-224.mjs
node design-system/check-master.mjs --record
node design-system/build-review.mjs
node design-system/check-master.mjs
node design-system/build-review.mjs --check
node design-system/global-chat-224.check.mjs
```

The focused check uses local headless Chrome and writes its report/screenshots to
`.dev/global-chat-design/`. Application acceptance tests belong to the later implementation.

Revision 3 adds `global-chat-224.native-preview.tsx` and its presentation CSS, bundled by
`global-chat-224.native-build.mjs`. They render the existing Develop page and move its one
mounted conversation into the proposed right panel. ModelChip, ModelPicker, Composer and
the complete application cascade are imported unchanged. The catalogue is illustrative
test data; no live catalogue/default is inferred. Media capture, file bytes and Send are
blocked in this comparison; the original metadata-only fixture demonstrates upload/dictation.

Build and inspect the comparison after `npm ci --ignore-scripts`:

```powershell
node design-system/global-chat-224.native-build.mjs
node design-system/global-chat-224.native-check.mjs
```

The checked-in native review links the generated `.dev/global-chat-design/native/page.html`;
the build also writes a portable embedded `standalone-review.html` there. Neither is application
implementation. Ten native comparison checks cover the actual page, one conversation mount,
composer retention, icon placement/visibility, model search, provider/effort controls and
choice retention after close/reopen. Historic turn 195 is missing from the live master;
exact historic pixel parity is not claimed. Frame 190e and current native controls are the
verified references. The overview drawings remain simplified; the native comparison governs
model-control appearance and behavior. Author design approval is still required.
