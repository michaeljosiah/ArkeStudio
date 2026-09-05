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
