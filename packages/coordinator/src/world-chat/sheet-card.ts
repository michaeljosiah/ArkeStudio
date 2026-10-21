import type { ConversationActionRecord, WorldChangeCandidate } from "@arke-studio/contracts";

/**
 * Recover old candidate cards without rewriting their binding, values or preview digest.
 * Exact matching prevents an ambiguous heading or a later draft from hiding unrelated fields.
 */
export function sheetCreationProseFields(
  action: ConversationActionRecord,
  candidates: ReadonlyMap<string, WorldChangeCandidate>,
): number[] | undefined {
  if (action.actionKind !== "world-chat-proposal" || action.shown.body.family !== "authored-diff") return;
  const fields = action.shown.body.fields;
  if (fields.some(field => field.before !== null)) return;
  const indices = new Set<number>();
  for (const target of action.targets) {
    const candidate = candidates.get(target.id);
    if (target.kind !== "world-change" || candidate?.classification !== "sheet.create") return;
    for (const section of candidate.draft.sections) {
      const label = `${candidate.draft.name}: ${section.heading}`.slice(0, 200);
      const after = section.body.length > 20_000 ? `${section.body.slice(0, 19_999)}…` : section.body;
      const matches = fields.flatMap((field, index) => field.label === label && field.after === after ? [index] : []);
      if (matches.length !== 1 || indices.has(matches[0]!)) return;
      indices.add(matches[0]!);
    }
  }
  return indices.size > 0 ? [...indices].sort((a, b) => a - b) : undefined;
}
