# Character audio foundation — Epic 110 / issue 117

The first delivery sequence is **117 → 255 → 111**. A director will generate a short character
speaking video or choose existing audio, explicitly assign the extracted clip, and automatically
reuse that clip when a scene's selected route supports voice references. The reference script
does not replace the scene's dialogue. Recording, cadence and exact-performance selection are
separate follow-on work.

## Implemented foundation

`packages/contracts/src/audio.ts` owns full hashes, source/range records, technical metadata,
QC, preparation provenance, transcript comparisons, rights, attestations and clearance. Existing
abbreviated artifact hashes remain valid; first audio use verifies their prefix and computes the
full hash. Optional `Provenance.audioAssets` freezes complete preparation evidence without changing
old takes. Transport routes, multimodal budgets and character bindings belong to issue 111.

`packages/coordinator/src/audio/` supplies these reusable operations:

- `prepareAudio`: resolves an artifact or ordinary/pass-segment take, freezes source bytes in
  staging, prepares canonical PCM, verifies duration and hashes, and caches a complete QC report.
  It returns a server-owned candidate; it never assigns, changes TTS, selects picture or spends.
- `acceptPreparedAudio`: revalidates the source and derivative, publishes the content-addressed
  WAV with an exclusive hard link, then invokes the consumer's ordinary metadata transaction.
  The consumer supplies the current kit/performance base hash and full frozen provenance.
- `appendAudioRights` / `readAudioRights`: append and flush exact-hash acknowledgement/withdrawal
  events under world ownership. Damaged or torn logs fail closed; a local-only sample needs no
  cloud acknowledgement. Repeating an identical event is idempotent.
- `clearAudioDispatch`: checks exact bytes, report version, warning acknowledgements, applicable
  attestations and current rights. Issue 111 must invoke it again just before physical submission,
  alongside its own route/intent/budget checks. A stored clearance is evidence, not lasting permission.
- `cachedAudioTranscript`: consumes the existing local transcription seam, caches by audio/text/
  engine/normalization identity, and keeps comparison text outside generic QC and provider history.

The desktop injects `audioMediaTools` only when explicitly resolved FFmpeg and ffprobe binaries
exist. Audio and existing video QC/poster/boundary extraction share the bounded process runner.
Cancellation and output/time ceilings kill the child; cleanup waits for process close. File
arguments are unshelled, and supported input formats/protocols exclude playlist/network inputs.

Canonical output is mono 48 kHz signed 16-bit PCM WAV. Preparation supports a reviewed range and
explicit gain; it does not denoise, remove silence or overwrite sources. Source files are bounded
at 512 MiB, canonical audio at 64 MiB and each media process at 30 seconds. Large source integrity
checks stream in 1 MiB chunks. Canonical output duration must match within 25 ms.

QC measures sample peak, RMS, full-scale samples, silence runs and DC offset. Whole-clip RMS at or
below -60 dBFS and boundary silence of at least one second warn. Digital silence has null dB values,
not JSON Infinity. Music, speaker count, speech presence, LUFS, true peak, noise and SNR remain
unavailable. Transcript comparison normalizes NFKC and whitespace only; a bounded word diff reports
case/punctuation/word changes without inventing timestamps. Human attestations do not relabel an
unavailable classifier as passing.

Provider capture summarizes nested data URIs and binary arrays as decoded hashes, size and type.
Capture persistence failure cannot cause a valid provider request to be refused or repeated.
Intentional prompt/TTS text still follows existing sensitive generation-history policy.

## Consumer integration still required

Issue 255 owns the character UI/design turn, speaking-video job/artifact workflow, legacy sample
read/revalidation, range audition, rights controls and explicit designation. It must retain the
server-side candidate rather than accept renderer filesystem paths or renderer-authored QC.
Generated artifact references can carry the source job/model/provider and generation-request hash;
the original artifact remains the authority for the full request. No dummy shot/performance is needed.

Issue 111 owns automatic speaking-character resolution, scene prompt instructions, per-dispatch
disable, dynamic model changes, exact provider routes, pricing, transport and frozen queued inputs.
These are not enabled by adding the foundation. No new video model capability is declared here.

Shared client QC/rights surfaces must follow the issue's design-master/prototype turn before
implementation. The backend foundation does not create a second consent panel or a second player.

## Filesystem and recovery boundary

