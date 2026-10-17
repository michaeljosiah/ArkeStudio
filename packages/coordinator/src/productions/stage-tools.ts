import {
  SceneAtmosphereSchema,
  STAGE_CAMERA_MOVES,
  STAGE_POSE_LABELS,
  StageConstructionDraftSchema,
  StageLightSchema,
  StageObjectMotionSchema,
  StagePerformanceKeySchema,
  StageRigSchema,
  StagingFigureSchema,
  StagingKeySchema,
  StagingSetSchema,
  sampleStageCamera,
  stageCameraMotionWarnings,
  stageCameraMove,
  stageCameraStandoffWarnings,
  stageFigureAt,
  stageLineCrossings,
  stageProblems,
  stageSolveDraftWords,
  stageSpeedWarnings,
  stageTurnWarnings,
  type ResolvedShotStaging,
  type SceneAtmosphere,
  type SceneRecord,
  type StageCameraMove,
  type StageConstructionDraft,
  type StageInspectionFrame,
  type StageLight,
  type StageObjectMotion,
  type StagePerformance,
  type StagingFigure,
  type StagingKey,
  type StagingSet,
} from "@arke-studio/contracts";
import { z } from "zod";

/**
 * Build with Arke as a tool session (issue 1823, design turn 229f). The stage-designer edits a
 * draft the coordinator owns, one small validated call at a time, and looks when it wants to:
 * a render is the same inspection round-trip the client already serves. What it ends with is the
 * same `StageConstructionDraft` the one-reply build returned, so review, Keep and filing are
 * unchanged.
 *
 * Every edit is refused at the tool when it would touch what the build was asked to preserve, so
 * a protected field cannot move through any call; the run checks the finished draft again anyway.
 */

export interface StageToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type StageToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: "image/png" };

export interface StageToolResult {
  content: StageToolContent[];
  isError?: boolean;
}

/** What the build is of, fixed when it starts. */
export interface StageToolContext {
  scene: SceneRecord;
  shotId: string;
  aspect: string;
  lens: string | undefined;
  durationSec: number;
  sheets: ReadonlyArray<{ id: string; name: string }>;
  preserve: "blocking" | "camera" | "none";
  /** The resolved blockout the build starts from, when there is one. */
  original: ResolvedShotStaging | null;
  /** Whether the shot has its own kept camera, which is what `preserve: camera` protects. */
  shotStaged: boolean;
  /** The opening camera for a shot with nothing staged, so the first render has a lens. */
  openingKeys: StagingKey[];
  lights: StageLight[];
  atmosphere: SceneAtmosphere | undefined;
}

export interface StageToolHooks {
  /** A step landed: the log line, and the draft as it now stands when it is a whole one. */
  step(label: string, detail: string | undefined, draft: StageConstructionDraft | null, calls: number): void;
  /** Render the draft through the client's lens; resolves with the frames and their saved names. */
  render(draft: StageConstructionDraft, times: number[]): Promise<Array<{ name: string; frame: StageInspectionFrame }>>;
  /** Whether the source images the build was given have been read. */
  sourcesRead(): { read: boolean; missing: string[] };
}

export const STAGE_RENDER_BUDGET = 8;
export const STAGE_CALL_BUDGET = 160;

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const anything = { type: "object", additionalProperties: true };

