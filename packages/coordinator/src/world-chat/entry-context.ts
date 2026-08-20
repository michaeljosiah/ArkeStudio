import type { WorldBundle, WorldChatContext } from "@arke-studio/contracts";

/**
 * What the conversation was opened about, in a sentence the model can use (#70 phase 6).
 *
 * A conversation started from a refusal already has its question; one started from a sheet
 * already has its subject. Handing that over is the whole point of the entry points — otherwise
 * somebody describes what they were looking at, having just been looking at it.
 *
 * Only names and ids cross: the model reads the entity itself through its tools, at the version
 * that is current when it asks, rather than from a snapshot pasted into a prompt that may already
 * be out of date.
 */
export function describeEntryContext(context: WorldChatContext, bundle: WorldBundle): string {
  switch (context.kind) {
    case "world":
      return "";
    case "canon-question": {
      const considered = context.candidateEntryIds.filter((id) => bundle.canon.some((c) => c.id === id));
      const closest =
        considered.length > 0
          ? ` The closest entries the search found were ${considered.join(", ")}, and none of them answered it.`
          : " Nothing in canon came close to it.";
      return `This conversation was opened from a question canon could not answer: "${context.question}".${closest}`;
    }
    case "canon-entry": {
      const entry = bundle.canon.find((c) => c.id === context.entryId);
      const named = entry ? `${context.entryId} — "${entry.title}"` : context.entryId;
      return `This conversation was opened from the canon entry ${named}. Read it before proposing a change to it.`;
    }
    case "sheet": {
      const sheet = bundle.sheets.find((s) => s.id === context.sheetId);
      const named = sheet ? `${sheet.name} (${context.sheetKind}, ${context.sheetId})` : context.sheetId;
      return `This conversation was opened from the ${context.sheetKind} sheet for ${named}. Read it before proposing a change to it.`;
    }
    case "attachment":
      return "This conversation was opened from a document that was handed over. Read it before drawing anything from it.";
    case "production": {
      const production = bundle.productions.find((p) => p.meta.id === context.productionId);
      const named = production ? `"${production.meta.title}" (${context.productionId})` : context.productionId;
      // The production records are not reachable through the world-query tools, so the current
      // state travels in the entry narration — the same reasoning as the world look.
      const lines = [
        `This is the Development thread for the production ${named}. It shapes the overview, the season, and the episodes; world facts that surface here cross over as their own proposals, never inside a production edit.`,
      ];
      if (production?.story) {
        lines.push(
          `The overview is v${production.story.version}${production.story.logline ? ` — logline: "${clip(production.story.logline)}"` : ""}${production.story.spine ? `; spine: "${clip(production.story.spine)}"` : ""}.`,
        );
      } else lines.push("There is no overview yet.");
      if (production?.season) {
        lines.push(
          `The season is v${production.season.version}${production.season.question ? ` — question: "${clip(production.season.question)}"` : ""}${production.season.ending ? `; ending: "${clip(production.season.ending)}"` : ""}.`,
        );
      }
      if (production && production.episodes.length > 0) {
        lines.push(
          `Episodes, in order: ${production.episodes
            .slice(0, 20)
            .map((e) => `${e.id} "${e.title}" (${e.scenes.length} scene${e.scenes.length === 1 ? "" : "s"})`)
            .join("; ")}.`,
        );
      }
      return lines.join(" ");
    }
    case "episode": {
      const production = bundle.productions.find((p) => p.meta.id === context.productionId);
      const episode = production?.episodes.find((e) => e.id === context.episodeId);
      const named = episode ? `"${episode.title}" (${context.episodeId})` : context.episodeId;
      const lines = [
        `This is the episode thread for ${named} in the production ${context.productionId}. An episode is its promise and its scenes in order; a script belongs to a scene and to nothing above it.`,
      ];
      if (episode) {
        const promise = episode.promise;
        if (promise && (promise.opens || promise.turn || promise.closes)) {
          lines.push(
            `Its promise: ${[
              promise.opens ? `opens — "${clip(promise.opens)}"` : null,
              promise.turn ? `turn — "${clip(promise.turn)}"` : null,
              promise.closes ? `closes — "${clip(promise.closes)}"` : null,
            ]
              .filter(Boolean)
              .join("; ")}.`,
          );
        }
        lines.push(
          episode.scenes.length > 0 ? `Its scenes, in order: ${episode.scenes.join(", ")}.` : "It has no scenes yet.",
        );
      }
      return lines.join(" ");
    }
    case "scene": {
      const production = bundle.productions.find((p) => p.meta.id === context.productionId);
      const scene = production?.scenes.find((s) => s.id === context.sceneId);
      const named = scene ? `"${scene.title}" (${context.sceneId})` : context.sceneId;
      const lines = [
        `This is the scene thread for ${named} in the production ${context.productionId}. Its script is ordered blocks that shots cite; propose the whole block list as it should read, keeping an existing block's id when only its text changes.`,
      ];
      if (scene?.script && scene.script.blocks.length > 0) {
        lines.push(
          `The current blocks: ${scene.script.blocks
            .slice(0, 40)
            .map((b) => `${b.id} [${b.kind}${b.speaker ? ` ${b.speaker}` : ""}] "${clip(b.text)}"`)
            .join("; ")}.`,
        );
      } else if (scene) lines.push(`It has no script yet, and ${scene.shots.length} shot${scene.shots.length === 1 ? "" : "s"}.`);
      return lines.join(" ");
    }
  }
}

/** Bounded quotation: enough to recognise the text, never the whole document. */
function clip(text: string): string {
  return text.length <= 200 ? text : `${text.slice(0, 197)}…`;
}
