import { setImmediate as yieldToHost } from "node:timers/promises";
import {
  EFFECT_ANALYSIS_PROFILE,
  SONG_SECTION_PROFILE,
  createEffectPcmAnalyzer,
  findSongSections,
  type ExportPlan,
  type SongSections,
  type SongSectionsFound,
  type SongSectionsResult,
} from "@arke-studio/contracts";
import type { EffectAudioAnalysisHost } from "../media/node-effect-audio.js";
import { hashMediaFile } from "../media/media-file-hash.js";
import { containedWorldFilePath } from "../world/contained-file.js";
import type { WorldStore } from "../world/store.js";

/** A reason a person can read. Anything else is the decoder's, with paths in it, and is not passed on. */
export class SongNotMeasured extends Error {}

/**
 * A song measured for its sections (issue 3099, SPEC-041 R-68).
 *
 * The decode is the effects analysis's own (SPEC-053 R-14): the song alone as a one-sound film,
 * through the same graph, limiter and resampler, in the same bounded chunks, into the same
 * analyzer. Nothing is spooled and nothing is added to what the Studio ships: a song the effects
 * can react to is a song this can measure.
 */
export async function measureSong(
  host: EffectAudioAnalysisHost,
  input: { absolutePath: string; durationSec: number; signal: AbortSignal; expectedHash?: string },
): Promise<SongSectionsFound> {
  const frameRate = SONG_SECTION_PROFILE.frameRate;
  // Whole frames, as the analyzer requires: the last sliver of a frame is not a section.
  const frames = Math.floor(input.durationSec * frameRate);
  if (frames < 1) throw new SongNotMeasured("The song is too short to measure.");
  if (frames > EFFECT_ANALYSIS_PROFILE.maxFrames) throw new SongNotMeasured("The song is longer than the 30 minutes the Studio measures.");
  const totalSec = frames / frameRate;
  const sourceHash = await hashMediaFile(input.absolutePath, input.signal);
  if (input.expectedHash !== undefined && !`sha256:${sourceHash}`.startsWith(input.expectedHash)) throw new SongNotMeasured("The song's file changed on disk.");
  const plan: ExportPlan = {
    preset: "review-cut", frameRate, items: [], overlays: [], totalSec,
    audio: [{ path: "song", startSec: 0, endSec: totalSec, gainDb: 0, role: "music" }],
  };
  const inputs = [{ audioIndex: 0, absolutePath: input.absolutePath, sourceHash }];
  const descriptor = await host.describe({ plan, inputs, signal: input.signal });
  const analyzer = createEffectPcmAnalyzer({ frameRate, startFrame: 0, endFrame: frames });
  await host.renderAudiblePcm({
    plan, inputs, descriptor, signal: input.signal, selectedClipIds: null,
    onPcm: async (samples) => {
      input.signal.throwIfAborted();
      analyzer.push(samples);
      // Each bounded chunk yields, as the effects' own analysis does: the editor, a cancel and
      // the world's ownership checks are never behind a whole song.
      await yieldToHost();
    },
  });
  const data = analyzer.finish();
  await yieldToHost();
  return findSongSections(data, frameRate);
}

const unavailable =(reason: string): SongSectionsResult => ({ status: "unavailable", reason });

/**
 * What each open production's song measures to, made once per file and kept while the Studio runs.
 *
 * Derived and unsaved on purpose: it is a proposal, the same file measures the same every time,
 * and a section is authored only when a person sends it as a spine command. One song is decoded
 * at a time, so opening a world of music videos does not start a decoder for each.
 */
export class SongSectionsService {
  private readonly measured = new Map<string, SongSections>();
  private readonly measuring = new Map<string, Promise<SongSectionsResult>>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: EffectAudioAnalysisHost | undefined,
    private readonly stopping: AbortSignal,
  ) {}

  read(store: WorldStore, productionId: string): Promise<SongSectionsResult> {
    const bundle = store.getBundle();
    const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
    if (production === undefined) return Promise.resolve(unavailable("That production is not in this world."));
    if (production.spine === null) return Promise.resolve(unavailable("The production has no song yet."));
    const artifact = bundle.artifacts.find((candidate) => candidate.id === production.spine!.trackArtifactId);
    const durationSec = artifact?.mediaInfo?.durationSec;
    if (artifact === undefined || durationSec === undefined) return Promise.resolve(unavailable("The song has not been measured."));
    if (this.host === undefined) return Promise.resolve(unavailable("Audio analysis is unavailable on this host."));
    const host = this.host;
    // The world's folder as well as the file: two worlds may hold a copy of one artifact.
    const key = `${store.dir}|${artifact.id}|${artifact.hash}`;
    const known = this.measured.get(key);
    if (known !== undefined) return Promise.resolve({ status: "measured", song: known });
    const running = this.measuring.get(key);
    if (running !== undefined) return running;
    const signal = AbortSignal.any([store.closingSignal, this.stopping]);
    const work = this.tail.catch(() => {}).then(async (): Promise<SongSectionsResult> => {
      try {
        signal.throwIfAborted();
        const absolutePath = await containedWorldFilePath(store.dir, `artifacts/${artifact.file}`);
        const found = await measureSong(host, { absolutePath, durationSec, signal, expectedHash: artifact.hash });
        const song: SongSections = { trackArtifactId: artifact.id, durationSec, tempoBpm: found.tempoBpm, startsSec: found.startsSec };
        if (this.measured.size >= 64) this.measured.delete(this.measured.keys().next().value!);
        this.measured.set(key, song);
        return { status: "measured", song };
      } catch (error) {
        // Not kept: a file that was missing, changing or mid-import may measure on the next ask.
        return unavailable(signal.aborted ? "The world closed before the song was measured."
          : error instanceof SongNotMeasured ? error.message : "The song could not be measured.");
      } finally {
        this.measuring.delete(key);
      }
    });
    this.measuring.set(key, work);
    this.tail = work;
    return work;
  }

  /** Every decode in flight has been told to stop by the signal; this waits for the last to let go. */
  async stop(): Promise<void> {
    await this.tail.catch(() => {});
  }
}
