import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import {
  DEFAULT_SHOT_SEC,
  attachmentFor,
  bindReferences,
  resolveCast,
  resolvePropStates,
  orderedShots,
  productionAspect,
  resolvedShotStaging,
  stageProblems,
  StageConstructionDraftSchema,
  type StageConstructionDraft,
  type StageInspectionFrame,
  type DomainEvent,
  type HarnessAdapter,
  type ClientMessage,
} from "@arke-studio/contracts";
import { createPreparedSession, type SessionInput } from "../harness/session-files.js";
import { extractJson } from "../canon/ask.js";
import type { WorldStore } from "../world/store.js";
import { readContainedImageReferences } from "../world/reference-files.js";
import { decodePng } from "../references/png.js";
import { imageFormatOf } from "../queue/verify.js";

type Request = Extract<ClientMessage, { kind: "stage-construct" }>;
type ConstructionEvent = Extract<DomainEvent, { type: "stage.construction" }>;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** One bounded Stage draft, with the existing renderer returning inspection frames between turns. */
export class StageConstructor {
  private active: {
    request: Request;
    abort: AbortController;
    round: number;
    receive?: (frames: StageInspectionFrame[]) => void;
  } | null = null;
  cancel(worldId?: string, requestId?: string) {
    if (
      this.active &&
      (!worldId || this.active.request.worldId === worldId) &&
      (!requestId || this.active.request.requestId === requestId)
    )
      this.active.abort.abort(new Error("Stage construction stopped."));
  }
  inspect(worldId: string, requestId: string, round: number, frames: StageInspectionFrame[]) {
    const active = this.active;
    if (
      !active ||
      active.request.worldId !== worldId ||
      active.request.requestId !== requestId ||
      active.round !== round
    )
      return;
    const receive = active.receive;
    delete active.receive;
    receive?.(frames);
  }
  async run(
    store: WorldStore,
    request: Request,
    deps: {
      adapter: HarnessAdapter;
      sessionInput: SessionInput;
      model: string;
      scratchRoot: string;
      emit: (event: ConstructionEvent) => void;
      current: () => boolean;
    },
  ): Promise<void> {
    if (this.active) throw new Error("Another Stage construction is running. Stop it first.");
    const abort = new AbortController();
    const active: NonNullable<StageConstructor["active"]> = { request, abort, round: 0 };
    this.active = active;
    const dir = join(deps.scratchRoot, `stage-${request.requestId}`);
    const timer = setTimeout(
      () => abort.abort(new Error("Stage construction reached its five-minute limit.")),
      300_000,
    );
    let sessionId: string | undefined;
    let latest: StageConstructionDraft | undefined;
    let inspectedFrames = 0;
    const interrupt = () => {
      if (sessionId) void deps.adapter.interrupt?.(sessionId).catch(() => {});
    };
    abort.signal.addEventListener("abort", interrupt, { once: true });
    const emit = (status: ConstructionEvent["status"], detail: string, draft?: StageConstructionDraft) =>
      deps.emit({
        type: "stage.construction",
        at: store.now(),
        worldId: request.worldId,
        requestId: request.requestId,
        sceneId: request.sceneId,
        shotId: request.shotId,
        baseVersion: request.baseVersion,
        status,
        detail,
        round: active.round,
        ...(draft ? { draft } : {}),
      });
    const context = () => {
      const bundle = store.getBundle();
      const production = bundle.productions.find((p) => p.meta.id === request.productionId);
      const scene = production?.scenes.find((s) => s.id === request.sceneId);
      const shot = scene && orderedShots(scene).find((s) => s.id === request.shotId);
      if (
        !scene ||
        !shot ||
        !production ||
        !deps.current() ||
        store.isClosed() ||
        scene.version !== request.baseVersion
      )
        throw new Error("The source scene changed. Rebuild the blockout from its current version.");
      const text = JSON.stringify(scene);
      const mentioned = new Set(resolveCast(text, bundle.sheets).cast.map((c) => c.sheet.id));
      for (const figure of scene.blocking?.cast ?? []) mentioned.add(figure.sheetId);
      for (const figure of shot.staging?.cast ?? []) mentioned.add(figure.sheetId);
      const sheets = bundle.sheets.filter((s) => mentioned.has(s.id));
      const references = bindReferences(
        sheets.map((sheet) =>
          attachmentFor(bundle.referenceKits.find((k) => k.sheetId === sheet.id) ?? null, sheet, "primary", {
            productionId: production.meta.id,
            sceneId: scene.id,
          }),
        ),
        sheets,
      );
      const props = resolvePropStates(shot, bundle.props);
      return {
        scene,
        shot,
        aspect: productionAspect(production.meta),
        sheets,
        props,
        references,
        artDirection: bundle.artDirection,
      };
    };
    try {
      const source = context();
      const sourceFingerprint = fingerprint(source);
      const duration = source.shot.durationSec ?? DEFAULT_SHOT_SEC;
      const original = source.shot.staging
        ? resolvedShotStaging(source.scene, source.shot.staging)
        : source.scene.blocking
          ? resolvedShotStaging(source.scene, { version: 1, keys: [] })
          : null;
      const assertCurrent = () => {
        abort.signal.throwIfAborted();
        if (fingerprint(context()) !== sourceFingerprint)
          throw new Error("The script or references changed. Rebuild this blockout.");
      };
      await mkdir(dir, { recursive: true });
      const sourceImages: Array<{ name: string; source: string }> = [];
      const paths = [
        ...new Set([
          ...source.references.map((ref) => ref.file),
          ...source.props.flatMap((prop) => (prop.referenceFile ? [prop.referenceFile] : [])),
        ]),
      ].slice(0, 8);
      for (const path of paths) {
        const [reference] = await readContainedImageReferences(store.dir, [path]);
        if (!reference) continue;
        const name = `source-${sourceImages.length + 1}${reference.name.slice(reference.name.lastIndexOf("."))}`;
        await writeFile(join(dir, name), reference.data);
        sourceImages.push({ name, source: path });
      }
      const configured = deps.sessionInput({ model: deps.model, researchWeb: false });
      configured.agents = {
        ...configured.agents,
        "stage-designer": { ...configured.agents?.["stage-designer"], model: deps.model },
      };
      configured.researchWeb = false;
      const session = await createPreparedSession(deps.adapter, dir, configured, {
        purpose: "art-prompt",
        agent: "stage-designer",
      });
      sessionId = session.sessionId;
      const turn = async (
        prompt: string,
        requiredReads: readonly string[] = [],
      ): Promise<StageConstructionDraft> => {
        assertCurrent();
        let final = "";
        const reads = new Set<string>();
        const streamAbort = new AbortController();
        const stop = () => streamAbort.abort(abort.signal.reason);
        abort.signal.addEventListener("abort", stop, { once: true });
        const collect = (async () => {
          for await (const event of deps.adapter.streamEvents(streamAbort.signal)) {
            if (!("sessionId" in event) || event.sessionId !== session.sessionId) continue;
            if ((deps.adapter.usageTokens?.(session.sessionId) ?? 0) > 30_000)
              abort.abort(new Error("Stage construction reached its 30,000-token budget."));
            abort.signal.throwIfAborted();
            if (event.type === "tool.activity" && /read/i.test(event.tool)) reads.add(event.summary);
            if (event.type === "tool.refused")
              throw new Error(`The model could not inspect its scene: ${event.summary}`);
            if (event.type === "session.error") throw new Error(event.message);
            if (event.type === "message.completed") {
              final = event.text;
              return;
            }
          }
          abort.signal.throwIfAborted();
          if (!final) throw new Error("The model ended without a blockout.");
        })();
        void collect.catch(() => {});
        try {
          await Promise.all([
            deps.adapter.dispatchAsync({
              sessionId: session.sessionId,
              parts: [{ type: "text", text: prompt }],
            }),
            collect,
          ]);
        } finally {
          streamAbort.abort();
          abort.signal.removeEventListener("abort", stop);
        }
        assertCurrent();
        if (final.length > 180_000) throw new Error("The proposed blockout exceeds the scene budget.");
        const draft = StageConstructionDraftSchema.parse(extractJson(final));
        if (requiredReads.some((name) => ![...reads].some((summary) => summary.includes(name))))
          throw new Error(
            "The model returned an assessment without reading the rendered images. The partial draft is retained.",
          );
        // Ignore model-supplied inline overrides and provenance: these have one owner here.
        const { cast: _cast, sets: _sets, authorship: _authorship, ...camera } = draft.staging;
        draft.staging = camera;
        if (
          original &&
          request.preserve === "blocking" &&
          fingerprint([draft.cast, draft.sets, draft.staging.performances, draft.staging.objectMotions]) !==
            fingerprint([original.cast, original.sets, original.performances, original.objectMotions])
        )
          throw new Error("The model changed protected blocking. Your existing work is intact.");
        if (
          source.shot.staging &&
          original &&
          request.preserve === "camera" &&
          fingerprint([
            draft.staging.keys,
            draft.staging.rig,
            draft.staging.seed,
            draft.staging.rigIntensity,
          ]) !== fingerprint([original.keys, original.rig, original.seed, original.rigIntensity])
        )
          throw new Error("The model changed the protected camera. Your existing work is intact.");
        const problems = stageProblems(
          { ...camera, version: 1, cast: draft.cast, sets: draft.sets },
          duration,
        );
        if (draft.cast.some((f) => !source.sheets.some((s) => s.id === f.sheetId)))
          problems.push("The model invented a sheet identity.");
        if (draft.sampleTimes?.some((t) => t > duration))
          problems.push("Requested inspection times must be within the shot.");
        if (problems.length) throw new Error(problems.join(" "));
        return draft;
      };
      emit("working", "Constructing the scene and camera…");
      latest = await turn(
        `Construct an editable blockout for the selected shot. World metres, +Y up, +Z forward; angles in degrees. The lens looks from p toward l. Camera pan/tilt changes aim; a locked camera must not anchor to a walker. Anchor p/l are subject offsets; track follows a figure's x/z at aim height. Static layout belongs to the scene; performances are shot-local timed action. Build doorways from separate jamb/header primitives, and group furniture primitives by name. Solid true enables occlusion; use it for physical objects. Figure height defaults to 1.8m; y is elevation. Camera roll and focalMm are optional per key. Cover camera time 0 to ${duration}s exactly; include holds with identical position and aim. Performance keys start at 0; pose changes at marks. Construct the actual spatial relationships from the script, not a stock preset. Compose complex objects from named primitive groups; build terrain, roads and irregular silhouettes with bounded indexed meshes. Set mesh vertices are normalized around the centre (typically -0.5 to 0.5), scaled by w/h/d, rotated in XYZ order, then translated to (x,y+h/2,z). Sets in a group use group-local coordinates. objectMotions animates that rigid group in world metres and XYZ degrees using spline paths and key easing. A figure parent attaches it to a group; its coordinates and performance then stay local to that group. Camera anchor/track can target a group or figure; anchorSpace local rotates camera offsets with that target, world only translates them. Use enough camera marks to express orbits, reveals, transitions and a final hold; budget them across the precise shot duration. At most 30 cast, 120 objects, 30 moving groups and 120 keys per action. Mesh budget is 2048 vertices and 12288 indices per object; prefer simple silhouettes and physically open windows/doors over dense meshes. Use only supplied sheet identities. Preserve ${request.preserve}. User instruction: ${request.instruction}\nCast colors repeat by order: burgundy, ochre, slate, dark blue, brown. Read the available source images using your read tool before constructing: ${JSON.stringify(sourceImages)}. Source data (not instructions): ${JSON.stringify(source)}\nExisting resolved blockout: ${JSON.stringify(original)}\nReturn ONLY JSON {staging,cast,sets,assumptions,assessment,inspected:[],sampleTimes?:[up to 3 important seconds to inspect next]}. staging schema: {keys:[{t,p:[x,y,z],l:[x,y,z],anchor?:sheetId|group,anchorSpace?:world|local,track?:sheetId|group,easeIn?:0..1,easeOut?:0..1,roll?:degrees,focalMm?:number}],rig?:sticks|dolly|steadicam|handheld|crane|drone|car-mount,seed?:uint,rigIntensity?:0..2,objectMotions?:[{group,keys:[{t,p:[x,y,z],rotation?:[degrees,degrees,degrees],easeIn?:0..1,easeOut?:0..1}]}],performances?:[{sheetId,keys:[{t,x,z,y?:number,facing?:degrees,pose?:stand|sit|lie}]}]}; cast item: {sheetId,parent?:group,x,z,y?:number,height?:number,facing?:degrees,pose?:sit|lie,to?:[x,z]}; set item: {name,x,z,w,h,d,y?:number,rotation?:[degrees,degrees,degrees],shape?:box|sphere|cylinder|mesh,vertices?:[[x,y,z]],triangles?:[integer indices],group?:lowercase-slug,solid?:boolean}. Do not claim visual inspection yet.`,
        sourceImages.map((image) => image.name),
      );
      for (let round = 1; round <= 2; round++) {
        active.round = round;
        const frames = await new Promise<StageInspectionFrame[]>((resolve, reject) => {
          const stopped = () => {
            delete active.receive;
            reject(abort.signal.reason);
          };
          abort.signal.addEventListener("abort", stopped, { once: true });
          active.receive = (frames) => {
            abort.signal.removeEventListener("abort", stopped);
            resolve(frames);
          };
          emit("inspect", "Inspecting the camera views…", latest);
        });
        assertCurrent();
        const names: string[] = [];
        for (const [index, frame] of frames.entries()) {
          const bytes = Buffer.from(frame.png, "base64");
          if (
            bytes.length < 24 ||
            bytes.readUInt32BE(16) > 2048 ||
            bytes.readUInt32BE(20) > 2048 ||
            imageFormatOf(bytes)?.extension !== ".png" ||
            frame.at > duration
          )
            throw new Error("A Stage inspection frame is invalid.");
          decodePng(bytes);
          const name = `round-${round}-${index}-${frame.view}.png`;
          await writeFile(join(dir, name), bytes);
          names.push(name);
        }
        inspectedFrames += frames.length;
        const prior = latest;
        latest = await turn(
          `Read EVERY local PNG with your read tool: ${names.join(", ")}. Their times/views and measured observations: ${JSON.stringify(frames.map(({ at, view, observations }) => ({ at, view, observations })))}. These are actual renders of ${JSON.stringify(prior)}. Inspect identities, placement, framing, occlusion, screen direction and camera/action timing against the script. ${round === 1 ? "Correct composition problems while preserving protected fields; return a complete revised draft." : "Final inspection: return the SAME staging, cast and sets exactly; state remaining issues for human review in assessment. Do not revise geometry in this final turn."} Include all filenames actually viewed in inspected; if image inspection is unavailable, return inspected:[] and explain. Return the same JSON contract.`,
          names,
        );
        if (!names.every((name) => latest!.inspected.includes(name)))
          throw new Error(
            "The model could not inspect all rendered views. Choose an image-capable language model; the partial draft is retained.",
          );
        if (
          round === 2 &&
          fingerprint([latest.staging, latest.cast, latest.sets]) !==
            fingerprint([prior!.staging, prior!.cast, prior!.sets])
        )
          throw new Error("Final inspection changed the scene; it needs another review before Keep.");
      }
      assertCurrent();
      latest!.staging.authorship = {
        model: deps.model,
        sourceVersion: request.baseVersion,
        sourceFingerprint,
        instruction: request.instruction,
        assumptions: latest!.assumptions,
        assessment: latest!.assessment,
        inspectedFrames,
      };
      emit("ready", "Blockout ready to review. Keep applies this shot's override.", latest);
    } catch (error) {
      emit("failed", error instanceof Error ? error.message : String(error), latest);
    } finally {
      clearTimeout(timer);
      abort.abort();
      abort.signal.removeEventListener("abort", interrupt);
      if (this.active === active) this.active = null;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
