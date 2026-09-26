import { join } from "node:path";
import {
  CHARACTER_ROLE_MAX, GenesisContentReviewSchema, SHEET_SHAPES, approvedGenesisBlueprint, approvedGenesisContent, genesisContentRows, genesisSheetIds, checkPropName,
  type GenesisContentReview, type GenesisDecision, type GenesisReviewCard,
} from "@arke-studio/contracts";
import { conversationActionDigest } from "../arke-actions/digest.js";
import { serializeFileMutation } from "../world/atomic.js";
import { foldBlueprint } from "./blueprint.js";
import { genesisControlDir, genesisConversation } from "./genesis-conversation.js";
import { recoverGenesisImports, restoreGenesisSources, validateGenesisSources } from "./genesis-imports.js";

export async function reviewGenesisContent(dir: string): Promise<GenesisContentReview> {
  await recoverGenesisImports(dir);
  const blueprint = await restoreGenesisSources(dir, await foldBlueprint(dir));
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
    const decision = decisions.findLast(one => one.key === row.key && one.digest === digest);
    const previous = selected.get(row.key);
    const isSelected = previous && conversationActionDigest(previous) === digest;
    const removed = row.content.kind === "remove" && !previous && decision?.decision === "approve";
    return { ...row, digest, ...(previous ? { previous } : {}), status: decision?.decision === "reject" ? "rejected" : isSelected || removed ? "approved" : "pending" };
  });
  const approved = approvedGenesisBlueprint(selected);
  await validateGenesisSources(dir, approved);
  const problems = blueprint.dropped.map(file => `Cannot read ${file}; repair it before founding.`);
  const propNames = new Set<string>();
  const propSlugs = new Set<string>();
  const sheetNames = [...genesisSheetIds(approved).values()].map(id => ({ id, name: id }));
  for (const prop of approved.props ?? []) {
    if (!checkPropName(prop.name, (approved.props ?? []).filter(other => other !== prop).map(other => ({ id: other.slug, name: other.name })), sheetNames).ok) problems.push(`${prop.name}: the prop name conflicts with another entity.`);
    if (propSlugs.has(prop.slug) || propNames.has(prop.name.toLowerCase())) problems.push(`${prop.name}: prop identities and names must be unique.`);
    propSlugs.add(prop.slug); propNames.add(prop.name.toLowerCase());
    if (new Set(prop.states.map(state => state.name.toLowerCase())).size !== prop.states.length) problems.push(`${prop.name}: state names must be distinct.`);
  }
  for (const name of approved.keyArt?.characters ?? []) {
    if (!approved.characters.some(character => character.name === name)) problems.push(`Key art names ${name}, who is not an approved character. Update and approve the key-art brief before founding.`);
  }
  const ids = new Set([...approved.characters.map(c => `character:${c.slug}`), ...approved.locations.map(c => `location:${c.slug}`), ...approved.factions.map(c => `faction:${c.slug}`)]);
  for (const [kind, entities] of [["character", approved.characters], ["location", approved.locations], ["faction", approved.factions]] as const) {
    for (const entity of entities) {
      if ((entity.sheet?.role?.length ?? 0) > CHARACTER_ROLE_MAX) problems.push(`${entity.name}: shorten the character role to ${CHARACTER_ROLE_MAX} characters before founding.`);
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
    await validateGenesisSources(dir, await restoreGenesisSources(dir, await foldBlueprint(dir)));
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
