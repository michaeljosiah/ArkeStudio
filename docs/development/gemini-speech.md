# Gemini speech integration

The Google unary speech client is implemented, covered by protocol fixtures and smoke-tested
against both models with an authorised account. It is exported
from `@arke-studio/providers` and registered in the provider factory, with host-owned credential
setup. Both models are in the shipped catalogue. Desktop, development and standalone hosts
list their available presets after a Google key is configured in Settings → Models.

For new cloud choices, Flash leads creative casting and the audiobook narrator picker;
Flash-Lite leads routine read-aloud. Character matching still respects the written voice's
attributes before using the provider preference to break ties. Existing casting, routing and
book narrators are unchanged. Kokoro remains the app's default narrator, and local choices stay
first in narrator pickers. Setup and browsing do not synthesize speech or switch a narrator.
Models disabled in Settings are omitted from the shared catalogue and both narrator pickers
before recommendation. Character assignment and preview commands also enforce that setting.
Performance preparation, confirmation and speech queue admission likewise refuse disabled
models. Saved Gemini shot/performance and Bench choices are checked against the current key's
catalogue before quotes or take reservation; shared speech queue admission checks again before
journalling a job. These checks discover only Google's presets and do not synthesize speech.
Queue batches share discovery for each exact reader and credential; results expire with the
batch, and a changed key or disabled model invalidates them before another job is admitted.
A standalone host without a local speech service needs an explicitly selected cloud narrator;
book, chapter, audition and ordinary/voiced prose reads refuse an unavailable local reader before synthesis.
Table Read supports both Gemini assignments with model-specific WAV caches, bounded input and
current-reader validation before preparation. Existing cached reads remain playable offline.
Token-priced preview, founding audition and performance controls say “up to”; aggregate audiobook and page-read
confirmations also identify their authorization ceiling, with actual usage settled after generation.

The client targets the exact `gemini-3.8-flash-tts` and `gemini-3.8-flash-lite-tts` IDs through
`POST /v1beta/interactions`. Spoken text and `speech_metadata.style` remain separate. Requests
are stateless (`store: false`) and ask for one complete WAV: mono, 24 kHz, signed 16-bit PCM.
Incomplete responses and incompatible or truncated WAVs become witnessed failures carrying
any reported usage. They never become playable takes. Network uncertainty is held for
reconciliation; the client claims neither idempotency nor remote lookup.

Live stateless responses omit the interaction ID. Arke records a distinct local inline receipt
for these responses, preserving the usage and audio. That receipt does not imply that Google
stores the result or that it can be polled after a restart.

Model readiness and the 30 preset candidates use read-only model discovery, including
pagination. Being listed does not prove quota or paid synthesis access. Unbound custom voice
IDs and reference recordings remain refused. Stored designed voices use the binding flow below;
replication and its recording/consent workflow are separate work.

## Designing and saving a voice

The provider layer implements stored prompted-voice creation, exact-id retrieval and one-page
listing through Google's Voices API. These methods pass through the captured host transport;
creation gets a synchronous-generation deadline. Construction and preset discovery do not call
them. The returned metadata includes the vendor's expiry rather than a locally invented TTL.
Creation and retrieval return a validated WAV preview when present. If a response contains a
voice id but an unusable preview, the id and reported usage survive so the coordinator
operation can retrieve that identity rather than paying to create another. A lost or malformed
response is uncertain; there is no retry, idempotency claim or reconciliation by display name.
Audio payloads and bearer-like stateless voice keys are redacted from provider call capture.

Character Voice offers **Design a voice**, seeded from the written voice. The audiobook narrator
dialog offers **Design a narrator**. Editing costs nothing; Generate explicitly creates one
candidate. Each candidate is a durable queue job, with its intent flushed before the request,
reported usage retained and its provider audition stored locally. Reopening the dialog shows
recent candidates; unknown outcomes are held, never automatically recreated. Save verifies the
exact remote identity using the current Google key, then publishes a world-owned audition and
library record in one owned transaction. Verification can recover a known ID whose first preview
was unusable. An existing stored ID can also be imported and is labelled as imported.

Save, auditioning an author's line, and Use are separate actions. Provider previews do not claim
to speak the selected character line: **Hear this line** is a separately quoted normal speech job
and matching cached reads replay without provider calls. Using a voice for a book returns to the
existing narrator impact/confirmation flow and does not change the app narrator. Both Flash and
Lite can read a saved designed voice through the existing character, performance and audiobook
pipelines. No real-person replication or consent-upload control is offered.

The first save raises the world schema to 42. `voices/voices.json` contains a distinct `designed`
variant, without a fake reference clip. Its stable Arke ID and immutable acoustic revision form
the namespaced target carried by assignments, narrator settings, jobs, takes and caches. The
Google ID is a separate binding, verified with the executing credential immediately before a new
read. The API does not expose an account/project identifier; Arke does not invent one or persist
an API-key fingerprint as a project identity. Missing access and expiry refuse new reads without
changing assignments or deleting audio. The saved library in the design dialog plays auditions
locally, including expired ones. A replacement is a new explicit identity and assignment; no
automatic regeneration or rebinding occurs. Remote deletion and replication remain separate work.

