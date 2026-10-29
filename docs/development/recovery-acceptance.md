# Recovery acceptance and user journeys

Epic #2194 / PR #2197 is not fully accepted. Component tests and a green build do not establish
the complete user experience. This record separates the 28 October 2026 application walkthrough,
native lifecycle checks and outstanding qualification.

## Repeat the browser journey

Build the real client for the isolated host, then start the qualifier from an interactive terminal:

```powershell
$env:VITE_ARKE_WS = 'ws://127.0.0.1:4416'
$env:ARKE_DEV_ORIGIN = 'http://127.0.0.1:4415'
npm run build --workspace @arke-studio/client
node --import tsx scripts/qualify-recovery-ui.mjs .dev/recovery-ui-new-run
```

The directory must be new and inside this checkout's `.dev`. The qualifier copies the public
fixture world and uses production client/coordinator composition, authenticated sockets and real
settings/history files. It serves only client build assets. Its private `session.private.json`
provides the normal browser session capability; never copy that capability into documentation,
screenshots or a public asset/bootstrap endpoint. Open the UI with the normal `arke-session`
fragment handoff. Restart mints a new capability; reconnect using the new handoff and reload.
This developer-browser step does not qualify desktop startup IPC.

Runtime responses and available capacity are synthetic. Both runtime overrides are explicitly
selected within the test profile. Installers/model downloads refuse, and no paid provider or
personal world is used. In the qualifier's terminal, one JSON command per line controls faults:

```json
{"action":"report"}
{"action":"storage","freeGiB":1}
{"action":"storage","freeGiB":100}
{"action":"health","healthy":false}
{"action":"health","healthy":true}
{"action":"restart"}
{"action":"stop"}
```

`observations.json` retains non-secret policy/readiness observations. Synthetic faults do not
prove real model installation, physical disk exhaustion, actual runtime compatibility or GPU
release. Keep the scenario and actual native-model qualification results distinct.

## Observed results

| Journey | Evidence and result |
|---|---|
| Local sign-in → Settings → Diagnostics | Real app navigation completed. Ordinary recovery controls are visible; Advanced starts closed. |
| Change download preferences → Save | The authenticated command returned a correlated confirmation and the control file held the selected values. |
| Defaults without Save → coordinator restart | The previous saved 65-file/45-minute preferences survived. Merely editing defaults did not overwrite them. |
| Clear/retype a number | Found and fixed an empty input becoming zero. A blank now remains editable; invalid values disable Save and ranges are visible. |
| Change a saved draft or restore defaults | Found and fixed a stale Saved message. The draft now says Unsaved changes until explicitly saved. |
| Open/refresh Ollama while another engine is working | Found and fixed GPU admission during a read-only health check. The native application regression holds Ming's lane, checks healthy/failed/healthy transitions and forbids competing unloads. |
| Healthy Ollama with no installed language model | Found and fixed the provider rail saying not answering. Runtime readiness is independent of model availability. |
| Disk-pressure event | A 1-GiB synthetic reading produced a proactive notice, System/Activity attention and a retained incident before a world was opened. A stale reading became unknown, not healthy. |
| Runtime health loss and restoration | The local-AI readiness gate changed false/true with both services' health. System showed unavailable/failed states and Diagnostics retained the event. |
| System → Diagnostics | A direct handoff opened the live Diagnostics page. Unknown GPU readings remained unknown. |
| Keyboard and phone | System Tab/Escape and focus return passed. Settings actions remained reachable at 390×844 and reduced 390×500. Light/dark rendering was inspected. This is not physical keyboard/device acceptance. |
| Native managed-service recovery | Seventeen focused application/readiness/lifecycle cases passed, including real owned child crashes, durable retry policy, cleanup uncertainty and cancelled setup activation. Runtime responses in those child fixtures are synthetic. |
| Actual local Studio delegation | One run interrupted at the diagnostic phase after two real completions. A test-only observer on a subsequent explicit run saw valid response schemas/references, all three completions, requester-only privacy, canonical history restoration without replay and both native shutdowns. The first failure remains unexplained. |

The native-model observation records only response byte counts, schema validity and reference
counts, not prompts/replies/credentials. It delegates to the original runner and leaves its
execution/ownership checks intact. A successful rerun does not resolve the earlier failure.

