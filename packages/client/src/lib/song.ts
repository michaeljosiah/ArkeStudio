import {
  orderedShots, pinnedInWindowSec, productionShape, proposedSectionLabel, sceneSections, songTime,
  type ArtifactSidecar, type AudioSpineCommand, type ProductionSpine, type SceneRecord, type SongWindow, type SpineMarker,
} from "@arke-studio/contracts";
import { seconds } from "./format.js";

/**
 * A music video's song (issue 3088): the master track its audio spine is cut to.
 *
 * The spine was reachable only through Arke's card, so a new music video opened on "Make the first
 * clip" with nothing anywhere asking for the one thing it is made from. These say when to ask and
 * what a press sends; the coordinator's spine authority still decides whether it lands.
 */
type SongProduction = { meta: Parameters<typeof productionShape>[0]; spine: ProductionSpine | null };

/** A music video with no master track yet: its Dashboard and its Cut say so. */
export function wantsSong(production: SongProduction): boolean {
  return production.spine === null && productionShape(production.meta).kind === "music-video";
}

/**
 * Whether a Library row offers Use as the song. A production cut to a song — a music video, or
 * anything that already has a spine — and a sound file whose length is known: the authority
 * refuses an unmeasured master, and offering a press it will refuse is a control that lies.
 */
export function offersSong(production: SongProduction, artifact: Pick<ArtifactSidecar, "kind" | "mediaInfo">): boolean {
  if (production.spine === null && productionShape(production.meta).kind !== "music-video") return false;
  return artifact.kind === "audio" && artifact.mediaInfo?.durationSec !== undefined;
}

/** Whether this file is the song now. */
export function isSong(production: SongProduction, artifactId: string): boolean {
  return production.spine?.trackArtifactId === artifactId;
}

/**
 * The one command that makes a file the song: the spine created on it, or the spine's track moved
 * to it at the revision shown. Null when it is the song already, which the authority would refuse
 * as a change of nothing.
 */
export function songCommand(
  spine: ProductionSpine | null,
  artifactId: string,
): { baseRevision: number | null; command: AudioSpineCommand } | null {
  if (spine === null) return { baseRevision: null, command: { kind: "create", trackArtifactId: artifactId } };
  if (spine.trackArtifactId === artifactId) return null;
  return { baseRevision: spine.revision, command: { kind: "assign-track", trackArtifactId: artifactId } };
}

/**
 * A scene's place in the song (issue 3100): `0:16–0:44`, and `0:16.5–0:44.25` where it is not on
 * the second. The song's own clock, as a spine card reads it: rounded to whole seconds, a window
 * read a different time from the section it marks, and one under a second read as a single moment.
 */
export function songWindowLabel(window: SongWindow): string {
  return `${songTime(window.startSec)}–${songTime(window.endSec)}`;
}

/**
 * A scene's length in the song (issue 3101): its window, and how much of it its shots are pinned
 * to. A music video's scene read "0 shots · 0s" until it had shots, with its sixteen seconds of
 * the song only in its title. Null where there is nothing to say — no master track, or a scene
 * with no place in it — and the scene then shows its shots' own lengths, as it always has.
 *
 * The two lengths read to a tenth of a second, as the Cut reads an anchor's length on the song's
 * track: `12s of 28s`, and `12.5s of 27.8s` for a window off the second. Whole seconds made a
 * window of 27.75 seconds read `28s` beside the boundaries that say otherwise, and 27.6 of it
 * pinned read as all of it; anything finer than a tenth is a measured take's tail, or a float's.
 */
export function sceneSongLine(production: Pick<SongProduction, "spine">, scene: SceneRecord): string | null {
  const window = scene.songWindow;
  if (production.spine === null || window === undefined) return null;
  const pinned = pinnedInWindowSec(window, production.spine, orderedShots(scene).map((shot) => shot.id));
  return `${songWindowLabel(window)} · ${seconds(pinned)} of ${seconds(window.endSec - window.startSec)} pinned`;
}

/**
 * Mark N sections from the scenes (issue 3100): the sections the scenes' places would give a
 * song that has none, and the one command that marks them. Null when it is not offered: no song,
 * a song that already has a section, or no scene with a place in it. Null too when a scene starts
 * past the end of the song, which the authority refuses, as a press it will refuse is not offered.
 */
export function sectionsFromScenes(
  production: Pick<SongProduction, "spine"> & { scenes: readonly SceneRecord[] },
  trackDurationSec: number | undefined,
): { count: number; baseRevision: number; command: AudioSpineCommand } | null {
  const spine = production.spine;
  if (spine === null || spine.markers.some((marker) => marker.kind === "section")) return null;
  const sections = sceneSections(production.scenes);
  if (sections.length === 0) return null;
  if (trackDurationSec !== undefined && sections.some((section) => section.atSec > trackDurationSec)) return null;
  return { count: sections.length, baseRevision: spine.revision, command: { kind: "mark-sections-from-scenes" } };
}

/**
 * A song with no sections marked (issue 3099): the Cut asks what the Studio measured of it and
 * offers that. One marked section, by anyone, ends the offer: nothing is proposed over a person's
 * own marks.
 */
export function wantsSections(spine: ProductionSpine | null): spine is ProductionSpine {
  return spine !== null && !spine.markers.some((marker) => marker.kind === "section");
}

/**
 * The one command that marks proposed sections: the spine's marker import, at the revision shown,
 * named by their order in the song because where a section starts is all that was measured.
 *
 * An import owns sections and lyrics alike and replaces both, so the lyrics already on the spine
 * are sent back with it: the same ids, words and times, under the import's provenance, which an
 * import requires of every marker. Leaving them out would trade somebody's lyric sheet for the
 * sections they pressed for.
 */
export function sectionsCommand(
  spine: ProductionSpine,
  startsSec: readonly number[],
  mintId: () => string,
): { baseRevision: number; command: AudioSpineCommand } {
  const sections = [...startsSec].sort((a, b) => a - b).map((atSec, index): SpineMarker => ({
    kind: "section", id: mintId(), label: proposedSectionLabel(index), atSec, source: "json",
  }));
  const lyrics = spine.markers.filter((marker) => marker.kind === "lyric").map((marker): SpineMarker => ({ ...marker, source: "json" }));
  return { baseRevision: spine.revision, command: { kind: "import-markers", format: "json", markers: [...sections, ...lyrics] } };
}

/**
 * A place in the song as a field shows it: `0:42`, `1:01.9`, `0:22.424`, exact to the millisecond.
 *
 * The notation a spine card reads a time in, contracts' `songTime`, so the Cut, the card and a
 * scene's window say one time one way.
 */
export function songTimeText(sec: number): string {
  return songTime(sec);
}

/**
 * What `songTimeText` prints, read back as seconds; null for anything that is not a time in a song.
 * Counted in whole milliseconds, so a time printed and read again is the same number: added up in
 * seconds, 1 and 0.118 come to a hair off 1.118, and a start nobody moved would read as moved.
 */
export function parseSongTime(text: string): number | null {
  const match = /^(\d{1,3}):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(text.trim());
  if (match === null) return null;
  return ((Number(match[1]) * 60 + Number(match[2])) * 1000 + (match[3] ? Number(match[3].padEnd(3, "0")) : 0)) / 1000;
}
