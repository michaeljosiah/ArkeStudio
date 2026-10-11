import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdtemp, realpath, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { buildCanonicalAudioGraph, EffectAudioNativeDescriptorSchema, EFFECT_ANALYSIS_PROFILE,
  type EffectAudioNativeDescriptor, type ExportPlan } from "@arke-studio/contracts";
import { hashMediaFile } from "./media-file-hash.js";
import { createNodeMediaProcessRunner } from "./node-media-process.js";

export interface FrozenAudioInput { audioIndex: number; absolutePath: string; sourceHash: string; clipId?: string }
export interface EffectAudioDescribeRequest { plan: ExportPlan; inputs: readonly FrozenAudioInput[]; signal: AbortSignal }
export interface EffectAudiblePcmRequest extends EffectAudioDescribeRequest {
  /** null means the whole composition; an empty selection is valid silence. */
  selectedClipIds: readonly string[] | null;
  descriptor: EffectAudioNativeDescriptor;
  onPcm: (interleaved48kStereo: Float32Array) => Promise<void> | void;
}
export interface EffectAudioAnalysisHost {
  describe(request: EffectAudioDescribeRequest): Promise<EffectAudioNativeDescriptor>;
  renderAudiblePcm(request: EffectAudiblePcmRequest): Promise<{ descriptor: EffectAudioNativeDescriptor; pcmHash: string; sampleFrames: number }>;
}

/** CPU, pipe and graph budgets are independent of song length. No decoded PCM is spooled. */
export const EFFECT_AUDIO_NATIVE_LIMITS = Object.freeze({ graphBytes: 2 * 1024 * 1024, chunkFrames: 32768,
  stderrBytes: 16384, describeMs: 30000, idleMs: 60000, maxWallTimeMs: 60 * 60_000 });
const EPSILON = 0.000001;
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

async function executablePath(command: string): Promise<string> {
  if (isAbsolute(command) || /[\\/]/.test(command)) return realpath(resolve(command));
  for (const directory of (process.env["PATH"] ?? "").split(delimiter)) {
    for (const suffix of process.platform === "win32" ? ["", ".exe"] : [""]) {
      const candidate = join(directory, command + suffix);
      try { await access(candidate, constants.X_OK); if ((await stat(candidate)).isFile()) return await realpath(candidate); } catch { /* Next PATH entry. */ }
    }
  }
  throw new Error("The audio analysis decoder executable is unavailable");
}

function validate(request: EffectAudioDescribeRequest): FrozenAudioInput[] {
  const { plan, inputs } = request;
  if (!Number.isFinite(plan.totalSec) || plan.totalSec <= 0 || plan.totalSec > EFFECT_ANALYSIS_PROFILE.maxSeconds ||
    plan.audio.length > EFFECT_ANALYSIS_PROFILE.maxSources) throw new Error("Audio analysis exceeds its 30-minute or 128-source profile");
  const ordered = [...inputs].sort((a, b) => a.audioIndex - b.audioIndex);
  if (ordered.length !== plan.audio.length || ordered.some((input, i) => input.audioIndex !== i || !isAbsolute(input.absolutePath) || !/^[a-f0-9]{64}$/.test(input.sourceHash))) {
    throw new Error("Audio analysis needs one frozen, resolved identity for every canonical input");
  }
  return ordered;
}
async function verifyInputs(inputs: readonly FrozenAudioInput[], signal: AbortSignal): Promise<void> {
  for (const input of inputs) if (await hashMediaFile(input.absolutePath, signal) !== input.sourceHash) throw new Error("Audio analysis source changed during decoding");
}

