import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  BenchRequestSnapshotSchema, BenchSubjectSchema, BenchTakeSchema, WorldChatProductionTakeFileActionSchema, foldBenchSession, newId, orderedShots,
  type BenchSession, type WorldChatProductionTakeFileAction,
} from "@arke-studio/contracts";
import { conversationActionDigest } from "../arke-actions/lifecycle.js";
import { existingBenchSubjectFiling, fileBenchSubjectTake } from "../bench/filing.js";
import { BenchStore, sessionMediaDir } from "../bench/store.js";
import { atomicWriteFile } from "../world/atomic.js";
import { readContainedImageReferences, readContainedVideoReferences } from "../world/reference-files.js";
import type { WorldStore, WorldStatePrecondition } from "../world/store.js";
import type { BoundaryFrameMaker } from "../takes/boundary.js";

type Action = WorldChatProductionTakeFileAction["action"];
const PlanSchema = z.object({ action: WorldChatProductionTakeFileActionSchema.shape.action, actionDigest: z.string(), sourceDigest: z.string(), sceneVersion: z.number(), selectionDigest: z.string(),
  mediaHash: z.string(), subject: BenchSubjectSchema, request: BenchRequestSnapshotSchema, take: BenchTakeSchema, digest: z.string() }).strict();
type Plan = z.infer<typeof PlanSchema>;
function digest(plan: Plan) { const { digest: _digest, ...fields } = plan; return conversationActionDigest(fields); }

/** A loose Bench result keeps its original media, prompt and settings while an approved card
 * fixes its production destination and new immutable identities (SPEC-051 R-7). */
