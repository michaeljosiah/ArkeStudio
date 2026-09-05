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
