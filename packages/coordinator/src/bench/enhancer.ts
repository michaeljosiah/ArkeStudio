import type { ManifestModel, WorldBundle } from "@arke-studio/contracts";
import { bibleExcerpt } from "../references/key-art-references.js";

/**
 * The bench's prompt enhancer (issue 305 §3, asked for on 2026-08-16): the art director
 * rewrites the author's rough ask into a prompt the CHOSEN model wants, grounded in what the
 * world itself says — its look, its standing failures, its bible, its settled canon — never in
 * invented context.
 *
 * This assembles the one-turn brief; the turn itself is the same art-director machinery the
 * world image uses (references/art-director.ts): one harness session, JSON `{prompt}` or
 * nothing, and nothing here is allowed to be the reason a button does nothing.
 */
export function enhancerBrief(
  bundle: WorldBundle,
  model: ManifestModel,
  ask: string,
): string {
  // The most-cited settled canon, the same six the world image is held to.
  const canonLines = bundle.canon
    .filter((c) => c.status !== "open")
    .slice(0, 6)
    .map((c) => `- ${c.title}`);
  const meta = bundle.meta;
  const cap = model.limits.maxPromptChars;
  /*
   * The Bible is the author's own thinking, and it is deliberately NOT canon (master §4.5): nothing
   * cites it, and the grounded Q&A pipeline never answers out of it. A prompt is not an answer,
   * though — key art already draws on it for exactly this reason (SPEC-031 R-58), because an
   * image assembled from a logline and two adjectives is an image of a genre rather than of this
   * world. So it rides here as intent, said to be intent, and never under the word "binding"
   * that the look and the settled canon are given.
   */
  const bible = bundle.bible.present ? bibleExcerpt(bundle.bible.text, 600) : "";
  const world = [
    `World: ${meta.name}`,
    meta.logline?.trim() ? `Logline: ${meta.logline.trim()}` : null,
    meta.tone?.trim() ? `Tone: ${meta.tone.trim()}` : null,
    meta.genre?.trim() ? `Genre: ${meta.genre.trim()}` : null,
    `The world's look, binding: ${bundle.artDirection.description}`,
    bible !== ""
      ? `The author's own thinking about this world - intent and mood, not settled fact: ${bible}`
      : null,
    canonLines.length > 0 ? `Established, and binding:\n${canonLines.join("\n")}` : null,
  ].filter((l): l is string => l !== null);
  /*
   * The look's standing failures — "do not drift the Polaroid", "hands stay whole" — are the
   * things worth saying every time, and the rewrite is the only place a bench prompt can hear
   * them: the bench sends its brief to the provider as it stands, so nothing downstream restores
   * one the rewrite left out. Bounded by the record itself (20 × 300 chars), not again here.
   */
  const failureModes = bundle.artDirection.failureModes;
  const rules = [
    "- Keep the author's subject; translate it into what an image or video model wants - subject, light, lens, material, motion.",
    "- Stay inside the world's look and its established canon; invent nothing the world has not said.",
    ...(failureModes.length > 0
      ? [
          `- The look's standing failures, to be written against every time:\n${failureModes
            .map((mode) => `  - ${mode}`)
            .join("\n")}`,
        ]
      : []),
    '- Mentions like "@Image 1" or "@Audio 2" are citations of pictures and sounds already attached - keep every one the ask uses, verbatim, at-sign and all. Dropping one, or rewriting it into plain words, loses the reference.',
    ...(cap !== undefined ? [`- ${model.displayName} takes at most ${cap} characters of prompt; stay well inside it.`] : []),
    '- Answer with JSON only: {"prompt": "..."} - no prose around it.',
  ];
  return [
    `Rewrite the author's ask below as a single ${model.capability} prompt for ${model.displayName}` +
      (model.family !== undefined ? ` (the ${model.family} family)` : "") +
      ".",
    world.join("\n"),
    `The author's ask, whose subject and intent are not yours to change:\n${ask.trim()}`,
    `Rules:\n${rules.join("\n")}`,
  ].join("\n\n");
}
