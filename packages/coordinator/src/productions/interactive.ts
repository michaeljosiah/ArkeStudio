/**
 * Interactive video (epic #401; brief rev 1): the routing record through the gate machinery,
 * durable traversal evidence, named findings, canon promotion with route provenance, and the
 * self-hostable export package with deterministic validation.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, open as openFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  ConversationActionSemanticIdSchema,
  deriveCut,
  hasOwnFrame,
  playbackWindow,
  playerBeats,
  productionShape,
  publicationBlockers,
  routingFindings,
  RoutingSchema,
  sceneBeats,
  TraversalEvidenceSchema,
  ulid,
  INTERACTIVE_PLAYER_SOURCE,
  type ArtifactSidecar,
  type PlayerBeat,
  type ProductionBundle,
  type Routing,
  type RoutingCommand,
  type RoutingFinding,
  type TraversalEvidence,
  orderedShots,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { JsonFile, sha256 } from "../world/text-files.js";
import type { ProposalManager } from "../gate/proposals.js";
import type { CommitInput } from "../world/commit.js";
import type { WorldStatePrecondition, WorldStore } from "../world/store.js";

/**
 * Save the routing record — the import boundary where the no-state rule is enforced twice:
 * the strict parse here refuses a `condition` key by name, and the gate's own routing lane
 * (JSON_TRACK_SCHEMAS) refuses the same shape arriving through a proposal.
 */
export async function saveRouting(
  store: WorldStore,
  productionId: string,
  proposed: unknown,
  options: { source?: string; requestId?: string; precondition?: WorldStatePrecondition } = {},
): Promise<Routing> {
  const routing = RoutingSchema.parse(proposed);
  const raw = await readRoutingRaw(store, productionId);
  await store.commit(routingCommit(productionId, routing, raw, options), undefined, options.precondition);
  return routing;
}

function routingPath(productionId: string): string {
  return `productions/${productionId}/routing.json`;
}

