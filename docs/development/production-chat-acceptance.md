# Production Chat film acceptance

Issue #1427 implements SPEC-051 R-1..R-3. The thirteen-step journey is the definition of
done for epic #1428. Scripted authority coverage and installed Windows acceptance are
separate evidence: a stub-provider export does not establish live model behavior, installed
playback or access to every gesture in the renderer.

## Scripted journey

From `packages/coordinator`, run:

```powershell
node --import tsx --test --test-timeout=240000 test/world-chat/production-acceptance.test.ts
```

The test drives the real chat runner, leased MCP reads and preparation receipts, permission
card lifecycle, native production mutations, provider queue, immutable take filing, in-thread
human editor decisions and cut export. The writing harness and media providers return fixture
responses. Speech admission uses the test queue; it does not test account or host speech policy.
The ordinary suite injects media probing and encoding so it needs no native tool installation.

To exercise the native export, install FFmpeg and FFprobe and set these variables before the
same command (PowerShell shown; on Linux use the equivalent environment assignments):

```powershell
$env:ARKE_PRODUCTION_ACCEPTANCE_REAL_MEDIA = '1'
$env:ARKE_PRODUCTION_ACCEPTANCE_DIR = '/absolute/path/to/acceptance-output'
```

`ARKE_FFMPEG` and `ARKE_FFPROBE` optionally name absolute executable paths; otherwise they
resolve on PATH. The native mode generates valid provider footage, probes each result and
encodes a twelve-second 1280 × 720 cut with audio. It verifies the three picture placements,
subtitle cue and SRT delivery. The output directory receives `report.json`, `review-cut.mp4`
and `review-cut.srt`; without it, the temporary world is removed at test shutdown.

The report retains every frozen permission card, human prompt, decision, pre-approval estimate,
dispatched job IDs, ledger totals and final action states. Providers are labelled `stub` and
installed acceptance is explicitly false. Denying creation and an image quote preserves the
production and starts no job. Every prepared card starts zero jobs and encodes; only approved
generation dispatches the eight purchases (three frames, three clips, one voice and one score).

The dedicated `production-acceptance` job in `.github/workflows/ci.yml` runs native mode on
Windows and Linux and uploads those three files. The ordinary sharded suite also runs the
injected-encoder case. Queue `test/queue/dispatcher.test.ts` covers failed Bench score filing:
the result stays retryable, and retry completes with one provider submission and one ledger row.

## Installed Windows journey

Use a disposable copy of a world containing two characters and a location. Record the installed
app version, tested commit, Windows version, writing harness/model and the media routes/models.
The installed build must contain the programme changes. Record any configuration needed before
the journey, including provider availability, character voice assignment and references. Keep
secrets out of the evidence. Agree the spending limit before approving real provider work.

Perform the following from the same Production Chat. The permitted gestures are typing,
Approve, Deny and the existing in-thread human decision controls. Capture the card before each
decision and its result afterwards; record each generation estimate and corresponding ledger
amount/source. A step requiring another screen is a failure against its owning child issue.

| Step | Request and verification |
|---|---|
| 1 | Create a short film in 16:9; deny once, verify no production was created, then approve. |
| 2 | Write a one-scene overview. |
| 3 | Create a scene with three shots and one line of dialogue. |
| 4 | Cast the two existing characters and the location. |
| 5 | Generate one start frame per shot; deny one quote first and verify no dispatch or charge. Review and select the resulting frames in the thread. |
| 6 | Generate one video take per shot; verify no job starts before each approval. Play the resulting clips. |
| 7 | Select one take per shot through separate take review decisions. |
| 8 | Voice the dialogue line and play the result. |
| 9 | Generate a score cue and play the result. |
| 10 | Assemble the selected takes; accept the in-thread editor request. |
| 11 | Place the voice and score on the cut; accept the in-thread editor requests. |
| 12 | Add subtitles and accept the in-thread editor request. |
| 13 | Export the cut, play it in the completion card and open the delivered file. Verify picture order, audible line and score, duration and subtitle delivery. |

Save the screenshots/card record, per-approval spend, exported file and sidecar, and a pass/fail
result for each step. Add the evidence location to #1427. Close #1427 and #1428 only after this
installed real-provider run passes; CI artifacts alone are insufficient.

On 2026-10-04, the installed run could not begin: the Windows computer-use JavaScript runtime
returned `failed to write kernel assets: The system cannot find the path specified. (os error 3)`
both before and after a runtime reset. No installed app state or real-provider result was
observed. Restore that runtime or perform the recorded journey manually to complete R-1.