## Open acceptance

- **Live Studio reliability:** explain the first diagnostic interruption and establish a
  useful, recoverable user-facing failure path. Do not call this route reliably accepted based
  on the successful rerun or automatically replay its interrupted request.
- Actual mandatory managed-runtime downloads/installation and packaged Electron startup,
  desktop notifications, microphone/speaker interaction and physical GPU handover need their
  own application/device checks. This isolated browser fixture does not establish them.
- Complete output/scratch/export admission, remaining repair owners and Studio controls,
  other-platform/fault coverage and the approved turn-239 matched visual comparison remain
  open under SPEC-061/062. This journey is not a substitute for the design-master comparison.

## Final pass: failures found and corrected

The later real-client run starts with both selected fixture services unhealthy: first-run
completion remains disabled. Making both healthy advances to the library. A later health
failure leaves the current workspace usable and presents actionable Diagnostics/Activity status.
Capacity remains synthetic; no installer or model runs in this browser fixture.

The phone walkthrough exposed diagnostic text squeezed to a few characters per line. Evidence,
notes and manual guidance now wrap independently; affected recipes start in a collapsed disclosure.
Expanded consequences were checked at 390×844, with dark/reduced-height and tablet navigation also
inspected. An external ComfyUI failure now names the user's next step and the actual Settings path,
without offering to restart that installation. These are actual implementation captures, not
the still-required turn-239 design comparison.

Studio now retains a closed private interruption reason for malformed responses, unverifiable
evidence, model failure, cancellation, delegation limits and host shutdown. Existing history
remains readable. The card explains a next step; acknowledgement retains that explanation without
resubmission. Raw errors/rejected replies are not added to history, diagnostics or shared state.
The specialist prompt enumerates the allowed evidence IDs explicitly; verification still refuses
invented references. This improves the failure path and is not proof that the earlier failure is fixed.

A further real-model run completed the main and diagnostic responses with valid references, then
failed during the final native call. Shutdown also failed to confirm the original OpenCode exit.
The qualification lock remains; it was not deleted to force another run. A later read-only native
query found neither that writer port nor the qualification's Ollama executable still running.

A focused native regression reproduced a related cleanup gap: the tree-kill dependency can
return without terminating the captured child. Forced termination now waits briefly, then tries
the captured child handle. Descendants still require confirmed reaping and failed cleanup still
retains ownership. The regression failed before the change; both fallback and all-termination-
routes-fail checks pass afterward. This mechanism alone does not explain the final model failure.

The first broad fault pass recorded 297 passes, one timeout and one platform skip. Its combined
root/reparse case passed alone; those independent native scenarios now have separate existing
deadlines, with every refusal and protected-byte assertion retained. Subsequent native runs and
the real-model rerun remain qualification work; do not describe an earlier green checkpoint as
acceptance of these later changes.

The completed final serial matrix on public `352e97392` reports **301 cases: 300 passed, one
platform-specific skip, zero failures or cancellations**. The fresh actual-model run completed
all three calls, requester-only privacy, canonical history restoration without replay and both
native shutdowns. Full workspace typecheck, lint (seven existing warnings), production build and
main-bundle load smoke pass. Separate actual sandboxed Electron transport and startup-presentation
checks also pass. These results overlap focused runs and must not be added together.

The checkpoint's Windows CI shard 4 exposed one additional test seam: original-cleanup failure
must refuse the complete forced-stop owner, including its new captured-handle fallback. Both
native failure fixtures now do so and still require the exact original cleanup proof after a
successful retry. This changes fault injection, not production cleanup or its acceptance rules.
Both complete supervisor/original-cleanup suites pass all twenty cases under CI's Node 22 after
this correction; coordinator typecheck and lint also pass.
The fix requires its own CI. Remaining implementation, packaged-install/device and matched
design-master acceptance listed above are unchanged; the full epic is not closed by this pass.

