import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AudioDramaRecordSchema, EpisodeScriptSchema, episodeScriptFile, productionShape,
  type AudioDramaRecord, type DramaChapterDecision, type DramaReviewDecision, type DramaRole, type EpisodeScriptBlock,
} from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";

/**
 * One read-change-write at a time per file (codex on PR 1873): two edits arriving together would
 * both read the same bytes, and the later one's fenced write would be refused.
 */
const writing = new Map<string, Promise<unknown>>();
export async function oneAtATime<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = writing.get(key) ?? Promise.resolve();
  const turn = before.catch(() => {}).then(work);
  writing.set(key, turn);
  try { return await turn; } finally { if (writing.get(key) === turn) writing.delete(key); }
}

/** `audio-drama.json`, changed in one write fenced on the file it was read from (SPEC-057 R-85). */
async function writeDramaRecord(store: WorldStore, productionId: string, change: (record: AudioDramaRecord) => AudioDramaRecord): Promise<void> {
  const path = `productions/${productionId}/audio-drama.json`;
  return oneAtATime(`${store.dir}/${path}`, () => writeDramaRecordNow(store, path, change));
}
async function writeDramaRecordNow(store: WorldStore, path: string, change: (record: AudioDramaRecord) => AudioDramaRecord): Promise<void> {
  const live = await readFile(toExtendedLength(join(store.dir, fromPortable(path))), "utf8").catch(() => null);
  if (live === null) throw new Error("that production is not an audio drama");
  const next = AudioDramaRecordSchema.parse(change(AudioDramaRecordSchema.parse(JSON.parse(live))));
  await store.commit({ kind: "audio-drama", source: "audio-drama", files: [{
    path, action: "replace", content: `${JSON.stringify(next, null, 2)}\n`, baseHash: sha256(live),
  }] });
}

/** A role as this production plays it (R-55..R-60); null clears it back to the sheet. */
export async function setDramaRole(store: WorldStore, productionId: string, role: string, value: DramaRole | null): Promise<void> {
  await writeDramaRecord(store, productionId, (record) => {
    const cast = { ...record.cast };
    if (value === null) delete cast[role];
    else cast[role] = value;
    const { cast: _was, ...rest } = record;
    return Object.keys(cast).length > 0 ? { ...rest, cast } : rest;
  });
}

/** What became of a source chapter (R-61); null clears it back to what the scripts say. */
export async function setDramaVerdict(store: WorldStore, productionId: string, chapter: string, value: DramaChapterDecision | null): Promise<void> {
  await writeDramaRecord(store, productionId, (record) => {
    const verdicts = { ...record.verdicts };
    if (value === null) delete verdicts[chapter];
    else verdicts[chapter] = value;
    const { verdicts: _was, ...rest } = record;
    return Object.keys(verdicts).length > 0 ? { ...rest, verdicts } : rest;
  });
}

/** A review note decided (R-53); null opens it again. */
export async function decideDramaNote(store: WorldStore, productionId: string, key: string, decision: DramaReviewDecision | null): Promise<void> {
  await writeDramaRecord(store, productionId, (record) => {
    const review = { ...record.review };
    if (decision === null) delete review[key];
    else review[key] = decision;
    const { review: _was, ...rest } = record;
    return Object.keys(review).length > 0 ? { ...rest, review } : rest;
  });
}

/**
 * Save an audio drama's episode script whole (SPEC-057 R-83). Fenced like a chapter save: the
 * base hash is the file the editor read, null for an episode with no script yet, and a save
 * against a moved base is refused by the committer rather than merged. A direct save keeps the
 * version; the committer stamps it and keeps the snapshot.
 */
export async function saveEpisodeScript(
  store: WorldStore,
  productionId: string,
  input: { episode: number; title: string; blocks: readonly EpisodeScriptBlock[]; baseHash: string | null },
  options: { source?: string; requestId?: string } = {},
): Promise<{ version: number; hash: string }> {
  const production = store.getBundle().productions.find((candidate) => candidate.meta.id === productionId);
  if (!production) throw new Error(`production ${productionId} is not in this world`);
  if (!productionShape(production.meta).isAudioDrama) throw new Error(`${production.meta.title} is not an audio drama.`);
  const path = `productions/${productionId}/scripts/${episodeScriptFile(input.episode)}`;
  // Parsed here so a broken relation (a cut with no line breaking in) is refused before it lands.
  const record = EpisodeScriptSchema.parse({ version: 1, episode: input.episode, title: input.title, blocks: input.blocks });
  // A placed sound must be one this production can play (codex on PR 1872): audio, here, not retired.
  for (const block of record.blocks) {
    if ((block.kind !== "sound" && block.kind !== "ambience" && block.kind !== "music") || !block.soundArtifact) continue;
    const artifact = store.getBundle().artifacts.find((candidate) => candidate.id === block.soundArtifact);
    if (!artifact || artifact.kind !== "audio" || artifact.retiredAt !== undefined || (artifact.production !== undefined && artifact.production !== productionId)) {
      throw new Error(`“${block.heard}” is placed with a sound this production cannot use. Choose its sound again.`);
    }
  }
  const result = await store.commit({
    kind: "episode-script-save",
    source: options.source ?? "editor",
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
    files: [{
      path,
      action: input.baseHash === null ? "create" : "replace",
      content: `${JSON.stringify(record, null, 2)}\n`,
      baseHash: input.baseHash,
      preserveVersion: true,
    }],
  });
  const hash = result.hashes?.[path];
  if (hash === undefined) throw new Error("The script was saved without a hash to save against next.");
  return { version: result.versions[path]!, hash };
}