async function readRoutingRaw(store: WorldStore, productionId: string): Promise<string | null> {
  try {
    return await readFile(toExtendedLength(join(store.dir, fromPortable(routingPath(productionId)))), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** The routing file as a commit against `raw`, the file it was computed from — so a move since is stale. */
function routingCommit(
  productionId: string,
  routing: Routing,
  raw: string | null,
  options: { source?: string; requestId?: string },
): CommitInput {
  const path = routingPath(productionId);
  let content: string;
  if (raw !== null) {
    const doc = JsonFile.parse(raw);
    doc.set(routing);
    content = doc.serialize();
  } else {
    content = JSON.stringify(routing, null, 2) + "\n";
  }
  return {
    kind: "routing-save",
    source: options.source ?? "form",
    files: [
      raw !== null
        ? { path, action: "replace", content, baseHash: sha256(raw) }
        : { path, action: "create", content, baseHash: null },
    ],
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
  };
}

/** Scenes a route reaches: the start and everything its choices lead to. */
function reachable(routing: Routing): Set<string> {
  const seen = new Set([routing.start]);
  const queue = [routing.start];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const choice of routing.choices) {
      if (choice.from === at && !seen.has(choice.to)) {
        seen.add(choice.to);
        queue.push(choice.to);
      }
    }
  }
  return seen;
}

/**
 * An excluded scene is off every route (brief §2: exclusion is what makes "unreachable" an
 * author's decision). A scene a route reaches could be excluded, and a choice routed into an
 * excluded one; the findings did not object, so the export was offered, and then refused after
 * copying media, because the excluded scene ships none. The commands refuse the shape instead.
 */
function refuseExcludedOnRoute(next: Routing): void {
  const excluded = new Set(next.excluded.map((entry) => entry.sceneId));
  for (const id of reachable(next)) {
    if (excluded.has(id)) {
      throw new Error(`${id} is excluded but a route reaches it — remove or retarget the choices into it first.`);
    }
  }
}

/** Apply one closed routing command; the full record remains the existing routing authority. */
export function applyRoutingCommand(current: Routing | null, command: RoutingCommand): Routing {
  if (current === null) {
    if (command.operation !== "set-start") throw new Error("Set the start scene before editing routing.");
    return RoutingSchema.parse({ version: 1, start: command.sceneId, choices: [], endings: [], excluded: [], groups: [] });
  }
  let next: Routing;
  switch (command.operation) {
    case "set-start":
      next = { ...current, start: command.sceneId };
      break;
    case "add-choice":
      if (current.choices.some((choice) => choice.id === command.choice.id)) {
        throw new Error(`Choice ${command.choice.id} already exists.`);
      }
      next = { ...current, choices: [...current.choices, command.choice] };
      break;
    case "edit-choice": {
      const index = current.choices.findIndex((choice) => choice.id === command.choiceId);
      if (index < 0) throw new Error(`Choice ${command.choiceId} does not exist.`);
      next = {
        ...current,
        choices: current.choices.map((choice, at) => at === index ? { ...choice, ...command.changes } : choice),
      };
      break;
    }
    case "remove-choice":
      if (!current.choices.some((choice) => choice.id === command.choiceId)) {
        throw new Error(`Choice ${command.choiceId} does not exist.`);
      }
      next = { ...current, choices: current.choices.filter((choice) => choice.id !== command.choiceId) };
      break;
    case "set-ending":
      next = {
        ...current,
        endings: [
          ...current.endings.filter((ending) => ending.sceneId !== command.sceneId),
          { sceneId: command.sceneId, title: command.title },
        ],
      };
      break;
    case "clear-ending":
      if (!current.endings.some((ending) => ending.sceneId === command.sceneId)) {
        throw new Error(`${command.sceneId} is not designated as an ending.`);
      }
      next = { ...current, endings: current.endings.filter((ending) => ending.sceneId !== command.sceneId) };
      break;
    case "exclude-scene":
      next = {
        ...current,
        excluded: [
          ...current.excluded.filter((entry) => entry.sceneId !== command.sceneId),
          { sceneId: command.sceneId, reason: command.reason },
        ],
      };
      break;
    case "include-scene":
      if (!current.excluded.some((entry) => entry.sceneId === command.sceneId)) {
        throw new Error(`${command.sceneId} is not excluded.`);
      }
      next = { ...current, excluded: current.excluded.filter((entry) => entry.sceneId !== command.sceneId) };
      break;
    case "add-group":
      if (current.groups.some((group) => group.id === command.group.id)) {
        throw new Error(`Group ${command.group.id} already exists.`);
      }
      next = { ...current, groups: [...current.groups, command.group] };
      break;
    case "edit-group": {
      const index = current.groups.findIndex((group) => group.id === command.groupId);
      if (index < 0) throw new Error(`Group ${command.groupId} does not exist.`);
      next = {
        ...current,
        groups: current.groups.map((group, at) => at === index ? { ...group, ...command.changes } : group),
      };
      break;
    }
    case "remove-group":
      if (!current.groups.some((group) => group.id === command.groupId)) {
        throw new Error(`Group ${command.groupId} does not exist.`);
      }
      next = { ...current, groups: current.groups.filter((group) => group.id !== command.groupId) };
      break;
  }
  // Only the commands that can put an excluded scene on a route are held to it, so a routing file
  // written before this rule can still be edited everywhere else, and repaired.
  if (
    command.operation === "set-start" ||
    command.operation === "add-choice" ||
    command.operation === "edit-choice" ||
    command.operation === "exclude-scene"
  ) {
    refuseExcludedOnRoute(next);
  }
  return RoutingSchema.parse({ ...next, version: current.version + 1 });
}

/**
 * The scenes a command puts into the routing. Only these are checked against the production: a
 * removal names what is already there, and must stay possible when that scene has since gone —
 * it is how the invalid-destination finding is repaired.
 */
function scenesNamedBy(command: RoutingCommand): string[] {
  switch (command.operation) {
    case "set-start":
    case "set-ending":
    case "exclude-scene":
      return [command.sceneId];
    case "add-choice":
      return [command.choice.from, command.choice.to];
    case "edit-choice":
      return [command.changes.from, command.changes.to].filter((id): id is string => id !== undefined);
    case "add-group":
      return command.group.scenes;
    case "edit-group":
      return command.changes.scenes ?? [];
    default:
      return [];
  }
}

/**
 * Apply one closed routing command to the routing on disk (design turn 157). The branch map used
 * to send the whole file it had composed from the copy it last saw, so two quick edits raced: both
 * read one version, and the second was refused as stale or wrote over the first. Here the read,
 * the command and the write are one store operation, serialised with every other writer in the
 * world — another map edit, an accepted production-routing action, a whole-file save — so a
 * command always applies to the file as the last of them left it, and none is written over.
 */
export function applyRoutingCommandOnDisk(
  store: WorldStore,
  productionId: string,
  command: RoutingCommand,
  options: { source?: string; precondition?: WorldStatePrecondition } = {},
): Promise<Routing> {
  return store.gateOp(async () => {
    const raw = await readRoutingRaw(store, productionId);
    const current = raw === null ? null : RoutingSchema.parse(JSON.parse(raw));
    // The map sends what it last saw; a scene deleted since then must not be written into the
    // routing, where it would stand as a route to nothing. Checked against the production as it
    // is now, inside the operation.
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
    if (!production) throw new Error("That production is no longer in this world.");
    const known = new Set(production.scenes.map((scene) => scene.id));
    const missing = scenesNamedBy(command).find((sceneId) => !known.has(sceneId));
    if (missing !== undefined) throw new Error(`Scene ${missing} is no longer in this production.`);
    // The map derives a new choice's id from its label against the routing it last saw; two quick
    // adds with one label derive the same id, and the second would be refused as a duplicate. The
    // id is the map's own coinage, so it is made unique here, against the file it applies to.
    let applied = command;
    if (command.operation === "add-choice" && current !== null) {
      const taken = new Set(current.choices.map((choice) => choice.id));
      let id = command.choice.id;
      for (let n = 2; taken.has(id); n++) id = `${command.choice.id}-${n}`;
      applied = { ...command, choice: { ...command.choice, id } };
    }
    const routing = applyRoutingCommand(current, applied);
    await store.commitUnserialised(routingCommit(productionId, routing, raw, options));
    return routing;
  }, options.precondition);
}

const EVIDENCE_FILE = "routing-evidence.jsonl";
const StoredTraversalEvidenceSchema = TraversalEvidenceSchema.extend({
  requestId: ConversationActionSemanticIdSchema.optional(),
}).strict();

/** One preview traversal, appended durably (brief §4). */
export async function appendTraversal(
  store: WorldStore,
  productionId: string,
  line: TraversalEvidence,
  options: { requestId?: string; precondition?: WorldStatePrecondition } = {},
): Promise<void> {
  const parsed = TraversalEvidenceSchema.parse(line);
  await store.gateOp(async () => {
    if (options.requestId !== undefined) {
      const existing = await readStoredTraversal(store, productionId);
      if (existing.some((entry) => entry.requestId === options.requestId)) return;
    }
    const dir = join(store.dir, "productions", productionId);
    await mkdir(toExtendedLength(dir), { recursive: true });
    const handle = await openFile(toExtendedLength(join(dir, EVIDENCE_FILE)), "a");
    try {
      await handle.writeFile(JSON.stringify({ ...parsed, ...(options.requestId ? { requestId: options.requestId } : {}) }) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }, options.precondition);
}

async function readStoredTraversal(store: WorldStore, productionId: string) {
  try {
    const raw = await readFile(
      toExtendedLength(join(store.dir, "productions", productionId, EVIDENCE_FILE)),
      "utf8",
    );
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [StoredTraversalEvidenceSchema.parse(JSON.parse(line))];
        } catch {
          return []; // a malformed line never blocks the findings that read the rest
        }
      });
  } catch {
    return [];
  }
}

