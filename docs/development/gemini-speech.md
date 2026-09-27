# Gemini speech integration

The Google unary speech client is implemented, covered by protocol fixtures and smoke-tested
against both models with an authorised account. It is exported
from `@arke-studio/providers` for qualification and registered in the provider factory, with
host-owned credential setup. No Gemini models are yet in the shipped model catalogue, and no
application default changes in this stage.

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
pagination. Being listed does not prove quota or paid synthesis access. This stage refuses
unbound custom voice IDs and reference recordings. Voice design and replication need their
own project bindings, separately authorised operations, consent handling and verified pricing.

The pricing foundation uses dated standard rates and the published full service limits to
bound each request. Duration is not treated as a guaranteed ceiling. The client additionally
rejects compiled text plus style over a conservative 7,000-byte request budget; this is not a
claim that bytes equal Google tokens. Token-aware packing and tighter authorisation belong to
the long-read integration before production activation.

Credentials travel in the host's `x-goog-api-key` header and do not enter prompts or harness
environments. Transport capture redacts the key and summarises nested audio data as its size
and digest while keeping usage counters. Returned text/audio quantities are journalled before
settlement and priced separately from provider-reported charges.

## Verification

From the repository root:

```powershell
node --import tsx --test packages/providers/test/google-tts.test.ts packages/providers/test/capture.test.ts
node --import tsx --test packages/coordinator/test/queue/speech-pricing.test.ts
```

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
outstanding; no Gemini model is enabled by this smoke test.

Protocol and rates were checked on 2026-09-27 against Google's [speech guide](https://ai.google.dev/gemini-api/docs/speech-generation),
[Interactions reference](https://ai.google.dev/api/interactions-api),
[Flash model limits](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts), and
[API prices](https://ai.google.dev/gemini-api/docs/pricing).