On 2026-09-28 the [Voices reference](https://ai.google.dev/api/voices) and
[voice-design guide](https://ai.google.dev/gemini-api/docs/voice-design) document `CreateVoice`
and its token usage. At the author's direction, creation estimates use the selected model's
published Standard rates from the [pricing page](https://ai.google.dev/gemini-api/docs/pricing).
The assumptions are explicit: these are model rates, not a separately verified CreateVoice
tariff; the full model token limits are a budgeting allowance, not an endpoint-enforced spending
cap. Creation quotes carry `costBasis: estimate` and no `tokenLimits`. The UI says **estimate**,
never **up to**, for creation. Free-tier availability and quotas are Google's decision; no
account is assumed to be free and no missing usage becomes a zero charge. Reported usage is
priced at the frozen published rates and labelled usage-derived, not provider-reported billing.
Rates change on 2027-01-01 and are rechecked before submission. Tests incur no provider charges.

Design-master turn 165d's comparison is delivered as successive individually priced candidates:
the API returns one voice per creation. Three candidates require three explicit Generate actions.
Closing the dialog keeps jobs and auditions and does not delete remote candidates.

For ordinary synthesis, the pricing foundation uses dated standard rates and the published full service limits to
bound each request. Duration is not treated as a guaranteed ceiling. The client additionally
rejects compiled text plus style over a conservative 7,000-byte request budget; this is not a
claim that bytes equal Google tokens. The shared speech packer applies this byte bound before
quoting plain reads and directed audiobook parts, including a performed character's note.
The author requested preset activation before the broader acoustic qualification on 2026-09-27.
Tighter token/output bounds and acoustic long-read qualification remain outstanding.

`geminiSpeechModel` supplies the shipped rows. Their six deliveries and short phrase compile to separate instructions through
the existing cadence compiler. A delivery span becomes its own request and the surrounding style
resumes after it. Numeric speed, pause, breath and emphasis remain held; no exact timing or
acoustic adherence is claimed. Vocal-event authoring and its schema migration are still pending.
Bench and shot lines also carry their named delivery as separate style. The single-line
performance path refuses delivery spans; those use the audiobook's directed-part compiler.
Bench and shot lines validate words plus delivery bytes before reserving a take or creating
a queue request; oversized lines need shortening or the audiobook's read-in-parts path.
Character previews validate their normalized wording before quotation and queue construction.

`splitSpeechInput` in contracts packs at sentence/word boundaries and retains source offsets,
without cutting a surrogate pair. The byte allowance includes the separate instructions. An
impossible style or a marked span that cannot survive a split is refused before paid admission.
The audiobook reserves room for the performed note before rendering, then validates the final
words and instructions together. Each prepared part retains the existing full-service output
authorisation, job, usage and recovery paths; byte packing does not lower its reserved token cost.
The compiled request fingerprint binds those parts' words, style, settings, format and compiler
version to the quote and durable job. A changed compilation cannot adopt old parts merely because
the block text and number of parts stayed the same. Existing readers retain their legacy identity.

Credentials travel in the host's `x-goog-api-key` header and do not enter prompts or harness
environments. Transport capture redacts the key and summarises nested audio data as its size
and digest while keeping usage counters. Returned text/audio quantities are journalled before
settlement and priced separately from provider-reported charges.

## Verification

From the repository root:

```powershell
node --import tsx --test packages/providers/test/google-tts.test.ts packages/providers/test/gemini-activation.test.ts packages/providers/test/capture.test.ts
node --import tsx --test packages/providers/test/google-voices.test.ts apps/desktop/test/provider-transport.test.ts
node --import tsx --test packages/coordinator/test/queue/speech-pricing.test.ts
node --import tsx --test packages/coordinator/test/voice/designed.test.ts
node --import tsx --test packages/contracts/test/speech-input.test.ts packages/coordinator/test/productions/gemini-speech-parts.test.ts
```

From `packages/client`, run `node --import tsx --test test/design-voice.test.tsx test/gemini-voice-preference.test.tsx`.

These checks use injected responses, not paid provider calls. They do not establish model
quality, latency, supported-language quality, project access or actual billing. Live
qualification requires an explicitly approved spend cap and credentials; neither a fixture
nor a models-list result substitutes for it. See SPEC-049 and issues #1327, #1328 and #1329.

### Live smoke test, 2026-09-27

Under an explicitly approved $1 total cap, one short Charon narration was submitted to each
model, then each was repeated after fixing the stateless-response ID assumption. All four
requests returned HTTP 200, completed interactions and reported text/audio usage. The second
pair passed through the client and decoded independently with FFmpeg:

| Model | Audio duration | Request wall time | Reported text/audio tokens | Cost from usage at paid rates |
| --- | ---: | ---: | ---: | ---: |
| Flash | 9.36 s | 4.628 s | 25 / 300 | $0.002713 |
| Flash-Lite | 10.40 s | 4.540 s | 25 / 333 | $0.002011 |

Both files are mono 24 kHz, signed 16-bit PCM WAV. All four requests together price to
$0.009247 at the published standard paid rates; this is usage-derived cost, not an invoice or
proof of a particular billing tier. No key was written to the repository or probe files.
This establishes basic account access and the unary protocol only. Listening quality,
direction adherence, languages, long reads, custom voices, and rollout qualification remain
outstanding. The later preset activation is a staged product decision, not a claim that this
smoke test established full release qualification.

Protocol and rates were checked on 2026-09-27 against Google's [speech guide](https://ai.google.dev/gemini-api/docs/speech-generation),
[Interactions reference](https://ai.google.dev/api/interactions-api),
[Flash model limits](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts), and
[API prices](https://ai.google.dev/gemini-api/docs/pricing).
