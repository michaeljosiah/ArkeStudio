import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  MediaInfoSchema,
  STAGE_CAMERA_EVALUATOR_VERSION,
  STAGE_FRAME_RATE,
  productionAspect,
  stageBoardAnimaticIsStale,
  stageBoardCuts,
  stageBoardFingerprintInput,
  stageBoardStagings,
  stageFrameCount,
  ulid,
  type ArtifactSidecar,
  type SceneRecord,
  type WorldBundle,
} from "@arke-studio/contracts";
import type { MediaProbe } from "../media/probe.js";
import { atomicWriteFile } from "../world/atomic.js";
import { imageFormatOf, verifyArtifact } from "../queue/verify.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { parseSceneRecord } from "./scene-record.js";
import { stemOrThrow } from "./scene-commands.js";

/**
 * Filing a board's cut animatic (issue 1824, design turn 228g). Like a playblast (SPEC-036 R-35):
 * the bytes and the pin land in one commit under one gate, or neither does; the pin sits on the
 * scene's boards keyed by the exact member set, as a board prompt is; and it records each member's
 * staging, so a moved shot reads as stale and the animatic stops riding.
 */
export interface AnimaticFiling {
  productionId: string;
  sceneFile: string;
  sceneId: string;
  baseVersion: number;
  members: string[];
  /** Each member's staging as the recording saw it. */
  stagings: Array<{ shotId: string; version: number; durationSec: number; lens: string }>;
  durationSec: number;
  aspect: string;
  look?: "greybox" | "lit" | "plate";
  sourcePath: string;
  openingFrameSourcePath: string;
}

export type AnimaticOutcome =
  | { outcome: "filed"; artifacts: [ArtifactSidecar, ArtifactSidecar] }
  | { outcome: "refused"; reason: string };
const refused = (reason: string): AnimaticOutcome => ({ outcome: "refused", reason });

export function stageBoardFingerprint(scene: SceneRecord, members: readonly string[], aspect: string): string {
  return createHash("sha256").update(stageBoardFingerprintInput(scene, members, aspect)).digest("hex");
}

