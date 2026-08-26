import { mkdir } from "node:fs/promises";
import { createPreparedSession, type SessionInput } from "../harness/session-files.js";
import { join } from "node:path";
import { z } from "zod";
import type { HarnessAdapter, WorldMeta } from "@arke-studio/contracts";
import { extractJson } from "../canon/ask.js";
import { toExtendedLength } from "../world/paths.js";

/**
 * The art director: one harness turn that turns what a world *is* into a prompt an image model
 * can use.
 *
 * Concatenating the logline and posting it at an image model is a weak prompt — the logline is
 * written for a reader ("a drowned god still sings") and an image model wants a subject, a
 * light, a lens and a material. A writing model is good at that translation, and we already
 * have one running.
 *
 * It is a suggestion, never a gate: if the harness is down, slow, or answers with something
 * that is not a prompt, the caller falls back to the plain assembly and the picture is still
 * made. Nothing here is allowed to be the reason a button does nothing.
 */

/**
 * Measured, not guessed. The first real run answered in 93 seconds and I had given up at 45,
 * so the plain assembly went to the image model while a perfectly good prompt was still being
 * written. Extraction allows 120s for the same kind of turn; this matches it.
 */
const WALL_CLOCK_MS = 120_000;

/** What the art director is told. Only what the world itself says — no invented context. */
export function worldBrief(meta: WorldMeta, canonLines: readonly string[]): string {
  const lines = [
    `World: ${meta.name}`,
    meta.logline?.trim() ? `Logline: ${meta.logline.trim()}` : "",
    meta.tone?.trim() ? `Tone: ${meta.tone.trim()}` : "",
    meta.genre?.trim() ? `Genre: ${meta.genre.trim()}` : "",
    canonLines.length > 0 ? `Established, and binding:\n${canonLines.map((l) => `- ${l}`).join("\n")}` : "",
  ];
  return lines.filter((l) => l.length > 0).join("\n");
}

export function makeArtDirector(
  adapter: HarnessAdapter,
  sessionInput: SessionInput,
  scratchRoot: string,
  options: {
    /** Which roster agent answers. The default is the key-art writer this file was born for. */
    agent?: "art-director" | "prompt-enhancer" | "lyricist";
    /**
     * The JSON key the answer arrives under. Every agent here replies with one string in one
     * object; they disagree only about what to call it, and a lyricist answering {"prompt":…}
     * would be describing a song rather than writing one.
     */
    answerKey?: "prompt" | "lyrics";
    /** The longest answer accepted. Key art keeps its ~60-word posture; the enhancer's
        ceiling is the chosen model's own published cap, so a long valid rewrite is never
        thrown away as "no answer". */
    maxChars?: number;
  } = {},
): (brief: string) => Promise<string | null> {
  const key = options.answerKey ?? "prompt";
  const PromptSchema = z.object({ [key]: z.string().min(1).max(options.maxChars ?? 2000) });
  return async (brief) => {
    const sandbox = join(scratchRoot, `art-${Date.now().toString(36)}`);
    await mkdir(toExtendedLength(sandbox), { recursive: true });
    const session = await createPreparedSession(adapter, sandbox, sessionInput({}), {
      purpose: "art-prompt",
      agent: options.agent ?? "art-director",
    });

    let finalText = "";
    const abort = new AbortController();
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
    await adapter.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: brief }] });

    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => reject(new Error("the art director took too long")), WALL_CLOCK_MS);
    });
    try {
      await Promise.race([collected, timeout]);
    } finally {
      clearTimeout(deadline);
      abort.abort();
    }
    // extractJson throws when there is no object at all — prose, an apology, an empty reply.
    // All of those are the same answer here: no prompt, use the plain assembly instead.
    try {
      const parsed = PromptSchema.safeParse(extractJson(finalText));
      return parsed.success ? String(parsed.data[key]).trim() : null;
    } catch {
      return null;
    }
  };
}