Staging is `.staging/audio/<uuid>/`; QC cache is `.cache/audio-qc/<full-hash>/`; comparison cache is
`.cache/audio-transcripts/<audio-hash>/`. Rights live in `audio/rights.jsonl`. Durable WAV locations
belong to consumers. Path resolution checks every component for links, traversal, ADS and containment.
These checks and pre/post hashing detect changes; they are not an atomic fence against arbitrary
external filesystem mutation, consistent with the world's existing ownership model.

All mutations use `WorldStore.gateOp` or `ownedWrite`. Hard-link publication prevents a partial WAV
from occupying a canonical hash name. Metadata still uses the existing journalled commit. An
uncertain metadata failure can recover forward, so landed media is retained rather than guessed
unreferenced and deleted. Same-hash reuse verifies existing bytes.

`cleanupAudioStaging` removes only expired staging under ownership and takes a retained-operation
set for active reviews. Consumers must provide that set. It deliberately never collects durable
media: reference-aware collection must include future kits, performance records, queued jobs,
immutable takes and history before deleting any derivative. Cache deletion does not invalidate
accepted evidence. No world-open migration, source rewrite or provider-side deletion is implied.

Focused tests cover contracts, PCM fixtures, real WorldStore preparation/acceptance, source changes,
pass coordinates, path containment, rights withdrawal/corruption, local transcript caching,
clearance and provider capture. A smoke check with the bundled binaries exercises real trim/gain/
conversion and analysis. The 255/111 workflow and provider payload tests remain with their owners.

## Character sample consumer (#255)

The character Voice screen now contains a separate reference-sample panel above TTS. Speaking-video
requests use the durable queue and verified Seedance 2.0 reference routes, with an explicit quote,
accepted imagery and independent script. Reference finalization files every video as an immutable
artifact; it never selects a voice or picture. Existing artifacts, take ranges and explicit legacy
revalidation converge on `audio/character-sample.ts`. The client submits identities, never paths.

A prepared review can resume from its server-owned staging record after restart. Acceptance freezes
the full-hash provenance in kit.json and records an operation id for lost-response retries. It checks
the preparation-time kit hash, so concurrent kit changes refuse rather than overwrite. Clear retains
durable audio; withdrawing scope appends a current rights event. Reopening does not migrate legacy
samples. Ranged source audition and prepared audition share the existing single audio player.

This increment establishes the assignment precursor. Automatic scene transport belongs to #111;
legacy missing-media messages, in-flight extraction cancellation, reference-aware staging collection
and complete narrow-screen interaction verification remain part of the epic integration work.

## Automatic scene reference transport (#111)

`contracts/audio-reference.ts` owns route declarations, the source/intent matrix, authored speaker
resolution and ordered frozen bindings. `planScene` and subject-bound Bench dispatch share it.
The renderer offers a dispatch-scoped bypass, recomputes on model changes, and exposes refusal
reasons. Bench reruns use the take's frozen audio plan. Empty/off metadata never reaches a provider.

At plan/enqueue and again before physical submit, `audio/reference-inputs.ts` reads the frozen
content-addressed files and current rights events. Reassignment cannot substitute audio in a queued
job. FAL checks route, ordered count and full hashes again before building `audio_urls`; no bytes
are journalled. It explicitly enables generated audio, while prompts preserve scene words and label
voice guidance honestly. Whole-scene plans carrying voice audio retain independent reference routes;
they do not chain through first-frame routes that cannot accept audio. Explicit shot frame and
continuation modes surface incompatibility instead of dropping audio.

