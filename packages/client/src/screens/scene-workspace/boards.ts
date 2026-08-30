import {
  DEFAULT_SHOT_SEC,
  hasOwnFrame,
  orderedShots,
  packBoards,
  packShotsFor,
  resolveCast,
  type ArtifactSidecar,
  type PackedBoard,
  type ProductionBundle,
  type SceneRecord,
  type Sheet,
} from "@arke-studio/contracts";

export function shotHasFrame(
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
  shotId: string,
  stagedShotIds: ReadonlySet<string> = new Set(),
): boolean {
  if (stagedShotIds.has(shotId)) return false;
  if (hasOwnFrame(production.selections[shotId], artifacts)) return true;
  const accepted = production.selections[shotId]?.acceptedTakeId;
  const take = accepted === undefined ? undefined : production.takes.find((candidate) => candidate.id === accepted);
  return take?.kind === "frame" || take?.kind === "still";
}

export type WorkspaceBoardPack = { ok: true; boards: PackedBoard[] } | { ok: false; reason: string };

export function boardsForScene(input: {
  scene: SceneRecord;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  sheets: readonly Sheet[];
  capSec: number;
  panelCap?: number;
  stagedShotIds?: ReadonlySet<string>;
}): WorkspaceBoardPack {
  const shots = orderedShots(input.scene);
  const packed = packBoards(
    packShotsFor({
      scene: input.scene,
      shots,
      selections: Object.fromEntries(
        Object.entries(input.production.selections).filter(([shotId]) => !input.stagedShotIds?.has(shotId)),
      ),
      takes: input.production.takes,
      castOf: (shot) =>
        resolveCast(shot.description, [...input.sheets]).cast
          .filter((entry) => entry.sheet.type === "character")
          .map((entry) => entry.sheet.id),
      defaultDurationSec: DEFAULT_SHOT_SEC,
    }),
    input.capSec,
    new Set(input.scene.boards?.splits ?? []),
    new Set(input.scene.boards?.merges ?? []),
    (shotId) => shotHasFrame(input.production, input.artifacts, shotId, input.stagedShotIds),
    input.panelCap,
  );
  return packed.ok
    ? packed
    : {
        ok: false,
        reason: `Shot ${packed.oversizeShot.number} is ${packed.oversizeShot.durationSec}s, over the ${packed.oversizeShot.capSec}s clip limit.`,
      };
}