/** A private, exclusively-created graph file avoids Windows' short process argument limit. */
async function withGraph<T>(graph: string, run: (path: string) => Promise<T>): Promise<T> {
  if (Buffer.byteLength(graph) > EFFECT_AUDIO_NATIVE_LIMITS.graphBytes) throw new Error("Audio analysis graph exceeds its byte budget");
  const base = await realpath(tmpdir()), directory = await mkdtemp(join(base, "arke-effect-audio-")), identity = await lstat(directory);
  const path = join(directory, "audio.ffgraph");
  let fileIdentity: Awaited<ReturnType<typeof lstat>> | undefined;
  try { await writeFile(path, graph, { flag: "wx" }); fileIdentity = await lstat(path); return await run(path); }
  finally {
    try {
      const current = await lstat(directory);
      if (current.dev === identity.dev && current.ino === identity.ino && !current.isSymbolicLink() && await realpath(directory) === directory) {
        const file = await lstat(path);
        if (fileIdentity && file.dev === fileIdentity.dev && file.ino === fileIdentity.ino && !file.isSymbolicLink()) await unlink(path);
        await rmdir(directory);
      }
    } catch { /* An externally redirected or replaced path is no longer ours. */ }
  }
}
function commandBudget(args: readonly string[]): void {
  if (process.platform === "win32" && args.reduce((sum, arg) => sum + arg.length + 3, 0) > 28000) {
    throw new Error("These audio source paths exceed the Windows decoder command budget; shorten the world path or source names.");
  }
}
function observe(text: string): Array<{ format: string; channels: number; layout: string; rate: number }> {
  return [...text.matchAll(/ashowinfo@arke_limiter[^\n]*fmt:(\S+) channels:(\d+) chlayout:(.*?) rate:(\d+) nb_samples:(\d+)/g)]
    .map(match => ({ format: match[1]!, channels: Number(match[2]), layout: match[3]!, rate: Number(match[4]) }));
}
function canonicalDescriptor(observed: ReturnType<typeof observe>[number], ceiling: number): EffectAudioNativeDescriptor["canonical"] {
  if (!observed || observed.format !== "dbl" || !["mono", "stereo"].includes(observed.layout) || ![1, 2].includes(observed.channels)) {
    throw new Error("Audio reaction supports canonical mono or stereo mixes; conform this channel layout before analysing it.");
  }
  return { sampleRate: observed.rate, channels: observed.channels as 1 | 2, channelLayout: observed.layout as "mono" | "stereo", sampleFormat: "dbl",
    limiterDelaySamples: Math.floor(observed.rate * 0.005) - 1,
    limiter: { attackMs: 5, releaseMs: 50, level: false, asc: false, latency: false, levelIn: 1, levelOut: 1, ceiling } };
}

