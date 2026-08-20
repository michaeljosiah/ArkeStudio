/**
 * Interactive video (epic #401; brief rev 1): the routing record through the gate machinery,
 * durable traversal evidence, named findings, canon promotion with route provenance, and the
 * self-hostable export package with deterministic validation.
 */

import { createHash } from "node:crypto";
import { copyFile, mkdir, open as openFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  publicationBlockers,
  routingFindings,
  RoutingSchema,
  TraversalEvidenceSchema,
  ulid,
  type ProductionBundle,
  type Routing,
  type RoutingFinding,
  type TraversalEvidence,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { JsonFile, sha256 } from "../world/text-files.js";
import type { ProposalManager } from "../gate/proposals.js";
import type { WorldStore } from "../world/store.js";

/**
 * Save the routing record — the import boundary where the no-state rule is enforced twice:
 * the strict parse here refuses a `condition` key by name, and the gate's own routing lane
 * (JSON_TRACK_SCHEMAS) refuses the same shape arriving through a proposal.
 */
export async function saveRouting(store: WorldStore, productionId: string, proposed: unknown): Promise<Routing> {
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
    source: "form",
    files: [
      raw !== null
        ? { path, action: "replace", content, baseHash: sha256(raw) }
        : { path, action: "create", content, baseHash: null },
    ],
  });
  return routing;
}

const EVIDENCE_FILE = "routing-evidence.jsonl";

/** One preview traversal, appended durably (brief §4). */
export async function appendTraversal(
  store: WorldStore,
  productionId: string,
  line: TraversalEvidence,
): Promise<void> {
  const parsed = TraversalEvidenceSchema.parse(line);
  const dir = join(store.dir, "productions", productionId);
  await mkdir(toExtendedLength(dir), { recursive: true });
  const handle = await openFile(toExtendedLength(join(dir, EVIDENCE_FILE)), "a");
  try {
    await handle.writeFile(JSON.stringify(parsed) + "\n", "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function readTraversal(store: WorldStore, productionId: string): Promise<TraversalEvidence[]> {
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
          return [TraversalEvidenceSchema.parse(JSON.parse(line))];
        } catch {
          return []; // a malformed line never blocks the findings that read the rest
        }
      });
  } catch {
    return [];
  }
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
): Promise<{ proposalId: string; canonId: string }> {
  const [canonId] = await store.allocateCanonIds(1, `branch-promotion:${input.productionId}`);
  const content = [
    "---",
    `id: ${canonId}`,
    "type: lore",
    `title: ${input.title}`,
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
    source: `branch-promotion:${input.productionId}/${input.sceneId}`,
    targets: [{ path: `canon/${canonId}.md`, content }],
    preReservedCanonIds: [canonId!],
  });
  return { proposalId: proposal.id, canonId: canonId! };
}

// ---------------------------------------------------------------------------
// The export package (brief §6): self-contained, offline, deterministic
// ---------------------------------------------------------------------------

export type InteractiveExportResult =
  | { ok: true; dir: string; file: string }
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
): Promise<InteractiveExportResult> {
  const routing = production.routing;
  if (routing === null) return { ok: false, blockers: ["this production has no routing yet"] };
  const findings = await interactiveFindings(store, production);
  const blockers = publicationBlockers(findings).map((finding) => finding.detail);

  // Every routed, unexcluded scene ships footage: the accepted take's media, by selection.
  const excluded = new Set(routing.excluded.map((entry) => entry.sceneId));
  const shipped = production.scenes.filter((scene) => !excluded.has(scene.id));
  const media: Array<{ sceneId: string; source: string; file: string }> = [];
  for (const scene of shipped) {
    const accepted = scene.shots
      .map((shot) => production.selections[shot.id]?.acceptedTakeId ?? null)
      .find((takeId) => takeId !== null);
    const take = accepted != null ? production.takes.find((t) => t.id === accepted) : undefined;
    if (take?.media === undefined) {
      blockers.push(`${scene.id} has no accepted footage to ship`);
      continue;
    }
    media.push({
      sceneId: scene.id,
      source: join(store.dir, "productions", production.meta.id, "takes", take.id, take.media),
      file: `media/${scene.id}${take.media.slice(take.media.lastIndexOf("."))}`,
    });
  }
  if (blockers.length > 0) return { ok: false, blockers };

  const stamp = clock().replace(/[-:TZ.]/g, "").slice(0, 14);
  const outName = `interactive-${production.meta.id}-${stamp}`;
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
      exportId: `iv_${ulid()}`,
    },
  };
  await atomicWriteFile(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await atomicWriteFile(join(outDir, "player.html"), playerHtml(manifest));

  // Deterministic validation (brief §6): the exporter re-reads its own output and refuses,
  // naming the file, rather than shipping a package that cannot play.
  const written = JSON.parse(
    await readFile(toExtendedLength(join(outDir, "manifest.json")), "utf8"),
  ) as typeof manifest;
  const problems: string[] = [];
  for (const entry of written.media) {
    try {
      const bytes = await readFile(toExtendedLength(join(outDir, entry.file)));
      if (fullHash(bytes) !== entry.hash) problems.push(`${entry.file} does not match its manifest hash`);
    } catch {
      problems.push(`${entry.file} is missing from the package`);
    }
  }
  const shippedIds = new Set(written.media.map((entry) => entry.sceneId));
  for (const choice of written.routing.choices) {
    if (!shippedIds.has(choice.to)) problems.push(`choice ${choice.id} points at ${choice.to}, which shipped no media`);
  }
  const files = await readdir(toExtendedLength(outDir));
  if (!files.includes("player.html")) problems.push("player.html is missing from the package");
  if (problems.length > 0) return { ok: false, blockers: problems };
  return { ok: true, dir: `exports/${outName}`, file: `exports/${outName}/player.html` };
}