export async function readTraversal(store: WorldStore, productionId: string): Promise<TraversalEvidence[]> {
  return (await readStoredTraversal(store, productionId)).map(({ requestId: _requestId, ...entry }) => entry);
}

export async function hasTraversalRequest(
  store: WorldStore,
  productionId: string,
  requestId: string,
): Promise<boolean> {
  return (await readStoredTraversal(store, productionId)).some((entry) => entry.requestId === requestId);
}

/** The brief §4 findings for one production, from disk truth. */
export async function interactiveFindings(
  store: WorldStore,
  production: ProductionBundle,
): Promise<RoutingFinding[]> {
  if (production.routing === null) return [];
  const evidence = await readTraversal(store, production.meta.id);
  return routingFindings(production.routing, production.scenes, evidence);
}

/**
 * Promote a branch outcome to world canon — explicitly, through the gate, with the route named
 * (brief §7). The proposal's summary and body carry the source production, the outcome scene,
 * and the route that reaches it, so the canon entry's provenance names the branch it came from
 * and the gate's ripple view shows what the promotion touches before anyone accepts it.
 */
export async function proposeBranchCanon(
  store: WorldStore,
  gate: ProposalManager,
  input: { productionId: string; sceneId: string; route: readonly string[]; title: string; body: string },
  options: {
    source?: string;
    conversationId?: string;
    precondition?: WorldStatePrecondition;
  } = {},
): Promise<{ proposalId: string; canonId: string }> {
  const source = options.source ?? `branch-promotion:${input.productionId}/${input.sceneId}`;
  const [canonId] = await store.allocateCanonIds(
    1,
    options.source ?? `branch-promotion:${input.productionId}`,
    options.precondition,
  );
  // YAML-safe: a raw user title carrying a newline or a colon broke — or injected — frontmatter
  // fields in the staged canon file. Quoted and escaped, with line breaks flattened.
  const safeTitle = JSON.stringify(input.title.replace(/[\r\n]+/g, " ").trim());
  const content = [
    "---",
    `id: ${canonId}`,
    "type: lore",
    `title: ${safeTitle}`,
    "status: open",
    "links: []",
    "---",
    "",
    input.body.trim(),
    "",
    `Promoted from ${input.productionId}'s branch outcome at ${input.sceneId}, reached by the route ${[
      ...input.route,
    ].join(" → ")}.`,
    "",
  ].join("\n");
  const proposal = await gate.stage({
    kind: "new-canon",
    summary: `Branch outcome becomes canon: ${input.title} (${input.productionId} · ${input.sceneId})`,
    source,
    ...(options.conversationId
      ? {
          origin: {
            surface: "world-chat" as const,
            gesture: "conversation-action",
            conversationId: options.conversationId,
          },
          decision: {
            mode: "attended" as const,
            owner: { kind: "world-chat" as const, conversationId: options.conversationId },
          },
        }
      : {}),
    targets: [{ path: `canon/${canonId}.md`, content }],
    preReservedCanonIds: [canonId!],
  }, options.precondition);
  return { proposalId: proposal.id, canonId: canonId! };
}

// ---------------------------------------------------------------------------
// The export package (brief §6): self-contained, offline, deterministic
// ---------------------------------------------------------------------------

export type InteractiveExportResult =
  | { ok: true; id: string; dir: string; file: string }
  | { ok: false; blockers: string[] };

function fullHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}`;
}

/**
 * The package's page (design turn 156): the same player the branch map's preview mounts, inlined
 * as its own text, with the manifest embedded so file:// playback works offline. The page adds
 * only what the package knows — the manifest, the key the viewer's place is kept under on this
 * device, and the titles to show — and calls the player once.
 */
function playerHtml(
  manifest: InteractiveExportManifest,
  presentation: { worldId: string; title: string; eyebrow: string; titles: Record<string, string> },
): string {
  const json = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
  const player = INTERACTIVE_PLAYER_SOURCE.replace("export function mountInteractivePlayer", "function mountInteractivePlayer").replace(/<\/script/gi, "<\\/script");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${presentation.title.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!)}</title>
<style>html,body{margin:0;height:100%;background:#0a0a0a}#app{position:fixed;inset:0}</style>
</head><body>
<div id="app"></div>
<script>
${player}
// Playback state only (brief §1/§5), kept with the viewer and keyed by world, production and
// routing version: a package from a re-cut graph never resumes into a scene it does not have, and
// two worlds' productions with one slug, served from one origin, never share a viewer's place.
const manifest = ${json(manifest)};
const titles = ${json(presentation.titles)};
const KEY = "arke-iv-" + ${json(presentation.worldId)} + "-" + manifest.provenance.productionId + "-v" + manifest.provenance.routingVersion;
mountInteractivePlayer(document.getElementById("app"), {
  title: ${json(presentation.title)},
  eyebrow: ${json(presentation.eyebrow)},
  start: manifest.routing.start,
  scenes: Object.fromEntries(manifest.media.map((m) => [m.sceneId, {
    title: titles[m.sceneId] || m.sceneId,
    clips: m.windows && m.windows.length > 0 ? m.windows.map((w) => ({ src: m.file, from: w.from, to: w.to })) : [m.file],
  }]).concat((manifest.beats || []).map((s) => [s.sceneId, { title: titles[s.sceneId] || s.sceneId, beats: s.beats }]))),
  choices: manifest.routing.choices,
  endings: manifest.routing.endings,
  storageKey: KEY,
});
</script></body></html>
`;
}

type PlaybackWindow = { from: number; to?: number };

/** A visual novel's beat as the package carries it: its picture and voice are files in `files`. */
type ManifestBeat = PlayerBeat;

interface InteractiveExportManifest {
  readonly routing: Routing;
  /** `windows`: the parts of `file` the scene plays, in order; absent, the whole file plays. */
  readonly media: ReadonlyArray<{ sceneId: string; file: string; hash: string; windows?: PlaybackWindow[] }>;
  /**
   * A visual novel's scenes (turn 174), read as beats instead of played; their pictures and voices
   * are listed once in `files` with their hashes, since beats share pictures.
   */
  readonly beats?: ReadonlyArray<{ sceneId: string; beats: ReadonlyArray<ManifestBeat> }>;
  readonly files?: ReadonlyArray<{ file: string; hash: string }>;
  readonly provenance: {
    readonly productionId: string;
    readonly routingVersion: number;
    readonly exportedAt: string;
    readonly exportId: string;
  };
}

function parseInteractiveManifest(value: unknown): InteractiveExportManifest | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const routing = RoutingSchema.safeParse(record["routing"]);
  const provenance = record["provenance"];
  const media = record["media"];
  if (
    !routing.success ||
    typeof provenance !== "object" || provenance === null || Array.isArray(provenance) ||
    !Array.isArray(media)
  ) return null;
  const provenanceRecord = provenance as Record<string, unknown>;
  if (
    typeof provenanceRecord["productionId"] !== "string" ||
    typeof provenanceRecord["routingVersion"] !== "number" ||
    typeof provenanceRecord["exportedAt"] !== "string" ||
    typeof provenanceRecord["exportId"] !== "string"
  ) return null;
  const parsedMedia = media.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const mediaRecord = entry as Record<string, unknown>;
    const windows = mediaRecord["windows"];
    const windowsOk =
      windows === undefined ||
      (Array.isArray(windows) &&
        windows.every((w: unknown) => {
          if (typeof w !== "object" || w === null || Array.isArray(w)) return false;
          const { from, to } = w as Record<string, unknown>;
          return typeof from === "number" && from >= 0 && (to === undefined || (typeof to === "number" && to > from));
        }));
    return typeof mediaRecord["sceneId"] === "string" &&
      typeof mediaRecord["file"] === "string" &&
      /^media\/[^/\\]+$/.test(mediaRecord["file"]) &&
      typeof mediaRecord["hash"] === "string" &&
      /^sha256:[0-9a-f]{16}$/.test(mediaRecord["hash"]) &&
      windowsOk
      ? [{
          sceneId: mediaRecord["sceneId"],
          file: mediaRecord["file"],
          hash: mediaRecord["hash"],
          ...(windows !== undefined ? { windows: windows as PlaybackWindow[] } : {}),
        }]
      : [];
  });
  if (parsedMedia.length !== media.length) return null;
  const packaged = (file: unknown) => typeof file === "string" && /^media\/[^/\\]+$/.test(file);
  const filesValue = record["files"];
  if (filesValue !== undefined && !(Array.isArray(filesValue) && filesValue.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const { file, hash } = entry as Record<string, unknown>;
    return packaged(file) && typeof hash === "string" && /^sha256:[0-9a-f]{16}$/.test(hash);
  }))) return null;
  const files = filesValue as Array<{ file: string; hash: string }> | undefined;
  const listed = new Set((files ?? []).map((entry) => entry.file));
  const beatsValue = record["beats"];
  if (beatsValue !== undefined && !(Array.isArray(beatsValue) && beatsValue.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const { sceneId, beats } = entry as Record<string, unknown>;
    return typeof sceneId === "string" && Array.isArray(beats) && beats.length > 0 && beats.every((beat: unknown) => {
      if (typeof beat !== "object" || beat === null || Array.isArray(beat)) return false;
      const b = beat as Record<string, unknown>;
      // A beat names only files the package lists, so every one of them is re-hashed below.
      return (b["picture"] === undefined || (packaged(b["picture"]) && listed.has(b["picture"] as string))) &&
        (b["audio"] === undefined || (packaged(b["audio"]) && listed.has(b["audio"] as string))) &&
        (b["text"] === undefined || typeof b["text"] === "string") &&
        (b["speaker"] === undefined || typeof b["speaker"] === "string") &&
        ["voice", "tap", "hold"].includes(b["advance"] as string) &&
        typeof b["holdSec"] === "number" && b["holdSec"] > 0 &&
        ["push", "drift", "none"].includes(b["motion"] as string) &&
        (b["keep"] === undefined || b["keep"] === true) &&
        (b["dialogue"] === undefined || b["dialogue"] === true);
    });
  }))) return null;
  const beats = beatsValue as Array<{ sceneId: string; beats: ManifestBeat[] }> | undefined;
  return {
    routing: routing.data,
    media: parsedMedia,
    ...(beats !== undefined ? { beats } : {}),
    ...(files !== undefined ? { files } : {}),
    provenance: {
      productionId: provenanceRecord["productionId"],
      routingVersion: provenanceRecord["routingVersion"],
      exportedAt: provenanceRecord["exportedAt"],
      exportId: provenanceRecord["exportId"],
    },
  };
}

