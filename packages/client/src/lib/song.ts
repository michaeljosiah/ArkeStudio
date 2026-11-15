import { productionShape, proposedSectionLabel, type ArtifactSidecar, type AudioSpineCommand, type ProductionSpine, type SpineMarker } from "@arke-studio/contracts";

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
 * The notation a spine card reads a time in, the coordinator's `songTime`, so the Cut and the card
 * say one time one way. Written again here because that one is not shared with the client yet;
 * when it is, this is that.
 */
export function songTimeText(sec: number): string {
  const ms = Math.round(sec * 1000);
  const fraction = ms % 1000;
  return `${Math.floor(ms / 60_000)}:${String(Math.floor((ms % 60_000) / 1000)).padStart(2, "0")}${
    fraction === 0 ? "" : `.${String(fraction).padStart(3, "0").replace(/0+$/, "")}`}`;
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
