import { z } from "zod";
import { SlugSchema, SceneIdSchema, CheckReceiptIdSchema } from "./ids.js";
import type { WorldBundle, ProductionBundle } from "./client-state.js";
import { orderedShots } from "./scene-flow.js";
import { sortScenes } from "./scene.js";
import { productionShape } from "./production-shape.js";
import { attachmentFor, parseMentions, propSlug } from "./planning.js";
import { performanceLineKey } from "./performance.js";
import { audioSourceOf } from "./cut.js";
import { cueStaleness, textDigest } from "./subtitles.js";
import { basePictureTrack, AUDIO_TRACK_KINDS } from "./timeline.js";
import { audibleTracks } from "./render-plan.js";
import { hasOwnFrame } from "./scene.js";
import { beatPictureShotId, sceneBeats } from "./beats.js";
import { routingFindings, publicationBlockers } from "./routing.js";
import { deriveRehearsalLines } from "./rehearsal.js";
import { performanceClipTiming, dialogueSlots, dialogueTimingProblems } from "./dialogue-timing.js";

export const PRODUCTION_READINESS_SCHEMA_VERSION = 59;
export const ReadinessCheckSchema = z.object({
  key: z.enum(["script", "shots", "cast", "place", "kits", "start-frames", "selected-takes", "dialogue-voiced", "in-cut", "cut", "subtitles", "export", "chapters", "manuscript", "routing", "beat-text"]),
  label: z.string(), status: z.enum(["ready", "missing", "not-required", "blocked"]),
  completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), missingIds: z.array(z.string()), detail: z.string(),
}).strict();
export type ReadinessCheck = z.infer<typeof ReadinessCheckSchema>;
export const ReadinessExportSchema = z.object({
  id: z.string(), worldId: z.string(), productionId: z.string().optional(), episodeId: z.string().optional(),
  status: z.enum(["running", "done", "cancelled", "failed"]), createdAt: z.string().optional(), output: z.string().nullable().optional(),
  sourceFingerprint: z.string().max(200).optional(),
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

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
}

/** The render-relevant record snapshot, captured before an export begins. Old unstamped exports
 * remain visible history but cannot prove that the current production has been delivered. */
export function productionExportFingerprint(world: ReadinessWorld, production: ProductionBundle): string {
  const timeline = production.timeline?.status === "ready" ? production.timeline.timeline : null;
  const content = {meta:production.meta,chapters:production.chapters.filter(c=>!c.retired),scenes:production.scenes,
    selections:production.selections,performanceSelections:production.performanceReview.selections,spine:production.spine,cut:production.cut,routing:production.routing,
    timeline:timeline ? {frameRate:timeline.frameRate,tracks:timeline.tracks,mix:timeline.mix,migratedCut:timeline.migratedCut} : production.timeline};
  const refs = JSON.stringify(content), takeIds = new Set(production.takes.filter(t=>refs.includes(t.id)).map(t=>t.id));
  for (const take of production.takes) if (takeIds.has(take.id) && take.segment) takeIds.add(take.segment.passTakeId);
  const takes = production.takes.filter(t=>takeIds.has(t.id));
  const performances = production.performances.filter(p=>refs.includes(p.id));
  const referenced = `${refs}${JSON.stringify(takes)}`;
  const speakers = new Set(production.scenes.flatMap(scene=>[...Object.keys(scene.cast ?? {}),...(scene.script?.blocks.flatMap(b=>b.speaker ? [b.speaker] : []) ?? []),
    ...orderedShots(scene).flatMap(s=>[...parseMentions(s.description),...(s.audio?.speaker ? [s.audio.speaker] : [])])]));
  const snapshot = {...content,takes,performances,performanceReviews:production.performanceReview.reviews.filter(r=>performances.some(p=>p.id === r.performanceId)),
    takeMediaInfo:Object.fromEntries(Object.entries(production.takeMediaInfo).filter(([id])=>takeIds.has(id))),
    artifacts:world.artifacts.filter(a=>referenced.includes(a.id)).sort((a,b)=>a.id.localeCompare(b.id)),
    sheets:world.sheets.filter(s=>speakers.has(s.id)).sort((a,b)=>a.id.localeCompare(b.id))};
  return `production-export-v1:${textDigest(JSON.stringify(canonical(snapshot)))}`;
}

export function deriveProductionReadiness(world: ReadinessWorld, production: ProductionBundle, exports: readonly ReadinessExport[] = []): ProductionReadiness {
  const shape = productionShape(production.meta);
  const available = (id: string) => world.artifacts.find(a => a.id === id && !a.retiredAt && (!a.production || a.production === production.meta.id));
  const timeline = production.timeline?.status === "ready" ? production.timeline.timeline : null;
  const base = timeline ? basePictureTrack(timeline) : null;
  const picture = base && !base.muted ? base.clips : [];
  const audio = timeline ? audibleTracks(timeline).filter(t=>AUDIO_TRACK_KINDS.has(t.kind)).flatMap(t=>t.clips) : [];
  const slots = dialogueSlots(production);
  const placements = timeline ? audio.filter(clip=>clip.source.kind === "performance").map(clip=>({clip,result:performanceClipTiming(clip,production.performances,slots,timeline.frameRate)})) : [];
  const timingsValid = dialogueTimingProblems(placements.flatMap(p=>p.result.ok ? [p.result.timing] : []),slots,Math.max(0,...slots.map(s=>s.endSec))).length === 0;
  const ownImage = (id: string) => {
    const selection = production.selections[id], artifact = available(selection?.startFrameArtifactId ?? "");
    return !!artifact && /^[^/\\]+$/.test(artifact.file) && hasOwnFrame(selection,world.artifacts.filter(a=>!a.retiredAt && (!a.production || a.production === production.meta.id)));
  };
  const takeFor = (shotId: string) => {
    const id = production.selections[shotId]?.acceptedTakeId;
    const take = production.takes.find(t => t.id === id && t.coversShots.includes(shotId) && !t.boardSheetParent);
    if (!take) return undefined;
    const media = take.segment ? production.takes.find(t => t.id === take.segment!.passTakeId)?.media : take.media;
    return media ? take : undefined;
  };
  const scenes = sortScenes(shape.hasScenes ? production.scenes : []).map(scene => {
    const shots = orderedShots(scene), shotIds = shots.map(s => s.id);
    const pictureId = (id: string) => shape.playsAsBeats ? beatPictureShotId(shots,id) : id;
    const propIds = new Set(world.props.map(p => propSlug(p.name)));
    const mentions = [...new Set(shots.flatMap(s => parseMentions(s.description)))];
    const castIds = [...new Set([...Object.keys(scene.cast ?? {}), ...(scene.script?.blocks.flatMap(b => b.speaker ? [b.speaker] : []) ?? []),
      ...shots.flatMap(s => s.audio?.speaker ? [s.audio.speaker] : []),
      ...mentions.filter(id => !propIds.has(id) && id !== scene.inherits?.location && (!world.sheets.some(s => s.id === id) || world.sheets.some(s => s.id === id && s.type === "character")))])];
    const places = [...new Set([...(scene.inherits?.location ? [scene.inherits.location] : []), ...mentions.filter(id => world.sheets.some(s => s.id === id && s.type === "location"))])];
    const cast = (id: string) => world.sheets.find(s => s.id === id && s.type === "character" && !s.retired);
    const spoken = deriveRehearsalLines(scene,world.sheets).map(line=>({shotId:line.shotId,blockId:line.blockId,speaker:line.speakerSheetId}));
    for (const block of scene.script?.blocks ?? []) if (block.kind === "dialogue" && block.text.trim() && !spoken.some(line => line.blockId === block.id)) {
      spoken.push({shotId:"uncovered",blockId:block.id,speaker:block.speaker});
    }
    const voiced = (id: string) => {
      const line = spoken.find(l => `${l.shotId}/${l.blockId ?? "legacy"}` === id)!;
      const selection = production.performanceReview.selections[performanceLineKey({ sceneId: scene.id, shotId: line.shotId, blockId: line.blockId })];
      const performance = production.performances.find(p => p.id === selection?.performanceId);
      if (performance && line.speaker && performance.target.sceneVersion === scene.version && performance.target.speakerSheetId === line.speaker &&
        performance.target.sceneId === scene.id && performance.target.shotId === line.shotId && performance.target.blockId === line.blockId &&
        performance.target.productionId === production.meta.id &&
        production.performanceReview.reviews.filter(r => r.performanceId === performance.id).at(-1)?.decision === "accept" &&
        timingsValid && placements.some(({clip,result})=>result.ok && clip.source.kind === "performance" && clip.source.performanceId === performance.id && clip.source.shotId === line.shotId &&
          clip.source.sourceHash === performance.provenance.outputHash)) return true;
      // Legacy voice-line writes the accepted voice take into a dialogue placement. It cannot
      // prove a particular covered script block, so it satisfies only the legacy shot line.
      return line.blockId === undefined && production.cut.audio.filter(t => t.kind === "dialogue").flatMap(t => t.entries).some(entry => {
        const source = audioSourceOf(entry), take = source?.kind === "take" ? production.takes.find(t => t.id === source.takeId) : undefined;
        return entry.shotId === line.shotId && take?.kind === "voice" && !!take.media && take.coversShots.includes(line.shotId) &&
          take.provenance.sceneId === scene.id && take.provenance.sceneVersion === scene.version && entry.sheetId === line.speaker &&
          (!timeline || audio.some(clip=>clip.source.kind === "take" && clip.source.takeId === take.id));
      });
    };
    const checks = [
      check("script", "Script", [scene.id], () => !!scene.script?.blocks.some(b => b.text.trim()), "An authored scene script is present."),
      check("shots", "Shots", [scene.id], () => shots.length > 0, "The scene has shots."),
      check("cast", "Cast resolved", castIds, id => !!cast(id), "Every named character resolves to a current sheet."),
      check("place", "Place resolved", places, id => !!world.sheets.find(s => s.id === id && s.type === "location" && !s.retired), "Every named place resolves to a current location sheet."),
      check("kits", "Cast references", castIds, id => { const sheet = cast(id); return !!sheet && attachmentFor(world.referenceKits.find(k => k.sheetId === id) ?? null, sheet, "primary", { productionId: production.meta.id, sceneId: scene.id }).file !== null; }, "Each character has an accepted usable reference."),
      check("start-frames", "Start frames", shotIds, id => { const selectedId = pictureId(id); return ownImage(selectedId) || !!production.takes.find(t => t.coversShots.includes(selectedId) && ["frame", "still"].includes(t.kind) && !!t.media && !t.boardSheetParent &&
        (production.selections[selectedId]?.acceptedTakeId === t.id || production.reviews.filter(r => r.takeId === t.id).at(-1)?.decision === "accept")) ||
        !!takeFor(selectedId)?.startFrame || available(production.selections[selectedId]?.startFrameArtifactId ?? "")?.kind === "image"; }, "Accepted own shot frames or explicit boundary images; steering footage alone is insufficient.", "missing"),
      check("selected-takes", "Selected takes", shotIds, id => { const selectedId = pictureId(id), t = takeFor(selectedId); return shape.dispatchCapability === "image"
        ? ownImage(selectedId) || !!t && ["frame", "still"].includes(t.kind) : t?.kind === "clip"; }, "Each shot selects available media of the required kind.", "missing"),
      check("dialogue-voiced", "Dialogue voiced", spoken.map(l => `${l.shotId}/${l.blockId ?? "legacy"}`), voiced, "Each spoken line has a current accepted performance or legacy voice placement."),
      check("in-cut", "In the cut", shotIds, id => picture.some(c => { const source = c.source; return source.kind === "shot" ? source.shotId === id : source.kind === "take" && production.takes.some(t => t.id === source.takeId && t.coversShots.includes(id)); }), "Every scene shot has a visible picture-track placement in the saved cut.", "missing"),
    ];
    if (shape.dispatchCapability === "image") {
      for (const item of checks.filter(c=>c.key === "in-cut" || c.key === "dialogue-voiced")) { item.status="not-required"; item.detail=item.key === "in-cut"
        ? "This format delivers selected pictures directly, without a video cut." : "This format delivers images or beat text; prepared voices are optional."; }
    }
    if (shape.playsAsBeats) {
      const beats = sceneBeats(scene);
      const lines = scene.script?.blocks.length ? scene.script.blocks.map(b=>b.id) : beats.filter(b=>b.kind !== "picture").map(b=>b.lineId!);
      checks.push(check("beat-text","Beat text",lines,id=>!!beats.find(b=>b.blockId === id || b.lineId === id)?.text.trim(),"Authored beat lines are delivered as text when no prepared voice is present."));
    }
    if (shape.isBranching && production.routing?.excluded.some(e=>e.sceneId === scene.id)) for (const item of checks) { item.status="not-required"; item.detail="This scene is explicitly excluded from the playable package."; }
    return { sceneId: scene.id, title: scene.title, checks, ready: ready(checks) };
  });
  const exportsHere = exports.filter(e => e.worldId === world.meta.worldId && e.productionId === production.meta.id && e.episodeId === undefined)
    .map(({ id, worldId, productionId, episodeId, status, createdAt, output, sourceFingerprint }) => ({ id, worldId, productionId, episodeId, status, createdAt, output, sourceFingerprint }))
    .sort((a,b) => (a.createdAt ?? a.id).localeCompare(b.createdAt ?? b.id) || a.id.localeCompare(b.id));
  const lastExport = exportsHere.at(-1) ?? null;
  const currentFingerprint = productionExportFingerprint(world,production);
  const checks = [
    check("cut", "Cut assembled", [production.meta.id], () => !!timeline && picture.length > 0 && scenes.some(s => s.checks.find(c => c.key === "in-cut")?.status === "ready") && scenes.every(s => ["ready","not-required"].includes(s.checks.find(c => c.key === "in-cut")?.status ?? "missing")), "A saved picture cut includes every required scene shot."),
    check("subtitles", "Subtitles", [production.meta.id], () => !!timeline?.tracks.some(t => t.kind === "subtitle" && !t.muted && t.cues?.length && t.cues.every(c => !cueStaleness(c, production).stale)), "An unmuted subtitle track contains current editable cues."),
    check("export", "Last export", [production.meta.id], () => lastExport?.status === "done" && !!lastExport.output && lastExport.sourceFingerprint === currentFingerprint,
      lastExport ? `Last production export: ${lastExport.status}.${lastExport.status === "done" && lastExport.sourceFingerprint !== currentFingerprint ? " Export again: its source snapshot is older or unavailable." : ""}` : "No production export is recorded."),
  ];
  if (!shape.hasScenes || shape.dispatchCapability === "image") for (const c of checks.filter(c => c.key !== "export")) { c.status = "not-required"; c.detail = "This format delivers directly without a video cut or subtitle track."; }
  if (shape.hasChapters) {
    const chapters = production.chapters.filter(c=>!c.retired), ids = chapters.map(c=>c.id);
    checks.unshift(check("chapters","Chapters",[production.meta.id],()=>chapters.length > 0,"At least one current chapter is present."),
      check("manuscript","Manuscript",ids,id=>(chapters.find(c=>c.id === id)?.words ?? 0) > 0,"Every current chapter has saved prose.","missing"));
  }
  if (shape.isBranching) checks.unshift(check("routing","Routing",[production.meta.id],()=>!!production.routing && publicationBlockers(routingFindings(production.routing,production.scenes,production.routingTraversals ?? [])).length === 0,"The branch map has valid start, endings, destinations and current preview traversal evidence."));
  if (shape.hasScenes && shape.dispatchCapability === "video" && production.timeline?.status === "invalid") for (const c of checks.filter(c => c.key !== "export")) { c.status = "blocked"; c.detail = "Repair the invalid saved timeline before assessing the cut."; }
  return { productionId: production.meta.id, title: production.meta.title, scenes, checks, lastExport, ready: ready(checks) && scenes.every(s => s.ready) };
}