async function interactiveExportProblems(
  outDir: string,
  expected: { productionId: string; exportId: string },
): Promise<string[]> {
  let written: InteractiveExportManifest | null = null;
  try {
    written = parseInteractiveManifest(JSON.parse(
      await readFile(toExtendedLength(join(outDir, "manifest.json")), "utf8"),
    ));
  } catch {
    // Reported below with the same path-free language as other package validation failures.
  }
  if (written === null) return ["manifest.json is missing or invalid"];

  const problems: string[] = [];
  if (
    written.provenance.productionId !== expected.productionId ||
    written.provenance.exportId !== expected.exportId ||
    written.provenance.routingVersion !== written.routing.version
  ) problems.push("manifest.json names another export");
  for (const entry of written.media) {
    try {
      const bytes = await readFile(toExtendedLength(join(outDir, entry.file)));
      if (fullHash(bytes) !== entry.hash) problems.push(`${entry.file} does not match its manifest hash`);
    } catch {
      problems.push(`${entry.file} is missing from the package`);
    }
  }
  for (const entry of written.files ?? []) {
    try {
      const bytes = await readFile(toExtendedLength(join(outDir, entry.file)));
      if (fullHash(bytes) !== entry.hash) problems.push(`${entry.file} does not match its manifest hash`);
    } catch {
      problems.push(`${entry.file} is missing from the package`);
    }
  }
  // A scene ships as footage or as beats; either is something to play.
  const shippedIds = new Set([...written.media.map((entry) => entry.sceneId), ...(written.beats ?? []).map((entry) => entry.sceneId)]);
  if (!shippedIds.has(written.routing.start)) {
    problems.push(`the start scene ${written.routing.start} shipped no media`);
  }
  for (const choice of written.routing.choices) {
    if (!shippedIds.has(choice.to)) problems.push(`choice ${choice.id} points at ${choice.to}, which shipped no media`);
  }
  const files = await readdir(toExtendedLength(outDir)).catch((): string[] => []);
  if (!files.includes("player.html")) problems.push("player.html is missing from the package");
  return problems;
}

/** Recovery uses the export's own validation boundary, never mere presence of a partial folder. */
export async function interactiveExportCompleted(
  store: WorldStore,
  productionId: string,
  exportId: string,
): Promise<boolean> {
  if (!/^iv_[0-9A-HJKMNP-TV-Z]{26}$/.test(exportId)) return false;
  const outDir = join(store.dir, "exports", `interactive-${productionId}-${exportId}`);
  return (await interactiveExportProblems(outDir, { productionId, exportId })).length === 0;
}

/**
 * Export the production as a self-hostable folder (brief §6): refuses while any blocking
 * finding stands, in the findings' own words; copies each routed scene's accepted footage;
 * writes player.html and manifest.json with content hashes; then re-reads its own output and
 * verifies every hash and destination before calling itself done.
 */
