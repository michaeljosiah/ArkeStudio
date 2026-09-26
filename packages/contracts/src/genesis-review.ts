import { z } from "zod";
import { BlueprintCharacterSchema, BlueprintFactionSchema, BlueprintLocationSchema, GenesisBlueprintSchema, GenesisCanonSchema, type GenesisBlueprint } from "./genesis.js";
import { SHEET_SHAPES } from "./sheet-shapes.js";

export const FOUNDING_CONTENT_SCHEMA_VERSION = 34;

export const GenesisContentSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("world"), value: GenesisBlueprintSchema.omit({ characters: true, locations: true, factions: true, canon: true, threads: true, dropped: true, reviewed: true }) }).strict(),
  z.object({ kind: z.literal("character"), value: BlueprintCharacterSchema }).strict(),
  z.object({ kind: z.literal("location"), value: BlueprintLocationSchema }).strict(),
  z.object({ kind: z.literal("faction"), value: BlueprintFactionSchema }).strict(),
  z.object({ kind: z.literal("canon"), value: GenesisCanonSchema }).strict(),
  z.object({ kind: z.literal("thread"), value: z.string().min(1).max(300) }).strict(),
  z.object({ kind: z.literal("remove"), value: z.string().min(1) }).strict(),
]);
export type GenesisContent = z.infer<typeof GenesisContentSchema>;
export const GenesisDecisionSchema = z.object({
  key: z.string().min(1), digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  content: GenesisContentSchema, decision: z.enum(["approve", "reject"]), at: z.string().datetime(),
}).strict();
export type GenesisDecision = z.infer<typeof GenesisDecisionSchema>;
export const GenesisReviewCardSchema = z.object({
  key: z.string(), digest: z.string(), title: z.string(),
  content: GenesisContentSchema, previous: GenesisContentSchema.optional(),
  status: z.enum(["pending", "approved", "rejected"]),
}).strict();
export type GenesisReviewCard = z.infer<typeof GenesisReviewCardSchema>;
export const GenesisContentReviewSchema = z.object({
  cards: z.array(GenesisReviewCardSchema), selected: GenesisBlueprintSchema,
  problems: z.array(z.string()),
}).strict();
export type GenesisContentReview = z.infer<typeof GenesisContentReviewSchema>;

export function genesisContentChanges(previous: GenesisContent, next: GenesisContent): Array<{ field: string; before: string; after: string }> {
  const flatten = (value: unknown, prefix = ""): Record<string, string> => {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).flatMap(([key, child]) => Object.entries(flatten(child, prefix ? `${prefix} · ${key}` : key))));
    }
    return { [prefix]: Array.isArray(value) ? value.join(", ") : String(value ?? "") };
  };
  const before = flatten(previous.value), after = flatten(next.value);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(field => before[field] !== after[field])
    .map(field => ({ field, before: before[field] ?? "", after: after[field] ?? "" }));
}

/** Canonical sheet text is what the preview and the founding writer both consume. */
export function completeGenesisSheet<T extends { name: string; line?: string; description?: string; sheet?: z.infer<typeof import("./genesis.js").GenesisSheetContentSchema> }>(kind: "character" | "location" | "faction", entity: T) {
  const shape = SHEET_SHAPES[kind];
  const sections = { ...entity.sheet?.sections };
  const first = shape.sections.find(section => section.required)!.heading;
  if (!sections[first]?.trim()) {
    sections[first] = entity.description ?? entity.line ?? entity.name;
  }
  for (const section of shape.sections) {
    if (section.required && !sections[section.heading]?.trim()) sections[section.heading] = "—";
  }
  return { ...entity, sheet: { ...entity.sheet, sections: Object.fromEntries(Object.entries(sections).map(([key, value]) => [key, value.trim()])) } };
}

export function genesisContentRows(blueprint: GenesisBlueprint): Array<{ key: string; title: string; content: GenesisContent }> {
  const { characters, locations, factions, threads, canon, dropped, reviewed, ...world } = blueprint;
  void dropped; void reviewed;
  return [
    { key: "world", title: world.name ?? "World identity and bible", content: { kind: "world", value: world } as GenesisContent },
    ...(["character", "location", "faction"] as const).flatMap((kind, index) =>
      ([characters, locations, factions][index] ?? []).map(entity => ({
        key: `${kind}:${entity.slug}`, title: entity.name,
        content: { kind, value: completeGenesisSheet(kind, entity) } as GenesisContent,
      }))),
    ...(canon ?? []).map(entry => ({ key: `canon:${entry.slug}`, title: entry.title, content: { kind: "canon", value: entry } as GenesisContent })),
    ...[...new Set(threads)].map(question => ({ key: `thread:${question}`, title: question, content: { kind: "thread", value: question } as GenesisContent })),
  ];
}

export function approvedGenesisContent(decisions: readonly GenesisDecision[]): Map<string, GenesisContent> {
  const selected = new Map<string, GenesisContent>();
  for (const decision of decisions) {
    if (decision.decision !== "approve") continue;
    if (decision.content.kind === "remove") selected.delete(decision.key);
    else selected.set(decision.key, decision.content);
  }
  return selected;
}

export function approvedGenesisBlueprint(selected: ReadonlyMap<string, GenesisContent>): GenesisBlueprint {
  const result: GenesisBlueprint = { characters: [], locations: [], factions: [], threads: [], canon: [], dropped: [], reviewed: true };
  for (const content of selected.values()) {
    switch (content.kind) {
      case "world": Object.assign(result, content.value); break;
      case "character": result.characters.push(content.value); break;
      case "location": result.locations.push(content.value); break;
      case "faction": result.factions.push(content.value); break;
      case "canon": result.canon!.push(content.value); break;
      case "thread": result.threads.push(content.value); break;
    }
  }
  return result;
}

/** Frozen blueprint order gives recoverable, unique world sheet IDs for draft identities. */
export function genesisSheetIds(blueprint: GenesisBlueprint): Map<string, string> {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const [kind, entities] of [["character", blueprint.characters], ["location", blueprint.locations], ["faction", blueprint.factions]] as const) {
    for (const entity of entities) {
      const stem = `${kind}-${entity.slug}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 70).replace(/-$/, "");
      let id = stem;
      for (let n = 2; taken.has(id); n++) id = `${stem}-${n}`;
      taken.add(id);
      ids.set(`${kind}:${entity.slug}`, id);
    }
  }
  return ids;
}