/** R-10: analyze the selected contribution after the shared mix's limiter, never solo/re-limit it. */
export function createNodeEffectAudioAnalysisHost(options: { ffmpeg: string }): EffectAudioAnalysisHost {
  const identity = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    const path = await executablePath(options.ffmpeg), executableHash = await hashMediaFile(path, signal);
    const result = await createNodeMediaProcessRunner({ ffmpeg: path, ffprobe: "" }).run("ffmpeg", ["-version"], { signal, timeoutMs: 10000, maxStdoutBytes: 65536, maxStderrBytes: 16384 });
    if (result.code !== 0) throw new Error("Audio analysis decoder identity is unavailable");
    return { path, decoder: { executableHash, versionConfigHash: sha256(result.stdout) } };
  };
  return {
    async describe(request) {
      const plan = structuredClone(request.plan), inputs = validate({ ...request, plan, inputs: structuredClone(request.inputs) });
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(EFFECT_AUDIO_NATIVE_LIMITS.maxWallTimeMs)]);
      const tool = await identity(signal);
      await verifyInputs(inputs, signal);
      const ceiling = Number(Math.pow(10, (plan.mix?.limiterCeilingDb ?? -1) / 20).toFixed(6));
      let observed: ReturnType<typeof observe>[number] = { format: "dbl", channels: 2, layout: "stereo", rate: 48000 };
      if (inputs.length) {
        const graph = buildCanonicalAudioGraph(plan, inputs.map(input => input.absolutePath));
        graph.filters[graph.filters.length - 1] = `${graph.preLimiter},${graph.limiter},ashowinfo@arke_limiter[aout]`;
        await withGraph(graph.filters.join(";"), async path => {
          const args = ["-hide_banner", "-nostdin", "-loglevel", "info", "-filter_complex_threads", "1", ...graph.args,
            "-filter_complex_script", path, "-map", "[aout]", "-c:a", "aac", "-b:a", "192k", "-frames:a", "1", "-f", "null", "-"];
          commandBudget(args);
          const result = await createNodeMediaProcessRunner({ ffmpeg: tool.path, ffprobe: "" }).run("ffmpeg", args, { signal, timeoutMs: EFFECT_AUDIO_NATIVE_LIMITS.describeMs, maxStdoutBytes: 1024, maxStderrBytes: 131072 });
          if (result.code !== 0) throw new Error(signal.aborted ? "Audio analysis cancelled" : `The canonical audio format could not be observed: ${result.stderr.slice(-1500)}`);
          const samples = observe(result.stderr);
          if (!samples.length || samples.some(sample => JSON.stringify(sample) !== JSON.stringify(samples[0]))) throw new Error("The canonical audio format is unstable or unavailable");
          observed = samples[0]!;
        });
      }
      await verifyInputs(inputs, signal);
      if (await hashMediaFile(tool.path, signal) !== tool.decoder.executableHash) throw new Error("Audio analysis decoder changed during description");
      return EffectAudioNativeDescriptorSchema.parse({ profileId: "audible-pcm-v1", decoder: tool.decoder, canonical: canonicalDescriptor(observed, ceiling),
        analysis: { sampleRate: 48000, channels: 2, sampleFormat: "f32le", monoPolicy: "duplicate-unity", resamplerProfile: "swr-v1" } });
    },
    async renderAudiblePcm(request) {
      const plan = structuredClone(request.plan), inputs = validate({ ...request, plan, inputs: structuredClone(request.inputs) });
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(EFFECT_AUDIO_NATIVE_LIMITS.maxWallTimeMs)]), descriptor = EffectAudioNativeDescriptorSchema.parse(request.descriptor);
      const selected = request.selectedClipIds === null ? null : new Set(request.selectedClipIds);
      if (descriptor.canonical.limiter.ceiling !== Number(Math.pow(10, (plan.mix?.limiterCeilingDb ?? -1) / 20).toFixed(6))) throw new Error("The canonical audio limiter changed; analyse the source again");
      const tool = await identity(signal);
      if (tool.decoder.executableHash !== descriptor.decoder.executableHash || tool.decoder.versionConfigHash !== descriptor.decoder.versionConfigHash) throw new Error("Audio analysis decoder changed; analyse the source again");
      await verifyInputs(inputs, signal);
      const expected = Math.round(plan.totalSec * 48000), hash = createHash("sha256");
      let sampleFrames = 0;
      const consume = async (bytes: Buffer) => {
        signal.throwIfAborted();
        hash.update(bytes); sampleFrames += bytes.length / 8;
        if (sampleFrames > expected) throw new Error("Audio decoder exceeded the expected sample count");
        const pcm = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
        for (const value of pcm) if (!Number.isFinite(value)) throw new Error("Audio decoder returned non-finite PCM");
        await new Promise<void>((resolvePcm, rejectPcm) => {
          const finish = (error?: unknown) => { clearTimeout(timer); signal.removeEventListener("abort", abort); if (error) rejectPcm(error); else resolvePcm(); };
          const abort = () => finish(new Error("Audio analysis cancelled"));
          const timer = setTimeout(() => finish(new Error("Audio analysis consumer stopped responding")), EFFECT_AUDIO_NATIVE_LIMITS.idleMs);
          signal.addEventListener("abort", abort, { once: true });
          Promise.resolve().then(() => { signal.throwIfAborted(); return request.onPcm(pcm); }).then(() => finish(), finish);
        });
      };
      const selectedIndices = selected === null ? null : inputs.filter(input => input.clipId && selected.has(input.clipId)).map(input => input.audioIndex);
      if (!inputs.length || selectedIndices?.length === 0) {
        for (let frame = 0; frame < expected; frame += EFFECT_AUDIO_NATIVE_LIMITS.chunkFrames) {
          await consume(Buffer.alloc(Math.min(EFFECT_AUDIO_NATIVE_LIMITS.chunkFrames, expected - frame) * 8));
          await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
        }
      } else {
        const graph = audibleGraph(plan, inputs, descriptor, selectedIndices);
        await withGraph(graph.filters.join(";"), async path => {
          const args = ["-hide_banner", "-nostdin", "-loglevel", "info", "-filter_complex_threads", "1", ...graph.args,
            "-filter_complex_script", path, "-map", "[analysis]", "-c:a", "pcm_f32le", "-f", "f32le", "pipe:1"];
          commandBudget(args);
          await streamPcm(tool.path, args, signal, descriptor, Math.round(plan.totalSec * descriptor.canonical.sampleRate), consume);
        });
      }
      if (sampleFrames !== expected) throw new Error(`Audio decoder produced ${sampleFrames} frames; expected ${expected}`);
      await verifyInputs(inputs, signal);
      if (await hashMediaFile(tool.path, signal) !== tool.decoder.executableHash) throw new Error("Audio analysis decoder changed during rendering");
      return { descriptor, pcmHash: hash.digest("hex"), sampleFrames };
    },
  };
}

