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
  }
}