export async function exportInteractive(
  store: WorldStore,
  production: ProductionBundle,
  clock: () => string,
  options: {
    exportId?: string;
    precondition?: WorldStatePrecondition;
    /**
     * A visual novel's prepared voices, scene by scene: line id → world-relative file (the table
     * read's answer). Absent, every line reads as text — an unvoiced line never blocks.
     */
    voices?: BeatVoices;
    /**
     * The production as it stands now, read again under the export's gate: a visual novel waits
     * on its voices between the snapshot and the write, and a picture accepted in between must
     * not ship as the one before it. The store's, unless a caller holds its own.
     */
    current?: () => ProductionBundle | undefined;
  } = {},
): Promise<InteractiveExportResult> {
  const routing = production.routing;
  if (routing === null) return { ok: false, blockers: ["this production has no routing yet"] };
  const findings = await interactiveFindings(store, production);
  const blockers = publicationBlockers(findings).map((finding) => finding.detail);
  if (productionShape(production.meta).playsAsBeats) return exportBeats(store, production, routing, blockers, clock, options);

  // Every routed, unexcluded scene ships ONE file that covers the whole scene: a pass take, or
  // the single shot's accepted clip. A multi-shot scene with only per-shot takes is refused by
  // name — silently shipping the first shot's clip was a package missing most of its scene.
  const excluded = new Set(routing.excluded.map((entry) => entry.sceneId));
  const shipped = production.scenes.filter((scene) => !excluded.has(scene.id));
  const media: Array<{ sceneId: string; source: string; file: string; windows: PlaybackWindow[] }> = [];
  const cut = new Map(deriveCut(production).entries.map((entry) => [entry.shot.id, entry]));
  for (const scene of shipped) {
    const shots = orderedShots(scene);
    const acceptedIds = new Set(
      shots
        .map((shot) => production.selections[shot.id]?.acceptedTakeId ?? null)
        .filter((takeId): takeId is string => takeId !== null),
    );
    // Segments resolve to the pass clip that actually holds the pixels.
    const resolved = [...acceptedIds].map((takeId) => {
      const take = production.takes.find((t) => t.id === takeId);
      return take?.segment !== undefined
        ? production.takes.find((t) => t.id === take.segment!.passTakeId)
        : take;
    });
    const covering = resolved.find(
      (take) =>
        take?.media !== undefined && shots.every((shot) => take.coversShots.includes(shot.id)),
    );
    if (covering?.media === undefined) {
      blockers.push(
        shots.length > 1 && acceptedIds.size > 0
          ? `${scene.id} spans ${shots.length} shots with no single clip covering them — cut a whole-scene pass before export`
          : `${scene.id} has no accepted footage to ship`,
      );
      continue;
    }
    // Every shot's accepted take must BE the covering clip (directly or as its segment): a
    // covering pass silently overriding a newer per-shot accept would ship footage the screen
    // says was replaced.
    const outsideCovering = shots.filter((shot) => {
      const acceptedId = production.selections[shot.id]?.acceptedTakeId ?? null;
      if (acceptedId === null) return true;
      const accepted = production.takes.find((t) => t.id === acceptedId);
      return accepted === undefined || (accepted.segment?.passTakeId ?? accepted.id) !== covering.id;
    });
    if (outsideCovering.length > 0) {
      blockers.push(
        `${scene.id}'s accepted takes for ${outsideCovering
          .map((shot) => shot.id)
          .join(", ")} are not part of the covering clip — re-cut the pass or accept its takes before export`,
      );
      continue;
    }
    // `media` is an unrestricted string in the take schema, and a hand-edited or imported take
    // can name `../../..`; joined onto the take's folder, the export copied a host file into a
    // portable package. A take's media is a plain filename in its own folder, as the scanner holds.
    if (!/^[^/\\]+$/.test(covering.media) || covering.media === "." || covering.media === "..") {
      blockers.push(`${scene.id}'s accepted take names media outside its own folder`);
      continue;
    }
    // The parts of the file the cut plays, shot by shot — a trim's in-point, a segment's range,
    // the slot's end — so the package plays the scene the preview plays, not the whole file with
    // its discarded head and tail. An unsegmented pass covering several shots has no cut entries
    // of its own and plays whole, which is what it is.
    const path = `productions/${production.meta.id}/takes/${covering.id}/${covering.media}`;
    const windows: PlaybackWindow[] = [];
    const unplayed: string[] = [];
    for (const shot of shots) {
      const entry = cut.get(shot.id);
      const played = entry?.media?.path === path ? playbackWindow(entry) : null;
      if (played) windows.push(played);
      else unplayed.push(shot.id);
    }
    // No window at all is either a whole pass the scene accepted as itself — no cut entries of
    // its own, so it plays whole — or a cut that leaves nothing, every shot trimmed past its end.
    // Read as the first, the second shipped the whole file, the footage the trims discarded too.
    const wholePass =
      covering.segment === undefined &&
      covering.coversShots.length > 1 &&
      shots.every((shot) => production.selections[shot.id]?.acceptedTakeId === covering.id);
    // Every shot plays its window, or the scene is the whole pass: some windows and not others
    // (a shot still on the unsegmented pass beside its neighbours' segments, one trimmed past its
    // end) shipped the scene with those shots silently missing.
    if (!wholePass && windows.length === 0) {
      blockers.push(`${scene.id}'s cut leaves nothing to play — its trims run past the end of every shot`);
      continue;
    }
    if (!wholePass && unplayed.length > 0) {
      blockers.push(`${scene.id}'s cut has nothing to play for ${unplayed.join(", ")} — accept a segment for each shot, or trim less`);
      continue;
    }
    media.push({
      sceneId: scene.id,
      source: join(store.dir, "productions", production.meta.id, "takes", covering.id, covering.media),
      file: `media/${scene.id}${covering.media.slice(covering.media.lastIndexOf("."))}`,
      windows,
    });
  }
  if (blockers.length > 0) return { ok: false, blockers };

  return store.gateOp(async () => {
    const exportId = options.exportId ?? `iv_${ulid()}`;
    if (!/^iv_[0-9A-HJKMNP-TV-Z]{26}$/.test(exportId)) throw new Error("invalid interactive export id");
    // Named by the export's own id, always: named by the second when none was given, two exports
    // in one second shared a folder, and the second wrote over the first's files and left its
    // stale media behind. The id is a ULID, so the folders still sort by when they were made.
    const outName = `interactive-${production.meta.id}-${exportId}`;
    const outDir = join(store.dir, "exports", outName);
    await mkdir(toExtendedLength(join(outDir, "media")), { recursive: true });
    const manifestMedia: InteractiveExportManifest["media"][number][] = [];
    for (const entry of media) {
      await copyFile(toExtendedLength(entry.source), toExtendedLength(join(outDir, entry.file)));
      manifestMedia.push({
        sceneId: entry.sceneId,
        file: entry.file,
        hash: fullHash(await readFile(toExtendedLength(join(outDir, entry.file)))),
        ...(entry.windows.length > 0 ? { windows: entry.windows } : {}),
      });
    }
    const manifest = {
      routing,
      media: manifestMedia,
      provenance: {
        productionId: production.meta.id,
        routingVersion: routing.version,
        exportedAt: clock(),
        exportId,
      },
    };
    await atomicWriteFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await atomicWriteFile(
      join(outDir, "player.html"),
      playerHtml(manifest, {
        worldId: store.worldId,
        title: production.meta.title,
        eyebrow: store.getBundle().meta.name,
        titles: Object.fromEntries(production.scenes.map((scene) => [scene.id, scene.title])),
      }),
    );

    // Deterministic validation (brief §6): the exporter re-reads its own output and refuses,
    // naming the file, rather than shipping a package that cannot play.
    const problems = await interactiveExportProblems(outDir, { productionId: production.meta.id, exportId });
    if (problems.length > 0) return { ok: false, blockers: problems };
    return { ok: true, id: exportId, dir: `exports/${outName}`, file: `exports/${outName}/player.html` };
  }, options.precondition);
}