export const STAGE_TOOLS: readonly StageToolDefinition[] = [
  { name: "stage_get", description: "The draft as it stands: cast, sets, lights, atmosphere, camera keys, marks, and what this build may change. Read it before your first edit.", inputSchema: object({}) },
  { name: "stage_add", description: "Add one thing to the stage: kind figure (a cast sheet: sheetId, x, z, facing?, height?, pose?: sit|lie, to?), set (a kit item or primitive, named) or light. One thing per call.", inputSchema: object({ kind: { type: "string", enum: ["figure", "set", "light"] }, item: anything }, ["kind", "item"]) },
  { name: "stage_update", description: "Change one figure (by sheetId), set or light (by name): the patch's fields replace the item's; null clears an optional field.", inputSchema: object({ name: { type: "string" }, patch: anything }, ["name", "patch"]) },
  { name: "stage_remove", description: "Take a figure (by sheetId), set or light (by name) off the stage, with any marks it had.", inputSchema: object({ name: { type: "string" } }, ["name"]) },
  { name: "stage_pose", description: "Put a mark on a figure's track: {t, x, z, facing?, pose?, hand?: {side, on, part?}, look?, gait?, hold?, easeIn?, easeOut?}. A mark at the same time is replaced; remove: true takes it away.", inputSchema: object({ sheetId: { type: "string" }, key: anything, remove: { type: "boolean" } }, ["sheetId", "key"]) },
  { name: "stage_object", description: "Put a key on a set group's motion track: {t, p, rotation?, easeIn?, easeOut?}. A key at the same time is replaced; remove: true takes it away.", inputSchema: object({ group: { type: "string" }, key: anything, remove: { type: "boolean" } }, ["group", "key"]) },
  { name: "stage_camera_key", description: "Put a camera key at t. Write it in words — {t, frame: {subject, size, angle, side, over?, focalMm?}} — and the Stage solves the position through the shot's lens; or as numbers {t, p, l, anchor?, track?, ...}. A key at the same time is replaced; remove: true takes it away (the first and last stay).", inputSchema: object({ key: anything, remove: { type: "boolean" } }, ["key"]) },
  { name: "stage_camera_move", description: `Replace the camera with a named move about a figure: ${STAGE_CAMERA_MOVES.map((move) => move.id).join(", ")}.`, inputSchema: object({ move: { type: "string", enum: STAGE_CAMERA_MOVES.map((move) => move.id) }, subject: { type: "string" }, at: { type: "number" } }, ["move"]) },
  { name: "stage_settings", description: "The camera rig (sticks, dolly, steadicam, handheld, crane, drone, car-mount), its seed and intensity, the atmosphere, and where the location plate's camera stood (plateCamera {p, l, focalMm}).", inputSchema: object({ rig: { type: "string" }, seed: { type: "number" }, rigIntensity: { type: "number" }, atmosphere: anything, plateCamera: anything }) },
  { name: "stage_render", description: `Look through the shot's lens: renders the opening, the end and up to three times you name, plus an overview, with measured observations. ${STAGE_RENDER_BUDGET} renders per build.`, inputSchema: object({ at: { type: "array", items: { type: "number" }, maxItems: 3 } }) },
  { name: "stage_measure", description: "Distance and bearing between two things at a time: a figure (sheetId), a set or light (name), or camera.", inputSchema: object({ a: { type: "string" }, b: { type: "string" }, at: { type: "number" } }, ["a", "b"]) },
  { name: "stage_check", description: "What is wrong with the draft: problems that block it, the 180° line, camera standoff and motion, walking speeds and turns.", inputSchema: object({}) },
  { name: "stage_done", description: "Finish: your assessment of the blockout and the assumptions you made. Render at least once and resolve every problem first.", inputSchema: object({ assessment: { type: "string" }, assumptions: { type: "array", items: { type: "string" }, maxItems: 20 } }, ["assessment"]) },
];

type Thing = { kind: "figure"; index: number } | { kind: "set"; index: number } | { kind: "light"; index: number };

