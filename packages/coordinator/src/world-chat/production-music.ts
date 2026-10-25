import { EMPTY_MUSIC_RECORD, musicKindOf, productionShape, type ArkeCommandBodySchema, type WorldBundle, type WorldChatPreparedAction } from "@arke-studio/contracts";
import type { z } from "zod";
import { addMusicTrack, removeMusicTrack, reorderMusicTracks, setMusicCover, updateMusicTrack, type MusicCommitOptions } from "../productions/music.js";
import type { WorldStore } from "../world/store.js";

/**
 * World Chat's reach to a music production's album (SPEC-060 R-19, design turn 238c – 238e): a
 * card for each command the album page sends — add, retitle or set lyrics, remove, reorder, cover —
 * checked against the album as it is when the card is prepared, and written by the page's own
 * writes with the card's source and request id, so a redelivered approval finds its commit rather
 * than adding a track twice.
 */

type Prepared = Extract<WorldChatPreparedAction, { kind: "world-chat-production-music" }>;

export interface MusicAlbumCard {
  title: string;
  consequence: string;
  body: z.infer<typeof ArkeCommandBodySchema>;
}

const line = (label: string, detail?: string) => ({ label: label.slice(0, 200), ...(detail !== undefined ? { detail: detail.slice(0, 4_000) } : {}) });
const tracksOf = (count: number) => `${count} track${count === 1 ? "" : "s"}`;

/**
 * Lyrics whole, in as many lines as a card's 4,000-character line needs, each cut after a line
 * break where it can be: what is approved is every word that is written (codex on PR 2190).
 * Joined, the pieces are the lyrics exactly.
 */
