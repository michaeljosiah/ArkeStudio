import { useEffect, useRef, useState } from "react";
import {
  formatMicroUsd, formatSeconds, pickableArtifacts,
  type ArtifactSidecar, type ProductionBundle, type ScriptCue, type WorldBundle,
} from "@arke-studio/contracts";
import { ReferencePickerBody, type PickerSource } from "./reference-picker.js";
import { generateDramaSound, subscribeDramaSound, uploadArtifacts, type DramaSound } from "../lib/store.js";
import { recordingToWav } from "../lib/wav.js";

import { Button } from "./ui.js";

const CUE_LABEL = { sound: "Sound", ambience: "Ambience", music: "Music" } as const;

/** How many cues across the production's scripts place each sound (230w): uses, never stored. */
export function soundUses(production: ProductionBundle): Map<string, number> {
  const uses = new Map<string, number>();
  for (const entry of production.episodeScripts ?? []) {
    for (const block of entry.script.blocks) {
      if ((block.kind === "sound" || block.kind === "ambience" || block.kind === "music") && block.soundArtifact) {
        uses.set(block.soundArtifact, (uses.get(block.soundArtifact) ?? 0) + 1);
      }
    }
  }
  return uses;
}

const words = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3));

/**
 * The world's and this production's audio as picker rows (230w): ranked against the cue's words,
 * grouped Sound, Ambience or Music by what each was made for, with how many cues use it.
 */
export function soundSources(artifacts: readonly ArtifactSidecar[], production: ProductionBundle, heard: string): { all: PickerSource[]; mine: PickerSource[] } {
  const uses = soundUses(production);
  const wanted = words(heard);
  const rows = pickableArtifacts(artifacts).filter((artifact) => artifact.kind === "audio" && (artifact.production === undefined || artifact.production === production.meta.id))
    .map((artifact) => {
      const generation = artifact.generation?.source === "sound" ? artifact.generation : null;
      const said = generation ? `${generation.name} ${generation.heard} ${generation.prompt}` : artifact.file;
      const score = [...words(said)].filter((word) => wanted.has(word)).length;
      const used = uses.get(artifact.id) ?? 0;
      const row: PickerSource = {
        key: `artifact:${artifact.id}`, kind: "audio", name: generation?.name ?? artifact.file,
        meta: [artifact.mediaInfo ? formatSeconds(artifact.mediaInfo.durationSec) : null, used > 0 ? `${used} use${used === 1 ? "" : "s"}` : null,
          artifact.production === undefined ? "world" : null].filter(Boolean).join(" · "),
        group: generation ? CUE_LABEL[generation.cue] : "Other",
        durationSec: artifact.mediaInfo?.durationSec ?? null,
        pick: { source: "artifact", artifactId: artifact.id },
      };
      return { row, score, mine: artifact.production === production.meta.id };
    })
    .sort((a, b) => b.score - a.score || a.row.name.localeCompare(b.row.name));
  return { all: rows.map((entry) => entry.row), mine: rows.filter((entry) => entry.mine).map((entry) => entry.row) };
}

/**
 * Add a sound (design turn 230w–y, SPEC-057 R-43): turn 69's picker, filtered to audio, in single
 * pick, with Generate and Record beside Upload — and Generate's panel in the same dialog, never a
 * new one. What it places is an artifact, so a recurring sound is made once and placed by every cue.
 */
