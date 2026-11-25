import { BEFORE_SHOT_NAMES, beforeShotChecks, hasOwnFrame, orderedShots, type BeforeShotCheckId, type WorldBundle } from "@arke-studio/contracts";

/** A still only needs its people cited and its light named: the rest is a clip's. */
const IMAGE_ITEMS: ReadonlySet<BeforeShotCheckId> = new Set(["named", "light"]);

/**
 * The before-the-shot checks (design turns 287 and 288b) a generation card carries, a line a shot
 * with something to fix: the person approving paid work reads what is wrong with the shot before
 * money moves, as the bench shows it beside its press. Nothing here holds the card; it says.
 */
export function beforeShotNotes(bundle: WorldBundle, productionId: string, sceneId: string, shotIds: readonly string[], mode: "image" | "video"): string[] {
  const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
  const scene = production?.scenes.find((candidate) => candidate.id === sceneId);
  if (!production || !scene) return [];
  let shots;
  try { shots = orderedShots(scene); } catch { return []; }
  const characters = bundle.sheets.filter((sheet) => sheet.type === "character")
    .map((sheet) => ({ id: sheet.id, name: sheet.name, ...(sheet.aliases ? { aliases: sheet.aliases } : {}) }));
  return shotIds.flatMap((shotId) => {
    const index = shots.findIndex((candidate) => candidate.id === shotId), shot = shots[index];
    if (!shot) return [];
    const selection = production.selections[shot.id];
    const accepted = selection?.acceptedTakeId ? production.takes.find((take) => take.id === selection.acceptedTakeId) : undefined;
    const fixes = beforeShotChecks({
      scene, shot, look: production.meta.look,
      clipsFrom: shot.continuity?.clipsFrom ?? production.meta.clipsFrom ?? "frames",
      hasFrame: hasOwnFrame(selection, bundle.artifacts) || accepted?.kind === "frame" || accepted?.kind === "still",
      characters, board: null,
    }).filter((item) => item.result === "fix" && (mode === "video" || IMAGE_ITEMS.has(item.id)));
    return fixes.length === 0 ? [] : [`Shot ${index + 1} before it is made: ${fixes.map((item) => `${BEFORE_SHOT_NAMES[item.id].toLowerCase()} ${item.says}`).join("; ")}.`];
  });
}
