import { productionShape, type ArtifactSidecar, type AudioSpineCommand, type ProductionSpine } from "@arke-studio/contracts";

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
