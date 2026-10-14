import { createHash } from "node:crypto";
import { AGENT_LISTENING_LIMITS, AgentAudioListeningSchema, AgentListeningFocusesSchema, AgentListeningResultSchema,
  type AgentAudioListening, type AgentListeningFocus, type AgentListeningResult } from "@arke-studio/contracts";
import { readSpeechWav, writeSpeechWav } from "../audio/speech-wav.js";

/** A local, unmetered worker. No URL, provider key, cloud fallback or transcript input. */
export interface AgentAudioListener {
  ready(signal: AbortSignal): Promise<boolean>;
  listen(bytes: Uint8Array, focuses: AgentListeningFocus[], signal: AbortSignal): Promise<AgentListeningResult>;
}
export async function listenToAgentAudio(input: { bytes: Uint8Array; durationSec: number; streamIndex: number;
  focuses: AgentListeningFocus[]; listener: AgentAudioListener; signal: AbortSignal }): Promise<AgentAudioListening> {
  input.signal.throwIfAborted();
  const focuses = AgentListeningFocusesSchema.parse(input.focuses);
  if (input.bytes.length > 960044 || !Number.isFinite(input.durationSec) || input.durationSec <= 0 || input.durationSec > 30) throw new Error("Listening clip exceeds its profile");
  const pcm = readSpeechWav(input.bytes);
  if (pcm.rate !== 16000 || Math.abs(pcm.samples.length / pcm.rate - input.durationSec) > .000001 ||
    !Buffer.from(input.bytes).equals(Buffer.from(writeSpeechWav(pcm)))) throw new Error("Invalid canonical listening WAV");
  const deadline = new AbortController(), signal = AbortSignal.any([input.signal, deadline.signal]);
  const timer = setTimeout(() => deadline.abort(), AGENT_LISTENING_LIMITS.timeoutMs);
  let onAbort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Audio listening stopped or exceeded its deadline"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    signal.throwIfAborted();
    const result = AgentListeningResultSchema.parse(await Promise.race([input.listener.listen(input.bytes, focuses, signal), stopped]));
    signal.throwIfAborted();
    return AgentAudioListeningSchema.parse({ streamIndex: input.streamIndex, focuses, ...result,
    derivative: { profile: "arke-listening-16khz-mono-v1", hash: `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`,
      byteLength: input.bytes.length, durationSec: input.durationSec, sampleRate: 16000, channels: 1, format: "pcm-s16le-wav" },
      basis: "audio-model-interpretation", timing: "no-measured-event-times" });
  } finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
}