function audibleGraph(plan: ExportPlan, inputs: readonly FrozenAudioInput[], descriptor: EffectAudioNativeDescriptor, selected: number[] | null) {
  const graph = buildCanonicalAudioGraph(plan, inputs.map(input => input.absolutePath), 0, selected !== null);
  const { sampleRate, channelLayout, channels, limiterDelaySamples } = descriptor.canonical;
  const count = Math.round(plan.totalSec * sampleRate), analysisCount = Math.round(plan.totalSec * 48000);
  const stereo = channels === 1 ? ",pan=stereo|c0=c0|c1=c0" : "";
  graph.filters.pop();
  const limiter = `${graph.limiter}:level_in=1:level_out=1:attack=5:release=50:asc=0:latency=0`;
  if (selected === null) {
    graph.filters.push(`${graph.preLimiter},${limiter},ashowinfo@arke_limiter${stereo}[audible]`);
  } else {
    // Preserve the original channel/rate negotiation through the full mix. Only the tapped
    // contribution is conformed to that observed bus, including its canonical mono downmix.
    for (let i = 0; i < inputs.length; i++) graph.filters.push(selected.includes(i)
      ? `[at${i}]aformat=sample_fmts=dbl:sample_rates=${sampleRate}:channel_layouts=${channelLayout}[s${i}]` : `[at${i}]anullsink`);
    const labels = selected.map(i => `[s${i}]`).join("");
    graph.filters.push(`${labels}${selected.length === 1 ? "anull" : `amix=inputs=${selected.length}:normalize=0:duration=longest`},apad=whole_dur=${plan.totalSec},atrim=end_sample=${count},asetpts=PTS-STARTPTS${stereo},adelay=${limiterDelaySamples}S:all=1,atrim=end_sample=${count},asetnsamples=n=1024:p=1[selected]`);
    graph.filters.push(`${graph.preLimiter},asplit=3[limitIn][detectIn][preIn]`);
    graph.filters.push(`[limitIn]${limiter},ashowinfo@arke_limiter${stereo},asetnsamples=n=1024:p=1[limited]`);
    // The untouched limiter output remains authoritative. An equally linked peak detector
    // and quiet pilot recover gain only when cancellation makes limited/pre undefined (0/0).
    // asc is pinned off; the pilot is below the minimum limiter threshold. Do not clamp its
    // gain: native release can briefly exceed unity, and individual cancelling sources can
    // exceed the full mix ceiling. Native PCM fixtures pin this behavior across tool versions.
    graph.filters.push(`[detectIn]aeval=exprs='${channels === 1 ? "abs(val(0))" : "max(abs(val(0)),abs(val(1)))"}|${EPSILON}':c=stereo,${limiter},pan=mono|c0=c1,asetnsamples=n=1024:p=1[pilot]`);
    graph.filters.push(`[preIn]anull${stereo},adelay=${limiterDelaySamples}S:all=1,atrim=end_sample=${count},asetnsamples=n=1024:p=1[pre]`);
    // All four join inputs need identical packet lengths. Without this framing, FFmpeg join
    // silently dropped the final partial block in the 44.1 kHz fixture. Trim padding after join.
    graph.filters.push("[limited][pre][selected][pilot]join=inputs=4:channel_layout=6.1:map=0.0-FL|0.1-FR|1.0-FC|1.1-LFE|2.0-BC|2.1-SL|3.0-SR[joined]");
    graph.filters.push(`[joined]atrim=end_sample=${count},aeval=exprs='val(4)*if(eq(val(2),0),val(6)/${EPSILON},val(0)/val(2))|val(5)*if(eq(val(3),0),val(6)/${EPSILON},val(1)/val(3))':c=stereo[audible]`);
  }
  graph.filters.push(`[audible]aresample=48000:resampler=swr:filter_size=32:phase_shift=10:linear_interp=1:exact_rational=1,apad=whole_len=${analysisCount},atrim=end_sample=${analysisCount}[analysis]`);
  return graph;
}