That follow-up passed twenty of twenty-one CI jobs; Windows shard 5 refused native cleanup
preparation. Investigation reproduced a deadline mismatch: the worker's old fourteen-second
timer included lifetime binding and a delayed durable worker grant. A fifteen-second grant
returned an unknown outcome before any deletion. Native cache commands now allow thirty seconds
for startup/admission, then the existing fourteen seconds for execution, with a forty-four-second
native-worker ceiling. Original admission/close work remains retained until settlement. Input
remains withheld until the original grant; expiry/cancellation still
preserves unknown outcomes and original owners. Test deadlines derive from the supported native
operation budget rather than an unrelated thirty-second total for several commands. A failed
real preparation now prints only closed native mode/state/reason facts for diagnosis.
The regression fails before the change; all twenty-nine native cache cases pass afterward on
Node 22. Three actual authenticated cleanup/maintenance host cases, coordinator typecheck, lint,
desktop build and main-bundle load smoke also pass. The new checkpoint still requires its own CI.

## Installed checkpoint and Studio remedy reuse

Public `99b084d37` passed all 21 CI jobs, Effects and Engine. Its Windows x64 NSIS installer
was built locally with publishing disabled. The existing bundled tools were reused only after
manifest, architecture/version and pinned OpenCode executable verification; the licence and
packaged-resource gates passed. The installer is prepared for a normal upgrade after the current
remote-access host quits. Building the installer does not establish installed-app acceptance.

The latest Studio diagnostic message now offers current remedies and a direct Diagnostics link.
Storage review reuses the existing scoped cleanup control, with separate approval and no model
call or repair caused by opening the conversation. Nine focused client interaction checks pass,
including the shared control's stale-target, reconnect and cancellation behavior. Historical
observations remain labelled as observations; the repair control uses current host state.

Restore temporary viewport overrides and stop the qualifier's original host when finished.
Clear the two build environment variables before the normal production build. Retained test
worlds/private fixture conversations are not automatic cleanup candidates.

## Publication file admission

Publication capture, directory copying, stored ZIP output, pinned archive and expanded extraction
now use the shared finite-copy registry with a separate export owner. Known payloads and bounded
metadata are admitted on the actual destination; retained copies are counted by current capacity.
Story publication's second input copy also joins that registry. Native render peaks, pre-dispatch
generation planning and other export owners remain open; this is not full storage acceptance.

The final affected capture/delivery/playback/video/story/import pass reports 112 cases: 109 passed,
three existing skips, zero failures/cancellations. All 21 desktop publication-host cases pass.
New scenarios preserve sources and previous editions across competing reservations, separate full
scratch/destination volumes, a capacity loss between pinning and extraction, and a held capture
before payload writes. The initial extraction fixture failed to classify Windows extended paths;
its separate-volume mapping was corrected, then the complete affected suite passed. No real volume
was filled. Final coordinator/desktop types, lint (seven existing warnings), workspace build and
main-bundle load smoke pass. The new source checkpoint requires its own CI.

## Packaged first-run walkthrough

The Windows x64 packaged executable ran with its own empty app root and Electron profile.
Managed Ollama reached ready, while ComfyUI downloaded into that root's pinned resumable staging.
Pause was confirmed in the UI and receipt; the mandatory local-AI gate stayed disabled. Runtime
settings and Diagnostics remained reachable before a world was created, and managed ComfyUI was
the default. No personal runtime override or creative record was changed. Normal window close
exited the test host; both retained Ollama ledger PIDs were independently confirmed absent.
Dead ledger entries are retained for normal startup reconciliation, not cleared by the qualifier.

The walkthrough exposed a false 245-GB completed-download total: startup added unselected catalogue
sizes as completed bytes. The meter/ETA now describe the named active transfer, and unrelated
catalogue entries no longer inflate setup progress. The regression fails before the correction;
all thirteen launch/lifecycle and remote-label checks pass afterward. Client types and lint pass.
This is packaged-executable qualification, not an installed upgrade, completed runtime setup or
matched design-master acceptance. The paused ComfyUI prefix is retained for explicit resumption.

The corrected package reopened the same isolated root with ComfyUI still paused. An explicit
Resume reused the retained prefix; the active meter showed the actual 1.9-GB archive. Extraction
and managed-service startup completed, then the mandatory gate advanced automatically to first-run.
The System dialog reported both managed ComfyUI and Ollama ready. This establishes the packaged
download/readiness journey, not an installed upgrade, inference/GPU handover or visual acceptance.