/**
 * The world-relative file a visual novel's beat shows for a shot — its own frame, else its
 * accepted still — as the scene page shows it (`shotFramePath`). Null when it has none, and when
 * a hand-edited record names a file outside its own folder, which must never reach a package.
 */
function beatPicturePath(production: ProductionBundle, artifacts: readonly ArtifactSidecar[], shotId: string): string | null {
  const plain = (name: string) => /^[^/\\]+$/.test(name) && name !== "." && name !== "..";
  const selection = production.selections[shotId];
  if (hasOwnFrame(selection, artifacts)) {
    const artifact = artifacts.find((candidate) => candidate.id === selection?.startFrameArtifactId);
    return artifact !== undefined && plain(artifact.file) ? `artifacts/${artifact.file}` : null;
  }
  const takeId = selection?.acceptedTakeId ?? null;
  const take = takeId === null ? undefined : production.takes.find((candidate) => candidate.id === takeId);
  if (take === undefined || (take.kind !== "frame" && take.kind !== "still") || take.media === undefined || !plain(take.media)) return null;
  return `productions/${production.meta.id}/takes/${take.id}/${take.media}`;
}

/**
 * A scene's prepared voices as the table read planned them, with the scene version that plan was
 * made for — the store's current scene, which may no longer be the snapshot being exported.
 */
export type BeatVoices = (sceneId: string) => Promise<{ sceneVersion: number; files: ReadonlyMap<string, string> }>;

/** A voice the table read names, if it is a file inside the world rather than a way out of it. */
function safeWorldFile(path: string): boolean {
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..") && !path.includes("\\");
}

/**
 * A visual novel's package (turn 174): the same player, reading each routed scene as beats. Each
 * picture is copied once, however many beats show it; each prepared voice once; the text travels
 * as text. A beat with no picture is refused by name, as a scene with no footage is; a line with
 * no voice is not — the package reads it as text.
 */
