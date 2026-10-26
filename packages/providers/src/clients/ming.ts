import { isMingModel, MING_MODELS, MING_LANGUAGES, MING_REQUEST_CHARS, MING_REFERENCE_TEXT_CHARS, type CapabilityProbe, type ClientDeclarations } from "@arke-studio/contracts";
import { ProviderRequestRejectedError } from "../types.js";
import type { FetchedArtifact, PollResult, PreparedVoiceReference, ProviderClient, SubmitRequest, SubmitResult } from "../types.js";

export interface MingSynthesis {
  status(model: string): Promise<{ ready: boolean; reason?: string }>;
  synthesize(input: { model: string; text: string; instructions?: string; language: string; reference: PreparedVoiceReference }, signal: AbortSignal): Promise<Uint8Array>;
}

/** Local synchronous jobs share the ordinary queue, provenance and cancellation contracts. */
export class MingClient implements ProviderClient {
  readonly id = "ming" as const;
  readonly declarations: ClientDeclarations = { supportsIdempotencyKey: false, supportsLookupByKey: false, supportsListRecent: false, reportsCost: false };
  constructor(private readonly host: MingSynthesis) {}
  async validateKey(): Promise<CapabilityProbe[]> {
    const states = await Promise.all(Object.keys(MING_MODELS).map(model => this.host.status(model)));
    const ready = states.some(state => state.ready);
    return ["voice-tts", "voice-clone"].map(capability => ({ capability: capability as "voice-tts" | "voice-clone", available: ready,
      ...(!ready ? { reason: states[0]?.reason ?? "Install a Ming model in Settings → Models." } : {}) }));
  }
  async submit(_key: string, request: SubmitRequest): Promise<SubmitResult> {
    const refuse = (message: string): never => { throw new ProviderRequestRejectedError(`Ming: ${message}`); };
    if (request.capability !== "voice-tts" || !isMingModel(request.model)) refuse("this speech model is unsupported.");
    const text = request.params["text"];
    if (typeof text !== "string" || !text.trim() || text.length > MING_REQUEST_CHARS) refuse("read this text in shorter parts.");
    const reference = request.voiceReference;
    if (!reference?.data.length || reference.data.length > 50 * 1024 * 1024) refuse("a saved voice recording is required.");
    if (!reference!.transcript?.trim() || reference!.transcript!.length > MING_REFERENCE_TEXT_CHARS) refuse("add the words spoken in the recording when cloning this voice.");
    const instructions = request.params["instructions"];
    if (instructions !== undefined && (typeof instructions !== "string" || instructions.length > 300)) refuse("the delivery instruction is too long.");
    const language = typeof request.params["language"] === "string" ? request.params["language"] : "en";
    if (!MING_LANGUAGES.includes(language)) refuse("this recording language is unsupported by the local reader.");
    const ready = await this.host.status(request.model);
    if (!ready.ready) refuse(ready.reason ?? "this model is not ready.");
    const deadline = AbortSignal.timeout(30 * 60_000);
    const signal = request.signal ? AbortSignal.any([request.signal, deadline]) : deadline;
    const data = await this.host.synthesize({ model: request.model, text: text as string, reference: reference!,
      language,
      ...(typeof instructions === "string" && instructions.trim() ? { instructions: instructions.trim() } : {}) }, signal);
    if (data.length < 44 || String.fromCharCode(...data.slice(0, 4)) !== "RIFF" || String.fromCharCode(...data.slice(8, 12)) !== "WAVE") throw new Error("Ming returned invalid WAV audio.");
    return { remoteId: `ming-${crypto.randomUUID()}`, acceptedAt: new Date().toISOString(), artifacts: [{ name: "speech.wav", contentType: "audio/wav", data }] };
  }
  async poll(): Promise<PollResult> { return { state: "failed", error: "Local speech completes during submit; interrupted work requires an explicit retry." }; }
  async fetchArtifacts(): Promise<FetchedArtifact[]> { throw new Error("Ming audio is returned by submit."); }
  async cancel(): Promise<void> { /* The synchronous host receives the job's abort signal. */ }
}
