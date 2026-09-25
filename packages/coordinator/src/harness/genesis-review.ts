import { join } from "node:path";
import {
  GenesisContentReviewSchema, SHEET_SHAPES, approvedGenesisBlueprint, approvedGenesisContent, genesisContentRows,
  type GenesisContentReview, type GenesisDecision, type GenesisReviewCard,
} from "@arke-studio/contracts";
import { conversationActionDigest } from "../arke-actions/digest.js";
import { serializeFileMutation } from "../world/atomic.js";
import { foldBlueprint } from "./blueprint.js";
import { genesisControlDir, genesisConversation } from "./genesis-conversation.js";

export async function reviewGenesisContent(dir: string): Promise<GenesisContentReview> {
  const blueprint = await foldBlueprint(dir);
  const log = await genesisConversation(dir);
  const { events, problems: journalProblems } = await log.read();
  if (journalProblems.length) throw new Error("The conversation record needs repair before content can be approved.");
  const decisions = events.flatMap(({ event }) => event.type === "founding.decision" ? [event.decision] : []);
  const selected = approvedGenesisContent(decisions);
  const rows = genesisContentRows(blueprint);
  for (const [key, content] of selected) {
    if (rows.some(row => row.key === key)) continue;
    rows.push({ key, title: `Remove ${content.kind === "thread" ? content.value : typeof content.value === "object" && "name" in content.value ? content.value.name : key}`,
      content: { kind: "remove", value: key } });
  }
  const cards: GenesisReviewCard[] = rows.map(row => {
    const digest = conversationActionDigest(row.content);
    const lastDecision = decisions.findLast(one => one.key === row.key);
    const decision = lastDecision?.digest === digest ? lastDecision : undefined;
    const previous = selected.get(row.key);
    return { ...row, digest, ...(previous ? { previous } : {}), status: decision?.decision === "approve" ? "approved" : decision ? "rejected" : "pending" };
  });
  const approved = approvedGenesisBlueprint(selected);
  const problems = blueprint.dropped.map(file => `Cannot read ${file}; repair it before founding.`);
  const ids = new Set([...approved.characters.map(c => `character:${c.slug}`), ...approved.locations.map(c => `location:${c.slug}`), ...approved.factions.map(c => `faction:${c.slug}`)]);
  for (const [kind, entities] of [["character", approved.characters], ["location", approved.locations], ["faction", approved.factions]] as const) {
    for (const entity of entities) {
      for (const field of ["role", "billing", "region"] as const) {
        if (entity.sheet?.[field] && !SHEET_SHAPES[kind].extraFields.includes(field)) problems.push(`${entity.name}: ${field} is not a field on a ${kind} sheet.`);
      }
      for (const heading of Object.keys(entity.sheet?.sections ?? {})) {
        if (!SHEET_SHAPES[kind].sections.some(section => section.heading === heading)) problems.push(`${entity.name}: unsupported section "${heading}".`);
      }
      for (const link of entity.sheet?.links ?? []) {
        if (!ids.has(link)) problems.push(`${entity.name}: approve or remove the relationship to ${link} before founding.`);
      }
    }
  }
  return GenesisContentReviewSchema.parse({ cards, selected: approved, problems });
}

export async function decideGenesisContent(
  dir: string, choices: Array<{ key: string; digest: string }>, decision: "approve" | "reject", requestId: string,
): Promise<GenesisContentReview> {
  return serializeFileMutation(join(genesisControlDir(dir), "content-decisions"), async () => {
    const log = await genesisConversation(dir);
    const review = await reviewGenesisContent(dir);
    const cards = choices.map(choice => {
      const card = review.cards.find(one => one.key === choice.key);
      if (!card || card.digest !== choice.digest) throw new Error("The proposed content changed. Review the current version before deciding.");
      return card;
    });
    // Validate the complete batch before appending any decisions.
    for (const card of cards) {
      const record: GenesisDecision = { key: card.key, digest: card.digest, content: card.content, decision, at: new Date().toISOString() };
      await log.append({ type: "founding.decision", decision: record }, { at: record.at, requestId: `${requestId}:${card.key}` });
    }
    return reviewGenesisContent(dir);
  });
}

export async function approvedBlueprintForFounding(dir: string) {
  const review = await reviewGenesisContent(dir);
  if (!review.selected.name) throw new Error("Approve the world identity and bible in the conversation before founding.");
  if (review.problems.length) throw new Error(review.problems.join(" "));
  return review.selected;
}
