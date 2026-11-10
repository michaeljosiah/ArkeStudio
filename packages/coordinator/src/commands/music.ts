import type { ClientMessage, MusicWaveform, SessionId } from "@arke-studio/contracts";
import { LYRICS_MAX_CHARS, draftLyrics } from "../bench/lyricist.js";
import type { OpenedBench } from "../bench/service.js";
import { addMusicTrack, editMusicTrack, ensureMusicSession, MusicRefusal, readMusicRecord, removeMusicTrack, reorderMusicTracks, setMusicCover, setMusicSequence, tagMusicTakes, updateMusicTrack } from "../productions/music.js";
import { musicHeardIn } from "../productions/music-heard.js";
import { renderMusicAlbum } from "../productions/music-render.js";
import { musicWaveform } from "../productions/music-waveform.js";
import type { makeArtDirector } from "../references/art-director.js";
import type { FfmpegRunner } from "../takes/export.js";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";
import type { CommandModule, CommandOf } from "./router.js";

/**
 * An album (SPEC-060): its tracks, cover, takes, edits and sequence. Open world only. Lyrics,
 * Play all, a track's takes and a waveform answer a world that is not open with their own event,
 * which the music page waits on by its request, so those four check the world themselves.
 */
export function musicCommands(ctx: CommandContext, deps: {
  /** An answer from one roster agent, or null while the writing harness is not running. */
  ask: (options: Parameters<typeof makeArtDirector>[3]) => ((brief: string) => Promise<string | null>) | null;
  logLyrics(entry: { kind: "music.lyrics-drafted" | "music.lyrics-unavailable"; worldId: string; reason?: string }): void;
  logRenderFailed(entry: { production: string; message: string }): void;
  ffmpeg: FfmpegRunner | undefined;
  /** Play all's renders by request, cancelled with the world and with the coordinator. */
  rendering: Map<string, AbortController>;
  rejectBenchDispatch(requestId: string, reason: string): void;
  dispatch(msg: ClientMessage): Promise<void>;
  benchFor(worldId: string, sessionId: SessionId): Promise<OpenedBench | null>;
  chooseAlbumTake(store: WorldStore, productionId: string, trackId: string, sessionId: string, takeId: string, requestId: string): Promise<void>;
  emitMusicTakes(store: WorldStore, productionId: string, requestId: string | null): Promise<void>;
}) {
  const saveAlbum = async (msg: CommandOf<"music-track-add" | "music-track-update" | "music-track-remove" | "music-tracks-reorder" | "music-set-cover">, store: WorldStore) => {
    // The album's tracks and cover (design turn 238c – 238e, SPEC-060 R-5 – R-7): one fenced
    // write of music.json each. A refusal is said; the page follows the snapshot below either way.
    try {
      if (msg.kind === "music-track-add") await addMusicTrack(store, msg.productionId, msg.artifactId, { makeAlbum: msg.makeAlbum === true });
      else if (msg.kind === "music-track-update") await updateMusicTrack(store, msg.productionId, msg.trackId, { ...(msg.title !== undefined ? { title: msg.title } : {}), ...(msg.lyrics !== undefined ? { lyrics: msg.lyrics } : {}) });
      else if (msg.kind === "music-track-remove") await removeMusicTrack(store, msg.productionId, msg.trackId);
      else if (msg.kind === "music-tracks-reorder") await reorderMusicTracks(store, msg.productionId, msg.order);
      else await setMusicCover(store, msg.productionId, msg.artifactId);
    } catch (err) {
      ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The album could not be saved" });
    }
    await ctx.refreshWorldSnapshot(msg.worldId);
  };
  const editAlbum = async (msg: CommandOf<"music-track-edit" | "music-sequence-set">, store: WorldStore) => {
    // The track editor's Save (238j, R-11) and the album's sequence (238k, R-13): one fenced
    // write of music.json each, applied at render; the take itself is never touched.
    try {
      if (msg.kind === "music-track-edit") await editMusicTrack(store, msg.productionId, msg.trackId, { trim: msg.trim, fadeInMs: msg.fadeInMs, fadeOutMs: msg.fadeOutMs, sections: msg.sections });
      else await setMusicSequence(store, msg.productionId, { loudness: msg.loudness, joins: msg.joins });
    } catch (err) {
      ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The album could not be saved" });
    }
    await ctx.refreshWorldSnapshot(msg.worldId);
  };
  return {
    "music-track-add": { scope: "open-world", handle: saveAlbum },
    "music-track-update": { scope: "open-world", handle: saveAlbum },
    "music-track-remove": { scope: "open-world", handle: saveAlbum },
    "music-tracks-reorder": { scope: "open-world", handle: saveAlbum },
    "music-set-cover": { scope: "open-world", handle: saveAlbum },
    "music-draft-lyrics": {
      scope: "any-world",
      async handle(msg) {
        // Draft with Arke on a track (238e, R-7): the lyricist Bench's music mode asks, answered as
        // an event, because words reach the track only when the author keeps them.
        const answer = (lyrics: string | null, reason?: string) =>
          ctx.emit({ at: ctx.nowIso(), type: "music.lyrics-drafted", worldId: msg.worldId, productionId: msg.productionId, trackId: msg.trackId, requestId: msg.requestId, lyrics, ...(reason !== undefined ? { reason } : {}) });
        const store = ctx.openStore();
        if (!store || store.worldId !== msg.worldId) return answer(null, "that world is not open");
        const lyricist = deps.ask({ agent: "lyricist", answerKey: "lyrics", maxChars: LYRICS_MAX_CHARS });
        if (!lyricist) return answer(null, "the writing harness is not running");
        const drafted = await draftLyrics(lyricist, { description: msg.description });
        deps.logLyrics({ kind: drafted.lyrics ? "music.lyrics-drafted" : "music.lyrics-unavailable", worldId: msg.worldId, ...(drafted.reason ? { reason: drafted.reason } : {}) });
        return answer(drafted.lyrics, drafted.reason);
      },
    },
    "read-music-heard-in": {
      scope: "open-world",
      async handle(msg, store) {
        // Heard in (R-14): found again each time it is asked for, never kept.
        const tracks = await readMusicRecord(store, msg.productionId).then(({ record }) => musicHeardIn(store, msg.productionId, record)).catch(() => ({}));
        ctx.emit({ at: ctx.nowIso(), type: "music.heard-in", worldId: msg.worldId, productionId: msg.productionId, requestId: msg.requestId, tracks });
      },
    },
    "render-music": {
      scope: "any-world",
      async handle(msg) {
        // Play all (R-8): the export's render, made on demand and cached.
        const answer = (result: { ok: true; file: string; durationMs: number; starts: Array<{ trackId: string; atMs: number }> } | { ok: false; reason: string }) =>
          ctx.emit({ at: ctx.nowIso(), type: "music.rendered", worldId: msg.worldId, productionId: msg.productionId, requestId: msg.requestId, result });
        const store = ctx.openStore();
        if (!store || store.worldId !== msg.worldId) return answer({ ok: false, reason: "that world is not open" });
        if (deps.ffmpeg === undefined) return answer({ ok: false, reason: "Needs ffmpeg" });
        if (ctx.stopping()) return;
        // Cancelled with the world, and with the coordinator before it drains its handlers.
        const control = new AbortController();
        deps.rendering.set(msg.requestId, control);
        try {
          const { record } = await readMusicRecord(store, msg.productionId);
          const album = await renderMusicAlbum(store, record, { ffmpeg: deps.ffmpeg, signal: AbortSignal.any([control.signal, store.closingSignal]) });
          return answer({ ok: true, file: album.file, durationMs: album.durationMs, starts: album.starts });
        } catch (err) {
          deps.logRenderFailed({ production: msg.productionId, message: err instanceof Error ? err.message : String(err) });
          return answer({ ok: false, reason: control.signal.aborted ? "the render was cancelled" : err instanceof Error ? err.message.slice(0, 300) : "the album could not be rendered" });
        } finally {
          deps.rendering.delete(msg.requestId);
        }
      },
    },
    "music-track-make": {
      scope: "any-world",
      async handle(msg) {
        // A track's composer (238i, SPEC-060 R-9): its takes are Bench takes in the album's own
        // session, made by the Bench's own dispatch — the plan, quote, reservation, ledger and
        // Activity a press in Bench gets — and then tagged with the track that asked for them.
        // Its answer is the Bench dispatch's, under the same request, whether it is refused here
        // or by the plan, so the composer listens for one kind of result.
        const store = ctx.openStore();
        if (!store || store.worldId !== msg.worldId) return deps.rejectBenchDispatch(msg.requestId, "That world is not open.");
        if (msg.composer.params.kind !== "music") return deps.rejectBenchDispatch(msg.requestId, "A track's takes are music.");
        let sessionId: SessionId;
        try {
          const { record } = await readMusicRecord(store, msg.productionId);
          if (!record.tracks.some((track) => track.id === msg.trackId)) throw new MusicRefusal("That track is no longer on the album.");
          sessionId = await ensureMusicSession(store, msg.productionId, ctx.nowIso());
        } catch (err) {
          return deps.rejectBenchDispatch(msg.requestId, err instanceof Error ? err.message.slice(0, 300) : "The album could not be read.");
        }
        // The track rides in each reservation (codex on PR 2191): fsynced before any job exists,
        // so a take whose tagging below never lands is still found as this track's.
        await deps.dispatch({ kind: "bench-dispatch", worldId: msg.worldId, sessionId, requestId: msg.requestId, composer: { mode: "music", ...msg.composer, params: { ...msg.composer.params, track: msg.trackId } } });
        // A press of several takes reserves `<request>/<n>`; one take reserves the request itself.
        const made = (await deps.benchFor(msg.worldId, sessionId))?.session.takes
          .filter((take) => take.requestId === msg.requestId || take.requestId.startsWith(`${msg.requestId}/`)) ?? [];
        try {
          await tagMusicTakes(store, msg.productionId, msg.trackId, made.map((take) => ({ sessionId, takeId: take.id })));
        } catch (err) {
          ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The takes could not be added to the track" });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
        await deps.emitMusicTakes(store, msg.productionId, msg.requestId);
      },
    },
    "music-track-choose": {
      scope: "open-world",
      async handle(msg, store) {
        // Choose (238i, R-10): the take is kept to the shelf as Bench's Keep keeps one, and the
        // track plays it from there, so the render, the export and Heard in read it as any track.
        try {
          await deps.chooseAlbumTake(store, msg.productionId, msg.trackId, msg.sessionId, msg.takeId, msg.requestId);
        } catch (err) {
          ctx.emit({ at: ctx.nowIso(), type: "command.failed", command: msg.kind, requestId: null, reason: err instanceof Error ? err.message.slice(0, 300) : "The take could not be chosen" });
        }
        await ctx.refreshWorldSnapshot(msg.worldId);
        await deps.emitMusicTakes(store, msg.productionId, msg.requestId);
      },
    },
    "music-track-edit": { scope: "open-world", handle: editAlbum },
    "music-sequence-set": { scope: "open-world", handle: editAlbum },
    "read-music-takes": {
      scope: "open-world",
      async handle(msg, store) { await deps.emitMusicTakes(store, msg.productionId, msg.requestId); },
    },
    "read-music-waveform": {
      scope: "any-world",
      async handle(msg) {
        // A strip for the editor and the sequence (238j, 238k): decoded once and cached.
        const answer = (waveform: MusicWaveform | null, reason?: string) =>
          ctx.emit({ at: ctx.nowIso(), type: "music.waveform", worldId: msg.worldId, requestId: msg.requestId, file: msg.file, waveform, ...(reason !== undefined ? { reason } : {}) });
        const store = ctx.openStore();
        if (!store || store.worldId !== msg.worldId) return answer(null, "that world is not open");
        try {
          return answer(await musicWaveform(store.dir, msg.file, { ...(deps.ffmpeg !== undefined ? { ffmpeg: deps.ffmpeg } : {}), signal: store.closingSignal }));
        } catch (err) {
          return answer(null, err instanceof Error ? err.message.slice(0, 300) : "the waveform could not be read");
        }
      },
    },
  } satisfies CommandModule;
}
