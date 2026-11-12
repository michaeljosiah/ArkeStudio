# Claude handover: Studio assistant visual acceptance

The owner requested this handover on 29 October 2026, then explicitly requested immediate
merge and closure of epic #2194 without waiting for CI or another Codex review. This is a
delivery decision, not evidence that visual parity or every original acceptance item passed.

Copy this prompt into Claude:

---

Complete the visual comparison of Arke Studio's global **Arke · Studio assistant** dialog
against the approved **turn 239, revision 2** design master. Use KISS: fix discrepancies within
this surface; do not redesign it or expand the recovery epic.

Start from current `main` in `michaeljosiah/ArkeStudio`, including PR #2197. Read `AGENTS.md`,
`CLAUDE.md` and the client package guidance. Use an isolated worktree. The private specifications
live in the sibling `arke-studio-specs` repository or `ARKE_PRIVATE_DOCS`; PR #108 accompanies
the implementation. Relevant acceptance: SPEC-061 R-29 and design turn 239.

## Sources

- `design-system/global-chat-239.review.html`: approved review, frames 239a–239h.
- `design-system/global-chat-239.notes.md`: approval, sources and interaction requirements.
- `design-system/global-chat-239.frames.mjs`, `global-chat-239.css`, and
  `global-chat-239.reference.css`: deterministic master frames and styling.
- Existing references: writing-room turns 227a/227k/227m, Activity 206b and the approved shared
  composer/ModelChip. Reuse current native icons and design tokens.
- `packages/client/src/components/studio-assistant.tsx`, `studio-assistant.css`,
  `studio-assistant-context.tsx`, and `packages/client/src/lib/studio-assistant.ts`:
  actual implementation.
- `packages/client/test/studio-assistant-view.test.tsx`: existing fixtures and interaction tests.
- `docs/development/recovery-acceptance.md`: measured evidence and retained limitations.

Do not alter the approved master to conceal implementation differences. Preserve World Chat
and production Builder Chat as their existing separate surfaces.

## Comparison matrix

Capture master and implementation with identical state, content, selected model/effort, fonts,
renderer, zoom and device pixel ratio. Use deterministic synthetic diagnostic data. Do not delete
real files, submit paid work or call a model for screenshots. If a fixture is needed, render the
actual production components rather than a second hand-built implementation. Also verify the
packaged native surface.

| Frame | CSS viewport | State |
|---|---:|---|
| 239b | 1360 × 820 | Welcome |
| 239c | 1360 × 820 | Diagnosis and storage remedy |
| 239d | 1360 × 820 | Separate cleanup approval |
| 239e | 1360 × 820 | Named, editable World Chat handoff |
| 239f | 390 × 844 | Phone diagnosis |
| 239g | 834 × 900 | Tablet welcome |
| 239h | 390 × 550 | Reduced keyboard viewport and approval |

Run every row in light and dark. Frame 239a is the existing Activity shell reference. Save paired
screenshots, side-by-side images, aligned overlays and difference images. Record viewport, DPR,
zoom, fonts, renderer version, fixture state and any narrow dynamic masks. Do not mask geometry,
controls, icons or whole cards. Source/DOM checks alone do not demonstrate visual parity.

Verify:

- Desktop: 440px floating dialog, 12px corners, full border/shadow, top 50px, right 10px, bottom
  12px. Underlying page keeps its width. Header/composer stay fixed; messages scroll independently.
- Identity/scope: Arke, Studio assistant, History and Close; persistent Studio / Setup, local AI
  & help. Navigation never silently retargets the conversation.
- Typography, wrapping, spacing, surfaces, icons, composer, ModelChip and supported effort control.
  Retain the existing lowercase Arke welcome mark.
- Tablet below 1100px: modal overlay, maximum 520px width, 16px outer gaps, inert background and
  contained focus. Phone below 600px: all four corners rounded, 12px outer gaps/safe areas,
  44px controls and reachable send/close controls above the keyboard.
- Opening focuses the composer; dismissal returns focus. Closing/reopening retains the draft
  and leaves work running. History, Tab navigation, Escape and scrolling work.
- Activity/Settings cover the retained conversation without duplicating it. Notices never force
  chat open. Reviewing cleanup does not approve it. Handoff creates an editable draft in the
  named destination without sending it or merging transcripts.
- Report physical-device keyboard testing separately from a reduced browser viewport simulation.

Fix every unexplained discrepancy, repeat affected comparisons and retain durable evidence.
Run focused client tests and relevant repository gates. Commit, push and raise a focused PR.
Code review must never exceed three rounds and ends sooner when no P1 findings are returned.
Report precise passes and remaining limitations; do not claim 1:1 from visual impression alone.

## Previous session facts

Installed Windows checkpoint: `23bedea1f`. The owner confirmed GPU numbers in the preceding build;
the subsequent shutdown-window correction was installed and file-verified. This installed copy
predates the final inventory/model-review changes. Build current merged source for native testing.

Codex's browser rejected acquiring the approved `file://` review tab because only HTTP(S) is
allowed, even after explicit owner approval. No matched-master comparison passed. Implementation
screenshots under `.dev/studio-239-check/` in the original worktree are context, not parity proof.
The original approved review tab belongs to the user.

Keep this handover visual. The acceptance record also retains incomplete coverage of some
non-Ming native generation/scratch write plans and broader native/platform qualification.
Do not silently expand this task to implement those, or relabel them as tested.
