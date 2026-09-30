import {
  ModelWorldChatActionSchema,
  type ArkeReadRequirement,
  type ArkeTargetReadTool,
  WORLD_ACTION_DESCRIPTIONS,
  WORLD_CHAT_SHAPE_EXAMPLES,
  type ArkeActionScope,
  type ModelWorldChatAction,
  type WorldChatContext,
} from "@arke-studio/contracts";
import { modelActionFields, worldChatActionDescriptor } from "../arke-actions/registry.js";

/**
 * What the model is told it can prepare, generated from what the coordinator accepts
 * (SPEC-050 R-1..R-5).
 *
 * The registry has long produced a model-facing catalogue, and nothing ever put it in a prompt.
 * The brief carried a handwritten list instead — world metadata, Canon, sheets, art direction —
 * so about thirty actions that parse, prepare and execute were never mentioned, and a person who
 * asked to file a document, draw a look or export the cut was told it could not be done. Every
 * entry here is read off the model schema's own options, the drift-tested example, and the
 * prepared-action descriptor the approval adapter uses, so there is no second list to fall
 * behind.
 */

export type ModelActionKind = ModelWorldChatAction["kind"];

/**
 * The read tools behind each requirement the registry names.
 *
 * The registry speaks in categories — "canon", "timeline" — and the model calls tools. Told only
 * the category, it has to guess which read satisfies it, and a guess that misses is refused as an
 * incomplete read after the whole turn is written. Keyed by the enum so a new category cannot
 * ship without its tools; `bench` has none yet (SPEC-050 R-28).
 */
const READ_TOOLS: Record<ArkeReadRequirement, readonly ArkeTargetReadTool[]> = {
  "world-metadata": ["get_world_metadata"],
  canon: ["list_canon"],
  sheets: ["list_sheets"],
  bible: ["get_bible"],
  "art-direction": ["get_art_direction"],
  references: ["list_references"],
  artifacts: ["list_artifacts"],
  voices: ["list_voices"],
  "production-metadata": ["get_production_metadata"],
  series: ["list_series"],
  story: ["get_story"],
  seasons: ["get_season"],
  episodes: ["list_episodes"],
  chapters: ["list_chapters", "get_chapter"],
  scenes: ["list_scenes", "get_scene"],
  shots: ["get_scene_shots"],
  stage: ["get_scene_stage"],
  boards: ["get_scene_boards"],
  takes: ["list_takes"],
  timeline: ["get_timeline"],
  audio: ["get_timeline"],
  subtitles: ["get_timeline"],
  spine: ["get_spine"],
  routing: ["get_routing"],
  plans: ["list_plans"],
  jobs: ["list_jobs"],
  exports: ["list_exports"],
  bench: [],
};

export function readToolsFor(requirements: readonly ArkeReadRequirement[]): readonly ArkeTargetReadTool[] {
  return [...new Set(requirements.flatMap((requirement) => READ_TOOLS[requirement]))];
}

export interface ActionGuideEntry {
  readonly kind: ModelActionKind;
  readonly description: string;
  readonly scope: ArkeActionScope;
  readonly cardFamily: string;
  /** The read tools whose complete receipts the action's checkReceiptIds should cite. */
  readonly reads: readonly ArkeTargetReadTool[];
  /** Null when the action can be prepared and approved; otherwise the refusal, said once. */
  readonly unavailable: string | null;
  /** Payload fields other than `kind` and `checkReceiptIds`, which every entry shares. */
  readonly fields: readonly string[];
  readonly example: ModelWorldChatAction;
}

function kindOf(option: (typeof ModelWorldChatActionSchema.options)[number]): ModelActionKind {
  return (option.shape.kind as { value: ModelActionKind }).value;
}

/**
 * An action is unavailable when any stage the person would meet is blocked.
 *
 * Execution counts, not only preparation: a kind whose execution waits on a seam still parses and
 * still becomes a card, and that card can never be approved. Telling the model it may prepare one
 * is how a person ends up pressing an Approve that does nothing (SPEC-050 G-3).
 */
function unavailableReason(kind: ModelActionKind): string | null {
  const descriptor = worldChatActionDescriptor(kind);
  if (!descriptor) return "No approval adapter handles this action.";
  for (const stage of ["preparation", "reads", "execution"] as const) {
    const support = descriptor.support[stage];
    if (support.state === "blocked") return support.reason;
  }
  return null;
}