async function exportBeats(
  store: WorldStore,
  production: ProductionBundle,
  routing: Routing,
  blockers: string[],
  clock: () => string,
  options: { exportId?: string; precondition?: WorldStatePrecondition; voices?: BeatVoices; current?: () => ProductionBundle | undefined },
): Promise<InteractiveExportResult> {
  const artifacts = store.getBundle().artifacts;
  const sheets = store.getBundle().sheets;
  const excluded = new Set(routing.excluded.map((entry) => entry.sceneId));
  /** Package file → world-relative source, so a picture two beats share is copied once. */
  const copies = new Map<string, string>();
  const packaged = (source: string, name: string) => {
    const file = `media/${name}${source.slice(source.lastIndexOf("."))}`;
    copies.set(file, source);
    return file;
  };
  /** Each picture the beats show, by the shot it is resolved from, to check again under the gate. */
  const pictures = new Map<string, string | null>();
  // Whose voices the package speaks in, as they stand before anything is awaited: a sheet's voice
  // changed between one scene's plan and the next moves no scene version, and would have one
  // character change voice mid-story (codex round 10).
  const speakers = [...new Set(production.scenes.filter((scene) => !excluded.has(scene.id)).flatMap((scene) => {
    try { return sceneBeats(scene).flatMap((beat) => (beat.speaker === undefined ? [] : [beat.speaker])); } catch { return []; }
  }))].sort();
  const speakerVoices = () => JSON.stringify(speakers.map((id) => [id, store.getBundle().sheets.find((sheet) => sheet.id === id)?.voice ?? null]));
  const voicesBefore = speakerVoices();
  const scenes: Array<{ sceneId: string; beats: PlayerBeat[] }> = [];
  for (const scene of production.scenes.filter((candidate) => !excluded.has(candidate.id))) {
    // A resolver that fails is not a scene with no voices: shipping every prepared line as text
    // would pass for a finished package (codex round 9).
    let planned: Awaited<ReturnType<BeatVoices>> | null = null;
    if (options.voices) {
      try {
        planned = await options.voices(scene.id);
      } catch {
        blockers.push(`${scene.id}'s voices could not be gathered — export again`);
        continue;
      }
    }
    // The plan reads the store's scene; the beats read the snapshot. A scene edited in between
    // would ship its old lines beside voices for new ones, or without the ones it had, so the
    // package is refused rather than mixed (codex round 8).
    if (planned !== null && planned.sceneVersion !== scene.version) {
      blockers.push(`${scene.id} changed while the package was made — export again`);
      continue;
    }
    const voices = planned?.files ?? new Map<string, string>();
    let beats: PlayerBeat[];
    try {
      beats = playerBeats(scene, {
        picture: (shotId) => {
          const source = beatPicturePath(production, artifacts, shotId);
          pictures.set(shotId, source);
          return source === null ? undefined : packaged(source, `picture-${shotId}`);
        },
        audio: (lineId) => {
          const source = voices.get(lineId);
          return source === undefined || !safeWorldFile(source) ? undefined : packaged(source, `voice-${lineId.replace(/[^A-Za-z0-9_-]/g, "_")}`);
        },
        speakerName: (id) => sheets.find((sheet) => sheet.id === id)?.name ?? id,
      });
    } catch {
      blockers.push(`${scene.id}'s shots do not read in order — repair its flow before export`);
      continue;
    }
    if (beats.length === 0) {
      blockers.push(`${scene.id} has no beats to read`);
      continue;
    }
    beats.forEach((beat, index) => {
      if (beat.picture === undefined) blockers.push(`${scene.id}, beat ${index + 1} needs a picture`);
    });
    scenes.push({ sceneId: scene.id, beats });
  }
  if (blockers.length > 0) return { ok: false, blockers };

  return store.gateOp(async () => {
    // Under the gate, the production is read again: an edited scene or a frame accepted while the
    // voices were gathered would ship beside the snapshot's (codex round 9). A frame choice is
    // not a scene edit and moves no scene version, so each picture is resolved again as well.
    const now = (options.current ?? (() => store.getBundle().productions.find((candidate) => candidate.meta.id === production.meta.id)))();
    const nowArtifacts = store.getBundle().artifacts;
    const moved = scenes.filter(({ sceneId }) =>
      now?.scenes.find((scene) => scene.id === sceneId)?.version !== production.scenes.find((scene) => scene.id === sceneId)?.version);
    const reframed = now === undefined || [...pictures].some(([shotId, source]) => beatPicturePath(now, nowArtifacts, shotId) !== source);
    // The routing the package plays is the snapshot's; a choice drawn meanwhile would ship the
    // graph Studio no longer shows (codex round 10).
    const rerouted = JSON.stringify(now?.routing ?? null) !== JSON.stringify(routing);
    const revoiced = speakerVoices() !== voicesBefore;
    if (moved.length > 0 || reframed || rerouted || revoiced) {
      return {
        ok: false,
        blockers: [
          ...moved.map(({ sceneId }) => `${sceneId} changed while the package was made — export again`),
          ...(reframed && moved.length === 0 ? ["a picture changed while the package was made — export again"] : []),
          ...(rerouted ? ["the branch map changed while the package was made — export again"] : []),
          ...(revoiced ? ["a character's voice changed while the package was made — export again"] : []),
        ],
      };
    }
    const exportId = options.exportId ?? `iv_${ulid()}`;
    if (!/^iv_[0-9A-HJKMNP-TV-Z]{26}$/.test(exportId)) throw new Error("invalid interactive export id");
    const outName = `interactive-${production.meta.id}-${exportId}`;
    const outDir = join(store.dir, "exports", outName);
    await mkdir(toExtendedLength(join(outDir, "media")), { recursive: true });
    const files: Array<{ file: string; hash: string }> = [];
    for (const [file, source] of [...copies].sort(([a], [b]) => a.localeCompare(b))) {
      await copyFile(toExtendedLength(join(store.dir, fromPortable(source))), toExtendedLength(join(outDir, file)));
      files.push({ file, hash: fullHash(await readFile(toExtendedLength(join(outDir, file)))) });
    }
    const manifest = {
      routing,
      media: [],
      beats: scenes,
      files,
      provenance: {
        productionId: production.meta.id,
        routingVersion: routing.version,
        exportedAt: clock(),
        exportId,
      },
    };
    await atomicWriteFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await atomicWriteFile(
      join(outDir, "player.html"),
      playerHtml(manifest, {
        worldId: store.worldId,
        title: production.meta.title,
        eyebrow: store.getBundle().meta.name,
        titles: Object.fromEntries(production.scenes.map((scene) => [scene.id, scene.title])),
      }),
    );
    const problems = await interactiveExportProblems(outDir, { productionId: production.meta.id, exportId });
    if (problems.length > 0) return { ok: false, blockers: problems };
    return { ok: true, id: exportId, dir: `exports/${outName}`, file: `exports/${outName}/player.html` };
  }, options.precondition);
}
