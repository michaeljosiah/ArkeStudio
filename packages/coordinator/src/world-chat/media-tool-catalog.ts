const source = { oneOf: [
  { type: "object", properties: { kind: { const: "production-take" }, productionId: { type: "string" }, takeId: { type: "string" } }, required: ["kind", "productionId", "takeId"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "bench-take" }, sessionId: { type: "string" }, takeId: { type: "string" } }, required: ["kind", "sessionId", "takeId"], additionalProperties: false },
  { type: "object", properties: { kind: { const: "artifact" }, id: { type: "string" } }, required: ["kind", "id"], additionalProperties: false },
] } as const;
const range = { type: "object", properties: { startSec: { type: "number", minimum: 0 }, endSec: { type: "number", minimum: 0 } }, required: ["startSec", "endSec"], additionalProperties: false } as const;
const streamIndex = { type: "integer", minimum: 0, maximum: 255 } as const;
export const AGENT_MEDIA_TOOL_CATALOG = [
  { name: "inspect_media", description: "Inspect verified stream metadata for an immutable production take, Bench take or artifact. No paths or URLs. Hashless or changed sources are refused. Returns stream indices, duration, dimensions and original audio rate/channels; metadata does not establish pixel quality, motion or audio performance.",
    inputSchema: { type: "object", properties: { source }, required: ["source"], additionalProperties: false } },
  { name: "sample_video", description: "Inspect 1–8 actual video frames in a positive interval of at most 60 seconds, measured from this take's start. Returns PNG images and actual decoded source timestamps (including segment offsets). Choose streamIndex explicitly if video tracks are ambiguous. Shares image-model/privacy and per-run image budgets. Sparse still frames never establish continuous motion, flicker, sound or sync; report unreviewed gaps.",
    inputSchema: { type: "object", properties: { source, range, count: { type: "integer", minimum: 1, maximum: 8, default: 3 }, streamIndex }, required: ["source", "range"], additionalProperties: false } },
  { name: "analyze_audio_signal", description: "Measure original-channel decoded samples in a positive interval of at most 60 seconds from this take's start. Choose streamIndex explicitly for ambiguous audio tracks. Reports per-channel sample peak, RMS, silence (-60 dBFS) and full-scale sample flags with source/PCM hashes. No downmix or resampling. This is signal measurement, not listening, transcription, speech/performance judgment, true peak, LUFS, loudness range or audiovisual sync.",
    inputSchema: { type: "object", properties: { source, range, streamIndex }, required: ["source", "range"], additionalProperties: false } },
] as const;
