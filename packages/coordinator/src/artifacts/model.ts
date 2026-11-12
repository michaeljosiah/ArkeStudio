import { mkdir } from "node:fs/promises";
import { createPreparedSession, sessionTurnTimeoutMs, type SessionInput } from "../harness/session-files.js";
import { runHarnessTurn } from "../harness/turn.js";
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
    let session: Awaited<ReturnType<typeof createPreparedSession>>;
    try {
      session = await createPreparedSession(adapter, sandbox, sessionInput({ agent: "canon-author" }), {
        purpose: "extraction",
        agent: "canon-author",
      }, undefined, signal);
    } catch (error) {
      if (signal?.aborted) throw stopped();
      throw error;
    }
    // Making the sandbox and opening the session takes long enough to be stopped inside — on a
    // slow machine, easily. Checked here so a stop during setup ends it before a turn is ever
    // dispatched, rather than starting one nobody is waiting for.
    if (signal?.aborted) throw stopped();

    const turn = async (prompt: string): Promise<string> => {
      if (signal?.aborted) throw stopped();
      const outcome = await runHarnessTurn(adapter, { sessionId: session.sessionId, parts: [{ type: "text", text: prompt }],
        timeoutMs: sessionTurnTimeoutMs(session.model, WALL_CLOCK_MS), ...(signal ? { signal } : {}) });
      // A stop is said as one, not as an extraction that found nothing: the difference between
      // "you stopped it" and "there is nothing in this document".
      if (outcome.kind === "cancelled" || signal?.aborted) throw stopped();
      if (outcome.kind === "completed") return outcome.text;
      throw new Error(outcome.kind === "failed" ? outcome.detail : outcome.kind === "timeout" ? "extraction took too long" : "extraction did not finish");
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
