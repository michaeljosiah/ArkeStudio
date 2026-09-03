import { spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { SPOOL_LIMIT_BYTES, spoolDir } from "@arke-studio/coordinator";

type SpawnLike = typeof nodeSpawn;

export interface StageExportSpec {
  width: number;
  height: number;
  frameRate: number;
  frameCount: number;
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; reason: string };

interface Job {
  dir: string;
  path: string;
  frameBytes: number;
  frameCount: number;
  nextFrame: number;
  writing: boolean;
  finishing: boolean;
  child: ReturnType<SpawnLike>;
  done: Promise<void>;
}

function validSpec(spec: unknown): spec is StageExportSpec {
  if (typeof spec !== "object" || spec === null) return false;
  const value = spec as Partial<StageExportSpec>;
  return typeof value.width === "number" && Number.isInteger(value.width) && value.width >= 2 && value.width <= 4096 && value.width % 2 === 0 &&
    typeof value.height === "number" && Number.isInteger(value.height) && value.height >= 2 && value.height <= 4096 && value.height % 2 === 0 &&
    value.frameRate === 30 && typeof value.frameCount === "number" && Number.isInteger(value.frameCount) && value.frameCount >= 1 && value.frameCount <= 18_000;
}

/** A bounded, backpressured raw-frame pipe into the app's pinned ffmpeg. */
export function createStageExporter(root: string, ffmpeg: string | null, spawn: SpawnLike = nodeSpawn) {
  const jobs = new Map<string, Job>();
  let starting = false;
  let generation = 0;

  const cancel = async (jobId: string): Promise<void> => {
    const job = jobs.get(jobId);
    if (job === undefined) return;
    jobs.delete(jobId);
    if (job.child.exitCode === null) job.child.kill("SIGKILL");
    await job.done.catch(() => {});
    await rm(job.dir, { recursive: true, force: true }).catch(() => {});
  };

  return {
    async start(spec: unknown): Promise<Result<{ jobId: string }>> {
      if (ffmpeg === null) return { ok: false, reason: "playblast export needs the bundled ffmpeg" };
      if (!validSpec(spec)) return { ok: false, reason: "the Stage export dimensions or frame count are invalid" };
      if (starting || jobs.size > 0) return { ok: false, reason: "another Stage export is already running" };
      starting = true;
      const startedIn = generation;
      const jobId = randomUUID();
      const dir = join(spoolDir(root), jobId);
      const path = join(dir, "playblast.mp4");
      let child: ReturnType<SpawnLike>;
      try {
        await mkdir(dir, { recursive: true });
        if (generation !== startedIn) {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
          starting = false;
          return { ok: false, reason: "the Stage export was cancelled" };
        }
        child = spawn(ffmpeg, [
          "-hide_banner", "-loglevel", "error", "-y",
          "-f", "rawvideo", "-pixel_format", "rgba",
          "-video_size", `${spec.width}x${spec.height}`,
          "-framerate", String(spec.frameRate), "-i", "pipe:0",
          "-an", "-vf", "vflip,format=yuv420p",
          "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-threads", "1",
          "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact",
          "-frames:v", String(spec.frameCount), "-fs", String(SPOOL_LIMIT_BYTES), "-movflags", "+faststart", path,
        ], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
      } catch (error) {
        starting = false;
        await rm(dir, { recursive: true, force: true }).catch(() => {});
        return { ok: false, reason: `ffmpeg could not start: ${String(error)}` };
      }
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 16_384) stderr += chunk.toString().slice(0, 16_384 - stderr.length);
      });
      // A closed ffmpeg pipe reports through both the write callback and the stream event.
      // The callback returns the refusal; this listener keeps the duplicate event from escaping.
      child.stdin?.on("error", () => {});
      const done = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        child.on("error", (error) => finish(error));
        child.on("exit", (code) => finish(code === 0 ? undefined : new Error(stderr.trim() || `ffmpeg exited ${code}`)));
      });
      void done.catch(() => {});
      jobs.set(jobId, {
        dir,
        path,
        frameBytes: spec.width * spec.height * 4,
        frameCount: spec.frameCount,
        nextFrame: 0,
        writing: false,
        finishing: false,
        child,
        done,
      });
      starting = false;
      return { ok: true, jobId };
    },

    async write(jobId: string, index: number, bytes: Uint8Array): Promise<Result> {
      const job = jobs.get(jobId);
      if (job === undefined) return { ok: false, reason: "that Stage export is no longer active" };
      if (job.finishing) return { ok: false, reason: "that Stage export is already finishing" };
      if (job.nextFrame >= job.frameCount) return { ok: false, reason: `the Stage export already has all ${job.frameCount} frames` };
      if (job.writing || index !== job.nextFrame) return { ok: false, reason: `the Stage export expected frame ${job.nextFrame}` };
      if (bytes.byteLength !== job.frameBytes) return { ok: false, reason: "the Stage frame has the wrong byte length" };
      job.writing = true;
      try {
        await new Promise<void>((resolve, reject) => {
          job.child.stdin!.write(bytes, (error) => error ? reject(error) : resolve());
        });
        job.nextFrame += 1;
        return { ok: true };
      } catch (error) {
        await cancel(jobId);
        return { ok: false, reason: `ffmpeg could not accept frame ${index}: ${String(error)}` };
      } finally {
        job.writing = false;
      }
    },

    async finish(jobId: string): Promise<Result<{ path: string }>> {
      const job = jobs.get(jobId);
      if (job === undefined) return { ok: false, reason: "that Stage export is no longer active" };
      if (job.finishing) return { ok: false, reason: "that Stage export is already finishing" };
      if (job.writing || job.nextFrame !== job.frameCount) {
        await cancel(jobId);
        return { ok: false, reason: `the Stage export ended after ${job.nextFrame} of ${job.frameCount} frames` };
      }
      job.finishing = true;
      job.child.stdin!.end();
      try {
        await job.done;
        const info = await stat(job.path);
        if (!info.isFile() || info.size === 0 || info.size >= SPOOL_LIMIT_BYTES) {
          throw new Error("ffmpeg produced an empty or oversized playblast");
        }
        jobs.delete(jobId);
        return { ok: true, path: job.path };
      } catch (error) {
        await cancel(jobId);
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    cancel,
    async cancelAll(): Promise<void> {
      generation += 1;
      await Promise.all([...jobs.keys()].map(cancel));
    },
  };
}

export type StageExporter = ReturnType<typeof createStageExporter>;
