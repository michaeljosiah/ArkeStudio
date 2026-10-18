import { EpisodeScriptSchema, episodeScriptFile, productionShape, type EpisodeScriptBlock } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";

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