export function AddSoundDialog({ open, onClose, world, production, cue, onPlace }: {
  open: boolean; onClose: () => void; world: WorldBundle; production: ProductionBundle; cue: ScriptCue; onPlace: (artifactId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<"pick" | "generate" | "record">("pick");
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) { setView("pick"); node.showModal?.(); }
    if (!open && node.open) node.close?.();
  }, [open]);
  const sources = soundSources(world.artifacts, production, cue.heard);
  const place = (artifactId: string) => { onPlace(artifactId); dialog.current?.close?.(); onClose(); };
  return (
    <dialog ref={dialog} className="fy-gendialog fy-gendialog--wide fy-ad-sound" aria-label="Add a sound" onClose={onClose}
      onClick={(event) => { if (event.target === event.currentTarget) dialog.current?.close?.(); }}>
      <div className="fy-gendialog__panel">
        {open && view === "pick" && (
          <ReferencePickerBody mode="slot" only="audio" budget="none" model={null} carried={[]} worldSlug={world.meta.slug}
            title="Add a sound" note={`For: ${cue.heard}`} world={sources.all} session={sources.mine} sessionLabel="This production"
            onChoose={(pick) => { if (pick.source === "artifact") place(pick.artifactId); }}
            onUpload={() => uploadArtifacts(world.meta.worldId, undefined, production.meta.id)}
            actions={[{ label: "Generate", onPress: () => setView("generate") }, { label: "Record", onPress: () => setView("record") }]}
            onClose={() => dialog.current?.close?.()} />
        )}
        {open && view === "generate" && (
          <GeneratePanel world={world} production={production} cue={cue} onBack={() => setView("pick")} onMade={place} />
        )}
        {open && view === "record" && (
          <RecordPanel world={world} production={production} cue={cue} onBack={() => setView("pick")} />
        )}
      </div>
    </dialog>
  );
}

/** The prompt Arke would send (R-44): the script's words, asked close and dry — distance is the mix's. */
export function defaultPrompt(cue: Pick<ScriptCue, "kind" | "heard">): string {
  return cue.kind === "music" ? `${cue.heard.trim()} Instrumental.` : `${cue.heard.trim()} Close and dry, no reverb, no music.`;
}

/**
 * Generate (230x/y): the script's words, read-only; What's sent, editable; the engine; the length;
 * a loop; the name to save it as — and the price on the button. An ambience is two loops.
 */
function GeneratePanel({ world, production, cue, onBack, onMade }: {
  world: WorldBundle; production: ProductionBundle; cue: ScriptCue; onBack: () => void; onMade: (artifactId: string) => void;
}) {
  const [prompt, setPrompt] = useState(() => defaultPrompt(cue));
  const [automatic, setAutomatic] = useState(cue.kind !== "music");
  const [seconds, setSeconds] = useState(cue.kind === "music" ? 60 : 5);
  const [loop, setLoop] = useState(false);
  const [name, setName] = useState(() => cue.heard.split(/\s+/).slice(0, 5).join(" ").replace(/[.,;:]$/, "") || CUE_LABEL[cue.kind]);
  const [quote, setQuote] = useState<DramaSound | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const durationSec = cue.kind === "ambience" || automatic ? null : seconds;
  const input = { cue: cue.kind, heard: cue.heard, prompt: prompt.trim() || cue.heard, durationSec, ...(cue.kind === "sound" && loop ? { loop } : {}), name: name.trim() || CUE_LABEL[cue.kind] };
  const key = JSON.stringify(input);
  useEffect(() => {
    setQuote(null);
    const timer = setTimeout(() => { asked.current = generateDramaSound(world.meta.worldId, production.meta.id, { ...input, quoteOnly: true }); }, 300);
    return () => clearTimeout(timer);
  }, [key]);
  useEffect(() => subscribeDramaSound((result) => {
    if (result.requestId === asked.current) { setQuote(result); if (result.disposition === "refused") setFailure(result.reason ?? "Not priced."); }
    if (result.requestId === making) {
      setMaking(null);
      if (result.disposition === "made" && result.artifactIds?.[0]) onMade(result.artifactIds[0]);
      else setFailure(result.reason ?? "Not made.");
    }
  }), [making, key]);
  const priced = quote?.disposition === "quoted" ? quote.quote : undefined;
  const engine = cue.kind === "music" ? "Eleven Music" : "ElevenLabs Sound Effects v2";
  return (
    <section className="fy-ad-gen" aria-label={`Generate ${CUE_LABEL[cue.kind].toLowerCase()}`}>
      <header><button type="button" className="fy-linkbtn" onClick={onBack}>‹ Sounds</button><h2>Generate {CUE_LABEL[cue.kind].toLowerCase()}</h2></header>
      <label>In the script<textarea readOnly value={cue.heard} rows={2} /></label>
      <label>What's sent<textarea value={prompt} rows={3} maxLength={2_000} onChange={(event) => setPrompt(event.target.value)} /></label>
      <div className="fy-ad-gen__row"><span>Engine</span><b>{engine}</b></div>
      {cue.kind === "ambience" ? (
        <div className="fy-ad-gen__row"><span>Length</span><b>Two seamless loops · 30 s and 23 s</b></div>
      ) : (
        <div className="fy-ad-gen__row">
          <span>Length</span>
          <label><input type="radio" checked={automatic} onChange={() => setAutomatic(true)} /> Automatic</label>
          <label><input type="radio" checked={!automatic} onChange={() => setAutomatic(false)} /> Set</label>
          {!automatic && <input aria-label="Seconds" type="number" min={cue.kind === "music" ? 3 : 0.5} max={cue.kind === "music" ? 300 : 30} step={0.5}
            value={seconds} onChange={(event) => setSeconds(Number(event.target.value))} />}
        </div>
      )}
      {cue.kind === "sound" && <label className="fy-ad-gen__check"><input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} /> Loop seamlessly</label>}
      <label>Save as<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
      {priced && <small className="fy-ad-gen__note">{priced.requests.map((request) => `${request.engine}${request.durationSec ? ` · ${request.durationSec} s` : " · length chosen by the model"}${request.loop ? " · loop" : ""}`).join("; ")}</small>}
      {failure && <p role="alert" className="fy-ad-gen__fail">{failure}</p>}
      <footer>
        <Button variant="ghost" onClick={onBack}>Back</Button>
        <Button variant="primary" disabled={!priced || making !== null} onClick={() => {
          setFailure(null);
          const requestId = generateDramaSound(world.meta.worldId, production.meta.id, { ...input, quoteToken: priced!.token });
          if (requestId === null) setFailure("The studio is disconnected."); else setMaking(requestId);
        }}>{making ? "Making…" : `Generate${priced ? ` · ${formatMicroUsd(priced.estimatedMicroUsd)}` : ""}`}</Button>
      </footer>
    </section>
  );
}