async function streamPcm(executable: string, args: string[], signal: AbortSignal, descriptor: EffectAudioNativeDescriptor, expectedCanonicalFrames: number, consume: (bytes: Buffer) => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  const child = spawn(executable, args, { windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  let failed: Error | undefined, stderr = "", line = "", observed = false, canonicalFrames = 0, carry = Buffer.alloc(0);
  const fail = (error: Error) => { failed ??= error; child.kill("SIGKILL"); };
  const abort = () => fail(new Error("Audio analysis cancelled"));
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => fail(new Error("Audio analysis exceeded its time budget")), EFFECT_AUDIO_NATIVE_LIMITS.maxWallTimeMs);
  let idle: ReturnType<typeof setTimeout>;
  const activity = () => { clearTimeout(idle); idle = setTimeout(() => fail(new Error("Audio analysis decoder or consumer stopped responding")), EFFECT_AUDIO_NATIVE_LIMITS.idleMs); };
  activity();
  child.stderr.on("data", (bytes: Buffer) => {
    const text = bytes.toString(); stderr = (stderr + text).slice(-EFFECT_AUDIO_NATIVE_LIMITS.stderrBytes); line += text;
    const last = line.lastIndexOf("\n");
    if (last >= 0) {
      const complete = line.slice(0, last + 1);
      for (const match of complete.matchAll(/ashowinfo@arke_limiter[^\n]*nb_samples:(\d+)/g)) canonicalFrames += Number(match[1]);
      for (const sample of observe(complete)) {
        observed = true;
        const canonical = descriptor.canonical;
        if (sample.format !== canonical.sampleFormat || sample.rate !== canonical.sampleRate || sample.channels !== canonical.channels || sample.layout !== canonical.channelLayout) fail(new Error("Canonical audio format changed between description and decode"));
      }
      line = line.slice(last + 1);
    }
    if (line.length > 65536) fail(new Error("Audio decoder exceeded its diagnostic line budget"));
  });
  const closed = new Promise<void>((resolveClose, rejectClose) => {
    child.once("error", error => { failed ??= error; });
    child.once("close", code => code === 0 && !failed ? resolveClose() : rejectClose(failed ?? new Error(stderr.trim() || `Audio decoder exited ${code}`)));
  });
  void closed.catch(() => {});
  try {
    if (signal.aborted) abort();
    for await (const raw of child.stdout) {
      if (failed) throw failed;
      activity();
      const bytes = Buffer.concat([carry, raw as Buffer]), complete = bytes.length - bytes.length % 8;
      for (let start = 0; start < complete; start += EFFECT_AUDIO_NATIVE_LIMITS.chunkFrames * 8) await consume(bytes.subarray(start, Math.min(complete, start + EFFECT_AUDIO_NATIVE_LIMITS.chunkFrames * 8)));
      carry = Buffer.from(bytes.subarray(complete));
    }
    await closed;
    if (carry.length || !observed || canonicalFrames !== expectedCanonicalFrames) throw new Error(`Audio decoder returned incomplete or unverified PCM (${canonicalFrames}/${expectedCanonicalFrames} canonical frames)`);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error))); await closed.catch(() => {}); throw failed;
  } finally { clearTimeout(timer); clearTimeout(idle!); signal.removeEventListener("abort", abort); }
}
