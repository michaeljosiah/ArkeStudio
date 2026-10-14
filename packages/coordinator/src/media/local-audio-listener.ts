import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { AGENT_LISTENING_LIMITS, AgentListeningFocusesSchema, AgentListeningResultSchema } from "@arke-studio/contracts";
import type { AgentAudioListener } from "./agent-listening.js";

/** Offline flags are not a credential boundary: the optional worker gets only runtime variables. */
export function audioListenerChildEnvironment(host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const names = ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "HOME", "CUDA_PATH", "CUDA_VISIBLE_DEVICES",
    "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "OMP_NUM_THREADS", "MKL_NUM_THREADS"] as const;
  const env: Record<string, string> = {};
  for (const name of names) { const value = host[name]; if (value) env[name] = value; }
  return { ...env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1",
    PYTHONNOUSERSITE: "1", TOKENIZERS_PARALLELISM: "false" };
}

/** Opt-in host setup; absent/incomplete paths fail closed without affecting app startup. */
export function localAudioListenerOptions(worker: string, env: NodeJS.ProcessEnv = process.env): { agentAudioListener?: AgentAudioListener } {
  const python = env["ARKE_AUDIO_LISTENER_PYTHON"], modelDirectory = env["ARKE_AUDIO_LISTENER_MODEL"];
  return python && modelDirectory && [python, worker, modelDirectory].every(isAbsolute)
    ? { agentAudioListener: createLocalAudioListener({ python, worker, modelDirectory }) } : {};
}

/** Explicit local executable and offline model directory; never download or invoke a shell.
 * Native process completion follows close so world-close cannot race live output handles. */
export function createLocalAudioListener(options: { python: string; worker: string; modelDirectory: string }, spawnProcess = spawn): AgentAudioListener {
  if (![options.python, options.worker, options.modelDirectory].every(isAbsolute)) throw new Error("Audio listener paths must be absolute");
  const pending = new Map<AbortSignal, Set<Promise<unknown>>>();
  const run = (probe: boolean, input: string, signal: AbortSignal): Promise<unknown> => {
    const task = new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("Audio listening stopped")); return; }
    const child = spawnProcess(options.python, ["-I", options.worker, "--model", options.modelDirectory, ...(probe ? ["--probe"] : [])], {
      windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"],
      env: audioListenerChildEnvironment(),
    });
    let output = Buffer.alloc(0), stderrBytes = 0, failed = false;
    const stop = () => { failed = true; child.kill("SIGKILL"); };
    const timer = setTimeout(stop, probe ? 20_000 : AGENT_LISTENING_LIMITS.timeoutMs);
    signal.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > 65536) { stop(); return; }
      output = Buffer.concat([output, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 65536) stop(); });
    child.on("error", () => { failed = true; });
    child.stdin.on("error", () => { failed = true; });
    child.on("close", code => {
      clearTimeout(timer); signal.removeEventListener("abort", stop);
      // Worker errors may include paths, library diagnostics or media text. Never forward them.
      if (failed || code !== 0 || signal.aborted) { reject(new Error("Local audio listening failed, was stopped or exceeded its bounded profile")); return; }
      try { resolve(JSON.parse(output.toString("utf8"))); } catch { reject(new Error("Invalid local audio listener response")); }
    });
    child.stdin.end(input);
    if (signal.aborted) stop();
    });
    const group = pending.get(signal) ?? new Set<Promise<unknown>>(); group.add(task); pending.set(signal, group);
    const release = () => { group.delete(task); if (!group.size) pending.delete(signal); };
    void task.then(release, release);
    return task;
  };
  return {
    async drain(signal) { await Promise.allSettled(pending.get(signal) ?? []); },
    async ready(signal) {
      signal.throwIfAborted();
      try {
        const files = await Promise.all([stat(options.python), stat(options.worker), stat(options.modelDirectory)]);
        if (!files[0]!.isFile() || !files[1]!.isFile() || !files[2]!.isDirectory()) return false;
        const response = await run(true, "", signal) as { ready?: boolean };
        signal.throwIfAborted(); return response?.ready === true;
      } catch { signal.throwIfAborted(); return false; }
    },
    async listen(bytes, focuses, signal) {
      if (bytes.length < 46 || bytes.length > 960044) throw new Error("Listening WAV exceeds its bounded profile");
      return AgentListeningResultSchema.parse(await run(false, JSON.stringify({ audio: Buffer.from(bytes).toString("base64"), focuses: AgentListeningFocusesSchema.parse(focuses) }), signal));
    },
  };
}
