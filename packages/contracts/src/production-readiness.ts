import { z } from "zod";
import { SlugSchema, SceneIdSchema, CheckReceiptIdSchema } from "./ids.js";
import type { WorldBundle, ProductionBundle } from "./client-state.js";
import { orderedShots } from "./scene-flow.js";
import { sortScenes } from "./scene.js";
import { productionShape } from "./production-shape.js";
import { attachmentFor, parseMentions, propSlug } from "./planning.js";
import { performanceLineKey } from "./performance.js";
import { audioSourceOf } from "./cut.js";
import { cueStaleness } from "./subtitles.js";

export const PRODUCTION_READINESS_SCHEMA_VERSION = 59;
export const ReadinessCheckSchema = z.object({
  key: z.enum(["script", "shots", "cast", "place", "kits", "start-frames", "selected-takes", "dialogue-voiced", "in-cut", "cut", "subtitles", "export"]),
  label: z.string(), status: z.enum(["ready", "missing", "not-required", "blocked"]),
  completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), missingIds: z.array(z.string()), detail: z.string(),
}).strict();
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;
export const ReadinessExportSchema = z.object({
  id: z.string(), worldId: z.string(), productionId: z.string().optional(), episodeId: z.string().optional(),
  status: z.enum(["running", "done", "cancelled", "failed"]), createdAt: z.string().optional(), output: z.string().nullable().optional(),
}).strict();
export type ReadinessExport = z.infer<typeof ReadinessExportSchema>;
export const ProductionReadinessSchema = z.object({
  productionId: SlugSchema, title: z.string(), ready: z.boolean(),
  scenes: z.array(z.object({ sceneId: SceneIdSchema, title: z.string(), ready: z.boolean(), checks: z.array(ReadinessCheckSchema) }).strict()),
  checks: z.array(ReadinessCheckSchema), lastExport: ReadinessExportSchema.nullable(),
}).strict();
export type ProductionReadiness = z.infer<typeof ProductionReadinessSchema>;
/** Only the proposed steps are authored. The checklist is always projected from current records. */
export const ProductionPlanRequestSchema = z.object({
  productionId: SlugSchema, checkReceiptIds: z.array(CheckReceiptIdSchema).min(1).max(100), nextSteps: z.array(z.string().min(1).max(500)).max(12),
}).strict();
export type ProductionPlanRequest = z.infer<typeof ProductionPlanRequestSchema>;
export const ProductionPlanCardSchema = z.object({
  kind: z.literal("production-plan"), worldId: z.string(), productionId: SlugSchema, nextSteps: ProductionPlanRequestSchema.shape.nextSteps,
  readiness: ProductionReadinessSchema.nullable(), exports: z.array(ReadinessExportSchema),
}).strict();
export type ProductionPlanCard = z.infer<typeof ProductionPlanCardSchema>;

function check(key: ReadinessCheck["key"], label: string, ids: readonly string[], present: (id: string) => boolean,
  detail: string, empty: ReadinessCheck["status"] = "not-required"): ReadinessCheck {
  const missingIds = ids.filter(id => !present(id));
  return { key, label, status: ids.length === 0 ? empty : missingIds.length ? "missing" : "ready",
    completed: ids.length - missingIds.length, total: ids.length, missingIds: missingIds.slice(0,40),
    detail: missingIds.length > 40 ? `${detail} Showing the first 40 of ${missingIds.length} missing ids; read the scene for the rest.` : detail };
}
const ready = (checks: readonly ReadinessCheck[]) => checks.every(c => c.status === "ready" || c.status === "not-required");