Windows CI on `693aa6bbe` passed twenty of twenty-one jobs; the extraction-capacity fixture missed
its expected hold. The fake volume mapping now canonicalizes destination paths and exercises an
explicit directory alias. All twenty-five delivery cases pass on Node 22, preserving the capacity
loss, original-ZIP and settlement assertions. Coordinator types and lint pass. Production admission
is unchanged; the corrected fixture still requires its own CI.

On the next normal launch, the same root reused its installed runtimes and reached first-run
without another runtime download. A new disposable world was created through Form → Decide later;
Studio and System opened without sending a model request. A controlled exit targeted only the
candidate's idle managed ComfyUI Python child, after checking its executable, parent and creation
time. Arke started a new owned process and recorded Automatic restart → Readiness verified. The
world remained usable. The previous host's eight original child PIDs were independently confirmed
absent after normal close; the personal installed host was not stopped or replaced.

The fresh-root walkthrough also exposed optional model offers becoming recovery incidents. The
existing Diagnostics catalogue still lists missing optional weights and their download controls,
but those available/skipped offers no longer create proactive incidents or alerts. Actual setup
holds and failures keep their existing behavior. The regression failed before this correction;
all 23 recovery-history cases pass on Node 22 afterward. Previously retained observations are kept,
not silently cleared or reported recovered. This does not complete the remaining epic acceptance.

## Finite document exports and Windows path aliases

DOCX/EPUB manuscripts and recording-script PDFs now admit measured payloads, destination metadata
and replacement manifests through the shared export owner. All twenty affected export and
compatibility tests pass, including world close during admission and full-destination holds.

CI on `a6cb708d4` passed 24 of 25 jobs. Windows shard 8 found a test comparing its short temporary
path (`RUNNER~1`) with the exporter's canonical path. The assertion now compares canonical paths
and the fixture explicitly uses a directory alias; all eight world-export cases pass locally.
Production path handling is unchanged. The corrected checkpoint `a9eef5b9a` passed all 25 CI
checks. Native render/scratch planning and matched design-master acceptance remain open.

## Studio dialog sizing and entry focus

Source comparison with approved turn 239 found the tablet boundary at 1024px rather than 1100px,
a missing composer scope label and an extra repeated agent label. The implementation now follows
the approved boundary and labels. Browser measurement also exposed fractional viewport widths
falling between integer media-query boundaries; exact `width < 1100px` / `width < 600px` queries
keep layout and modality aligned. Phone composer controls now measure at least 44px.

The real client was checked at 1360×820, 834×900, 390×844 and 390×550 in light and dark, using
the existing isolated onboarding host with no model configured. Desktop remains nonmodal;
tablet/phone use the native modal dialog. Measured shell widths are 440/520/366px respectively,
with 12px corners and no horizontal overflow. Close returns focus to Chat. Eight Studio interaction
tests plus ten existing composer/overlay tests pass, including entry focus that does not repeat
after a busy period. Temporary viewport and theme choices were restored.

These are implementation captures and source comparisons, not matched master captures or actual
microphone/keyboard-device qualification. The approved master browser preview remains inaccessible;
diagnostic/repair cards, supported model effort and the remaining epic acceptance stay open.

## Studio measured storage cards

The latest storage diagnosis now includes host-measured available space, drive capacity and the
warning reserve in the turn-239 fact-card layout. System and Studio share volume grouping and
pressure derivation; aliases do not add capacity. Historical diagnostic text stays separate from
these updating readings. Stale/disconnected values are labelled as earlier measurements, future
values are withheld, zero remains a real measurement and unknown quotas/scope remain disclosed.
The cards do not infer an export hold, required peak, shortfall or completion guarantee from free
space. Existing cleanup review and approval still use their original host controls.

All fourteen focused storage-card, Studio and cleanup interaction tests pass; client typecheck,
build and lint pass. Browser checks used the real components with explicitly synthetic readings
at desktop, phone and reduced phone sizes, in light and dark. They exposed and corrected a heading
running into its explanation. The fact grid has no horizontal overflow and the reduced viewport
keeps the composer and scrolling remedies reachable. These component captures are not a live
storage fault journey or matched master evidence. Operation-specific plan cards and the remaining
epic acceptance are still open.

CI on `b53d9c071` exposed an existing Windows timing assumption in the socket-writer test:
a delayed send-timeout callback starts the separate close deadline later, so a 40-ms sleep
does not prove that both callbacks ran. The tests now advance a controlled clock through each
deadline and verify both the pre-deadline and post-deadline behavior, including disposal.
Production socket behavior is unchanged.

