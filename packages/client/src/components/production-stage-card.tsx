import type { ConversationActionCard } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { TakeMediaFigure } from "./take-comparison-card.js";

/** Only the immutable artifact named by this completion can play outside its review details. */
export function StagePlayblastReceipt({ action }: { action: ConversationActionCard }) {
  const world = useStore().state?.world;
  if (world?.meta.worldId !== action.worldId || action.status !== "completed" || action.receipt?.kind !== "stage-playblast") return null;
  const shotId = action.targets.find(target => target.kind === "shot")?.id;
  const artifact = world.artifacts.find(a => a.id === action.receipt?.id && a.kind === "video" && a.production === action.productionId &&
    a.origin.by === "system" && a.origin.producedBy === `stage:${shotId}`);
  if (!artifact) return null;
  return <div className="fy-generation-card__grid" aria-label="Completed Stage playblast"><TakeMediaFigure world={world} id={artifact.id}
    label="Stage playblast" fallback={{ kind: "video", path: `artifacts/${artifact.file}` }} /></div>;
}
