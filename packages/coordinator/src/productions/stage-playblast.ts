import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { editShot, orderedShots, ulid, type ArtifactSidecar, type ShotStaging } from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { parseSceneRecord } from "./scene-record.js";
import { stemOrThrow } from "./scene-commands.js";

/**
 * Filing a playblast from the Stage (SPEC-036 R-34).
 *
 * The bytes land on the shelf and the pin lands on the staging in ONE commit, under one gate, or
 * neither does. Filed first and pinned after, a scene write landing between the two left a
 * playblast on the shelf that nothing pointed at, and each narrowing of that window (fence before
 * copying, re-fence after) still left a window (Codex rounds 1–3). The scene and the sidecar are
 * two files in the same commit here, so there is no "between".
 */
export interface PlayblastFiling {
  productionId: string;
  sceneFile: string;
  sceneId: string;
  baseVersion: number;
  shotId: string;
  stagingVersion: number;
  sourcePath: string;
  durationSec: number;
  aspect: string;
  lens?: string;
}

export type PlayblastOutcome =
  | { outcome: "filed"; artifact: ArtifactSidecar }
  | { outcome: "refused"; reason: string };

const refused = (reason: string): PlayblastOutcome => ({ outcome: "refused", reason });

export async function filePlayblast(store: WorldStore, input: PlayblastFiling): Promise<PlayblastOutcome> {
  const stem = stemOrThrow(input.sceneFile);
  const path = `productions/${input.productionId}/scenes/${stem}.json`;
  const absolute = toExtendedLength(join(store.dir, fromPortable(path)));
  return store.gateOp<PlayblastOutcome>(async () => {
    const raw = await readFile(absolute, "utf8").catch(() => null);
    if (raw === null) return refused("the scene is no longer on disk");
    const record = parseSceneRecord(raw);
    if (record.id !== input.sceneId) return refused("the scene was replaced while the playblast rendered — export it again");
    const shot = orderedShots(record).find((candidate) => candidate.id === input.shotId);
    // Refused by name, and before any byte is copied: a playblast with no staging to pin onto
    // would be an orphan on the shelf.
    if (shot?.staging === undefined) return refused("stage the shot before filing a playblast for it");
    if (shot.staging.version !== input.stagingVersion) {
      return refused(`the staging moved to v${shot.staging.version} while the playblast rendered — export it again`);
    }
    if (record.version !== input.baseVersion) {
      return refused(`the scene moved to v${record.version} while the playblast rendered — export it again`);
    }
    const bytes = await readFile(input.sourcePath).catch(() => null);
    if (bytes === null) return refused(`${input.sourcePath} is not readable`);

    const id = `ar_${ulid()}`;
    const file = `playblast-${input.shotId}-${id.slice(-8).toLowerCase()}.webm`;
    const artifact: ArtifactSidecar = {
      id,
      kind: "video",
      file,
      hash: `sha256:${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}` as ArtifactSidecar["hash"],
      origin: { by: "system", producedBy: `stage:${input.shotId}` },
      links: [input.productionId, input.sceneId, input.shotId],
      production: input.productionId as ArtifactSidecar["production"],
      created: store.now(),
    };
    const staging: ShotStaging = {
      ...shot.staging,
      playblast: {
        artifactId: id,
        version: input.stagingVersion,
        durationSec: input.durationSec,
        aspect: input.aspect,
        ...(input.lens !== undefined ? { lens: input.lens } : {}),
      },
    };
    const next = editShot(record, { shotId: input.shotId, change: { staging } });
    await atomicWriteFile(join(store.dir, "artifacts", file), bytes);
    await store.commitUnserialised({
      kind: "scene-command",
      source: "stage-playblast",
      files: [
        { path, action: "replace", content: `${JSON.stringify(next, null, 2)}\n`, baseHash: sha256(raw) },
        { path: `artifacts/${file}.json`, action: "create", content: `${JSON.stringify(artifact, null, 2)}\n`, baseHash: null },
      ],
    });
    return { outcome: "filed", artifact };
  });
}
