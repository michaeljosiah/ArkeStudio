# Turn 279 — Pending restart and empty export

13 November 2026. Both designs approved by the owner in chat. Implementation is delivered in
separate issue fixes; these drawings record the approved copy and scope.

These are HTML detail drawings using the existing typography and neutral controls. The narrow
Harness drawing is a cropped narrow desktop panel, not a new remote-device control. The actual
application retains its complete settings and export options; the drawings focus on the changed
copy. They add no restart action, new dialog, or new product navigation.

## #1695 — Pending authoring harness

Keep running and selected engines distinct. While an installed selected engine is waiting for
restart, show the existing pending status with:

> Finish active work, then quit and reopen Arke Studio.
>
> If remote access is running, choose **Quit Arke Studio** in the system tray. Closing the window
> only hides it. Paired devices disconnect until Arke reopens.

Use the existing note/caption area, with normal wrapping. The manual shutdown and its existing
failure handling remain authoritative. Closing/reopening a hidden window cannot change the
running label. A failed quit leaves the selection pending. Show the explanation only for a
pending selection; existing unavailable/starting reasons take precedence. No automatic restart,
new IPC or change to job handling. Authority: issue #1695 and SPEC-005 harness selection.

## #1610 — Video export with no complete chapter

Once the export plan is known and the selected scope has no complete readable chapter, replace
the size/time estimate with **Read a chapter in full to render a video.** Keep the existing
Render control disabled and label it **Render video**, rather than Render 0 chapters. On a
single-chapter scope, use **Read this chapter in full to render a video.** Reuse the existing
incomplete-chapter explanation rather than repeating it. The whole-book view must have no
zero-size, zero-file, or already-rendered estimate in this state. Do not render it as a warning
about a failed job.

Loading still shows loading; a refused plan retains its refusal. Partial books with at least one
complete chapter keep their normal estimates and omitted-chapter disclosure. Successful and
active exports are unchanged. Authority: narrowed issue #1610, SPEC-047 R-132–R-145.

## Review and delivery

Render the proposed detail drawings in light/dark at desktop and narrow widths. Show the narrow
drawings inline in chat so the owner can review on a phone. Implementation follows approval,
one minimal PR per issue, with the owner's standing instruction to merge without CI/review waits.
