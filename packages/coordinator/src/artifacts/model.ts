import { mkdir } from "node:fs/promises";
import { writeSessionFiles, type SessionInput } from "../harness/session-files.js";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { extractJson } from "../canon/ask.js";
import { toExtendedLength } from "../world/paths.js";
import type { RawCandidate } from "./extraction.js";

/**
 * The live extraction runner (SPEC-016 closing SPEC-015's seam): the same sandboxed
 * JSON-contract exchange the ask service uses, pointed at the extraction agent. Everything it
 * returns is re-verified mechanically before a user ever sees it — the model is never trusted,
 * only quoted (SPEC-015 R-13).
 */

const RawCandidatesSchema = z.object({
  candidates: z.array(
    z
      .object({
        kind: z.enum(["canon", "character", "location", "faction"]),
        name: z.string().min(1),
        body: z.string().min(1),
        section: z.string().optional(),
        quote: z.string().min(1),
        line: z.number().int().min(1).optional(),
      })
      .strict(),
  ),
});

function buildExtractionPrompt(text: string, artifactFile: string, retryNote?: string): string {
  return `Extract world facts from the document below. Respond with ONLY a JSON object:
{"candidates": [{"kind": "canon"|"character"|"location"|"faction", "name": "...", "body": "...", "section": "Essence"|"Appearance"|"Look"|"Sound"|"Wants" (sheets only), "quote": "...", "line": 1}]}

Rules — every one is enforced mechanically after you answer:
- "quote" must be copied character-for-character from the document. A paraphrase will be dropped.
- Propose only what the quoted span itself evidences. A paragraph about a coat authorises nothing about relationships.
- Leave anything unevidenced out entirely; do not complete a sheet.
- "body" is one plain sentence restating the quoted fact. "name" is the entity or rule name.
- If the document evidences nothing, return {"candidates": []}.
${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
## Document (${artifactFile})
${text.slice(0, 24_000)}`;
}

const WALL_CLOCK_MS = 120_000;

export function makeAdapterExtractor(
  adapter: HarnessAdapter,
  sessionInput: SessionInput,
  scratchRoot: string,
): (text: string, artifactFile: string, signal?: AbortSignal) => Promise<RawCandidate[]> {
  return async (text, artifactFile, signal) => {
    const stopped = () => new Error("stopped");
    if (signal?.aborted) throw stopped();
    const sandbox = join(scratchRoot, `extract-${Date.now().toString(36)}`);
    await mkdir(toExtendedLength(sandbox), { recursive: true });
    const preparationId = await writeSessionFiles(adapter, sandbox, sessionInput({}));
    const session = await adapter
      .createSession({ purpose: "extraction", cwd: sandbox, agent: "canon-author", preparationId })
      .catch((error) => {
        adapter.abandonSessionPreparation?.(preparationId);
        throw error;
      });
    // Making the sandbox and opening the session takes long enough to be stopped inside — on a
    // slow machine, easily. Checked here so a stop during setup ends it before a turn is ever
    // dispatched, rather than starting one nobody is waiting for.
    if (signal?.aborted) throw stopped();

    const turn = async (prompt: string): Promise<string> => {
      if (signal?.aborted) throw stopped();
      let finalText = "";
      const abort = new AbortController();
      // Stopping has to end the wait, not just ask the harness to stop: a session that
      // accepted a prompt without starting a turn answers an interrupt with silence, and the
      // strip would sit on "Reading…" for as long as anyone watched. Same lesson as genesis.
      const onStop = () => {
        void (adapter as { interrupt?: (id: string) => Promise<void> }).interrupt
          ?.call(adapter, session.sessionId)
          .catch(() => {});
        abort.abort();
      };
      signal?.addEventListener("abort", onStop, { once: true });
      // A listener added to an already-aborted signal never fires. Miss this and a stop that
      // lands in the gap is a stop that does nothing: the turn runs to the 120s wall clock and
      // reports "took too long" — which is what CI saw, and what the user would have seen.
      if (signal?.aborted) onStop();
      const events = adapter.streamEvents(abort.signal);
      const collected = (async () => {
        for await (const event of events) {
          if (!("sessionId" in event) || event.sessionId !== session.sessionId) continue;
          if (event.type === "message.completed") {
            finalText = event.text ?? "";
            return;
          }
          if (event.type === "session.error") throw new Error(event.message);
        }
      })();
      await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: prompt }] });
      // Refed, and cleared below: an unref'd deadline lets the loop drain while `collected`
      // is parked, so it never fires and the extraction waits forever.
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("extraction took too long")), WALL_CLOCK_MS);
      });
      try {
        await Promise.race([collected, timeout]);
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", onStop);
        abort.abort();
      }
      // The stream ends on a stop as well as on an answer, so an empty reply after an abort is
      // a stop, not an extraction that found nothing. Saying which is the difference between
      // "you stopped it" and "there is nothing in this document".
      if (signal?.aborted) throw stopped();
      return finalText;
    };

    // Parse with one retry naming the failure — the SPEC-006 pattern.
    let raw = await turn(buildExtractionPrompt(text, artifactFile));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return RawCandidatesSchema.parse(extractJson(raw)).candidates;
      } catch (err) {
        if (attempt === 1) return [];
        raw = await turn(
          buildExtractionPrompt(
            text,
            artifactFile,
            `not valid JSON matching the contract (${err instanceof Error ? err.message.slice(0, 200) : "parse error"})`,
          ),
        );
      }
    }
    return [];
  };
}
