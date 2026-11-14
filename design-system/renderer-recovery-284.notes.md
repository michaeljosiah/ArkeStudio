# Turn 284 — Recover a crashed desktop window (#1815)

Proposed 14 November 2026; awaiting owner approval before implementation.

Use an operating-system message box, owned by Electron main, so it remains usable
when the renderer has crashed. The HTML drawings specify copy and actions; the
operating system supplies the actual typography, geometry, theme and focus ring.
This is a desktop-only change. A phone variant is not needed.

Title: Arke Studio. Message: The window stopped working.

Detail: Reload the window to return to your work. Background jobs keep running
and will not be submitted again.

Unsaved changes in this window may be lost.

Actions: Not now and Reload window. Reload window has initial focus. Escape and
the native close button mean Not now. Not now leaves the coordinator running;
after the user switches away and returns to the affected window, offer recovery
again. Do not immediately reopen the prompt as it closes. Show at most one prompt.

Reload only the affected window, preserving the coordinator, world and accepted
jobs. Do not restart the app, resubmit work, or automatically reload in a loop.
Keep existing crash receipts and renderer-owned export/playback cleanup. Ignore
normal renderer exits and stale responses after shutdown, window disposal or a
successful intervening load. A failed reload can be offered again on return.

The original OOM investigation is historical context. Its snapshot/client fixes
are already covered by #2279–#2283. This turn does not claim that a long-session
OOM has been reproduced or eliminated. SPEC-001 is draft; amend its desktop
lifecycle requirements alongside the implementation after design approval.

Verification: lifecycle tests for reload/dismiss/repeated failure/shutdown and a
deliberate renderer crash in a sandboxed Electron file page. Check recovery of the
authenticated connection and an already-accepted synthetic job without duplicate
dispatch. Do not use an author's live world or paid provider work.