## Studio effort selection

The existing model chip now accepts a per-conversation effort choice when the model catalogue
declares a supported value. The choice follows the explicit send through preparation, disclosure,
the private manifest, native session and provider body. Changing models clears it; delegation to
a different diagnostic model retains that model's default. Reconnect does not resend. A removed
or unsupported choice is refused before inference. Default keeps the existing operational policy;
the Studio labels do not describe it as Medium or describe Off as Minimal.

The focused contract, client, runner, service and managed transport tests pass. OpenCode 2.0.26
with the production managed composition and an isolated synthetic provider verifies unsupported
High sends nothing, followed by exactly one explicit-default request and confirmed retirement.
The native fixture's catalogue does not offer nondefault efforts; its result does not qualify
nondefault model behavior. Those values have protocol fixture coverage, not live-model evidence.
Browser component checks at desktop/light and reduced phone/dark verify selection, keyboard
return to Default, focus and no horizontal overflow. The catalogue is explicitly synthetic;
these captures do not establish matched master parity or finish the epic's remaining acceptance.

## Ming write planning

The worker now plans the full dependency set before extracting any entry. Extraction verifies
each stream's declared size. Audio's existing ten-minute and 64-MiB limits are checked before
the WAV write, with inter-chunk silence included. Standard-library tests cover a bad final
dependency leaving the first untouched, oversized/truncated streams and generated audio refused
before its writer is called. Existing cloning/freeform task mapping remains covered.

Native extraction of the already-downloaded, hash-verified dependencies matched the plan exactly:
35 archives / 139,479,516 bytes for 0.5B and 35 archives / 248,768,939 bytes for 7.9B. Temporary
extraction had a measured free-space precheck and was removed afterward; it ran no model/GPU.
These checks establish known expansion/audio bounds; the shared admission evidence below is
separate from extraction and narration quality.

Current-session batch settlement now follows the exact original native owner, including later
cleanup after an unconfirmed exit. The 13 speech/process checks include real native failure and
retry: inputs remain while the worker can run, then disappear only after confirmed native/log
and host-file settlement. A cancelled GPU waiter removes only its own unlaunched batch, and a
failed settlement prevents replacement until retry. These checks do not establish restart
reconciliation, storage admission or a new narration-quality result.

The subsequent storage integration reserves known batch inputs/expansion/audio and a monitored
2-GiB additional cache-growth estimate on the actual staging/cache volumes, sharing other owners'
reservations. Low-space/unknown checks occur before reference copying and again before native
launch after the GPU wait. Confirmed host writes reduce remaining need; uncertain native exit
holds affected new admissions. Cache metadata monitoring cancels only its original worker on
unavailable measurement or excess growth, retaining the lease through original native/file exit.
The growth estimate is conservative polling, not a quota or a guarantee against fast/external writes.

Synthetic-capacity checks cover shared/separate volumes, competition, post-wait recheck and
uncertain/confirmed settlement. Real bounded worker fixtures verify growth cancellation and
later cleanup. A force-closed native Windows host proves reconciliation uses its exited process
identity plus its original global job, not merely a new host's empty worker list. Missing/empty
job proof releases planning only; retained files are not deleted. An abandoned metadata call
keeps the lease until its original read closes. Broader native owners and installed/design
acceptance remain open; this is not completion of SPEC-062 or the epic.

Offline model checks on 2026-10-28 used the actual managed Python, unchanged downloaded models,
native capacity collection and shared reservation service. 0.5B returned 732,104 audio bytes in
52.6 seconds; 7.9B returned 726,812 bytes in 266.5 seconds. Both observed a live reservation and
ended with no worker, no new batch directory and zero reservations. Existing-cache growth was
221,250 and 5,186 bytes respectively. These are warm-cache compatibility checks, not cold-cache
upper bounds or new listening judgments. Their private evidence/audio are under the gitignored
`.dev/ming-integration/storage-{dense,tiny}-*` outputs; no model download or installed-service
restart occurred.

## Known storage shortfalls