export class ProductionTakeFiling {
  constructor(private readonly world: WorldStore, private readonly ports: {
    bench(sessionId: Action["sessionId"]): Promise<{ session: BenchSession; store: BenchStore } | null>;
    toPng?: BoundaryFrameMaker;
    serialise?<T>(key: string, work: () => Promise<T>): Promise<T>;
    refresh?(sessionId: Action["sessionId"]): Promise<void>;
  }) {}
  private path(id: string) { return join(this.world.dir, ".history/world/prepared", `${id}.take-filing.json`); }
  private async read(id: string) {
    const raw = await readFile(this.path(id), "utf8").catch(error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; });
    const plan = raw === null ? null : PlanSchema.parse(JSON.parse(raw));
    if (plan && plan.digest !== digest(plan)) throw new Error("The prepared filing changed; prepare a fresh card.");
    return plan;
  }
  private async source(action: Action) {
    const bench = await this.ports.bench(action.sessionId);
    const take = bench?.session.takes.find(take => take.id === action.takeId);
    if (!bench || !take?.media || take.status !== "succeeded" || take.disposition === "discarded" || !["image", "video"].includes(take.request.mode)) throw new Error("Choose a completed image or video Bench take.");
    const mediaPath = `${sessionMediaDir(action.sessionId, take.id)}/${take.media.file}`;
    const files = take.request.mode === "image" ? await readContainedImageReferences(this.world.dir, [mediaPath]) : await readContainedVideoReferences(this.world.dir, [mediaPath]);
    return { bench, take, mediaPath, mediaHash: createHash("sha256").update(files[0]!.data).digest("hex"),
      sourceDigest: conversationActionDigest({ request: take.request, media: take.media, jobId: take.jobId ?? null }) };
  }
  private destination(action: Action) {
    const production = this.world.getBundle().productions.find(p => p.meta.id === action.productionId);
    const scene = production?.scenes.find(s => s.id === action.sceneId);
    const shot = scene && orderedShots(scene).find(s => s.id === action.shotId);
    if (!production || !scene || !shot) throw new Error("That destination shot is no longer available.");
    return { production, scene, shot, selectionDigest: conversationActionDigest(production.selections[shot.id] ?? null) };
  }
  async prepare(action: Action, id: string) {
    const source = await this.source(action);
    const destination = this.destination(action);
    let plan = await this.read(id);
    if (source.take.filedTakeIds?.length) throw new Error("That Bench take is already filed. Review its production takes instead.");
    if (!plan) {
      const { production, scene, shot } = destination;
      const productionTakeId = newId("tk");
      const subject: BenchSession["subject"] = { kind: "shot", productionId: action.productionId, productionTitle: production.meta.title,
        sceneId: scene.id, sceneNumber: scene.number, sceneTitle: scene.title, shotId: shot.id, shotNumber: shot.number, shotTitle: shot.title,
        durationSec: shot.durationSec ?? 4, aspect: source.take.request.params.kind === "image" || source.take.request.params.kind === "video" ? source.take.request.params.aspect ?? "16:9" : "16:9",
        promptSheetVersions: source.take.request.productionProvenance?.sheets ?? {} };
      const duration = source.take.media!.info?.durationSec ?? (source.take.request.params.kind === "video" ? source.take.request.params.durationSec : undefined);
      if (source.take.request.mode === "video" && (!duration || duration <= 0)) throw new Error("This video needs a measured or requested duration before filing.");
      const request = BenchRequestSnapshotSchema.parse({ ...source.take.request,
        // A subjectless Bench did not record production provenance. Unknown remains unknown;
        // the current Canon revision cannot stand in for what the provider saw at generation.
        productionProvenance: source.take.request.productionProvenance ?? { canonRevision: 0, sheets: {} },
        filing: source.take.request.mode === "image" ? { kind: "shot", productionId: action.productionId, sceneId: scene.id,
          shotId: shot.id, productionTakeId, frameArtifactId: newId("ar") }
          : { kind: "board", productionId: action.productionId, sceneId: scene.id, productionTakeId,
            members: [{ shotId: shot.id, number: shot.number, startSec: 0, endSec: duration, takeId: newId("tk") }] } });
      plan = { action, actionDigest: conversationActionDigest(action), sourceDigest: source.sourceDigest, mediaHash: source.mediaHash,
        sceneVersion: scene.version, selectionDigest: destination.selectionDigest, subject, request, take: source.take, digest: "" };
      plan.digest = digest(plan);
      await this.world.ownedWrite(() => atomicWriteFile(this.path(id), JSON.stringify(PlanSchema.parse(plan)) + "\n"));
    }
    this.validate(action, plan, source, destination);
    return { family: "take-review" as const, mediaKind: source.take.request.mode === "image" ? "image" as const : "video" as const,
      mediaId: source.take.id, mediaPath: source.mediaPath,
      destination: `${destination.scene.title} · ${destination.shot.title}`,
      currentSelection: source.take.request.mode === "image" ? destination.production.selections[action.shotId]?.startFrameArtifactId ?? destination.production.selections[action.shotId]?.startFrameTakeId ?? null
        : destination.production.selections[action.shotId]?.acceptedTakeId ?? null,
      reason: "Files this Bench result and accepts it for the shot. The original prompt, settings and media are retained.",
      scene: `${destination.scene.number} · ${destination.scene.title}`, shot: `${destination.shot.number} · ${destination.shot.title}` };
  }
  private validate(action: Action, plan: Plan, source: Awaited<ReturnType<ProductionTakeFiling["source"]>>, destination: ReturnType<ProductionTakeFiling["destination"]>) {
    if (plan.actionDigest !== conversationActionDigest(action) || plan.sourceDigest !== source.sourceDigest || plan.mediaHash !== source.mediaHash ||
      plan.sceneVersion !== destination.scene.version || plan.selectionDigest !== destination.selectionDigest) throw new Error("The Bench take or destination changed. Prepare a fresh review card.");
  }
  file(action: Action, id: string, precondition: WorldStatePrecondition) {
    const work = () => this.fileUnserialised(action, id, precondition);
    return this.ports.serialise ? this.ports.serialise(`${action.sessionId}/${action.takeId}`, work) : work();
  }
  private async fileUnserialised(action: Action, id: string, precondition: WorldStatePrecondition) {
    const plan = await this.read(id);
    if (!plan || plan.actionDigest !== conversationActionDigest(action)) throw new Error("The prepared filing is unavailable.");
    const recovered = this.existing(action, plan);
    if (recovered) return recovered;
    const source = await this.source(action);
    const session = { ...source.bench.session, subject: plan.subject };
    const take = { ...source.take, request: plan.request };
    let filed = existingBenchSubjectFiling(this.world, session, take);
    if (!filed) {
      this.validate(action, plan, source, this.destination(action));
      filed = await fileBenchSubjectTake(this.world, session, take, { toPng: this.ports.toPng, explicitDestination: true,
        expectedMediaHash: plan.mediaHash,
        precondition: () => { const moved = precondition(); if (moved) return moved; this.validate(action, plan, source, this.destination(action)); return null; } });
    }
    await this.world.ownedWrite(() => source.bench.store.append({ type: "take-subject-filed", takeId: take.id, productionTakeIds: filed!.productionTakeIds as never,
      ...(filed!.artifactId ? { artifactId: filed!.artifactId as never } : {}) }, { at: this.world.now(), requestId: id })).catch(() => {});
    await this.ports.refresh?.(action.sessionId);
    return filed;
  }
  async reconcile(id: string) {
    const plan = await this.read(id);
    if (!plan || plan.actionDigest !== conversationActionDigest(plan.action)) return null;
    return this.existing(plan.action, plan);
  }
  private existing(action: Action, plan: Plan) {
    const session = foldBenchSession({ schemaVersion: 1, id: action.sessionId, createdAt: plan.take.createdAt, subject: plan.subject }, []);
    return existingBenchSubjectFiling(this.world, session, { ...plan.take, request: plan.request });
  }
  abandon(id: string) { return this.world.ownedWrite(() => rm(this.path(id), { force: true })); }
}