The first shipped transport is the verified Seedance 2.0/2.0 Fast reference-to-video route, with
three MP3/WAV inputs, 15 seconds combined, 15 MB per audio input and 12 combined references.
Performance and master-slice intents are strictly distinguished by schema; their actual source
resolution will be integrated with their owning issues (#113/#112/#256), never inferred from a
character designation. Full epic interaction verification and those downstream consumers remain.


## Recorded performances and conversion (#113)

`contracts/performance.ts` owns the common immutable performance base and authoritative line resolver.
Covered script dialogue takes precedence over legacy shot audio. Multiple covered lines need an explicit
block choice. Scratch and speech-to-speech records live in each production's `performances/<pf-id>/`;
they never participate in picture takes, picture selection, or designated character samples.

Design turn 115 defines explicit Start, Stop, Keep and Convert actions. The desktop permission policy
allows only its own top-level renderer's microphone request. The opaque host spool is process-owned,
limited to 128 MiB, and discarded after a durable Keep or a failure with an available renderer preview.
The coordinator re-reads the authored target, prepares canonical audio through #117, compares local
transcription when available, and commits `performance.json` last. A failed metadata commit retains
its bytes for commit-journal recovery. Abandoned scratch source directories are removed on reopen;
paid conversion landing material remains available for queue finalization replay.

ElevenLabs speech-to-speech is a distinct capability. The manifest records the verified model,
five-minute limit and duration rate. Account model probing is independent of cloning. Only a verified
enterprise probe exposes zero retention, and submission checks entitlement again. The queue freezes
the exact source hash, target, voice assignment, rights, wording confirmation and retention. Only
verified ephemeral bytes reach multipart upload. The transformed ID uses the queue job's ULID;
`performance-conversion` is a replayable finalization target. Source and result remain independently
playable, and conversion never accepts a performance or dispatches a video.

Purge takes the world write gate, refuses current production or durable job references, moves the
whole directory into `.staging/performance-purge`, flushes a content-free tombstone, and removes the
staged bytes. Reopen restores a staged record without a tombstone and deletes one with a tombstone.
Only the recovered manifest paths advance scan-state, preserving unrelated external edit detection.
Tombstones also block stale Keep and conversion finalization from resurrecting media. #112 and #114
must expose their reviews, selections and designations to this reference census.

Validation so far includes real world Keep/reopen/retry, interrupted purge restoration, completed
purge and resurrection refusal, desktop permission/spool tests, multipart upload/refusal and account
probe tests. The remaining epic integration pass must cover conversion queue/finalization replay,
recorder interaction and narrow-window QA, and downstream review/selection/bible references.


## Performance review and cadence (#112, first implementation slice)

Review decisions live in `performance-reviews.jsonl`; current choices live in
`performance-selections.json`. `performanceLineKey` includes scene, shot and covered block (or an
explicit legacy marker), so two authored lines covered by one shot cannot overwrite each other.
Accept compares both file hashes, current target and voice assignment, and exact media bytes before
committing review and selection together. Reject appends review alone. Request IDs make lost-response
retries idempotent. The bundle exposes both authorities and hashes; purge now sees these references.

The shared cadence mapper validates UTF-16 positions, surrogate boundaries, exact spans, ordering,
overlaps and duplicate cues. Model rows declare mappings and unsupported controls. Eleven v3's app
ID is `eleven-v3`, wire ID `eleven_v3`; the reviewed official rate is $0.10 per 1,000 characters.
Qualitative audio tags and capitalization are best-effort. Kokoro exposes existing delivery presets;
arbitrary speed and audio tags remain unsupported pending a packaged runtime check. Speech whitespace
normalization moved into contracts; existing voice-service imports continue to work.

Design turn 116 and the performance panel add transient A/B pins and explicit Accept/Reject controls.
World-store tests cover atomic selection, idempotent review, stale file refusal, reject preserving
selection, restart reads and purge blockers. Cadence tests cover exact Unicode addressing and honest
unsupported mappings. TTS generation/finalization and its full client cadence editor are the next
slice; the new mapper alone does not claim that workflow is complete.


### TTS generation integration

The cadence panel prepares a server-owned quote under `.staging/performances/<operationId>/quote.json`.
It freezes authoritative text/target, current voice assignment, normalized cadence hash, provider
mapping and exact character price. Confirm revalidates the target, assignment, model and price.
Local synthesis is uncached and cancellable through Voxa; deliberate retakes never collapse into a
preview cache. Cloud generation uses the durable queue with `performance-generation` finalization
and the job-derived performance ID. Both paths create an immutable `generated-tts` record, initially
unreviewed. Generated records carry no fabricated capture-rights acknowledgement.

The shared QC module now has an explicit unavailable report for verified encoded output. Optional
decoder failure preserves the paid WAV/MP3, marks duration and measurements unknown, and refuses
future reference clearance until usable preparation exists. Canonical decoded output still follows
#117's preparation/acceptance path. Source and derivative hashes, frozen cadence/provider text,
voice assignment and cost stay with the performance. Performance job errors link to the scene.

Generation tests cover quote character cost, stale confirmation, exact output retention with unknown
duration, finalization replay/reopen, no automatic review/picture changes, fresh local retakes,
forwarded pace and cancellation. The alias regression test verifies `eleven-v3` sends `eleven_v3`.
The full epic validation pass still needs recorder/cadence interactions, narrow-window inspection,
real packaged local pace verification, conversion queue recovery, and reference transport of the
accepted performance variants.


## Rehearsal and performance bible (#114)

`deriveRehearsalLines` projects current authored shot order and covered script blocks; duplicated
coverage reads once, legacy VO and dialogue share the same resolver, and unresolved speakers remain
visible. The table-read planner verifies accepted exact-line selection and bytes before considering
an exact speech cache. A broken selection is not hidden by synthesis fallback. Missing cloud lines
are priced in aggregate against current wire-model identity; confirmation binds the complete plan.
Running jobs are recognized, partial cloud enqueue uses the existing aggregate acknowledgement, and
an explicitly confirmed retry after failure gets a fresh spend key. Local preparation is sequential,
cache only and unledgered. `table-read-cache` finalization validates exact frozen cache identity.

The single player now owns playlist sequencing, previous/skip/restart, solo and playback rate. External
ordinary playback releases the playlist; table-read route cleanup cannot dismiss an unrelated clip.
No second audio element was added. Tests cover that ownership, end transitions and failed-line skips.

Rehearsal notes store only line keys, text hashes and user prose in `rehearsals/<rh-id>.json`, with
base-hash conflict refusal and no scene-version bump. Missing line keys become explicit orphan-note
problems. Performance bible events live in each character's `performance-bible.jsonl`, never kit.json.
Designate validates the current accepted decision, exact bytes, role, current identity assignment,
shared QC and explicit reference rights. Scratch is cadence only. Replace/clear append revisions;
retries are idempotent and historical bible events block source purge. Damaged histories keep intact
revisions visible while writes and purge fail closed.

Design 117 and the scene/character panels expose these distinctions. Tests cover derived ordering,
covered-line deduplication, tied recommendations, revision conflicts, accepted playback without spend,
cache planning and running-job reuse, notes, designation replay, raw-identity refusal and clear history.
The verified Multilingual v2 price is corrected to 100 micro-USD per character, with a 10,000-character
limit; Eleven v3 remains 100 micro-USD and 5,000 characters.

The epic integration pass must still exercise live narrow-window controls, explicit selection clear
for broken sources, bible cadence-plan seeding and advisory eligibility, deleted-scene note cleanup,
real local pace verification, and the end-to-end video/cut consumers in #111/#115/#256.

## Exact performance timing (#115, first integration)

The refreshed issue body missed the newer SPEC-037/038 editor: `timeline.json` is already the writable cut after migration. Do not revive `cut.json` writers or introduce a competing spine. Legacy cut source forms remain readable; new performance placements use the existing timeline command, revision, hash, history and render pipeline. A performance source carries its immutable id/hash and explicit physical trim, lead-in and post-speech handle. The reviewed placement command rechecks current selection, authored target, latest acceptance, contained bytes and cut hash inside the normal world gate. Picture selection is unchanged. Export checks exact bytes again and renders the physical audio range without frame-rounding truncation; stale timeline trims require a fresh placement review.

`resolvedAuthoredDuration` owns the four-second fallback for display, planning, packing and cut derivation. Fixed-step provider padding is recorded separately in job parameters and excluded from shotPlan/virtual segment boundaries. Provider clients strip that app metadata. Dispatch timing is frozen separately from returned media measurement.

Completed checks: exact trim/lead-in/reaction arithmetic, unknown and out-of-range refusal, mutual positive overlap calculations, legacy source compatibility, actual-store selected placement/stale CAS/export range, and unchanged picture selection; provider-padding compiler regression. The first timing panel deliberately exposes no overlap action until paired atomic placement is wired. Remaining #115 work includes anchored/saved-timeline pass packing, clock compatibility/creation, scene-duration proposal action, paired-overlap editing, and broader editor/narrow-window verification. This commit does not close the issue.

### Timing continuation

Planning now consumes the same production slots as timing review. Saved Picture clips take precedence over legacy spine anchors, then the authored four-second fallback applies only when there is no slot authority. Whole-scene packing orders anchored shots by time, excludes unanchored shots with a named warning, and closes at gaps. Per-shot planning preserves the authored fallback for unanchored shots. Both desktop preview and coordinator compilation receive this input; compiler timing provenance names the actual slot source. Original scene durations remain unchanged.

The timing panel can stage a precise authored-duration suggestion for an unanchored shot. It uses the existing scene JSON proposal manager, preserving graph and staging semantics, with a source hash checked inside staging. Nothing changes before normal proposal acceptance/rebase. Anchored shots instead direct the user to their operational timeline slot. Tested actual-store staging without scene mutation, stale scene refusal, exact anchor packing and gap closure.

## Creative prompt review (#116)

`contracts/prompt-review.ts` is the shared deterministic review contract for key art and later shot-prompt consumers. It normalizes LF only, runs a bounded stable Myers token diff, retains UTF-16 offsets, counts Unicode characters/UTF-8 bytes, and computes full SHA-256. Added hunks get exact-source evidence only from contiguous case-sensitive quotations in the source snapshots actually supplied; all other additions are explicitly unverified. Static versioned style-term warnings are advisory. No semantic grounding or token-count claims are made.

Key-art planning returns the assembled creative body, separate fixed constraints, registered sources and a session review identity. Draft alternative is explicit, optional, and queues no image. The director receives only creative text and registered source snapshots; candidate selection/editing does not change canon. Final Generate rechecks model, source and reference context, appends the fixed constraints, and freezes approved/final hashes in promptProvenance. Legacy generation with no review identity uses its explicit authored text or deterministic assembly and never invokes a hidden rewrite. Provider capture's common submit boundary verifies the final prompt hash before network IO; provider field mappers strip this internal provenance. Owner-visible payload history still contains the actual request, while application diagnostics no longer log key-art prompt bodies.

Review candidates live only in coordinator/client session state. Closing/changing the route invalidates the candidate; restart cannot revive one. Art-director work uses an exclusive UUID scratch directory, a bounded wait, an abortable event collector and cleanup on all outcomes. The harness API currently has no per-turn cancellation operation: cancellation stops waiting and ignores its late result; it must not be described as stopping remote model computation. No image generation occurs from a cancelled draft.

Focused verification covers exact-source/case behavior, stable replacements, UTF-16/Unicode counts, changed source/reference refusal, whole-candidate/base/edit choices, exact final prompt hashes and transmitted text, zero-network mismatch refusal, cleanup after success/timeout/session failure, and review rendering. Remaining integration includes the #252 shot-prompt consumer and full interactive/narrow-window QA.

### Accepted performances in video dispatch (#111)

Scene dispatch now accepts explicit accepted-performance references alongside automatic character samples. The existing performance record owns already-prepared immutable WAV/MP3 bytes: no derivative store is needed for a full clip. Review identity, source hash, current authored target and current voice are checked before planning; shared QC, exact-hash cloud authorization and contained bytes are checked before enqueue and again before physical upload. Each explicit performance replaces its character sample only in the relevant shot. Mixed intents within a pass refuse. The frozen plan retains the full record, acceptance timestamp, clearance and route effects in job/take settings.

`voice-reference` generates new scene speech. `performance-sync` sends `generate_audio: false` and leaves the external performance as final audio, without an exact-sync promise. The scene reference panel provides full-clip audition, source/hash/size/duration, intent, warning acknowledgements and cloud permission. Explicitly disabling audio clears transport for that dispatch only. Fast uses the actual `bytedance/seedance-2.0/fast/reference-to-video` path; every boundary enforces nine images, three audio files, twelve total references, fifteen combined seconds and 15,000,000 bytes per audio file.

Reviewed performance ranges now use `prepareAudio` with the immutable performance source. The UI auditions the staged derivative and reviews its own hash/QC; dispatch accepts it through `acceptPreparedAudio`, with a content-addressed WAV and an idempotent receipt under the production's `audio-inputs/`. Original performances are unchanged. Source acceptance and current target are still checked before enqueue, while queued jobs use the frozen derivative. Cancelling the UI review ignores late results and leaves staging to the existing conservative cleanup. Master-track slices remain the #256 source integration.

### Master playback slices (#256)

The current timeline supersedes the issue's old writable-spine assumption. A Picture shot clip now optionally stores `performanceSourceClipId`, naming its chosen artifact clip on a Music track. The existing `set-performance-source` timeline command validates the relationship and covering interval and participates in normal revision guards and undo history. Legacy `spine.json` remains readable and seeds its usual Music/Picture clips; there is no second timeline or migration writer.

`masterAudioBinding` resolves the one Picture slot and maps its absolute interval into the Music clip's physical source, including the music source-in and excluding picture media trims. Preparation uses the existing artifact/range audio service. Exact slice audition, QC, source/prepared hashes, timeline revision and cloud permission appear beside the existing scene reference review. Master playback is always `performance-sync`, generated audio is false, and the external timeline soundtrack remains final. Music does not require the dialogue-only single-speaker/no-music attestations.

An enabled performance shot requires a prepared source unless audio is explicitly disabled for that dispatch. Changed bindings, missing tracks, duplicate slots, out-of-range sources, unsupported routes, mixed intents and shared input budgets refuse without fallback. New enqueue checks the current timeline hash and binding; queued work reads frozen content-addressed audio and current rights, so re-anchoring never substitutes a new slice. Existing FAL ambiguity handling remains the only paid submission lifecycle. Design turn 121 records the desktop/narrow controls.

Focused integration verifies physical range mapping independent of picture trim, exact prepared bytes, missing-slice refusal, source-intent enforcement, `generate_audio: false`, re-anchor staleness versus frozen queue behavior, rights withdrawal and preservation of the original soundtrack.

### Paired overlap completion (#115)

The timing panel can now review a second selected performance's source range, lead-in and tail handle alongside the first. Both sides explicitly name each other. `placeSelectedPerformance` builds both existing timeline placements and commits them as one revision/undo step only after checking both selections, latest acceptances, current authored targets/voices, exact bytes, positive mutual speech intersection and all other placed dialogue. Invalid pairs never land a first half. Export continues through the existing precise audio mix. Generation also refuses a scene slot overlapped by a different scene's slot.

The newer timeline already gives ordinary dialogue productions an operational picture clock without any master artifact. No v2 competing `spine.json` is introduced: saved timeline slots govern, legacy master anchors remain the bootstrap fallback, and authored duration governs unanchored per-shot work. This supersedes the refreshed issue's old proposal for another writable clock shape. Tests cover atomic paired placement/refusal, exact exported overlap intervals and cross-scene slot conflicts.

### Selection repair (#112)

Clear selection is now available for every selected line, including missing media and stale targets. It changes only the existing `performance-selections.json` entry under its current hash guard, preserving reviews, immutable performances and placed timeline audio. Repeating a successful clear is harmless. The focused store test clears while media is absent, refuses a stale selection hash and verifies that both review history and the existing cut are unchanged.

### Rehearsal completion (#114)

The performance generator explicitly seeds cadence from current accepted cadence/both bible examples. Delivery and speed transfer; exact UTF-16 cues transfer only when the authored text hash matches. Selecting an example never generates audio or changes the character voice. Deleted-scene rehearsal notes remain visible and removable with the existing hash-guarded note command; removing the final note deletes only its empty orphaned session. Focused tests cover cue isolation across different wording and note removal after an externally deleted scene is reconciled.

### Authored dialogue guidance and diagnostics (#118)

Shots optionally carry explicit visualFacts in the existing scene file. The scene generation panel stages changes through ProposalManager, including isolated-speaker and over-the-shoulder drafts. Review shows the complete scene JSON and the exact changed facts. Accepted composition and cast presentation enter the ordinary prompt blocks. Mentions remain citations; no image/model inference supplies visual facts.

The pure dialogue assessment matches exact model, provider route, adapter revision, authored facts, audio intent and exact derivative duration against reviewed manifest guidance. The shipped list is intentionally empty: no unsourced quality warning is fabricated. FAL endpoint metadata is projected from the existing generated route maps; existing verified frame transports remain enabled. Manifest validation rejects guidance for missing routes, mismatched endpoint revisions or duplicate evidence identities. Other adapters without reviewed endpoint metadata cannot acquire inferred route guidance.

Compilation freezes per-shot assessments inside existing provenance, with exact evidence and deterministic acknowledgement identity. Scene passes retain every covered shot assessment; arrival copies this unchanged to primary and segment takes. Guidance is advisory and never extends hard blockers. Changes to route, facts, intent or relevant durations invalidate old acknowledgement IDs. No provider request, LLM call or mutation is involved in assessing guidance. Provider clients already strip provenance from wire payloads.

The separate take-feedback.jsonl journal records diagnostics through an owned, serialized, flushed append. It cannot change take metadata, acceptance or selection. Input-dependent tags require immutable take evidence; cadence requires an explicit sourced claim, never voice-reference intent alone. Scanning retains valid surrounding records and reports malformed line identity; appending refuses damaged history. Local aggregates report observation counts by frozen model/route/endpoint/evidence/predicate/facts/tag and never revise shipped guidance. Legacy shots, takes and production bundles remain readable with absent optional fields. Design turn 125 records proposal, advisory, narrow-layout, keyboard and disconnected states.