Admission now reports the numbers used for known multi-drive checks. Studio shows measured
available space, existing commitments, remaining writes, reserve and deficit for each drive.
The latest failed check is expanded; earlier checks use a disclosure. Checks remain explicitly
historical and are separate from live capacity and operation status. No waiting export, job
count, retry button or cleanup permission is inferred from a rejected check.

The host retains at most 16 anonymous checks for 15 minutes, without paths or owner names.
Only observations within 60 seconds contribute a grouped volume warning; unknown output and
missing measurements do not produce numeric claims. The queue's bookkeeping-only assessment
is labelled preparation space rather than an estimate of the eventual generated media.

The focused run passes 62 coordinator, 33 contract and 14 client cases, including authenticated
reconnect, observer isolation, same-drive aggregation, separate-drive shortfalls, privacy and
recovery hysteresis. Actual Studio component captures use synthetic values at 1440×900,
800×1000, 390×844 and 390×480. Desktop/phone light and dark captures and the reduced-height
scroll check are in the gitignored `.dev/studio-239-check/shortfall-*.png` files. These show
readable values and retained composer space; they do not establish installed-device acceptance
or comparison with the approved master. Live pending-work counts/status, other generation
write plans, broader attachment support and the existing native/design gates remain open.

## Installed Windows update — 28 October 2026

The installer for production checkpoint `b2ce967fc` was built with publishing disabled and
installed into the existing per-user Arke Studio location after the owner closed the app.
The installer exited successfully. SHA-256 comparisons matched the installed executable,
complete application archive, client entry and referenced JavaScript/CSS, and loose Ming
worker/licence files against the verified package. Arke remained closed after installation.
The installer SHA-256 is
`7a144887a1c35a5b01b8de55f246f8f64ce8fe71e83005375a00ca6882d0fe87`.

All 25 CI checks passed for `b2ce967fc`. The existing main-bundle load and sandboxed Electron
file-page transport smokes also passed. These checks establish installation and package identity;
they do not establish
normal reopening of the owner's workspace, device interaction or matched design acceptance.
Native desktop control was unavailable in this session. The owner reopened Arke and confirmed
that the workspace loaded and services looked correct, but GPU numbers were missing.

The NVIDIA tool returned counters directly but failed through Arke's actual owned runner with
`Failed to initialize NVML: Unknown Error`. Restoring only the standard Windows `ProgramFiles`
variable reproduced a successful read; the corrected production probe reported 10% use and
2,239,758,336 of 10,737,418,240 bytes in 4.46 seconds. The worker's native ownership and cleanup
were retained. This source-level hardware result still requires an updated installed build.
The broader acceptance gaps above remain open.

The follow-up installer for `753489564` completed on 28 October at 23:13 UTC. Its SHA-256 is
`1da401265d6de5bc291589e4394573bea914fa30b532649d67a6cb1c0cdbb2fd`.
Installed executable/archive/client assets and Ming files match the verified package. The owner
reopened Arke and confirmed **GPU numbers now appear**. Full workspace typecheck, lint, build,
main-bundle load and bundled-runtime licence checks pass for this code checkpoint.

The preceding build did not finish exiting after its window closed. Its GPU worker was absent,
but the child record remained and three Electron processes persisted. Only those exact processes
were ended after checking executable paths and creation times, before installing the update.
This is a retained shutdown observation, not proof of its root cause or that the update corrects
every shutdown failure. The installed GPU display is now verified; wider acceptance remains open.

The source now keeps an ordinary closing window alive while the existing before-quit owner
drains local work. A rejected cleanup can therefore show its existing warning instead of leaving
an invisible process. Only the owner's confirmed quit destroys the window. Remote-access
hide-on-close and update-specific handling keep their existing branches. Twenty-three startup,
runtime-owner and update tests pass, including delayed/failed cleanup followed by confirmed exit.
The follow-up installer for `23bedea1f` completed at 23:47 UTC on 28 October after the owner
closed Arke. Installed executable, archive, client assets and Ming files match the verified
package; SHA-256 is `33c1ff4373e0adedf36e2d5f924115ea2beb768e7e00cb4c10f3d844b4a16565`.
An isolated actual Electron window also passed delayed/failed cleanup retention and confirmed
retry exit. All 25 Windows/Linux CI, Effects and Engine checks pass for this checkpoint.
This does not establish why the old GPU cleanup was retained or finish the wider acceptance.

