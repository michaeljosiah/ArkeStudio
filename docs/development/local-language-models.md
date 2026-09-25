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
node --import tsx --test test/setup/catalogue-invariants.test.ts test/setup/local-setup.test.ts
```

From `packages/providers`, run:

```powershell
node --import tsx --test test/manifest.test.ts test/clients.test.ts
```

These tests cover setup/dispatch identities and the existing Ollama transport. They do not
establish model quality or OpenCode tool-call reliability. A live check must separately verify
the installed tag, a neutral text completion, and availability in the running harness catalogue.
