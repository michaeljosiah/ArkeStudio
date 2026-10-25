import { audioSourceOf, productionShape, type MusicHeardRow, type MusicRecord } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { readAudiobook } from "./audiobook.js";

/**
 * Where a music production's tracks are heard in the world's other productions (SPEC-060 R-14,
 * design turn 238 rule 8). Read, never stored: a placement moved or removed elsewhere would leave a
 * stored row saying something no longer true, so it is found again each time it is asked for.
 *
 * A track is found by what its source is — the artifact a kept take or an imported file became —
 * wherever another production places that artifact:
 *  - an audiobook chapter's bed or block sound, which name the world file, and its Audio Studio
 *    clips, which name the artifact;
 *  - an audio drama's music, ambience and sound cues, which name the artifact;
 *  - a film's cut: the edited timeline's clips once there is one, and before it the score and
 *    ambience beds, the clips placed on its lanes and the track a cut to music is cut to.
 *
 * `at` is the moment where the placement says one plainly — a fixed Audio Studio clip, a timeline
 * clip's first frame — and the start of the chapter, episode or cut where it is anchored to the
 * words instead, because those positions exist only once the chapter is timed.
 */

const STUDIO_RATE = 48_000;

export async function musicHeardIn(store: WorldStore, productionId: string, record: Pick<MusicRecord, "tracks">): Promise<Record<string, MusicHeardRow[]>> {
  const bundle = store.getBundle();
  const byArtifact = new Map<string, string[]>();
  for (const track of record.tracks) {
    if (!("artifactId" in track.source)) continue;
    byArtifact.set(track.source.artifactId, [...(byArtifact.get(track.source.artifactId) ?? []), track.id]);
  }
  const byFile = new Map<string, string>();
  for (const artifact of bundle.artifacts) if (byArtifact.has(artifact.id)) byFile.set(`artifacts/${artifact.file}`, artifact.id);
  const out: Record<string, MusicHeardRow[]> = Object.fromEntries(record.tracks.map((track) => [track.id, []]));
  const seen = new Set<string>();
  const add = (artifactId: string, row: MusicHeardRow) => {
    for (const trackId of byArtifact.get(artifactId) ?? []) {
      const key = `${trackId}|${row.production}|${row.chapter}|${row.at}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out[trackId]!.push(row);
    }
  };
  if (byArtifact.size === 0) return out;

  for (const production of bundle.productions) {
    if (production.meta.id === productionId) continue;
    const shape = productionShape(production.meta);
    const productionTitle = production.meta.title.slice(0, 200);
    const base = `/p/${production.meta.id}`;

    if (shape.hasChapters) {
      for (const chapter of [...production.chapters].filter((entry) => !entry.retired).sort((a, b) => a.order - b.order)) {
        const audiobook = await readAudiobook(store, production.meta.id, chapter.file).catch(() => null);
        if (audiobook === null || audiobook === "unreadable") continue;
        const row = (at: number): MusicHeardRow => ({ production: production.meta.id, productionTitle, chapter: chapter.id, label: `Chapter ${chapter.order}`, at, open: `${base}/story/chapters/${chapter.id}?view=audio-studio` });
        for (const bed of Object.values(audiobook.beds ?? {})) {
          const artifactId = byFile.get(bed.source.file);
          if (artifactId !== undefined) add(artifactId, row(0));
        }
        for (const sound of Object.values(audiobook.sounds ?? {})) {
          const artifactId = byFile.get(sound.source.file);
          if (artifactId !== undefined) add(artifactId, row(0));
        }
        for (const clip of audiobook.arrangement?.current.clips ?? []) {
          const artifactId = clip.source?.artifactId ?? (clip.source !== null ? byFile.get(clip.source.file) : undefined);
          if (artifactId === undefined || !byArtifact.has(artifactId)) continue;
          add(artifactId, row(clip.placement.kind === "fixed" ? Math.round((clip.placement.at * 1000) / STUDIO_RATE) : 0));
        }
      }
    }

    if (shape.isAudioDrama) {
      for (const { script } of production.episodeScripts ?? []) {
        for (const block of script.blocks) {
          if ((block.kind !== "music" && block.kind !== "ambience" && block.kind !== "sound") || block.soundArtifact === undefined) continue;
          if (!byArtifact.has(block.soundArtifact)) continue;
          add(block.soundArtifact, { production: production.meta.id, productionTitle, chapter: `episode-${script.episode}`, label: `Episode ${script.episode}`, at: 0, open: `${base}/script/${script.episode}` });
        }
      }
    }

    const cut = (at: number): MusicHeardRow => ({ production: production.meta.id, productionTitle, chapter: "cut", label: "Cut", at, open: `${base}/cut` });
    // Once the edited timeline exists it is the cut (SPEC-037): cut.json and the spine are the
    // placements it was made from, frozen, and a clip moved since is only where the timeline says.
    if (production.timeline?.status === "ready") {
      const { timeline } = production.timeline;
      for (const track of timeline.tracks) {
        for (const clip of track.clips) {
          if (clip.source.kind !== "artifact" || !byArtifact.has(clip.source.artifactId)) continue;
          add(clip.source.artifactId, cut(Math.round((clip.startFrame * 1000) / timeline.frameRate)));
        }
      }
      continue;
    }
    if (production.spine !== null && byArtifact.has(production.spine.trackArtifactId)) add(production.spine.trackArtifactId, cut(0));
    for (const track of production.cut.audio) {
      for (const entry of track.entries) {
        const source = audioSourceOf(entry);
        // A bed placed against a shot starts wherever that shot falls, which the cut derives.
        if (source?.kind === "artifact" && byArtifact.has(source.artifactId)) add(source.artifactId, cut(entry.shotId === undefined ? Math.round(entry.offsetSec * 1000) : 0));
      }
    }
    for (const overlay of production.cut.overlays) {
      if (byArtifact.has(overlay.artifactId)) add(overlay.artifactId, cut(Math.round(overlay.startSec * 1000)));
    }
  }
  for (const rows of Object.values(out)) rows.sort((a, b) => a.productionTitle.localeCompare(b.productionTitle) || a.label.localeCompare(b.label, undefined, { numeric: true }) || a.at - b.at);
  return out;
}
