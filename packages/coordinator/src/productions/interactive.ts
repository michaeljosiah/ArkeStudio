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
  publicationBlockers,
  routingFindings,
  RoutingSchema,
  TraversalEvidenceSchema,
  ulid,
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
  const path = `productions/${productionId}/routing.json`;
  let raw: string | null = null;
  try {
    raw = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8");
  } catch {
    raw = null;
  }
  let content: string;
  if (raw !== null) {
    const doc = JsonFile.parse(raw);
    doc.set(routing);
    content = doc.serialize();
  } else {
    content = JSON.stringify(routing, null, 2) + "\n";
  }
  await store.commit({
    kind: "routing-save",
    source: options.source ?? "form",
    files: [
      raw !== null
        ? { path, action: "replace", content, baseHash: sha256(raw) }
        : { path, action: "create", content, baseHash: null },
    ],
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
  }, undefined, options.precondition);
  return routing;
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
  return RoutingSchema.parse({ ...next, version: current.version + 1 });
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

/** The player, self-contained: inline CSS/JS, the manifest embedded so file:// playback works. */
function playerHtml(manifest: object): string {
  const json = JSON.stringify(manifest).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Interactive video</title>
<style>
body{margin:0;background:#0d0f11;color:#f4f1ea;font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;min-height:100vh}
video{max-width:100%;max-height:70vh;background:#000}
#choices{display:flex;flex-wrap:wrap;gap:12px;padding:20px;justify-content:center}
#choices button{font:600 16px system-ui;padding:12px 20px;border-radius:10px;border:1px solid #4a4f55;background:#1c2126;color:#f4f1ea;cursor:pointer}
#choices button:focus-visible{outline:3px solid #ec6a4a;outline-offset:2px}
#ending{font:600 22px system-ui;padding:28px;text-align:center}
</style></head><body>
<video id="v" controls playsinline></video>
<div id="choices" role="group" aria-label="Choices"></div>
<div id="ending" hidden></div>
<script>
// Playback state only (brief §1/§5): scene, position, route, updatedAt — nothing else exists.
const manifest = ${json};
const KEY = "arke-iv-" + manifest.provenance.productionId + "-v" + manifest.provenance.routingVersion;
const media = Object.fromEntries(manifest.media.map((m) => [m.sceneId, m.file]));
const endings = Object.fromEntries(manifest.routing.endings.map((e) => [e.sceneId, e.title]));
const v = document.getElementById("v"), choicesEl = document.getElementById("choices"), endingEl = document.getElementById("ending");
let state = { sceneId: manifest.routing.start, positionSec: 0, route: [], updatedAt: new Date().toISOString() };
try { const saved = JSON.parse(localStorage.getItem(KEY) || "null"); if (saved && media[saved.sceneId]) state = saved; } catch {}
function save() { state.updatedAt = new Date().toISOString(); try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} }
function play(sceneId, positionSec) {
  state.sceneId = sceneId; state.positionSec = positionSec || 0; save();
  choicesEl.replaceChildren(); endingEl.hidden = true;
  v.src = media[sceneId]; v.currentTime = state.positionSec; v.play().catch(() => {});
}
v.addEventListener("timeupdate", () => { state.positionSec = v.currentTime; save(); });
v.addEventListener("ended", () => {
  const options = manifest.routing.choices.filter((c) => c.from === state.sceneId);
  if (options.length === 0) {
    endingEl.textContent = endings[state.sceneId] ? "Ending — " + endings[state.sceneId] : "The end.";
    endingEl.hidden = false;
    const again = document.createElement("button");
    again.textContent = "Start again";
    again.onclick = () => { state.route = []; play(manifest.routing.start, 0); };
    choicesEl.append(again);
    return;
  }
  // Untimed by default (brief §5): the choices wait.
  for (const choice of options) {
    const button = document.createElement("button");
    button.textContent = choice.label;
    button.onclick = () => { state.route.push(choice.id); play(choice.to, 0); };
    choicesEl.append(button);
  }
  choicesEl.querySelector("button")?.focus();
});
play(state.sceneId, state.positionSec);
</script></body></html>
`;
}

interface InteractiveExportManifest {
  readonly routing: Routing;
  readonly media: ReadonlyArray<{ sceneId: string; file: string; hash: string }>;
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
    return typeof mediaRecord["sceneId"] === "string" &&
      typeof mediaRecord["file"] === "string" &&
      /^media\/[^/\\]+$/.test(mediaRecord["file"]) &&
      typeof mediaRecord["hash"] === "string" &&
      /^sha256:[0-9a-f]{16}$/.test(mediaRecord["hash"])
      ? [{ sceneId: mediaRecord["sceneId"], file: mediaRecord["file"], hash: mediaRecord["hash"] }]
      : [];
  });
  if (parsedMedia.length !== media.length) return null;
  return {
    routing: routing.data,
    media: parsedMedia,
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
  const shippedIds = new Set(written.media.map((entry) => entry.sceneId));
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
  options: { exportId?: string; precondition?: WorldStatePrecondition } = {},
): Promise<InteractiveExportResult> {
  const routing = production.routing;
  if (routing === null) return { ok: false, blockers: ["this production has no routing yet"] };
  const findings = await interactiveFindings(store, production);
  const blockers = publicationBlockers(findings).map((finding) => finding.detail);

  // Every routed, unexcluded scene ships ONE file that covers the whole scene: a pass take, or
  // the single shot's accepted clip. A multi-shot scene with only per-shot takes is refused by
  // name — silently shipping the first shot's clip was a package missing most of its scene.
  const excluded = new Set(routing.excluded.map((entry) => entry.sceneId));
  const shipped = production.scenes.filter((scene) => !excluded.has(scene.id));
  const media: Array<{ sceneId: string; source: string; file: string }> = [];
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
    media.push({
      sceneId: scene.id,
      source: join(store.dir, "productions", production.meta.id, "takes", covering.id, covering.media),
      file: `media/${scene.id}${covering.media.slice(covering.media.lastIndexOf("."))}`,
    });
  }
  if (blockers.length > 0) return { ok: false, blockers };

  return store.gateOp(async () => {
    const stamp = clock().replace(/[-:TZ.]/g, "").slice(0, 14);
    const exportId = options.exportId ?? `iv_${ulid()}`;
    if (!/^iv_[0-9A-HJKMNP-TV-Z]{26}$/.test(exportId)) throw new Error("invalid interactive export id");
    const outName = options.exportId
      ? `interactive-${production.meta.id}-${options.exportId}`
      : `interactive-${production.meta.id}-${stamp}`;
    const outDir = join(store.dir, "exports", outName);
    await mkdir(toExtendedLength(join(outDir, "media")), { recursive: true });
    const manifestMedia: Array<{ sceneId: string; file: string; hash: string }> = [];
    for (const entry of media) {
      await copyFile(toExtendedLength(entry.source), toExtendedLength(join(outDir, entry.file)));
      manifestMedia.push({
        sceneId: entry.sceneId,
        file: entry.file,
        hash: fullHash(await readFile(toExtendedLength(join(outDir, entry.file)))),
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
    await atomicWriteFile(join(outDir, "player.html"), playerHtml(manifest));

    // Deterministic validation (brief §6): the exporter re-reads its own output and refuses,
    // naming the file, rather than shipping a package that cannot play.
    const problems = await interactiveExportProblems(outDir, { productionId: production.meta.id, exportId });
    if (problems.length > 0) return { ok: false, blockers: problems };
    return { ok: true, id: exportId, dir: `exports/${outName}`, file: `exports/${outName}/player.html` };
  }, options.precondition);
}
