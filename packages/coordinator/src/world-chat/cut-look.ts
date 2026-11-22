import {
  orderedShots,
  productionShape,
  type ModelWorldChatAction,
  type WorldBundle,
  type WorldChatCheckReceipt,
} from "@arke-studio/contracts";

/**
 * Look before changing a shot beside a take (design turn 286, layer 3: a check, not a sentence).
 *
 * The brief and the continuity skill both say it, and on the installed app Arke still planned a
 * shot beside a take from the shots' words, asking the person which wrist the bangles were on when
 * the take showed it. In a long thread it trusted what it had said turns earlier instead of
 * looking again, so a wrong reading (a moving shot called a still) outlived the turn it was made
 * in. Prose it can skim; this it cannot. A turn that prepares a change to the picture of a shot
 * that has a take, or stands beside one, must have read the continuity skill and sampled frames
 * in that same turn. Otherwise the one corrective turn asks it to, with its tools, before the card
 * reaches the person.
 *
 * What counts as looking is deliberately coarse: any completed `sample_video` this run. Which
 * frames were the right ones is the skill's job and the model's judgement; the check only makes
 * sure the judgement was made from pictures.
 */

/** Fields whose change alters what a shot looks like at its cuts. Its title, notes and beats do not. */
const PICTURE_FIELDS: ReadonlySet<string> = new Set([
  "description", "camera", "framing", "propStates", "looks", "continuity", "durationSec", "visualFacts", "promptOverride",
]);

type SceneCommandAction = Extract<ModelWorldChatAction, { kind: "production-scene-command" }>;
type SceneCommand = NonNullable<SceneCommandAction["command"]>;

export const CUT_LOOK_SKILL = "continuity-across-cuts";

export function cutLookProblem(
  bundle: WorldBundle,
  actions: readonly ModelWorldChatAction[],
  receipts: readonly WorldChatCheckReceipt[],
): string | null {
  const read = receipts.some((r) => r.tool === "read-skill" && r.status === "complete" && (r.querySummary ?? "").startsWith(CUT_LOOK_SKILL));
  const looked = receipts.some((r) => r.tool === "sample-video" && r.status === "complete");
  if (read && looked) return null;

  for (const action of actions) {
    if (action.kind !== "production-scene-command") continue;
    const production = bundle.productions.find((p) => p.meta.id === action.productionId);
    if (!production || productionShape(production.meta).medium !== "video") continue;
    const scene = production.scenes.find((s) => s.id === action.sceneId);
    if (!scene) continue;
    const shots = orderedShots(scene);
    const taken = (i: number) => i >= 0 && i < shots.length && !!production.selections[shots[i]!.id]?.acceptedTakeId;
    const besideTake = (shotId: string) => {
      const i = shots.findIndex((shot) => shot.id === shotId);
      return i >= 0 && (taken(i) || taken(i - 1) || taken(i + 1)) ? shots[i]! : null;
    };
    const commands = [action.command, ...(action.commands ?? [])].filter((c): c is SceneCommand => c !== undefined);
    for (const command of commands) {
      const shot = touchedBesideTake(command, besideTake);
      if (!shot) continue;
      const missing = [!read && `call read_skill for ${CUT_LOOK_SKILL}`, !looked && "look with sample_video at the frames either side of its cuts (the accepted takes, or the latest export)"]
        .filter(Boolean).join(" and ");
      return `Shot ${shot.number} has a take or stands beside one. Before changing its picture, ${missing}, then prepare the change from what you saw. Do not rely on an earlier turn's look: takes and frames change.`;
    }
  }
  return null;
}

function touchedBesideTake(command: SceneCommand, besideTake: (shotId: string) => { number: number } | null) {
  switch (command.kind) {
    case "edit-shot":
      return Object.keys(command.change).some((key) => PICTURE_FIELDS.has(key)) ? besideTake(command.shotId) : null;
    case "set-prompt-override":
    case "edit-stage":
      return besideTake(command.shotId);
    case "insert-shot":
      return "before" in command.at ? besideTake(command.at.before) : "after" in command.at ? besideTake(command.at.after) : null;
    default:
      return null;
  }
}
