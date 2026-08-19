import { mkdir, rm } from "node:fs/promises";
import { writeSessionFiles, type SessionInput } from "../harness/session-files.js";
import { join } from "node:path";
import {
  AskModelResponseSchema,
  type AskCandidate,
  type AskResult,
  type HarnessAdapter,
} from "@arke-studio/contracts";
import { searchCanon, type CanonSearchResult } from "../index-db/queries.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";

/**
 * The grounded Q&A pipeline (SPEC-006 §2.6, D1).
 *
 * Retrieval decides whether an answer is possible: below the floor, no model call exists to
 * argue with (R-10). Verification decides whether an answer is real: every claim quotes its
 * span and the span is checked mechanically, all-or-nothing (R-6, D2) — dropping one failed
 * claim can turn a qualified answer into a false absolute. One retry per stage, independent,
 * with the failure named (R-6, R-7, D3).
 */

export interface AskOptions {
  /** Studio's session input, enriched with live Settings; the adapter decides what lands on disk. */
  sessionInput: SessionInput;
  /** Where ephemeral ask sandboxes live (an empty cwd per ask — never a world). */
  scratchRoot: string;
  wallClockMs?: number;
}

const DEFAULT_WALL_CLOCK_MS = 90_000;

/** Whitespace and unicode normalisation — formatting artefacts are not fabrication (§3.2). */
export function normalizeForVerify(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Does the excerpt appear verbatim (normalised) in the entry's text? */
export function excerptAppears(excerpt: string, entryText: string): boolean {
  const needle = normalizeForVerify(excerpt);
  if (needle.length === 0) return false;
  return normalizeForVerify(entryText).includes(needle);
}

export interface VerifyFailure {
  entryId: string;
  reason: "not-a-candidate" | "excerpt-not-found";
}

/** All-or-nothing verification (R-6, D2). Returns every failure so the retry can name them. */
export function verifyClaims(
  claims: Array<{ entryId: string; excerpt: string }>,
  candidates: Map<string, { title: string; statement: string }>,
): VerifyFailure[] {
  const failures: VerifyFailure[] = [];
  for (const claim of claims) {
    const candidate = candidates.get(claim.entryId);
    if (!candidate) {
      failures.push({ entryId: claim.entryId, reason: "not-a-candidate" });
      continue;
    }
    const source = `${candidate.title}\n${candidate.statement}`;
    if (!excerptAppears(claim.excerpt, source)) {
      failures.push({ entryId: claim.entryId, reason: "excerpt-not-found" });
    }
  }
  return failures;
}

/** Extract the JSON object from a model reply that may wrap it in prose or fences. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object in the response");
  return JSON.parse(body.slice(start, end + 1));
}

function toCandidates(retrieval: CanonSearchResult): AskCandidate[] {
  return retrieval.candidates.map((c) => ({ entryId: c.entryId, title: c.title, score: c.score }));
}

function buildPrompt(
  question: string,
  candidates: Array<{ entryId: string; title: string; statement: string }>,
  retryNote?: string,
): string {
  const entries = candidates
    .map((c) => `### ${c.entryId} — ${c.title}\n${c.statement}`)
    .join("\n\n");
  return `Answer the question using ONLY the canon entries below. Respond with ONLY a JSON object, no prose, no fences.

Contract:
- If the entries support an answer: {"outcome":"answer","claims":[{"text":"<one claim in your words>","entryId":"CANON-nnn","excerpt":"<a VERBATIM span copied from that entry that supports the claim>"}]}
- If they do not decide the question: {"outcome":"cannot_answer"}

Rules that are checked mechanically, not taken on trust:
- Every excerpt must be copied character-for-character from its entry's text (whitespace may differ). A paraphrase will be rejected.
- Every entryId must be one of the entries below.
- If any part of a complete answer would need a fact the entries do not state, return cannot_answer instead of guessing.
${retryNote ? `\nYour previous response was rejected: ${retryNote}\n` : ""}
## Question
${question}

## Canon entries (the complete set you may use)
${entries}`;
}

export class AskService {
  constructor(
    private readonly adapter: HarnessAdapter | null,
    private readonly opts: AskOptions,
  ) {}

  async ask(store: WorldStore, question: string, worldQueryUrl?: string): Promise<AskResult> {
    const index = store.getIndex();
    if (!index) {
      return { outcome: "unavailable", reason: "the derived index is unavailable", searched: 0, closest: [] };
    }
    const retrieval = searchCanon(index.db, question, { limit: 8 });

    // Stage 1 — the floor. Below it there is no model call at all (R-10, D8 of SPEC-003).
    if (!retrieval.floorCleared) {
      return {
        outcome: "refusal",
        cause: "nothing-retrieved",
        searched: retrieval.searched,
        closest: toCandidates(retrieval),
      };
    }

    if (!this.adapter || !this.adapter.readiness().ready) {
      return {
        outcome: "unavailable",
        reason: this.adapter?.readiness().reason ?? "authoring is not available",
        searched: retrieval.searched,
        closest: toCandidates(retrieval),
      };
    }

    const candidates = new Map(
      retrieval.candidates.map((c) => [c.entryId, { title: c.title, statement: c.statement }]),
    );
    const closest = toCandidates(retrieval);
    const refusal = (detail: string): AskResult => ({
      outcome: "refusal",
      cause: "unsupporting",
      searched: retrieval.searched,
      closest,
      detail,
    });

    // The ask sandbox: an empty directory holding only the session config — never a world.
    const sandbox = join(this.opts.scratchRoot, `ask-${Date.now().toString(36)}`);
    await mkdir(toExtendedLength(sandbox), { recursive: true });
    await writeSessionFiles(this.adapter, sandbox, this.opts.sessionInput(worldQueryUrl ? { worldQueryUrl } : {}));

    try {
      const session = await this.adapter.createSession({ purpose: "ask", cwd: sandbox, agent: "canon-qa" });

      const turn = async (prompt: string): Promise<string> => {
        let finalText = "";
        const abort = new AbortController();
        const events = this.adapter!.streamEvents(abort.signal);
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
        await this.adapter!.dispatchAsync({ sessionId: session.sessionId, parts: [{ type: "text", text: prompt }] });
        // Refed, and cleared below — see ArtifactModel for why an unref'd deadline never fires.
        let deadline: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error("the answer took too long")),
            this.opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
          );
        });
        try {
          await Promise.race([collected, timeout]);
        } finally {
          clearTimeout(deadline);
          abort.abort();
        }
        return finalText;
      };

      const candidateList = retrieval.candidates.map((c) => ({
        entryId: c.entryId,
        title: c.title,
        statement: c.statement,
      }));

      // Stage 2 — parse, one retry (R-7). Independent of the verification retry (D3).
      let parsed: ReturnType<typeof AskModelResponseSchema.parse> | null = null;
      let raw = await turn(buildPrompt(question, candidateList));
      for (let attempt = 0; attempt < 2 && parsed === null; attempt++) {
        try {
          parsed = AskModelResponseSchema.parse(extractJson(raw));
        } catch (err) {
          if (attempt === 1) {
            return refusal("the model could not produce a valid response");
          }
          raw = await turn(
            buildPrompt(
              question,
              candidateList,
              `it was not valid JSON matching the contract (${err instanceof Error ? err.message.slice(0, 200) : "parse error"}). Respond with ONLY the JSON object.`,
            ),
          );
        }
      }
      if (parsed === null) return refusal("the model could not produce a valid response");

      if (parsed.outcome === "cannot_answer") {
        // The honest outcome: entries came close and none decides it (R-8, R-12).
        return refusal("the closest entries describe the area without deciding the question");
      }

      // Stage 3 — verification, all-or-nothing, one retry with the failures named (R-6).
      let failures = verifyClaims(parsed.claims, candidates);
      if (failures.length > 0) {
        const named = failures
          .map((f) =>
            f.reason === "not-a-candidate"
              ? `${f.entryId} was not among the entries you were given`
              : `your excerpt for ${f.entryId} does not appear in it — copy an exact span, do not paraphrase`,
          )
          .join("; ");
        const retryRaw = await turn(buildPrompt(question, candidateList, named));
        try {
          const retryParsed = AskModelResponseSchema.parse(extractJson(retryRaw));
          if (retryParsed.outcome === "cannot_answer") {
            return refusal("the closest entries describe the area without deciding the question");
          }
          failures = verifyClaims(retryParsed.claims, candidates);
          if (failures.length === 0) parsed = retryParsed;
        } catch {
          return refusal("the model could not ground its answer in the entries");
        }
        if (failures.length > 0) {
          // No answer renders from a partially verified claim set — refusal is safe,
          // distortion is not (R-6, D2).
          return refusal("the answer could not be verified against the entries it cited");
        }
      }

      return {
        outcome: "answer",
        claims: parsed.claims.map((c) => ({ text: c.text, entryId: c.entryId, excerpt: c.excerpt })),
        searched: retrieval.searched,
      };
    } catch (err) {
      return refusal(err instanceof Error ? err.message : String(err));
    } finally {
      await rm(toExtendedLength(sandbox), { recursive: true, force: true }).catch(() => {});
    }
  }
}