export function lyricsPieces(lyrics: string, size = 4_000): string[] {
  const pieces: string[] = [];
  let rest = lyrics;
  while (rest.length > size) {
    const breakAt = rest.lastIndexOf("\n", size - 1);
    const cut = breakAt > 0 ? breakAt + 1 : size;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  pieces.push(rest);
  return pieces;
}

/** What the card shows, or the refusal it is prepared with: the album as it is now decides. */
export function musicAlbumCard(bundle: WorldBundle, prepared: Prepared): MusicAlbumCard {
  const { productionId, command } = prepared.action;
  const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
  if (!production || !productionShape(production.meta).isMusic) throw new Error("That music production is no longer in this world.");
  const record = production.music ?? EMPTY_MUSIC_RECORD;
  const album = production.meta.title;
  const titleOf = (id: string) => record.tracks.find((track) => track.id === id)?.title ?? id;
  const shelf = (id: string) => bundle.artifacts.find((artifact) => artifact.id === id && artifact.retiredAt === undefined);
  const card = (title: string, consequence: string, commands: ReturnType<typeof line>[], expectedResult: string): MusicAlbumCard =>
    ({ title: title.slice(0, 200), consequence, body: { family: "command", commands, expectedResult, undoAvailable: false } });
  switch (command.kind) {
    case "add-track": {
      const artifact = shelf(command.artifactId);
      if (!artifact || artifact.kind !== "audio") throw new Error("A track is an audio take or file on the shelf; that artifact is not one.");
      // A Single holds one track (R-3): a second makes it an Album only on the person's word.
      const becomesAlbum = musicKindOf(production.meta) === "single" && record.tracks.length >= 1;
      if (becomesAlbum && command.makeAlbum !== true) throw new Error("A single holds one track. Add another only when the person asks to make it an album, with makeAlbum.");
      return card(`Add a track to ${album}`, "Adds the take as the album's last track; the take itself is unchanged.", [
        line(`Track ${record.tracks.length + 1}`, artifact.file),
        ...(becomesAlbum ? [line("Kind", "The single becomes an album")] : []),
      ], `${album} has ${tracksOf(record.tracks.length + 1)}.`);
    }
    case "update-track": {
      const track = record.tracks.find((candidate) => candidate.id === command.trackId);
      if (!track) throw new Error("That track is no longer on the album.");
      if (command.title === undefined && command.lyrics === undefined) throw new Error("Give the track a new title or its lyrics.");
      const title = command.title?.trim();
      const lyrics = command.lyrics === undefined ? undefined : command.lyrics.trim() === "" ? null : command.lyrics;
      const retitled = title !== undefined && title !== track.title;
      const relyriced = lyrics !== undefined && (lyrics ?? undefined) !== track.lyrics;
      if (!retitled && !relyriced) throw new Error("The track already has that title and those lyrics.");
      return card(`Change ${track.title}`, `Updates the track on ${album}; its take is unchanged.`, [
        ...(retitled ? [line("Title", `${track.title} → ${title}`)] : []),
        ...(relyriced
          ? lyrics === null
            ? [line("Lyrics", "Cleared")]
            : lyricsPieces(lyrics).map((piece, index, all) => line(all.length === 1 ? "Lyrics" : `Lyrics ${index + 1} of ${all.length}`, piece))
          : []),
      ], `The track reads as shown on ${album}.`);
    }
    case "remove-track": {
      if (!record.tracks.some((track) => track.id === command.trackId)) throw new Error("That track is no longer on the album.");
      return card(`Remove ${titleOf(command.trackId)}`, "Takes the track off the album; its take stays on the shelf.", [line(`Remove ${titleOf(command.trackId)}`)], `${album} has ${tracksOf(record.tracks.length - 1)}.`);
    }
    case "reorder-tracks": {
      const current = record.tracks.map((track) => track.id);
      if (command.order.length !== current.length || new Set(command.order).size !== command.order.length || command.order.some((id) => !current.includes(id))) {
        throw new Error("Name every track on the album exactly once, in its new order.");
      }
      if (command.order.every((id, index) => id === current[index])) throw new Error("The tracks are already in that order.");
      return card(`Reorder ${album}`, "Puts the album's tracks in the order shown.", command.order.map((id, index) => line(`${index + 1}. ${titleOf(id)}`)), "The tracks play in exactly this order.");
    }
    case "set-cover": {
      if (command.artifactId === (record.cover ?? null)) throw new Error(command.artifactId === null ? "The album has no cover." : "That picture is already the album's cover.");
      if (command.artifactId === null) return card(`Remove ${album}'s cover`, "The album has no cover; the picture stays on the shelf.", [line("Cover", "None")], `${album} has no cover.`);
      const artifact = shelf(command.artifactId);
      if (!artifact || artifact.kind !== "image") throw new Error("A cover is a picture on the shelf; that artifact is not one.");
      return card(`Set ${album}'s cover`, "Shows the picture as the album's square cover, fitted to 1:1 when it is exported.", [line("Cover", artifact.file)], `${album}'s cover is ${artifact.file}.`);
    }
  }
}

/** The approved command, written by the album's own writes. */
export async function executeProductionMusic(store: WorldStore, prepared: Prepared, options: MusicCommitOptions): Promise<string> {
  // Checked again against the album now: what was approved still applies, or it refuses.
  musicAlbumCard(store.getBundle(), prepared);
  const { productionId, command } = prepared.action;
  switch (command.kind) {
    case "add-track": {
      const id = await addMusicTrack(store, productionId, command.artifactId, { makeAlbum: command.makeAlbum === true }, options);
      return `The take was added as ${id}.`;
    }
    case "update-track":
      await updateMusicTrack(store, productionId, command.trackId, { ...(command.title !== undefined ? { title: command.title } : {}), ...(command.lyrics !== undefined ? { lyrics: command.lyrics } : {}) }, options);
      return "The track was updated.";
    case "remove-track":
      await removeMusicTrack(store, productionId, command.trackId, options);
      return "The track was removed from the album.";
    case "reorder-tracks":
      await reorderMusicTracks(store, productionId, command.order, options);
      return "The tracks were reordered.";
    case "set-cover":
      await setMusicCover(store, productionId, command.artifactId, options);
      return command.artifactId === null ? "The cover was removed." : "The cover was set.";
  }
}