The new Windows CI run failed the Ming cleanup fixture's immediate PID-exit assertion. Its
readiness check could accept a newly created but empty PID file, which converts to process zero.
It now waits for a positive integer PID and identifies that PID in an exit-assertion failure.
Cleanup, GPU retention and no-replay assertions remain unchanged; all four native Ming cases
pass locally. This test-only correction needs its own Windows/Linux CI confirmation.

That correction is included in the all-green `23bedea1f` run above.

## Current storage work

Studio now distinguishes jobs waiting to submit, completed results awaiting local saving and
downloads blocked by disk. Counts use current typed owner observations, separate from earlier
space-check arithmetic. Unknown capacity/destination is labelled storage verification. The
existing Activity and Downloads controls own the next action; the card adds no retry or cleanup.
The queue observation stays outside the durable job schema, disappears on completion/cancellation
and is rebuilt by real checks after restart. Disconnected clients show last-reported counts.

Focused checks pass 26 queue storage, five contract, 15 client and 11 owned-process cases.
The process regression preserves the standard Windows installation location while withholding
an unrelated synthetic secret. Component captures with synthetic work cover desktop/light and
reduced phone/dark, including keyboard access to both actions and the 44-pixel phone button.
The captures are `.dev/studio-239-check/storage-waits-*.png`; they do not establish native
disk-failure behavior or matched-master parity. Browser testing resumed after owner approval.

## Scoped storage inventory — 29 October 2026

The storage overview now includes a collapsed seven-category inventory of fixed managed folders
and the open world. Preview counts reuse the existing receipt inventory; that subtree is excluded
from the metadata scan. Partial, stale and unknown sizes remain labelled, and no allocation or
recoverable-space claim is made. Scanning never reads media, follows directory links, traverses
the closed-world library or grants cleanup authority.

Seven focused inventory cases and six client storage cases pass. The earlier combined service
and authenticated cleanup/maintenance run passed 17 cases. A read-only metadata qualification of
the actual managed ComfyUI folder completed in 17.36 seconds, counting 58,989 runtime files and
4,401,516,248 logical bytes. This exposed an unsuitable whole-scan deadline; the collector now
abandons a stalled metadata call after 15 seconds without progress, while allowing bounded,
yielding slices to continue. A deterministic regression verifies that distinction. Unknown native
calls retain their read slot and cannot accumulate replacements or publish after cancellation.

The actual inventory component supports keyboard disclosure and has no horizontal overflow at
390×480 in dark mode. Its synthetic screenshot is `.dev/studio-239-check/inventory-phone-dark.png`.
This component check is not the approved-master comparison. Custom model destinations and other
write owners still require integration; this inventory slice does not complete the epic.

The managed Ollama store now follows its configured location through its two known model
subfolders. Seventeen focused storage/inventory tests pass, including relocated-store accounting,
unrelated-parent exclusion, default-store deduplication and observation removal on deselection.
External runtime installations and user-mapped ComfyUI folders remain outside automatic inventory;
the existing installer still observes the actual destination for their explicitly selected writes.

## Optional model removal review — 29 October 2026

Models and Downloads now share one review of the selected component, estimated installed size,
shared-file uncertainty and the need to download again. Cancel/Escape do nothing; confirmation
sends once. A changed installation requires a fresh review. Studio offers the existing Models
handoff only for a current removable installed model. No additional cleanup category is added.

The actual coordinator refuses an Ollama removal during local inference, then retains an idle
lane through the runtime's deletion response. It performs no eviction to acquire that lane.
Ming retains its existing file-change fence. Setup tracks removal/repair through shutdown and
refuses duplicate/concurrent changes to the same component. Old advertised-size “free space”
claims are replaced by an honest removal result and a fresh capacity request.

All 57 affected setup/removal, 17 GPU/coordinator composition and 17 ComfyUI repair cases pass.
All 57 Models/Downloads/removal-review client cases and seven Studio storage cases pass.
The actual component was checked at 390×480 dark: the review fits, Cancel receives initial
focus, Escape returns focus to Remove, and confirmation reaches the synthetic completion state.
No installed model was removed by this browser test. Screenshot:
`.dev/studio-239-check/model-removal-phone-dark.png`. This is component evidence, not the
still-required matched-master acceptance or proof about requests from other applications.
