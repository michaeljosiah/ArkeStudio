import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaInfo } from "@arke-studio/contracts";
import type { MediaProbe } from "../../src/media/probe.js";
import type { FfmpegRunner } from "../../src/takes/export.js";

async function command(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, signal: AbortSignal.any([AbortSignal.timeout(60_000), ...(signal ? [signal] : [])]), stdio: ["ignore", "pipe", "pipe"] });
    let output = "", error = "";
    child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { error = (error + chunk).slice(-4000); });
    child.once("error", reject); child.once("close", code => code === 0 ? resolve(output) : reject(new Error(`${executable} exited ${code}: ${error}`)));
  });
}
export async function acceptanceMedia(dir: string, real: boolean) {
  const boxes = Uint8Array.from(["ftyp", "moov", "mdat"].flatMap(name => [0, 0, 0, 8, ...new TextEncoder().encode(name)]));
  const encodes: string[][] = [];
  const ffmpeg = process.env.ARKE_FFMPEG ?? "ffmpeg", ffprobe = process.env.ARKE_FFPROBE ?? "ffprobe";
  const file = join(dir, "provider-clip.mp4");
  if (real) await command(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=steelblue:s=160x90:r=24", "-t", "4", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-threads", "1", "-y", file]);
  const info = async (source: string): Promise<MediaInfo> => {
    if (!real) return { durationSec: 4, width: 160, height: 90, frameRate: 24, hasAudio: true };
    const result = JSON.parse(await command(ffprobe, ["-v", "error", "-show_format", "-show_streams", "-of", "json", source])) as {
      format: { duration: string }; streams: { codec_type: string; width?: number; height?: number; avg_frame_rate?: string }[];
    };
    const video = result.streams.find(stream => stream.codec_type === "video"), rate = video?.avg_frame_rate?.split("/").map(Number);
    return { durationSec: Number(result.format.duration), hasAudio: result.streams.some(stream => stream.codec_type === "audio"),
      ...(video ? { width: video.width, height: video.height, ...(rate && rate[1] ? { frameRate: rate[0]! / rate[1] } : {}) } : {}) };
  };
  const probe = { info, durationSec: async (source: string) => (await info(source)).durationSec } satisfies MediaProbe;
  const runner: FfmpegRunner = { slateFont: "fixture-font.ttf", run: async (args, progress, signal) => {
    encodes.push(args); if (real) await command(ffmpeg, ["-v", "error", "-threads", "1", ...args], signal);
    else { if (signal.aborted) throw signal.reason; await writeFile(args.at(-1)!, boxes); }
    progress(100);
  } };
  return { real, encodes, probe, runner, video: real ? await readFile(file) : boxes };
}
