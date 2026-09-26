# Local language models

Arke uses Ollama to run local language models. There are two paths:

- Authoring sessions use the selected writing harness. With OpenCode, connect its Ollama
  integration and select a model from the live harness catalogue. OpenCode owns prompts and
  tool calls; Ollama owns inference. A model must appear in that catalogue before Arke can
  offer it for authoring. Installing a model does not configure a harness integration.
- Direct language-model jobs use the Ollama provider's `/api/generate` endpoint. The shipped
  manifest maps Arke's model id to the exact Ollama model name through `providerModelId`.

The manifest includes Llama 3.1 8B and Llama 3.3 70B. Their Ollama names are `llama3.1:8b`
and `llama3.3:70b`. Users can bring installed models to OpenCode independently of this static
manifest. The shared GPU coordinator serializes local harness inference with other GPU jobs.

## Gemma 4 12B Uncensored Balanced

The optional setup entry `ollama-gemma4-12b-balanced` provides the manifest model
`gemma4-12b-balanced` (SPEC-008 R-9, R-13; SPEC-033 R-39). It uses the community
[HauhauCS Balanced model](https://huggingface.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced)
with Q4_K_M weights. Select it explicitly in Settings; it is not in the automatic
recommendation order and does not replace standard Gemma 4 12B.
The catalogue entry enforces that (issue #1289): `explicitChoiceOnly` keeps it out of the
local default an unchosen agent falls back to, in the coordinator and in Arke's own harness, and
a session with nothing else installed is refused with where to choose it. The entry also carries
the model card's sampling (temperature 0.6, top_k 64, top_p 0.9, min_p 0.05, repeat_penalty 1.1),
which Arke's harness sends with every request: a Hugging Face pull carries only its stop tokens.
The harness sends `think: false` too — this build reasons before answering even though Ollama
lists no thinking capability for it, and a one-sentence answer cost 419 tokens and ten times
the time with thinking left on.
Settings names the Uncensored variant and displays its requirements before installation
(issue #1252). Installation and inference remain unverified by Arke; the persistent
catalogue caveat states that limitation and the mutable upstream weights independently
of download progress.

```powershell
ollama pull hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M
```

Use Ollama 0.34.3 or newer: 0.34.2 failed this pull during validation because it rejected
Hugging Face's CDN redirect. [Ollama 0.34.3 fixes Hugging Face pulls](https://github.com/ollama/ollama/releases/tag/v0.34.3).
The [Hugging Face integration](https://huggingface.co/docs/hub/en/ollama) selects the quantization
by tag; this is a mutable upstream reference, not an immutable artifact pin.

Source checked on 2026-09-24: revision `ae8045ac2bd216293ca49a3065da2c942dde4b68`, file
`Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced-Q4_K_M.gguf`, 7,381,381,760 bytes. The catalogue
rounds up to 7,382 MB. The manifest uses the existing 12B planning estimate of 9,600 MB VRAM;
this is not a benchmark or a guarantee that the advertised 256K context fits that memory.
Ollama controls the actual context allocation. Arke declares text input for this entry;
the optional vision projector and speculative decoding head are not installed.

## Validation

From `packages/coordinator`, run:

```powershell
node --import tsx --test test/setup/catalogue-invariants.test.ts test/setup/local-setup.test.ts test/setup/local-model-policy.test.ts
```

From `packages/providers`, run:

```powershell
node --import tsx --test test/manifest.test.ts test/clients.test.ts
```

These tests cover setup/dispatch identities and the existing Ollama transport. They do not
establish model quality or OpenCode tool-call reliability. A live check must separately verify
the installed tag, a neutral text completion, and availability in the running harness catalogue.

## Window, memory and compaction on Arke's harness

- **Window.** A session gets the model's own window, from 131,072 to 262,144 tokens (a host may
  fix it with `maxContextTokens`). Measured on a 10 GB RTX 3080 with Gemma 4 12B: 128k puts 30%
  of the model on the CPU at 11.8 tokens/s, 256k 44% at 7.8; both recalled a fact from the middle
  of a 121,000-token prompt. World Chat's assembled context on this lane stops at 64,000 tokens.
- **Working memory.** Agents whose confinement grants a scratch checklist get `checklist` (this
  ask only) and `notes`: a page per agent per world under `<appRoot>/agent-memory/<worldId>/`,
  and one author page, `<appRoot>/agent-memory/author.md`, shared by every agent in every world.
  Both are read into the instructions when a session opens. Notes are never canon: the world's
  files decide, and the instructions say so. Hosted harnesses keep their own memory.
- **Compaction in a session.** Old tool results become placeholders first. When whole exchanges
  must go, a digest note says what was asked, which tools were used and what was answered,
  keeping the session's first ask and the newest; the next trim folds it in.
- **Compaction across a conversation.** World Chat's rolling summary, for every harness, keeps
  fixed sections — decisions, open threads, where things stand (characters' places, knowledge,
  relationships), standing instructions, referenced canon by id — and folds new turns into them.
