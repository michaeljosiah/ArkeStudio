import { join } from "node:path";
import { MediaInfoSchema, type MediaInfo } from "@arke-studio/contracts";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";

/**
 * The one seam that measures media (#253), shared by the spine, the cut, #248's QC and #254's
 * derived proxies rather than each growing its own ffmpeg call.
 *
 * Returning null is a first-class answer. An input whose length cannot be read refuses whatever
 * depended on it — a track that cannot be a clock, a mode that cannot be priced — because a
 * dispatch or an export built on a guessed duration is worse than one not offered.
 *
 * Previously `MediaProbe` lived in `productions/continuation.ts` and answered only `durationSec`.
 * The spine needs to know whether a file has audio at all before it can be a master track, so the
 * seam widens; the old narrow method stays because continuation asks exactly that question and
 * nothing more.
 */
export interface MediaProbe {
  durationSec(absolutePath: string, opts?: ProbeOptions): Promise<number | null>;
  /** Full measurement, or null when nothing can read the file. */
  info?(absolutePath: string, opts?: ProbeOptions): Promise<MediaInfo | null>;
}

/**
 * How a caller withdraws a measurement it no longer wants (issue 288).
 *
 * A signal here is not the usual "stop waiting": a probe is a *subprocess holding the file open*,
 * and until it exits the world it is reading cannot be moved or, on Windows, renamed around. So
 * an implementation that takes this must kill the child, not merely stop listening to it —
 * otherwise cancelling changes nothing that the caller cared about.
 *
 * Optional, and optional on the interface too, so a host that only knows how to run a probe to
 * completion still satisfies `MediaProbe`. It measures for the full timeout as it always did;
 * the callers that pass a signal are the ones that also survive not having it honoured.
 */
export interface ProbeOptions {
  signal?: AbortSignal;
}

/** Measure an input's length, or null when nothing can read it (SPEC-019 R-39). */
export async function measureDurationSec(
  store: WorldStore,
  worldRelativePath: string,
  probe: MediaProbe | null,
  opts: ProbeOptions = {},
): Promise<number | null> {
  if (!probe) return null;
  try {
    const seconds = await probe.durationSec(
      toExtendedLength(join(store.dir, fromPortable(worldRelativePath))),
      opts,
    );
    return seconds !== null && Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    // An unreadable input is a refusal, never a default: the mode is withdrawn with a reason.
    return null;
  }
}

/**
 * Measure a world-relative file fully, or null.
 *
 * Parsed through the schema rather than trusted: a probe is a subprocess reading an arbitrary
 * file, and a duration of 0, NaN or a negative is exactly what a partly-written download reports.
 * Falls back to the narrow `durationSec` when a probe implements only that, so an older host
 * still produces something usable rather than nothing.
 */
export async function measureMediaInfo(
  store: WorldStore,
  worldRelativePath: string,
  probe: MediaProbe | null,
  opts: ProbeOptions = {},
): Promise<MediaInfo | null> {
  if (!probe) return null;
  const absolute = toExtendedLength(join(store.dir, fromPortable(worldRelativePath)));
  try {
    if (probe.info) {
      const raw = await probe.info(absolute, opts);
      if (raw === null) return null;
      const parsed = MediaInfoSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    }
    const seconds = await probe.durationSec(absolute, opts);
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
    // A narrow probe cannot say whether there is audio. Claiming there is would let a silent
    // file become a master track; claiming there is not would refuse a real one. `false` is the
    // conservative reading, and the spine's own gate re-probes before assigning a track.
    return { durationSec: seconds, hasAudio: false };
  } catch {
    return null;
  }
}

/**
 * The ffprobe invocation, as a pure argument list.
 *
 * JSON output and named entries, never localized prose: ffprobe's human-readable output is
 * translated and reformatted between versions, and parsing it is how a build starts reporting
 * durations of `null` on a machine whose locale uses a decimal comma.
 */
export function ffprobeArgs(absolutePath: string): string[] {
  return [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=codec_type,channels,sample_rate",
    "-of",
    "json",
    absolutePath,
  ];
}

interface FfprobeStream {
  codec_type?: unknown;
  channels?: unknown;
  sample_rate?: unknown;
}

/**
 * Turn ffprobe's JSON into a `MediaInfo`, or null.
 *
 * Every field is checked rather than cast. ffprobe reports `duration` as a *string*, omits it
 * entirely for some containers, and reports `sample_rate` as a string too — so a cast would
 * produce `NaN` seconds that read as a real measurement downstream.
 */
export function parseFfprobeJson(stdout: string): MediaInfo | null {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const doc = raw as { format?: { duration?: unknown }; streams?: unknown };
  const durationSec = Number(doc.format?.duration);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;

  const streams: FfprobeStream[] = Array.isArray(doc.streams) ? (doc.streams as FfprobeStream[]) : [];
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const channels = Number(audio?.channels);
  const sampleRate = Number(audio?.sample_rate);
  return {
    durationSec,
    hasAudio: audio !== undefined,
    ...(Number.isInteger(channels) && channels > 0 ? { audioChannels: channels } : {}),
    ...(Number.isInteger(sampleRate) && sampleRate > 0 ? { audioSampleRateHz: sampleRate } : {}),
  };
}
