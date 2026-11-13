# Turn 283 — Voice-upload confirmation (#2821)

Proposed, awaiting owner approval. This turn covers only the existing
RemoteVoiceUploadConfirmation. The broad primitive, popover and touch-rule migration
remains deferred. Issue #2822's separate reorganisation project is retired.

Keep the existing title, explanatory copy, destination label, optional vendor notice,
Not now and Send recording. The drawings use examples from the current component and
coordinator notice; this turn does not amend vendor policy copy.

Reuse EditorDialog, mounted on the document body and registered with the existing
overlay stack. Keep the compact centred panel, at most 520px wide, with 16px viewport
insets. Its content can scroll in a short window; long destination labels wrap.
Keep the two actions together when they fit and allow wrapping, with 44px phone targets.

Focus starts on Not now. Tab and Shift+Tab stay within the confirmation. Escape and
the backdrop run the same cancellation callback as Not now. Send recording is the
only affirmative action. Closing returns focus to the opener; when another sheet
was underneath, it becomes usable again. No new close button or intermediate step.

Request identity, vendor/voice consent tokens, the optional destination notice and the
subsequent price confirmation remain as implemented. References: SPEC-046 R-16/R-17
and the shared dialog focus rule in SPEC-039 R-5 (both draft capability documents).

After approval: verify the real cast-page read flow and a nested sheet, keyboard
containment, Escape/backdrop/Not now, positive confirmation, focus return and long
content at phone, desktop and short-window sizes. Run the existing consent/read-aloud
tests and required dialog smoke checks, plus lint, typecheck and build. Raise one PR
and merge without waiting for CI or code review, as the owner requested.
