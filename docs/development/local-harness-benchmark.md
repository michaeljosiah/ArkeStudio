# Measuring the local writing lanes

Phase 5 of issue #1247 decides whether Arke's own local harness (**Local**, engine `arke`)
becomes the default for Ollama models, in place of the bundled OpenCode. The deciding numbers
come from real hardware, so they are measured by a script you run on a machine with a GPU,
Ollama and the Gemma 4 models, not in CI.

`scripts/bench-local-harness.mjs` runs the same short writing conversation through each lane on
each model and reports:

| Measure | What it shows |
|---|---|
| Cold first token | Time to the first word of turn 1, which includes loading the model |
| Warm first token | The same for later turns; this is where prompt caching pays |
| Turn | Wall time of a whole turn, tool calls included |
| Prompt tokens / call (warm) | What Ollama actually processed per request after turn 1. A lane that keeps its prompt prefix stable processes far fewer |
| Tokens/s | Output speed, from Ollama's own counts |
| Context | The window requests really ran with (`num_ctx`, or what Ollama reports) |
| GPU free | How long until the card is free: on its own within the idle wait, or after asking, the way the GPU hand-back does |

Both lanes are measured at Ollama, by a small recording proxy, so they are compared with the
same ruler. OpenCode's Ollama address is fixed at `127.0.0.1:11434`, so the proxy takes that
port and Ollama moves one port up for the run. Nothing leaves the machine.

## Before you start

- Quit Arke Studio: it would otherwise hold port 11434's traffic and the GPU.
- Pull the models to compare, each stating a 256k context (both lanes refuse less):
  `ollama pull gemma4:12b`, `ollama pull gemma4:26b`, and optionally the Uncensored Balanced
  variant (`hf.co/HauhauCS/Gemma4-12B-QAT-Uncensored-HauhauCS-Balanced:Q4_K_M`).
- For the OpenCode lane, the bundled OpenCode v2: `npm run prepare:opencode2 -w apps/desktop`,
  then pass the binary's path with `--opencode` if discovery does not find it.
- `npm ci` at the repository root, so `tsx` and the workspaces are installed.

## Running it

Stop Ollama (quit it from the tray on Windows), then start it on port 11435:

```powershell
$env:OLLAMA_HOST = "127.0.0.1:11435"; ollama serve
```

```bash
OLLAMA_HOST=127.0.0.1:11435 ollama serve
```

In another terminal, from the repository root:

```bash
node --import tsx scripts/bench-local-harness.mjs --models gemma4:12b,gemma4:26b --runs 3
```

Useful options: `--lanes arke` or `--lanes opencode` to run one lane, `--turns 8` for longer
conversations, `--idle-wait 300` to see whether a model unloads on its own within Ollama's
default five-minute keep-alive, and `--opencode <path>` for the OpenCode binary. The header of
the script lists them all.

Afterwards, stop the port-11435 Ollama and start it normally again.

## What to send back

The script prints a Markdown table and writes every request's raw measurements to
`bench-local-harness-<time>.json`. Post the table on issue #1247 with the GPU and its memory,
the Ollama version (`ollama --version`), and the run count. The issue's rule for switching the
default is that Local clearly improves time to first token, turn time or GPU hand-back with no
drop in accept-gate pass rate. Judge the pass rate by reviewing the proposals each lane wrote in
normal use; the script measures speed, not quality.

## Reading the numbers

- **Prompt tokens / call (warm)** is the clearest sign of caching. When the prefix is stable,
  Ollama processes only what is new since the last request, so the count stays small as the
  conversation grows. When it is not, the whole conversation is processed every time.
- **Context** tells you whether a lane is silently running with a small window. The
  OpenAI-compatible route OpenCode uses cannot set `num_ctx`, so it gets Ollama's default.
- A blank ("—") means the lane did not report that measure. For example, OpenCode's route
  reports token usage only when its client asks for it.
