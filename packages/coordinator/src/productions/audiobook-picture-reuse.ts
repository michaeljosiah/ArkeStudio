import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { PICTURE_TEXT_DIRECTION, PICTURE_PROMPT_MAX, type ArtifactBenchGeneration, type BenchReferenceToken, type PictureReuse } from "@arke-studio/contracts";
import { BenchStore, sessionDir } from "../bench/store.js";
import { openBenchSession, type OpenedBench } from "../bench/service.js";
import type { WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";
import { containedWorldFile } from "./interactive.js";

export interface SavedPicture {
  generation: ArtifactBenchGeneration & { params: Extract<ArtifactBenchGeneration["params"], { kind: "image" }> };
  references: BenchReferenceToken[];
  keyframes: BenchReferenceToken[];
  brief: string;
  /** Full hashes for the existing dispatcher guard, in resolved world-file identity. */
  pins: Array<{ file: string; hash: string }>;
}

/** Read only the saved authority and contained bytes; never turn an artifact filename into a person. */
export async function savedPicture(store: WorldStore, source: PictureReuse, prompt: string): Promise<SavedPicture> {
  const artifact = store.getBundle().artifacts.find(candidate => candidate.id === source.artifactId);
  const generation = artifact?.generation;
  if (!artifact || artifact.hash !== source.hash || generation?.source !== "bench" || generation.params.kind !== "image") throw new Error("The saved picture provenance is unavailable. Choose the picture again.");
  const verify = async (file: string, expected: string, label: string) => {
    const path = await containedWorldFile(store.dir, file);
    if (!path) throw new Error(`${label} is no longer in this world. Choose its reference again in Bench.`);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(toExtendedLength(path))) {
      if (store.closingSignal.aborted) throw new Error("stopped");
      hash.update(chunk);
    }
    const digest = hash.digest("hex");
    if (!`sha256:${digest}`.startsWith(expected)) throw new Error(`${label} changed since this picture. Choose its reference again in Bench.`);
    return digest;
  };
  await verify(`artifacts/${artifact.file}`, artifact.hash, "The saved picture");
  const pins: SavedPicture["pins"] = [];
  const resolve = async (entry: BenchReferenceToken): Promise<BenchReferenceToken> => {
    let file: string;
    const source = entry.source;
    if (source.source === "world-file") file = source.path;
    else if (source.source === "artifact") {
      const ref = store.getBundle().artifacts.find(candidate => candidate.id === source.artifactId);
      if (!ref) throw new Error(`${entry.token} is no longer in this world. Choose its reference again in Bench.`);
      file = `artifacts/${ref.file}`;
    } else {
      const session = await new BenchStore(sessionDir(store.dir, generation.sessionId)).fold();
      const take = session?.takes.find(candidate => candidate.id === source.takeId);
      if (!take?.media) throw new Error(`${entry.token} is no longer in this world. Choose its reference again in Bench.`);
      file = `.sessions/${generation.sessionId}/media/${take.id}/${take.media.file}`;
    }
    const digest = await verify(file, entry.source.hash, entry.token);
    if (entry.kind === "image") pins.push({ file, hash: digest });
    // A take is scoped to its old session. Its immutable path carries those same bytes in the new one.
    return entry.source.source === "take" ? { ...entry, source: { source: "world-file", path: file, hash: entry.source.hash } } : entry;
  };
  const references: BenchReferenceToken[] = [], keyframes: BenchReferenceToken[] = [];
  for (const entry of generation.references) references.push(await resolve(entry));
  for (const entry of generation.keyframes) keyframes.push(await resolve(entry));
  const original = generation.brief.trim();
  const appBrief = original.endsWith(PICTURE_TEXT_DIRECTION) || original.endsWith("No text in the picture.");
  const suffix = appBrief && original.includes("\n\n") ? original.slice(original.indexOf("\n\n")) : "";
  const previousPrompt = appBrief ? original.split("\n\n")[0]! : original;
  // The card bounds its editable excerpt. An unchanged excerpt must not truncate a longer original.
  const brief = previousPrompt.slice(0, PICTURE_PROMPT_MAX) === prompt ? original : prompt + suffix;
  return { generation: { ...generation, params: generation.params }, references, keyframes, brief, pins };
}

/** A fresh, no-spend Bench draft; existing token identities and order remain exact, including gaps. */
export async function openSavedPicture(store: WorldStore, saved: SavedPicture, at: () => string, title?: string): Promise<OpenedBench> {
  if (store.closingSignal.aborted) throw new Error("stopped");
  const { generation } = saved;
  const opened = await openBenchSession(store.dir, at, { fresh: true, defaultModel: { provider: generation.provider, model: generation.model }, initial: { mode: "image", brief: saved.brief, ...(title ? { title } : {}) } });
  if (!opened) throw new Error("The Bench could not open a session.");
  for (const entry of saved.references) await opened.store.append({ type: "reference-added", entry }, { at: at() });
  for (const entry of saved.keyframes) await opened.store.append({ type: "reference-added", entry, lane: "keyframe" }, { at: at() });
  await opened.store.append({ type: "composer-set", mode: "image", provider: generation.provider, model: generation.model, params: { ...generation.params, count: 1 }, brief: saved.brief }, { at: at() });
  return { store: opened.store, session: (await opened.store.fold())! };
}
