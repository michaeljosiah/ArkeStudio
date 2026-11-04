import { extname } from "node:path";
import type { WorldChatReferenceWorldImageResultUseAction } from "@arke-studio/contracts";
import { readBenchSession, benchTakeMediaPath } from "../bench/chat-reads.js";
import { sessionMediaDir } from "../bench/store.js";
import { readContainedMediaBytes } from "../world/reference-files.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { KEY_ART_EXTENSIONS } from "../references/world-image.js";

export type BenchImageSource = NonNullable<WorldChatReferenceWorldImageResultUseAction["action"]["benchTake"]>;

/** The immutable take supplies both identity and expected bytes; a path from a model never does. */
export async function benchImageResult(store: WorldStore, source: BenchImageSource) {
  const take = readBenchSession(store.dir, source.sessionId)?.takes.find(take => take.id === source.takeId);
  if (!take?.media || take.status !== "succeeded" || take.disposition === "discarded" || take.request.mode !== "image") throw new Error("That Bench image is no longer available.");
  benchTakeMediaPath(store.dir, source.sessionId, take);
  const extension = extname(take.media.file).toLowerCase();
  if (!(KEY_ART_EXTENSIONS as readonly string[]).includes(extension)) throw new Error("That image format cannot be used here.");
  const mediaPath = `${sessionMediaDir(source.sessionId, take.id)}/${take.media.file}`;
  const bytes = await readContainedMediaBytes(store.dir, mediaPath, store.closingSignal);
  if (sha256(bytes).slice(0, take.media.hash.length) !== take.media.hash) throw new Error("That Bench image changed after generation.");
  return { bytes, extension, mediaPath };
}

