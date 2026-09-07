# Story mode validation — 2026-09-07

The remaining implementation work in issues #888–#892 is implemented on `codex/story-followups`. The installed-app run for #893 exposed three follow-up failures. The source changes have not been installed over the user's existing app, so the two forms of evidence below are distinct.

## Issue disposition

| Issue | Implementation and verification |
| --- | --- |
| [#888](https://github.com/michaeljosiah/ArkeStudio/issues/888) | Retire and restore chapters without deleting prose or history; move active chapters in the outline; exclude retired chapters from dashboard, continuity and manuscript export. Coordinator persistence/order/export and client outline tests pass. Commit `34406a30`. |
| [#889](https://github.com/michaeljosiah/ArkeStudio/issues/889) | Settle dramatic question and ending in the overview; propose an ordered set of planned chapters in one card. Existing proposal authorities handle acceptance and receipts. Overview and outline acceptance tests and client overview tests pass. Commit `bfeb60cb`, with prompt regression correction `4426406e`. |
| [#890](https://github.com/michaeljosiah/ArkeStudio/issues/890) | Assemble the current plan, preceding active chapter ending, story/style and draws through leased reads with receipts. Preserve the chapter subject on retry and refuse incomplete or oversized context. Real retrieval, receipt-fence, retry and scope tests pass. Commit `9ba424ab`. Live staging behavior still requires retesting after packaging; see #952. |
| [#891](https://github.com/michaeljosiah/ArkeStudio/issues/891) | Show the current plan and actual overview staleness on the dashboard and open the chapter workspace. Record positive word increments by local day in the same gated commit as prose. Concurrent, stale and corrupt-progress tests and dashboard navigation tests pass. Commit `793b8307`. |
| [#892](https://github.com/michaeljosiah/ArkeStudio/issues/892) | Remove the legacy draft-chapter command/sender/registry path and document the implemented workspace in SPEC-012, the architecture guide and code map. No legacy draft-chapter or draftChapter references remain in packages/docs. Relevant canon regression passes. Commit `99695eb1`. |
| [#893](https://github.com/michaeljosiah/ArkeStudio/issues/893) | Installed-app run recorded below. The intended drafting-to-canon journey is not yet validated end to end; follow-ups #952–#954 remain. |

## Source validation

- Focused tests, affected contracts/coordinator/client typechecks and affected lint passed after each implementation issue. Each issue was committed and pushed before starting the next.
- Full `npm run lint`: passed.
- Full `npm run build`: passed; existing client bundle-size warning remains.
- Full `npm test`: 5,860 tests, 5,857 passed, two skipped, one failed. The failure identified missing continuous-story guidance in the expanded planning prompt. The guidance was restored; the affected entry-context file then passed all 17 tests, followed by coordinator typecheck and lint. The full suite was run once, not repeated after this one-line correction.
- Validation ran on Windows with Node 24.11.1 and worktree-local workspace dependencies. Linux CI remains a separate check.

## Installed-app run for #893

Environment: installed Windows app **0.5.49**, configured live **Claude** harness, local **Kokoro/Voxa** narration. A new Story production, `story-validation-893`, was created through the UI inside the existing **E2E Proving Ground** scratch world. The chapter file is `chapters/untitled.md`; the conversation is `cv_01M1XPR7PTXJ8R92QDRGNZ5T3H`. No stub provider or development coordinator was used.

| Requested step | Observed outcome |
| --- | --- |
| 1. New chapter, synopsis, point of view | **Passed.** New chapter opened the workspace. The synopsis and Wren Halloway point of view persisted in chapter frontmatter. An accidental pronoun conflict in the initial test synopsis was corrected before the decisive drafting attempt. |
| 2. Draft from the synopsis, accept, inspect prose/draftedAgainst/Implies | **Failed — [#952](https://github.com/michaeljosiah/ArkeStudio/issues/952).** With the corrected synopsis and an accepted overview at v1, the live model returned prose only. No chapter card appeared; the chapter stayed empty and Implies stayed at zero. An explicit staging follow-up also refused chapter authorship. There was no accepted draft or draftedAgainst stamp to inspect. |
| 3. Implies → Propose → canon decision | **Blocked by #952.** No Implies fact or Propose control became available. The explicit staging workaround created four canon cards and an open-thread card directly in the conversation. They were left unaccepted and do not count as passing the requested Implies route. |
| 4a. Type prose, leave, return | **Failed after a plan edit — [#954](https://github.com/michaeljosiah/ArkeStudio/issues/954).** Prose autosave was refused as stale after the workspace's own synopsis change. Leaving and reopening lost the test text. A fresh reopen followed by typing the same 73-word passage saved successfully; its `Validation autosave marker 893.` survived Dashboard → Chapters → chapter navigation. |
| 4b. Read the chapter, stop midway | **Playback and UI stop passed.** The independently saved passage entered playback and reached paragraph 2 of 3. Stop returned the button to Read the chapter; it remained idle through navigation and return. The installed logs expose no per-synthesis cancellation acknowledgement, so stopping the underlying in-flight engine work was not independently established by this run. |
| 5. Change overview; chapter says overview moved | **Blocked by #952.** No accepted generated chapter carried draftedAgainst. Manually entered prose is not evidence for this requirement; no stamp was fabricated to make the check pass. |

Additional failure: [#953](https://github.com/michaeljosiah/ArkeStudio/issues/953). Accepting the overview through its existing side panel saved story.json v1, but its conversation card remained Needs your decision with Approve/Deny buttons after navigation and another completed turn.

### Diagnostic evidence

The detailed reproductions and log excerpts are in the three linked follow-up issues. Key records from the installed app:

- Corrected-synopsis draft: conversation event seq 14, run `run_01M1XQ4KW9DB0NVPMVV2ZRTS8R`, Claude, `2026-09-07T10:38:04.169Z`–`10:38:55.721Z`; completed with zero candidates and zero action-prepare intents despite containing the draft prose.
- Overview acceptance: coordinator event seq 132997, `2026-09-07T10:36:41.569Z`, `proposal.resolved`, proposal `pr_01M1XQ1AZ3Y2K14A9BZGF4JDNR`, outcome `accepted`. Its conversation action `act_01M1XQ1AWDH5CVECP6E14GX0X7` retained its pending binding.
- Refused autosave: coordinator event seq 133057, `2026-09-07T10:45:17.430Z`, `chapter.save-result`, `disposition: refused`, reason: `commit refused: base moved for productions/story-validation-893/chapters/untitled.md — staleness is detected, never merged`.
- The immediately following open-result returned an empty body and version 1. The independent fresh save at `2026-09-07T10:47:48.279Z` returned `disposition: saved` and persisted the 73-word test passage.

The scratch production and its conversation are retained for reproduction. No test canon cards were accepted. Keep #893 open until the blocked steps and engine cancellation have been checked on an installed build containing the fixes.

## Follow-up implementation — #952–#954

On `codex/story-893-fixes`, the drafting brief now explicitly requests a chapter action and the existing Implies schema (#952); proposal-manager decisions reconcile their conversation cards, including pending cards (#953); and chapter autosave refreshes same-version bases while retaining refused drafts across navigation with explicit recovery choices (#954). Each issue was committed and pushed separately after focused regression checks.

Further installed-app validation for #893 is assigned to the user's separate app-testing agent. A brief follow-up attempt produced a chapter action with malformed Implies items; the prompt now supplies the required `kind`/`what` fields. That correction has focused automated coverage but has not been retested in the app. The installed app's original archive and client resources were restored after closing the temporary build.

The scratch chapter `productions/story-validation-893/chapters/untitled-2.md` remains for the app-testing agent. Its draft run `run_01M1YBYC84T1S80QZ86PYEJ8TZ` ended as failed after schema validation; no generated chapter was accepted. Keep #893 open for the end-to-end checks above.

Automated follow-up validation: full `npm run lint`, `npm run typecheck`, `npm run build`, and `npm test` passed (5,894 tests: 5,892 passed, two skipped). The desktop main-bundle smoke also passed. Each full gate ran once; the final Implies prompt clarification then passed its focused chapter-brief test, affected lint, and coordinator typecheck. The build retains the existing client bundle-size warning. Windows/Node 24.11.1 results do not replace Linux CI or the delegated app validation.