/** Record (230w): a sound made at the microphone, kept as this production's artifact, then picked. */
function RecordPanel({ world, production, cue, onBack }: { world: WorldBundle; production: ProductionBundle; cue: ScriptCue; onBack: () => void }) {
  const [phase, setPhase] = useState<"idle" | "recording" | "saving" | "saved">("idle");
  const [failure, setFailure] = useState<string | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const start = async () => {
    setFailure(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const next = new MediaRecorder(stream);
      next.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
      next.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        setPhase("saving");
        try {
          const wav = await recordingToWav(new Blob(chunks, { type: next.mimeType }));
          const base = cue.heard.split(/\s+/).slice(0, 4).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "") || "recording";
          const file = new File([wav as BlobPart], `${base}.wav`, { type: "audio/wav" });
          const sent = uploadArtifacts(world.meta.worldId, [file], production.meta.id);
          if (sent.requestId === null) throw new Error(sent.reason ?? "The studio is disconnected.");
          setPhase("saved");
        } catch (error) { setFailure(error instanceof Error ? error.message : "The recording could not be kept."); setPhase("idle"); }
      };
      recorder.current = next;
      next.start();
      setPhase("recording");
    } catch { setFailure("The microphone is not available."); }
  };
  return (
    <section className="fy-ad-gen" aria-label="Record a sound">
      <header><button type="button" className="fy-linkbtn" onClick={onBack}>‹ Sounds</button><h2>Record a sound</h2></header>
      <p>For: {cue.heard}</p>
      {failure && <p role="alert" className="fy-ad-gen__fail">{failure}</p>}
      <footer>
        {phase === "saved" ? <Button variant="primary" onClick={onBack}>Choose it from this production</Button>
          : phase === "recording" ? <Button variant="primary" onClick={() => recorder.current?.stop()}>Stop</Button>
          : <Button variant="primary" disabled={phase === "saving"} onClick={() => void start()}>{phase === "saving" ? "Keeping…" : "Record"}</Button>}
      </footer>
    </section>
  );
}