export async function fileBoardAnimatic(
  store: WorldStore,
  input: AnimaticFiling,
  options: { source?: string; requestId?: string; mediaProbe?: MediaProbe } = {},
): Promise<AnimaticOutcome> {
  const stem = stemOrThrow(input.sceneFile);
  const path = `productions/${input.productionId}/scenes/${stem}.json`;
  const absolute = toExtendedLength(join(store.dir, fromPortable(path)));
  return store.gateOp<AnimaticOutcome>(async () => {
    const raw = await readFile(absolute, "utf8").catch(() => null);
    if (raw === null) return refused("the scene is no longer on disk");
    const record = parseSceneRecord(raw);
    if (record.id !== input.sceneId) return refused("the scene was replaced while the animatic rendered — export it again");
    if (record.version !== input.baseVersion) return refused(`the scene moved to v${record.version} while the animatic rendered — export it again`);
    const stagings = stageBoardStagings(record, input.members);
    if (stagings === null) return refused("stage every shot of the board before filing its animatic");
    if (JSON.stringify(stagings) !== JSON.stringify(input.stagings)) return refused("a shot of the board moved while the animatic rendered — export it again");
    const production = store.getBundle().productions.find((candidate) => candidate.meta.id === input.productionId);
    const cuts = stageBoardCuts(record, input.members);
    const total = cuts.at(-1)?.to ?? 0;
    if (!production || input.aspect !== productionAspect(production.meta) || Math.abs(input.durationSec - total) > 1e-6) {
      return refused("the board's timing or aspect changed — export it again");
    }
    // A board records each cut to whole frames, so its length is the sum of its members' frame counts.
    const frames = cuts.reduce((sum, cut) => sum + stageFrameCount(cut.to - cut.from), 0);
    const measured = await options.mediaProbe?.info?.(input.sourcePath).catch(() => null);
    const media = MediaInfoSchema.safeParse(measured);
    if (!media.success || Math.abs(media.data.durationSec - frames / STAGE_FRAME_RATE) > 0.02) return refused("the animatic duration could not be verified — export it again");
    const [wide, high] = input.aspect.split(":").map(Number);
    if (!media.data.width || !media.data.height || media.data.frameRate !== STAGE_FRAME_RATE || Math.abs(media.data.width / media.data.height - wide! / high!) > 0.003) {
      return refused("the encoded animatic dimensions or frame rate do not match the board");
    }
    const [bytes, opening] = await Promise.all([readFile(input.sourcePath).catch(() => null), readFile(input.openingFrameSourcePath).catch(() => null)]);
    if (bytes === null || bytes.byteLength === 0) return refused("the recording came back empty — export it again");
    if (opening === null) return refused("the opening frame is not readable");
    const videoProblem = verifyArtifact({ name: "animatic.mp4", contentType: "video/mp4", data: bytes });
    if (videoProblem !== null) return refused(`the animatic is not a valid MP4: ${videoProblem}`);
    if (imageFormatOf(opening)?.extension !== ".png" || opening.length < 24 || opening.readUInt32BE(16) !== media.data.width || opening.readUInt32BE(20) !== media.data.height) {
      return refused("the opening frame is not a valid PNG — export it again");
    }
    const make = (kind: "image" | "video", prefix: string, data: Buffer): ArtifactSidecar => {
      const id = `ar_${ulid()}`;
      return {
        id, kind,
        ...(kind === "video" ? { mediaInfo: media.data } : {}),
        file: `${prefix}-${input.members[0]}-${id.slice(-8).toLowerCase()}.${kind === "video" ? "mp4" : "png"}`,
        hash: `sha256:${createHash("sha256").update(data).digest("hex").slice(0, 16)}` as ArtifactSidecar["hash"],
        origin: { by: "system", producedBy: `stage-board:${input.members.join(",")}` },
        links: [input.productionId, input.sceneId, ...input.members],
        production: input.productionId as ArtifactSidecar["production"],
        created: store.now(),
      };
    };
    const video = make("video", "animatic", bytes);
    const still = make("image", "animatic-opening", opening);
    const boards = record.boards ?? { splits: [], merges: [] };
    const same = (members: readonly string[]) => members.length === input.members.length && members.every((id, index) => id === input.members[index]);
    const pin = {
      members: [...input.members],
      artifactId: video.id,
      openingFrameArtifactId: still.id,
      sourceFingerprint: stageBoardFingerprint(record, input.members, input.aspect),
      stagings,
      evaluatorVersion: STAGE_CAMERA_EVALUATOR_VERSION,
      durationSec: input.durationSec,
      aspect: input.aspect,
      ...(input.look === undefined || input.look === "greybox" ? {} : { look: input.look }),
    };
    const next: SceneRecord = { ...record, boards: { ...boards, animatics: [...(boards.animatics ?? []).filter((candidate) => !same(candidate.members)), pin] } };
    await Promise.all([atomicWriteFile(join(store.dir, "artifacts", video.file), bytes), atomicWriteFile(join(store.dir, "artifacts", still.file), opening)]);
    await store.commitUnserialised({
      kind: "scene-command",
      source: options.source ?? "stage-animatic",
      files: [
        { path, action: "replace", content: `${JSON.stringify(next, null, 2)}\n`, baseHash: sha256(raw) },
        ...[video, still].map((item) => ({ path: `artifacts/${item.file}.json`, action: "create" as const, content: `${JSON.stringify(item, null, 2)}\n`, baseHash: null })),
      ],
      ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    });
    return { outcome: "filed", artifacts: [video, still] };
  });
}

/** A board animatic's stills and video are withheld once their board has moved on. */
export function stageBoardArtifactProblem(bundle: WorldBundle, artifact: ArtifactSidecar): string | null {
  if (artifact.origin.by !== "system" || !artifact.origin.producedBy.startsWith("stage-board:")) return null;
  const production = bundle.productions.find((candidate) => candidate.meta.id === artifact.production);
  for (const scene of production?.scenes ?? []) {
    const pin = scene.boards?.animatics?.find((candidate) => candidate.artifactId === artifact.id || candidate.openingFrameArtifactId === artifact.id);
    if (pin === undefined) continue;
    const stale = stageBoardAnimaticIsStale(scene, pin, productionAspect(production!.meta)) || pin.sourceFingerprint !== stageBoardFingerprint(scene, pin.members, productionAspect(production!.meta));
    return stale ? "The board's animatic is stale. Export the current board and rebuild this session." : null;
  }
  return "The board's animatic is no longer pinned. Export it again.";
}
