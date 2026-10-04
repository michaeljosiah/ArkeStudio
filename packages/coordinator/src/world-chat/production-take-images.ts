import { z } from "zod";
import { extname } from "node:path";
import { SlugSchema, TakeIdSchema, type ProductionBundle, type Take, type WorldBundle } from "@arke-studio/contracts";
import { RetrievalError } from "./retrieval.js";

export const ProductionTakeImageArgsSchema = z.object({
  kind: z.literal("production-take"), productionId: SlugSchema, takeId: TakeIdSchema,
  frame: z.enum(["poster", "start-frame"]),
}).strict();
export type ProductionTakeImageArgs = z.infer<typeof ProductionTakeImageArgsSchema>;
const imageFile = (file: string) => [".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extname(file).toLowerCase());

/** Copyable reads name an immutable take, never today's mutable shot selection. */
export function productionTakeImageSources(production: ProductionBundle, take: Take) {
  const args = (frame: ProductionTakeImageArgs["frame"]): ProductionTakeImageArgs =>
    ({ kind: "production-take", productionId: production.meta.id, takeId: take.id, frame });
  return {
    ...(take.kind !== "voice" && (take.media || take.segment) ? { poster: args("poster") } : {}),
    ...(take.kind !== "voice" && take.startFrame ? { startFrame: args("start-frame") } : {}),
  };
}

export function productionTakeImageSource(bundle: WorldBundle, args: ProductionTakeImageArgs) {
  const production = bundle.productions.find(p => p.meta.id === args.productionId);
  const take = production?.takes.find(t => t.id === args.takeId);
  if (!production || !take || take.kind === "voice") {
    throw new RetrievalError("unavailable", "view_image: that production image take is unavailable.");
  }
  const identity = `production:${production.meta.id}:${take.id}:${args.frame}`;
  if (args.frame === "start-frame") {
    if (!take.startFrame || !imageFile(take.startFrame) || /^\.conversations(?:[\\/]|$)/i.test(take.startFrame)) {
      throw new RetrievalError("unavailable", "view_image: this take has no available frozen start frame. Never substitute the shot's current selection.");
    }
    const artifact = bundle.artifacts.find(a => `artifacts/${a.file}` === take.startFrame && ["image", "board"].includes(a.kind));
    return { path: take.startFrame, id: identity, label: `Start frame for ${take.id}`, video: false,
      expected: artifact?.hash, atSec: 0 };
  }
  const source = take.media ? take : take.segment ? production.takes.find(t => t.id === take.segment!.passTakeId) : undefined;
  // Imported take records are not permission to read another folder through a media filename.
  if (!source?.media || /[\\/:]/.test(source.media) || source.media.includes("\0") || [".", ".."].includes(source.media) || source.kind === "voice" ||
    (take.kind !== "clip" && !imageFile(source.media))) {
    throw new RetrievalError("unavailable", "view_image: this take's visual media is unavailable.");
  }
  const atSec = take.segment && !take.media ? take.segment.inSec : 0;
  if (take.segment && !take.media && (take.kind !== "clip" || source.kind !== "clip" || take.segment.outSec <= atSec)) {
    throw new RetrievalError("unavailable", "view_image: this take's pass segment is unavailable.");
  }
  return { path: `productions/${production.meta.id}/takes/${source.id}/${source.media}`,
    id: `${identity}:${source.id}:${atSec}`, label: take.kind === "clip" ? `Poster for ${take.id} at ${atSec}s` : `Image take ${take.id}`,
    video: take.kind === "clip", expected: take.panel?.hash ?? production.takeMediaInfo[source.id]?.sourceHash, atSec };
}
