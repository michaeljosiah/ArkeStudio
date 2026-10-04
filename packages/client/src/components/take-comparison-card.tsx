import type { ConversationActionCard, WorldBundle, ProductionBundle } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { takeMediaView } from "../lib/take-presentation.js";
import { mediaUrl } from "../lib/media.js";
import { PosterVideo } from "./player.js";

export function TakeMediaFigure({ world, production, id, label, fallback }: { world: WorldBundle; production?: ProductionBundle;
  id: string | null; label: string; fallback?: { path?: string; kind: string; poster?: string } }) {
  const take = production?.takes.find(t => t.id === id);
  const artifact = world.artifacts.find(a => a.id === id && a.kind === "image");
  const view = production && take ? takeMediaView(production, take) : null;
  const path = view?.sourcePath ?? (artifact ? `artifacts/${artifact.file}` : fallback?.path);
  const kind = view ? take?.kind === "voice" ? "audio" : view.isVideo ? "video" : "image" : artifact ? "image" : fallback?.kind;
  const poster = view?.posterPath ?? fallback?.poster;
  return <figure>
    {path ? kind === "video" ? <PosterVideo src={mediaUrl(world.meta.slug, path)} label={`${label} ${id}`} {...(poster ? { poster: mediaUrl(world.meta.slug, poster) } : {})} {...(take?.segment ? { range: take.segment } : {})} />
      : kind === "audio" ? <audio controls preload="metadata" src={mediaUrl(world.meta.slug, path)} />
      : kind === "image" ? <img src={mediaUrl(world.meta.slug, path)} alt={label} />
      : <a href={mediaUrl(world.meta.slug, path)}>Open document</a> : <p>{id ? "Media unavailable" : "None"}</p>}
    <figcaption>{label}{take ? ` · ${take.model}` : ""}{take?.segment ? ` · ${take.segment.inSec}–${take.segment.outSec}s` : ""}</figcaption>
  </figure>;
}

/** Candidate and frozen current selection share the take screen's media resolver. */
export function TakeComparisonCard({ action }: { action: ConversationActionCard }) {
  const world = useStore().state?.world;
  const body = action.shown.body;
  if (body.family !== "take-review" || world?.meta.worldId !== action.worldId) return null;
  const production = world.productions.find(p => p.meta.id === action.productionId);
  const cells = [{ id: body.currentSelection, label: "Current selection" }, { id: body.mediaId, label: "Candidate" }];
  return <div className="fy-generation-card__grid" aria-label="Take comparison">{cells.map(({ id, label }) => <TakeMediaFigure key={label} world={world} {...(production ? { production } : {})} id={id} label={label}
    {...(label === "Candidate" ? { fallback: { path: body.mediaPath, kind: body.mediaKind, poster: body.posterPath } } : {})} />)}</div>;
}