/** SPEC-051 R-38: pure, shared and never persisted as a readiness authority. */
export type ReadinessWorld = Pick<WorldBundle, "artifacts" | "sheets" | "props" | "referenceKits"> & { meta: Pick<WorldBundle["meta"], "worldId"> };
export function deriveProductionReadiness(world: ReadinessWorld, production: ProductionBundle, exports: readonly ReadinessExport[] = []): ProductionReadiness {
  const shape = productionShape(production.meta);
  const available = (id: string) => world.artifacts.find(a => a.id === id && !a.retiredAt && (!a.production || a.production === production.meta.id));
  const timeline = production.timeline?.status === "ready" ? production.timeline.timeline : null;
  const picture = timeline?.tracks.filter(t => t.kind === "picture" && !t.muted).flatMap(t => t.clips) ?? [];
  const takeFor = (shotId: string) => {
    const id = production.selections[shotId]?.acceptedTakeId;
    const take = production.takes.find(t => t.id === id && t.coversShots.includes(shotId) && !t.boardSheetParent);
    if (!take) return undefined;
    const media = take.segment ? production.takes.find(t => t.id === take.segment!.passTakeId)?.media : take.media;
    return media ? take : undefined;
  };
  const scenes = sortScenes(production.scenes).map(scene => {
    const shots = orderedShots(scene), shotIds = shots.map(s => s.id);
    const propIds = new Set(world.props.map(p => propSlug(p.name)));
    const mentions = [...new Set(shots.flatMap(s => parseMentions(s.description)))];
    const castIds = [...new Set([...Object.keys(scene.cast ?? {}), ...(scene.script?.blocks.flatMap(b => b.speaker ? [b.speaker] : []) ?? []),
      ...shots.flatMap(s => s.audio?.speaker ? [s.audio.speaker] : []),
      ...mentions.filter(id => !propIds.has(id) && id !== scene.inherits?.location && (!world.sheets.some(s => s.id === id) || world.sheets.some(s => s.id === id && s.type === "character")))])];
    const places = [...new Set([...(scene.inherits?.location ? [scene.inherits.location] : []), ...mentions.filter(id => world.sheets.some(s => s.id === id && s.type === "location"))])];
    const cast = (id: string) => world.sheets.find(s => s.id === id && s.type === "character" && !s.retired);
    const spoken = shots.flatMap<{ shotId: string; blockId: string | undefined; speaker: string | undefined }>(shot => {
      const blocks = shot.covers?.length ? shot.covers.flatMap(c => {
        const b = scene.script?.blocks.find(b => b.id === c.blockId);
        return b?.kind === "dialogue" ? [{ shotId: shot.id, blockId: b.id, speaker: b.speaker }] : [];
      }) : ["dialogue", "vo"].includes(shot.audio?.kind ?? "") && shot.audio?.line?.trim()
        ? [{ shotId: shot.id, blockId: undefined, speaker: shot.audio.speaker }] : [];
      return blocks;
    });
    for (const block of scene.script?.blocks ?? []) if (block.kind === "dialogue" && block.text.trim() && !spoken.some(line => line.blockId === block.id)) {
      spoken.push({shotId:"uncovered",blockId:block.id,speaker:block.speaker});
    }
    const voiced = (id: string) => {
      const line = spoken.find(l => `${l.shotId}/${l.blockId ?? "legacy"}` === id)!;
      const selection = production.performanceReview.selections[performanceLineKey({ sceneId: scene.id, shotId: line.shotId, blockId: line.blockId })];
      const performance = production.performances.find(p => p.id === selection?.performanceId);
      if (performance && line.speaker && performance.target.sceneVersion === scene.version && performance.target.speakerSheetId === line.speaker &&
        performance.target.sceneId === scene.id && performance.target.shotId === line.shotId && performance.target.blockId === line.blockId &&
        production.performanceReview.reviews.filter(r => r.performanceId === performance.id).at(-1)?.decision === "accept") return true;
      // Legacy voice-line writes the accepted voice take into a dialogue placement. It cannot
      // prove a particular covered script block, so it satisfies only the legacy shot line.
      return line.blockId === undefined && production.cut.audio.filter(t => t.kind === "dialogue").flatMap(t => t.entries).some(entry => {
        const source = audioSourceOf(entry), take = source?.kind === "take" ? production.takes.find(t => t.id === source.takeId) : undefined;
        return entry.shotId === line.shotId && take?.kind === "voice" && !!take.media && take.coversShots.includes(line.shotId) &&
          take.provenance.sceneId === scene.id && take.provenance.sceneVersion === scene.version && entry.sheetId === line.speaker;
      });
    };
    const checks = [
      check("script", "Script", [scene.id], () => !!scene.script?.blocks.some(b => b.text.trim()), "An authored scene script is present."),
      check("shots", "Shots", [scene.id], () => shots.length > 0, "The scene has shots."),
      check("cast", "Cast resolved", castIds, id => !!cast(id), "Every named character resolves to a current sheet."),
      check("place", "Place resolved", places, id => !!world.sheets.find(s => s.id === id && s.type === "location" && !s.retired), "Every named place resolves to a current location sheet."),
      check("kits", "Cast references", castIds, id => { const sheet = cast(id); return !!sheet && attachmentFor(world.referenceKits.find(k => k.sheetId === id) ?? null, sheet, "primary", { productionId: production.meta.id, sceneId: scene.id }).file !== null; }, "Each character has an accepted usable reference."),
      check("start-frames", "Start frames", shotIds, id => !!production.takes.find(t => t.coversShots.includes(id) && ["frame", "still"].includes(t.kind) && !!t.media && !t.boardSheetParent &&
        (production.selections[id]?.acceptedTakeId === t.id || production.reviews.filter(r => r.takeId === t.id).at(-1)?.decision === "accept")) ||
        !!takeFor(id)?.startFrame || available(production.selections[id]?.startFrameArtifactId ?? "")?.kind === "image", "Accepted own shot frames or explicit boundary images; steering footage alone is insufficient.", "missing"),
      check("selected-takes", "Selected takes", shotIds, id => { const t = takeFor(id); return !!t && (shape.dispatchCapability === "image" ? ["frame", "still"].includes(t.kind) : t.kind === "clip"); }, "Each shot selects available media of the required kind.", "missing"),
      check("dialogue-voiced", "Dialogue voiced", spoken.map(l => `${l.shotId}/${l.blockId ?? "legacy"}`), voiced, "Each spoken line has a current accepted performance or legacy voice placement."),
      check("in-cut", "In the cut", shotIds, id => picture.some(c => { const source = c.source; return source.kind === "shot" ? source.shotId === id : source.kind === "take" && production.takes.some(t => t.id === source.takeId && t.coversShots.includes(id)); }), "Every scene shot has a visible picture-track placement in the saved cut.", "missing"),
    ];
    return { sceneId: scene.id, title: scene.title, checks, ready: ready(checks) };
  });
  const exportsHere = exports.filter(e => e.worldId === world.meta.worldId && e.productionId === production.meta.id && e.episodeId === undefined)
    .map(({ id, worldId, productionId, episodeId, status, createdAt, output }) => ({ id, worldId, productionId, episodeId, status, createdAt, output }))
    .sort((a,b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id) || a.id.localeCompare(b.id));
  const lastExport = exportsHere.at(-1) ?? null;
  const checks = [
    check("cut", "Cut assembled", [production.meta.id], () => !!timeline && picture.length > 0 && scenes.length > 0 && scenes.every(s => s.checks.find(c => c.key === "in-cut")?.status === "ready"), "A saved picture cut includes every scene shot."),
    check("subtitles", "Subtitles", [production.meta.id], () => !!timeline?.tracks.some(t => t.kind === "subtitle" && t.cues?.length && t.cues.every(c => !cueStaleness(c, production).stale)), "A subtitle track contains current editable cues."),
    check("export", "Last export", [production.meta.id], () => lastExport?.status === "done" && !!lastExport.output, lastExport ? `Last production export: ${lastExport.status}.` : "No production export is recorded."),
  ];
  if (!shape.hasScenes) for (const c of checks.filter(c => c.key !== "export")) c.status = "not-required";
  if (production.timeline?.status === "invalid") for (const c of checks.filter(c => c.key !== "export")) { c.status = "blocked"; c.detail = "Repair the invalid saved timeline before assessing the cut."; }
  return { productionId: production.meta.id, title: production.meta.title, scenes, checks, lastExport, ready: ready(checks) && scenes.every(s => s.ready) };
}
