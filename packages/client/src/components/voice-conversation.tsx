import { useEffect, useRef, useState } from "react";
import type { VoiceConversationCommand, VoiceConversationResponse } from "@arke-studio/contracts";
import { onVoiceConversationReply, send, useConnection } from "../lib/store.js";
import { claimRead, releaseRead, stopReplyRead } from "../lib/reply-reads.js";
import { dismissPlayback, usePlayback } from "../lib/audio.js";
const captureUrl = new URL("../lib/voice-capture.worklet.js?no-inline", import.meta.url).href;

interface Capture {
  id: string; closed: boolean; ready: boolean; skipped: boolean;
  context?: AudioContext; stream?: MediaStream; node?: AudioWorkletNode; source?: MediaStreamAudioSourceNode;
  playback: Set<AudioBufferSourceNode>; next: number;
}
type State = Extract<VoiceConversationResponse, { type: "state" }>["state"];
const labels: Record<State, string> = { starting: "Starting voice…", listening: "Listening", thinking: "Thinking", speaking: "Speaking", ended: "Voice ended", failed: "Voice unavailable" };

/** Explicit live sending is separate from editable dictation. Capture is component
 * owned and every late permission/audio callback must re-check that ownership. */
export function VoiceConversation({ worldId, conversationId, available, model, onActive, canStart }: { worldId: string; conversationId: string; available: boolean; model: string; onActive(active: boolean): void; canStart: boolean }) {
  const connection = useConnection();
  const playback = usePlayback();
  const capture = useRef<Capture | null>(null);
  const [state, setState] = useState<State>("ended"), [reason, setReason] = useState<string | null>(null);
  const [silence, setSilence] = useState(650);
  const [lastText, setLastText] = useState("");
  const active = state !== "ended" && state !== "failed";
  useEffect(() => { onActive(active); return () => onActive(false); }, [active, onActive]);
  function command(owner: Capture, value: VoiceConversationCommand["command"]): boolean {
    return send({ kind: "voice-conversation", session: owner.id, command: value });
  }
  function clearPlayback(owner: Capture): void {
    for (const node of owner.playback) { try { node.stop(); } catch { /* Already ended. */ } }
    owner.playback.clear(); owner.next = 0;
  }
  function end(notice?: string): void {
    const owner = capture.current;
    capture.current = null;
    if (owner) {
      owner.closed = true; releaseRead(owner.id); command(owner, { action: "end" }); clearPlayback(owner);
      owner.node?.disconnect(); owner.source?.disconnect();
      for (const track of owner.stream?.getTracks() ?? []) track.stop();
      void owner.context?.close().catch(() => {});
    }
    setState(notice ? "failed" : "ended"); setReason(notice ?? null);
  }
  useEffect(() => { if (capture.current && playback.clip && (playback.status === "loading" || playback.status === "playing")) end(); }, [playback.clip?.id, playback.status]);
  useEffect(() => {
    const stop = () => end();
    const hidden = () => { if (document.hidden) stop(); };
    window.addEventListener("blur", stop); document.addEventListener("visibilitychange", hidden);
    return () => { window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", hidden); stop(); };
  }, [worldId, conversationId]);
  useEffect(() => { if (connection !== "open" || !available) end(); }, [connection, available]);
  useEffect(() => onVoiceConversationReply(frame => {
    const owner = capture.current;
    if (!owner || owner.closed || frame.session !== owner.id) return;
    const response = frame.response;
    if (response.type === "state") {
      if (response.state === "ended" || response.state === "failed") { end(response.reason); return; }
      owner.ready = response.state !== "starting"; setState(response.state);
      if (response.state === "listening") owner.skipped = false;
    } else if (response.type === "interrupted") {
      clearPlayback(owner); owner.skipped = false;
    } else if (response.type === "text") {
      if (response.role === "user") setLastText(`You: ${response.text}`);
    } else if (response.type === "audio" && !owner.skipped && owner.context) {
      const raw = atob(response.audioBase64), context = owner.context;
      if (raw.length % 2 || raw.length > 8192 || owner.playback.size > 75 || owner.next - context.currentTime > 1.5) { end("Audio playback fell behind. Start voice again."); return; }
      const buffer = context.createBuffer(1, raw.length / 2, 24000), values = buffer.getChannelData(0);
      for (let i = 0; i < values.length; i++) {
        const sample = raw.charCodeAt(i * 2) | raw.charCodeAt(i * 2 + 1) << 8;
        values[i] = (sample >= 32768 ? sample - 65536 : sample) / 32768;
      }
      const node = context.createBufferSource(); node.buffer = buffer; node.connect(context.destination);
      owner.playback.add(node); node.onended = () => { owner.playback.delete(node); node.disconnect(); };
      const at = Math.max(context.currentTime + .03, owner.next);
      node.start(at); owner.next = at + buffer.duration;
    }
  }), [worldId, conversationId]);
  async function start(): Promise<void> {
    if (capture.current || !canStart || !available || connection !== "open") return;
    stopReplyRead(); dismissPlayback(); setState("starting"); setReason(null); setLastText("");
    const owner: Capture = { id: crypto.randomUUID(), closed: false, ready: false, skipped: false, playback: new Set(), next: 0 };
    capture.current = owner; claimRead(owner.id, () => end(), true);
    try {
      const context = owner.context = new AudioContext({ sampleRate: 16000 });
      await context.resume();
      if (context.sampleRate !== 16000) throw new Error("Unsupported capture rate");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (owner.closed || capture.current !== owner) { for (const track of stream.getTracks()) track.stop(); return; }
      owner.stream = stream;
      await context.audioWorklet.addModule(captureUrl);
      if (owner.closed || capture.current !== owner) return;
      owner.source = context.createMediaStreamSource(stream);
      owner.node = new AudioWorkletNode(context, "arke-voice-capture");
      owner.node.port.onmessage = event => {
        if (owner.closed || capture.current !== owner || !owner.ready) return;
        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (bytes.length !== 1280) { end("Microphone capture stopped. Start voice again."); return; }
        let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
        if (!command(owner, { action: "audio", audioBase64: btoa(binary) })) end("The connection ended. Start voice again after reconnecting.");
      };
      owner.source.connect(owner.node); owner.node.connect(context.destination);
      if (!command(owner, { action: "open", worldId, conversationId, silenceMs: silence, cloudConsent: true })) throw new Error("Disconnected");
    } catch {
      if (capture.current === owner) end("Voice could not start. Allow microphone access and check local speech, the Kokoro narrator and your selected model.");
    }
  }
  if (!available) return null;
  return <div className="fy-cx__voice-conversation">
    {!active ? <>
      <button type="button" className="fy-cx__tool" disabled={connection !== "open" || !canStart} onClick={() => { void start(); }}>Talk with Arke</button>
      <label>Pause before reply <select aria-label="Pause before reply" value={silence} onChange={event => setSilence(Number(event.target.value))}>
        <option value={650}>0.65 seconds</option><option value={1000}>1 second</option><option value={1500}>1.5 seconds</option><option value={2000}>2 seconds</option>
      </select></label>
      <small>Starting sends recognized speech to {model} until you end voice. Requested background lookups send this world's sources to the same model. Replies are kept in this conversation. Say a correction or ask to continue. Dictation still creates an editable draft.</small>
    </> : <>
      <span role="status">{labels[state]}</span>
      <button type="button" className="fy-cx__tool" onClick={() => { const owner = capture.current; if (owner) { owner.skipped = true; clearPlayback(owner); } }}>Skip speech</button>
      <button type="button" className="fy-cx__tool" onClick={() => { const owner = capture.current; if (owner) { clearPlayback(owner); command(owner, { action: "interrupt" }); } }}>Interrupt reply</button>
      <button type="button" className="fy-cx__tool" onClick={() => end()}>End voice</button>
      {lastText && <small>{lastText}</small>}
    </>}
    {reason && <span role="alert">{reason}</span>}
  </div>;
}
