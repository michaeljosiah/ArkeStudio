import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { ffprobeArgs, parseFfprobeJson, type MediaProbe } from "@arke-studio/coordinator";
import type { MediaInfo } from "@arke-studio/contracts";

/**
 * The host half of media measurement (#253).
 *
 * The coordinator owns the arguments and the parsing; running a subprocess is the shell's
 * business, exactly as it is for ffmpeg and the QC probe. Split so both halves are testable —
 * the parser against captured ffprobe output, this against a fake spawn — and neither against
 * whether the machine running the tests happens to have ffprobe on it.
 */

type SpawnLike = typeof nodeSpawn;

/**
 * Where ffprobe is, in the order the issue settles:
 *
 * 1. `ARKE_FFPROBE` — an explicit answer always wins;
 * 2. the packaged binary beside ffmpeg;
 * 3. `ffprobe.exe` beside an explicitly-set `ARKE_FFMPEG`, because someone who pointed us at one
 *    binary of a pair almost always has the other in the same directory;
 * 4. nothing, with a reason.
 *
 * Never a bare `ffprobe` on PATH: picking up whatever a machine happens to have makes the
 * measurement depend on a version nobody chose, and a duration is not the kind of thing that
 * should vary by workstation.
 */
export function resolveFfprobe(input: {
  packagedDir: string | null;
  env?: NodeJS.ProcessEnv;
}): { path: string } | { path: null; reason: string } {
  const env = input.env ?? process.env;
  const explicit = env["ARKE_FFPROBE"];
  if (explicit) {
    return existsSync(explicit)
      ? { path: explicit }
      : { path: null, reason: `ARKE_FFPROBE is set to ${explicit}, which does not exist` };
  }
  if (input.packagedDir) {
    const bundled = join(input.packagedDir, "ffprobe.exe");
    if (existsSync(bundled)) return { path: bundled };
  }
  const ffmpeg = env["ARKE_FFMPEG"];
  if (ffmpeg) {
    const sibling = join(dirname(ffmpeg), "ffprobe.exe");
    if (existsSync(sibling)) return { path: sibling };
  }
  return {
    path: null,
    reason: "ffprobe was not found — bundled in packaged builds, or set ARKE_FFPROBE to one now",
  };
}

/**
 * A bounded ffprobe: killed on time, never given a shell to interpret, and answering null for
 * everything it cannot read.
 *
 * Null rather than a throw because every caller treats "cannot measure" as an ordinary outcome —
 * a track that cannot become a clock, a take whose length stays unknown — and an exception here
 * would have to be caught and turned back into null at each of them.
 */
export function createFfprobe(ffprobe: string, spawn: SpawnLike = nodeSpawn, timeoutMs = 20_000): MediaProbe {
  const run = (absolutePath: string): Promise<MediaInfo | null> =>
    new Promise((resolve) => {
      const child = spawn(ffprobe, ffprobeArgs(absolutePath), { windowsHide: true });
      let stdout = "";
      let settled = false;
      const finish = (value: MediaInfo | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        // A probe that will not finish is a probe that answered nothing. Killing it matters more
        // than the answer: an unbounded ffprobe on a corrupt file holds a handle on the world.
        child.kill();
        finish(null);
      }, timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        // Bounded: a well-formed answer is a few hundred bytes, and anything much larger is a
        // binary being mistaken for a probe rather than output worth keeping.
        if (stdout.length < 64_000) stdout += chunk.toString("utf8");
      });
      child.on("error", () => finish(null));
      child.on("close", (code) => finish(code === 0 ? parseFfprobeJson(stdout) : null));
    });

  return {
    async durationSec(absolutePath) {
      return (await run(absolutePath))?.durationSec ?? null;
    },
    info: run,
  };
}