function buildEntries(): readonly ActionGuideEntry[] {
  return ModelWorldChatActionSchema.options.map((option) => {
    const kind = kindOf(option);
    const descriptor = worldChatActionDescriptor(kind);
    if (!descriptor) throw new Error(`No prepared-action descriptor for model action ${kind}`);
    return {
      kind,
      description: WORLD_ACTION_DESCRIPTIONS[kind],
      scope: descriptor.scope,
      cardFamily: descriptor.cardFamily,
      reads: readToolsFor(descriptor.requiredReads),
      unavailable: unavailableReason(kind),
      fields: modelActionFields(option)
        .filter((field) => field.name !== "checkReceiptIds")
        .map((field) => `${field.name}${field.optional ? "?" : ""}: ${field.type}`),
      example: WORLD_CHAT_SHAPE_EXAMPLES.worldActions[kind],
    };
  });
}

/** Built once: every input is a module-level constant. */
export const ACTION_GUIDE_ENTRIES: readonly ActionGuideEntry[] = buildEntries();

const ENTRY_BY_KIND = new Map(ACTION_GUIDE_ENTRIES.map((entry) => [entry.kind, entry]));

export function actionGuideEntry(kind: string): ActionGuideEntry | undefined {
  return ENTRY_BY_KIND.get(kind as ModelActionKind);
}

/**
 * Which actions a thread is told about (SPEC-050 R-3).
 *
 * A world thread gets world actions; a production, episode or scene thread gets both, because
 * casting a character or drawing its look is part of making the scene. Production setup gets
 * none: its turns may only update their draft, and a list of actions it would be refused is
 * noise that invites the refusal.
 */
export function actionGuideScopes(context: WorldChatContext | undefined): readonly ArkeActionScope[] {
  switch (context?.kind) {
    case "production-setup":
      return [];
    case "production":
    case "episode":
    case "scene":
      return ["world", "production"];
    default:
      return ["world"];
  }
}

function fullEntry(entry: ActionGuideEntry): string {
  const head = `- ${entry.kind} · ${entry.cardFamily} card · read first: ${entry.reads.join(", ") || "nothing"}`;
  if (entry.unavailable !== null) {
    return `${head}\n  ${entry.description}\n  Unavailable: ${entry.unavailable} Do not prepare it; say so instead.`;
  }
  return [
    head,
    `  ${entry.description}`,
    `  fields: ${entry.fields.join("; ")}`,
    `  example: ${JSON.stringify(entry.example)}`,
  ].join("\n");
}

function compactEntry(entry: ActionGuideEntry): string {
  const suffix = entry.unavailable !== null ? " Unavailable; say so instead." : "";
  return `- ${entry.kind} · ${entry.cardFamily} — ${entry.description}${suffix}`;
}

const FULL_HEAD =
  "Each entry is a kind you may put in actions, with the card it becomes, the reads whose final complete receipts its checkReceiptIds cite, its fields besides kind and checkReceiptIds, and one valid example.";
const COMPACT_HEAD =
  "Only the kinds are listed here, to leave room for the conversation. Before preparing one, call describe_action through arke-world with its kind for the fields and an example.";

export interface RenderedActionGuide {
  readonly text: string;
  readonly mode: "full" | "compact" | "none";
}

/**
 * The guide for one turn, whole when it fits its share and collapsed when it does not.
 *
 * Collapsing keeps every kind named (R-5): leaving kinds out to save room would be the silent
 * omission this replaced. The share is a fifth of the turn's budget — enough that a large cloud
 * model sees every field and example, while a small local window still leaves the conversation
 * the room it needs and fetches detail on demand.
 */
export function renderActionGuide(
  scopes: readonly ArkeActionScope[],
  budgetChars: number,
): RenderedActionGuide {
  if (scopes.length === 0) return { text: "", mode: "none" };
  const entries = ACTION_GUIDE_ENTRIES.filter((entry) => scopes.includes(entry.scope));
  const full = [FULL_HEAD, ...entries.map(fullEntry)].join("\n");
  if (full.length <= Math.floor(budgetChars / 5)) return { text: full, mode: "full" };
  return { text: [COMPACT_HEAD, ...entries.map(compactEntry)].join("\n"), mode: "compact" };
}

/** What describe_action answers: one entry, whole, or null for a kind the schema does not take. */
export function describeAction(kind: string) {
  const entry = actionGuideEntry(kind);
  if (!entry) return null;
  return {
    kind: entry.kind,
    description: entry.description,
    scope: entry.scope,
    card: entry.cardFamily,
    reads: entry.reads,
    ...(entry.unavailable !== null
      ? { unavailable: entry.unavailable }
      : { fields: entry.fields, example: entry.example }),
  };
}
