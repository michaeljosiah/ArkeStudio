import type { ArkeTargetReadTool } from "@arke-studio/contracts";

export interface TargetReadToolDefinition {
  readonly name: ArkeTargetReadTool;
  readonly description: string;
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, unknown>>;
    readonly required?: readonly string[];
    readonly additionalProperties: false;
  };
}

const PAGE = {
  cursor: { type: "string", description: "Opaque next cursor from the preceding page" },
  limit: { type: "number", description: "Maximum rows (default 8, maximum 20)" },
} as const;
const PRODUCTION = { productionId: { type: "string", description: "Production id" } } as const;
const SCENE = {
  ...PRODUCTION,
  sceneId: { type: "string", description: "Scene id" },
} as const;

function tool(
  name: ArkeTargetReadTool,
  description: string,
  properties: Readonly<Record<string, unknown>>,
  required: readonly string[] = [],
): TargetReadToolDefinition {
  return {
    name,
    description: `${description} Results are revision-fenced and cursor-paged; follow nextCursor until complete is true before preparing a whole-target action.`,
    inputSchema: {
      type: "object",
      properties: { ...properties, ...PAGE },
      ...(required.length > 0 ? { required } : {}),
      additionalProperties: false,
    },
  };
}

/** Target-specific rather than path-shaped: callers can name an authority, never a file. */
export const TARGET_READ_TOOLS: readonly TargetReadToolDefinition[] = [
  tool("get_world_metadata", "Read the open world's complete metadata.", {}),
  tool("list_world_index", "List every targetable world, Canon, sheet, production and Series identity.", {}),
  tool("list_canon", "Read complete Canon entries in stable id order.", {}),
  tool("list_sheets", "Read complete character, location and faction sheets in stable id order.", {}),
  tool("get_bible", "Read the complete Bible in bounded text chunks.", {}),
  tool("get_art_direction", "Read the complete resolved art direction.", {}),
  tool("list_references", "Read complete reference kits, tiles, looks and compilations.", {}),
  tool("list_artifacts", "Read complete artifact sidecars including extraction state and provenance.", {}),
  tool("list_voices", "Read cloned voices and every sheet voice assignment.", {}),
  tool("list_productions", "Read every production identity and metadata record.", {}),
  tool("list_series", "Read complete Series records.", {}),
  tool("get_production_metadata", "Read one production's complete metadata.", PRODUCTION, ["productionId"]),
  tool("get_story", "Read one production's story overview and treatment in bounded chunks.", PRODUCTION, ["productionId"]),
  tool("get_season", "Read one production's complete season, including every arc.", PRODUCTION, ["productionId"]),
  tool("list_episodes", "Read every episode and scene membership in explicit order.", PRODUCTION, ["productionId"]),
  tool("list_chapters", "Read every chapter summary in explicit order.", PRODUCTION, ["productionId"]),
  tool(
    "get_chapter",
    "Read one chapter's complete prose in bounded chunks.",
    { ...PRODUCTION, chapterId: { type: "string", description: "Chapter id or file stem" } },
    ["productionId", "chapterId"],
  ),
  tool("list_scenes", "Read the complete scene identity and summary index; use get_scene for each full record.", PRODUCTION, ["productionId"]),
  tool("get_scene", "Read one complete scene record.", SCENE, ["productionId", "sceneId"]),
  tool("get_scene_script", "Read one scene's whole ordered script block list.", SCENE, ["productionId", "sceneId"]),
  tool("get_scene_shots", "Read every shot in one scene in canonical order.", SCENE, ["productionId", "sceneId"]),
  tool("get_scene_stage", "Read scene blocking and all shot staging in one scene.", SCENE, ["productionId", "sceneId"]),
  tool("get_scene_boards", "Read authored board controls, compiled board and storyboard for one scene.", SCENE, ["productionId", "sceneId"]),
  tool("list_takes", "Read every take, review, selection and available media measurement.", PRODUCTION, ["productionId"]),
  tool("get_timeline", "Read every timeline track, clip, cue, library item, mix value and available take.", PRODUCTION, ["productionId"]),
  tool("get_spine", "Read the complete production spine: track, markers and anchors.", PRODUCTION, ["productionId"]),
  tool("get_routing", "Read the complete interactive routing graph.", PRODUCTION, ["productionId"]),
  tool("list_plans", "Read complete durable dispatch plans.", PRODUCTION, ["productionId"]),
  tool("list_jobs", "Read every safe job record for this world, optionally narrowed to a production.", { ...PRODUCTION }),
  tool("list_exports", "Read every currently targetable export for this world, optionally narrowed to a production.", { ...PRODUCTION }),
];

export const TARGET_READ_TOOL_NAMES = TARGET_READ_TOOLS.map((entry) => entry.name);

const TARGET_READ_TOOL_SET: ReadonlySet<string> = new Set(TARGET_READ_TOOL_NAMES);

export function isTargetReadTool(value: string): value is ArkeTargetReadTool {
  return TARGET_READ_TOOL_SET.has(value);
}
