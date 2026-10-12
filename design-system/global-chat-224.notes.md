# Global Chat · design turn 224

Status: **proposed, awaiting author approval**, 13 October 2026. The author explicitly
requested a design turn before application implementation. No new Chat UI is implemented.

Open [the focused review](global-chat-224.review.html) for nine HTML drawings and an isolated
interactive example. The [master](Arke%20Studio.dc.html#t224) holds the binding proposed rules.
SPEC-051 records the proposal; acceptance depends on explicit author design approval.

Chat prepends to the titlebar's right-hand controls. Opening follows the current page;
an already open conversation stays attached to its subject. **Use this page** explicitly
resumes or creates the new subject's thread. Drafts belong to conversations. World changes
detach live access to the previous world and explain the boundary. Desktop uses a side panel;
phone uses a sheet. Existing Studio docks must reuse one conversation/card instance.

The fixture demonstrates navigation, typing, send, draft retention, subject switching,
conversation history, closing, Escape, focus return, phone focus containment, Activity/Settings
coexistence, running indication, world boundary and no-world state. Replies and runs are
illustrative. It does not exercise real agents, coordinator ownership, refresh durability,
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
