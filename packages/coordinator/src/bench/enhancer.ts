import type { ManifestModel, WorldBundle } from "@arke-studio/contracts";

/**
 * The bench's prompt enhancer (issue 305 §3, asked for on 2026-08-16): the art director
 * rewrites the author's rough ask into a prompt the CHOSEN model wants, grounded in what the
 * world itself says — its look, its settled canon — never in invented context.
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
  const world = [
    `World: ${meta.name}`,
    meta.logline?.trim() ? `Logline: ${meta.logline.trim()}` : null,
    meta.tone?.trim() ? `Tone: ${meta.tone.trim()}` : null,
    meta.genre?.trim() ? `Genre: ${meta.genre.trim()}` : null,
    `The world's look, binding: ${bundle.artDirection.description}`,
    canonLines.length > 0 ? `Established, and binding:\n${canonLines.join("\n")}` : null,
  ].filter((l): l is string => l !== null);
  const rules = [
    "- Keep the author's subject; translate it into what an image or video model wants - subject, light, lens, material, motion.",
    "- Stay inside the world's look and its established canon; invent nothing the world has not said.",
    '- Reference tokens like "Image 1" or "Audio 2" are citations the pipeline resolves - keep any the ask uses, verbatim.',
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