const round2 = (value: number) => Math.round(value * 100) / 100;
const text = (value: unknown): StageToolContent => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
/** A patch whose null fields clear the item's: the shape every update takes. */
function patched(item: object, patch: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...item };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}
const failure = (error: z.ZodError | Error) =>
  error instanceof z.ZodError ? error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`).join("; ") : error.message;

export class StageDraftTools {
  readonly tools = STAGE_TOOLS;
  private keys: StagingKey[];
  private rig: ResolvedShotStaging["rig"];
  private seed: number | undefined;
  private rigIntensity: number | undefined;
  private performances: StagePerformance[];
  private objectMotions: StageObjectMotion[];
  private cast: StagingFigure[];
  private sets: StagingSet[];
  private lights: StageLight[];
  private atmosphere: SceneAtmosphere | undefined;
  private plateCamera: StageConstructionDraft["plateCamera"];
  private calls = 0;
  private renders = 0;
  readonly inspected: string[] = [];
  framesSeen = 0;
  private finish: { assessment: string; assumptions: string[] } | null = null;
  private settle!: () => void;
  /** Resolves when the model calls stage_done and the draft passes. */
  readonly finished = new Promise<void>((resolve) => { this.settle = resolve; });

  constructor(private readonly context: StageToolContext, private readonly hooks: StageToolHooks) {
    const original = context.original;
    this.keys = original && original.keys.length >= 2 ? structuredClone(original.keys) : structuredClone(context.openingKeys);
    this.rig = original?.rig;
    this.seed = original?.seed;
    this.rigIntensity = original?.rigIntensity;
    this.performances = structuredClone(original?.performances ?? []);
    this.objectMotions = structuredClone(original?.objectMotions ?? []);
    this.cast = structuredClone(original?.cast ?? []);
    this.sets = structuredClone(original?.sets ?? []);
    this.lights = structuredClone(context.lights);
    this.atmosphere = context.atmosphere === undefined ? undefined : { ...context.atmosphere };
  }

  get done(): boolean { return this.finish !== null; }
  get callCount(): number { return this.calls; }
  get renderCount(): number { return this.renders; }

  /** The staging the evaluators read. */
  private resolved(): ResolvedShotStaging {
    return {
      version: 1,
      keys: this.keys,
      cast: this.cast,
      sets: this.sets,
      ...(this.performances.length > 0 ? { performances: this.performances } : {}),
      ...(this.objectMotions.length > 0 ? { objectMotions: this.objectMotions } : {}),
      ...(this.rig === undefined ? {} : { rig: this.rig }),
      ...(this.seed === undefined ? {} : { seed: this.seed }),
      ...(this.rigIntensity === undefined ? {} : { rigIntensity: this.rigIntensity }),
    };
  }

  /** The draft as the schema reads it, or why it is not one yet. */
  draft(extra: { sampleTimes?: number[] } = {}): { draft: StageConstructionDraft } | { problem: string } {
    const parsed = StageConstructionDraftSchema.safeParse({
      staging: {
        keys: this.keys,
        ...(this.rig === undefined ? {} : { rig: this.rig }),
        ...(this.seed === undefined ? {} : { seed: this.seed }),
        ...(this.rigIntensity === undefined ? {} : { rigIntensity: this.rigIntensity }),
        ...(this.performances.length > 0 ? { performances: this.performances } : {}),
        ...(this.objectMotions.length > 0 ? { objectMotions: this.objectMotions } : {}),
      },
      cast: this.cast,
      sets: this.sets,
      ...(this.lights.length > 0 ? { lights: this.lights } : {}),
      ...(this.atmosphere === undefined ? {} : { atmosphere: this.atmosphere }),
      ...(this.plateCamera === undefined ? {} : { plateCamera: this.plateCamera }),
      ...(extra.sampleTimes === undefined ? {} : { sampleTimes: extra.sampleTimes }),
      assumptions: this.finish?.assumptions ?? [],
      assessment: this.finish?.assessment ?? "",
      inspected: this.inspected.slice(-24),
    });
    return parsed.success ? { draft: parsed.data } : { problem: failure(parsed.error) };
  }

  private nameOf = (id: string) => this.context.sheets.find((sheet) => sheet.id === id)?.name ?? id;

  private guard(part: "blocking" | "camera"): void {
    if (part === "blocking" && this.context.preserve === "blocking" && this.context.original !== null)
      throw new Error("Blocking is protected in this build: the figures, sets and their motion stay as they are. Work on the camera, lights and atmosphere.");
    if (part === "camera" && this.context.preserve === "camera" && this.context.shotStaged && this.context.original !== null)
      throw new Error("The camera is protected in this build: its keys, rig and seed stay as they are. Work on the blocking.");
  }

  private find(name: string): Thing | null {
    const figure = this.cast.findIndex((candidate) => candidate.sheetId === name);
    if (figure >= 0) return { kind: "figure", index: figure };
    const set = this.sets.findIndex((candidate) => candidate.name === name);
    if (set >= 0) return { kind: "set", index: set };
    const light = this.lights.findIndex((candidate) => candidate.name === name);
    if (light >= 0) return { kind: "light", index: light };
    return null;
  }

  private landed(label: string, detail?: string): void {
    const now = this.draft();
    this.hooks.step(label, detail, "draft" in now ? now.draft : null, this.calls);
  }

  async call(name: string, args: Record<string, unknown>): Promise<StageToolResult> {
    this.calls += 1;
    if (this.finish !== null) return { content: [text("The build is finished.")], isError: true };
    if (this.calls > STAGE_CALL_BUDGET) return { content: [text(`The build has used its ${STAGE_CALL_BUDGET} calls. Call stage_done.`)], isError: true };
    try {
      return await this.run(name, args);
    } catch (error) {
      return { content: [text(error instanceof Error || error instanceof z.ZodError ? failure(error) : String(error))], isError: true };
    }
  }

  private async run(name: string, args: Record<string, unknown>): Promise<StageToolResult> {
    const { durationSec: duration, aspect, lens } = this.context;
    switch (name) {
      case "stage_get": {
        return { content: [text({
          shot: { durationSec: duration, aspect, lens: lens ?? null },
          preserve: this.context.preserve === "none" || this.context.original === null ? "nothing protected" : this.context.preserve,
          cast: this.cast, sets: this.sets, lights: this.lights, atmosphere: this.atmosphere ?? null,
          camera: { keys: this.keys, rig: this.rig ?? "sticks", seed: this.seed ?? null, rigIntensity: this.rigIntensity ?? null },
          performances: this.performances, objectMotions: this.objectMotions, plateCamera: this.plateCamera ?? null,
          sheets: this.context.sheets, rendersLeft: STAGE_RENDER_BUDGET - this.renders,
        })] };
      }
      case "stage_add": {
        const kind = args["kind"];
        if (kind === "figure") {
          this.guard("blocking");
          const figure = StagingFigureSchema.parse(args["item"]);
          if (!this.context.sheets.some((sheet) => sheet.id === figure.sheetId)) throw new Error(`${figure.sheetId} is not one of this shot's cast sheets: ${this.context.sheets.map((sheet) => sheet.id).join(", ")}.`);
          if (this.cast.some((candidate) => candidate.sheetId === figure.sheetId)) throw new Error(`${figure.sheetId} is already on the stage; update it instead.`);
          if (this.cast.length >= 30) throw new Error("The stage holds 30 figures.");
          this.cast.push(figure);
          this.landed(`${this.nameOf(figure.sheetId)} · ${figure.pose === "sit" ? "sits" : figure.pose === "lie" ? "lies" : figure.to ? "walks" : "stands"}`, `${round2(figure.x)}, ${round2(figure.z)}`);
          return { content: [text(`Added ${figure.sheetId}.`)] };
        }
        if (kind === "set") {
          this.guard("blocking");
          const set = StagingSetSchema.parse(args["item"]);
          if (this.find(set.name) !== null) throw new Error(`Something called ${set.name} is already on the stage; name this one apart.`);
          if (this.sets.length >= 120) throw new Error("The stage holds 120 sets.");
          this.sets.push(set);
          this.landed(set.kit ? `${set.name} · ${set.kit.kind} ${round2(set.w)} × ${round2(set.d)} × ${round2(set.h)}` : set.name, set.kit ? "kit" : set.shape ?? "box");
          return { content: [text(`Added ${set.name}.`)] };
        }
        if (kind === "light") {
          const light = StageLightSchema.parse(args["item"]);
          if (this.find(light.name) !== null) throw new Error(`Something called ${light.name} is already on the stage; name this one apart.`);
          if (this.lights.length >= 24) throw new Error("A scene holds 24 lights.");
          this.lights.push(light);
          this.landed(`${light.name} · light`, `${light.kind} · ${light.strength}`);
          return { content: [text(`Added ${light.name}.`)] };
        }
        throw new Error("kind is figure, set or light.");
      }
      case "stage_update": {
        const target = String(args["name"] ?? "");
        const patch = z.record(z.string(), z.unknown()).parse(args["patch"]);
        const thing = this.find(target);
        if (thing === null) throw new Error(`Nothing called ${target} is on the stage.`);
        if (thing.kind === "figure") {
          this.guard("blocking");
          const next = StagingFigureSchema.parse(patched(this.cast[thing.index]!, patch));
          if (next.sheetId !== target) throw new Error("A figure keeps its sheet.");
          this.cast[thing.index] = next;
        } else if (thing.kind === "set") {
          this.guard("blocking");
          const next = StagingSetSchema.parse(patched(this.sets[thing.index]!, patch));
          if (next.name !== target && this.find(next.name) !== null) throw new Error(`Something called ${next.name} is already on the stage.`);
          this.sets[thing.index] = next;
        } else {
          const next = StageLightSchema.parse(patched(this.lights[thing.index]!, patch));
          if (next.name !== target && this.find(next.name) !== null) throw new Error(`Something called ${next.name} is already on the stage.`);
          this.lights[thing.index] = next;
        }
        this.landed(`${thing.kind === "figure" ? this.nameOf(target) : target} · ${Object.keys(patch).join(", ")}`, thing.kind);
        return { content: [text(`Updated ${target}.`)] };
      }
      case "stage_remove": {
        const target = String(args["name"] ?? "");
        const thing = this.find(target);
        if (thing === null) throw new Error(`Nothing called ${target} is on the stage.`);
        if (thing.kind !== "light") this.guard("blocking");
        if (thing.kind === "figure") {
          this.cast.splice(thing.index, 1);
          this.performances = this.performances.filter((track) => track.sheetId !== target);
        } else if (thing.kind === "set") this.sets.splice(thing.index, 1);
        else this.lights.splice(thing.index, 1);
        this.landed(`${thing.kind === "figure" ? this.nameOf(target) : target} · removed`);
        return { content: [text(`Removed ${target}.`)] };
      }
      case "stage_pose": {
        this.guard("blocking");
        const sheetId = String(args["sheetId"] ?? "");
        if (!this.cast.some((figure) => figure.sheetId === sheetId)) throw new Error(`${sheetId} is not on the stage; add the figure first.`);
        const key = StagePerformanceKeySchema.parse(args["key"]);
        if (key.t > duration) throw new Error(`A mark sits inside the shot, 0 to ${duration} s.`);
        const track = this.performances.find((candidate) => candidate.sheetId === sheetId);
        const keys = (track?.keys ?? []).filter((candidate) => Math.abs(candidate.t - key.t) > 0.01);
        if (args["remove"] !== true) keys.push(key);
        keys.sort((a, b) => a.t - b.t);
        this.performances = [...this.performances.filter((candidate) => candidate.sheetId !== sheetId), ...(keys.length > 0 ? [{ sheetId, keys }] : [])];
        const what = args["remove"] === true ? "mark removed" : key.pose !== undefined && key.pose !== "stand" ? STAGE_POSE_LABELS[key.pose].toLowerCase() : key.gait ?? "mark";
        this.landed(`${this.nameOf(sheetId)} · ${what}`, `${key.t.toFixed(1)} s${key.hand ? ` · hand · ${this.nameOf(key.hand.on)}` : ""}`);
        return { content: [text(`${this.nameOf(sheetId)} has ${keys.length} marks.`)] };
      }
      case "stage_object": {
        this.guard("blocking");
        const group = String(args["group"] ?? "");
        if (!this.sets.some((set) => set.group === group)) throw new Error(`No set is in the group ${group}.`);
        const key = StageObjectMotionSchema.shape.keys.element.parse(args["key"]);
        if (key.t > duration) throw new Error(`A key sits inside the shot, 0 to ${duration} s.`);
        const track = this.objectMotions.find((candidate) => candidate.group === group);
        const keys = (track?.keys ?? []).filter((candidate) => Math.abs(candidate.t - key.t) > 0.01);
        if (args["remove"] !== true) keys.push(key);
        keys.sort((a, b) => a.t - b.t);
        this.objectMotions = [...this.objectMotions.filter((candidate) => candidate.group !== group), ...(keys.length > 0 ? [{ ...track, group, keys }] : [])];
        this.landed(`${group} · moves`, `${key.t.toFixed(1)} s`);
        return { content: [text(`${group} has ${keys.length} keys.`)] };
      }
      case "stage_camera_key": {
        this.guard("camera");
        const raw = z.record(z.string(), z.unknown()).parse(args["key"]);
        const t = z.number().min(0).max(duration).parse(raw["t"]);
        if (args["remove"] === true) {
          const at = this.keys.findIndex((key) => Math.abs(key.t - t) <= 0.01);
          if (at <= 0 || at === this.keys.length - 1) throw new Error("The first and last camera keys stay; move them instead.");
          this.keys.splice(at, 1);
          this.landed("camera key removed", `${t.toFixed(1)} s`);
          return { content: [text(`The camera has ${this.keys.length} keys.`)] };
        }
        const solved = raw["frame"] !== undefined && (raw["p"] === undefined || raw["l"] === undefined)
          ? (stageSolveDraftWords({ staging: { keys: [raw], ...(this.performances.length ? { performances: this.performances } : {}), ...(this.objectMotions.length ? { objectMotions: this.objectMotions } : {}) }, cast: this.cast, sets: this.sets }, duration, aspect, lens) as { staging: { keys: unknown[] } }).staging.keys[0]
          : raw;
        const key = StagingKeySchema.parse(solved);
        if (this.keys.length >= 120) throw new Error("A camera holds 120 keys.");
        this.keys = [...this.keys.filter((candidate) => Math.abs(candidate.t - key.t) > 0.01), key].sort((a, b) => a.t - b.t);
        const words = key.frame;
        this.landed(words ? `${words.size} on ${this.nameOf(words.subject)}` : "camera key", `${key.t.toFixed(1)} s${words ? ` · ${words.angle} · ${words.side}` : ""}`);
        return { content: [text({ key, keys: this.keys.length })] };
      }
      case "stage_camera_move": {
        this.guard("camera");
        const move = z.enum(STAGE_CAMERA_MOVES.map((entry) => entry.id) as [StageCameraMove, ...StageCameraMove[]]).parse(args["move"]);
        const subject = args["subject"] === undefined ? undefined : String(args["subject"]);
        if (this.cast.length === 0) throw new Error("A move is about a figure; add one first.");
        const at = typeof args["at"] === "number" ? Math.max(0, Math.min(duration, args["at"])) : 0;
        this.keys = stageCameraMove(move, this.resolved(), { durationSec: duration, at, ...(subject === undefined ? {} : { subjectId: subject }), ...(lens === undefined ? {} : { lens }), aspect });
        this.landed(STAGE_CAMERA_MOVES.find((entry) => entry.id === move)!.label, subject === undefined ? undefined : `on ${this.nameOf(subject)}`);
        return { content: [text({ keys: this.keys })] };
      }
      case "stage_settings": {
        const changed: string[] = [];
        if (args["rig"] !== undefined || args["seed"] !== undefined || args["rigIntensity"] !== undefined) this.guard("camera");
        if (args["rig"] !== undefined) { this.rig = StageRigSchema.parse(args["rig"]); changed.push(`rig ${this.rig}`); }
        if (args["seed"] !== undefined) { this.seed = z.number().int().min(0).parse(args["seed"]); changed.push("seed"); }
        if (args["rigIntensity"] !== undefined) { this.rigIntensity = z.number().min(0).max(2).parse(args["rigIntensity"]); changed.push("intensity"); }
        if (args["atmosphere"] !== undefined) { this.atmosphere = SceneAtmosphereSchema.parse(args["atmosphere"]); changed.push("atmosphere"); }
        if (args["plateCamera"] !== undefined) { this.plateCamera = StageConstructionDraftSchema.shape.plateCamera.parse(args["plateCamera"]); changed.push("plate camera"); }
        if (changed.length === 0) throw new Error("Name a setting to change.");
        this.landed(changed.join(" · "));
        return { content: [text(`Set ${changed.join(", ")}.`)] };
      }
      case "stage_render": {
        if (this.renders >= STAGE_RENDER_BUDGET) throw new Error(`The build has used its ${STAGE_RENDER_BUDGET} renders. Check, then finish.`);
        const times = z.array(z.number()).max(3).optional().parse(args["at"])?.filter((t) => t >= 0 && t <= duration) ?? [];
        const now = this.draft({ sampleTimes: times });
        if ("problem" in now) throw new Error(`The draft cannot be drawn yet: ${now.problem}`);
        this.renders += 1;
        const frames = await this.hooks.render(now.draft, times);
        this.framesSeen += frames.length;
        this.inspected.push(...frames.map((entry) => entry.name));
        this.landed(`render · ${times.length > 0 ? times.map((t) => `${t.toFixed(1)} s`).join(", ") : "opening and end"}`, `${frames.length} views`);
        return {
          content: [
            text({
              frames: frames.map(({ name: file, frame }) => ({ image: file, at: frame.at, view: frame.view, observations: frame.observations ?? [] })),
              rendersLeft: STAGE_RENDER_BUDGET - this.renders,
              note: "The images follow, in this order. If they do not reach you, read each one by its image name with your read tool.",
            }),
            ...frames.map(({ frame }) => ({ type: "image" as const, data: frame.png, mimeType: "image/png" as const })),
          ],
        };
      }
      case "stage_measure": {
        const at = typeof args["at"] === "number" ? Math.max(0, Math.min(duration, args["at"])) : 0;
        const a = this.positionOf(String(args["a"] ?? ""), at);
        const b = this.positionOf(String(args["b"] ?? ""), at);
        const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
        const result = {
          at,
          a: a.map(round2), b: b.map(round2),
          distance: round2(Math.hypot(dx, dy, dz)),
          ground: round2(Math.hypot(dx, dz)),
          rise: round2(dy),
          bearing: Math.round(((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360),
        };
        this.landed(`measure ${args["a"]} → ${args["b"]}`, `${result.distance.toFixed(2)} m`);
        return { content: [text(result)] };
      }
      case "stage_check": {
        const findings = this.findings();
        const count = findings.problems.length + findings.screenDirection.length + findings.standoff.length + findings.motion.length + findings.speed.length + findings.turns.length;
        this.landed("check", count === 0 ? "180° · standoff · speed · clear" : `${count} ${count === 1 ? "finding" : "findings"}`);
        return { content: [text(findings)] };
      }
      case "stage_done": {
        const assessment = z.string().min(1).max(4000).parse(args["assessment"]);
        const assumptions = z.array(z.string().max(1000)).max(20).optional().parse(args["assumptions"]) ?? [];
        if (this.renders === 0) throw new Error("Render the shot at least once and look before you finish.");
        const sources = this.hooks.sourcesRead();
        if (!sources.read) throw new Error(`Read the source images with your read tool first: ${sources.missing.join(", ")}.`);
        const { problems } = this.findings();
        if (problems.length > 0) throw new Error(`Resolve these first: ${problems.join(" ")}`);
        const now = this.draft();
        if ("problem" in now) throw new Error(now.problem);
        this.finish = { assessment, assumptions };
        this.landed("done", `${this.renders} ${this.renders === 1 ? "render" : "renders"}`);
        this.settle();
        return { content: [text("Done. The draft goes to the person for review.")] };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  /** Where a named thing is at a time: a figure's centre, a set's or light's middle, or the camera. */
  private positionOf(name: string, at: number): [number, number, number] {
    const duration = this.context.durationSec;
    if (name === "camera") return sampleStageCamera(this.resolved(), at, duration).p as [number, number, number];
    const figure = this.cast.find((candidate) => candidate.sheetId === name);
    if (figure !== undefined) {
      const state = stageFigureAt(figure, this.performances, at, duration, this.objectMotions);
      return [state.x, state.y + ((figure.height ?? 1.8) * 0.5), state.z];
    }
    const set = this.sets.find((candidate) => candidate.name === name);
    if (set !== undefined) return [set.x, (set.y ?? 0) + set.h / 2, set.z];
    const light = this.lights.find((candidate) => candidate.name === name);
    if (light !== undefined) return [light.x, light.y, light.z];
    throw new Error(`Nothing called ${name} is on the stage; name a figure's sheetId, a set, a light or camera.`);
  }

  /** The draft's findings: problems block finishing, the rest are for judgement. */
  findings() {
    const duration = this.context.durationSec;
    const staging = this.resolved();
    const problems = stageProblems(staging, duration);
    if (this.cast.some((figure) => !this.context.sheets.some((sheet) => sheet.id === figure.sheetId))) problems.push("A figure names a sheet this shot does not have.");
    const now = this.draft();
    if ("problem" in now) problems.push(now.problem);
    return {
      problems,
      screenDirection: stageLineCrossings(this.context.scene, this.context.aspect, { shotId: this.context.shotId, staging })
        .filter((finding) => finding.shotIds.includes(this.context.shotId)).map((finding) => finding.message).slice(0, 8),
      standoff: stageCameraStandoffWarnings(staging, duration).slice(0, 8),
      motion: stageCameraMotionWarnings(staging, duration).slice(0, 8),
      speed: stageSpeedWarnings(staging, this.nameOf, duration).slice(0, 8),
      turns: stageTurnWarnings(staging, this.nameOf).slice(0, 8),
    };
  }
}
