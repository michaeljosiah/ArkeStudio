import { useEffect, useRef, useState, type ReactNode } from "react";
import { audioSamples, audioSeconds, resolveAudioArrangement, type AudioArrangementCommand, type ChapterTiming } from "@arke-studio/contracts";
import { Button, Input } from "../components/ui.js";
import { useAudioStudio, useAudioStudioPlayer } from "../lib/audio-studio.js";
import { audioStudioAddition, audioStudioReview } from "../lib/audio-studio-edit.js";
import { importEditorMedia, subscribeQueueResults } from "../lib/store.js";
import { ChapterAudioStudio } from "./chapter-audio-studio.js";
import { AudioStudioTimeline } from "./audio-studio-timeline.js";
import { AudioStudioInspector } from "./audio-studio-inspector.js";
import { AudioStudioLibrary } from "./audio-studio-library.js";
import { AudioStudioRepairs } from "./audio-studio-repairs.js";
import type { TimingRowLike } from "./chapter-timing.js";

export function AudioStudioWorkspace(props: {
  worldId: string; productionId: string; chapterId: string; chapterFile: string; slug: string; book: string; title: string;
  connection: string; stamp: unknown; rows: readonly TimingRowLike[]; timing: ChapterTiming;
  passage: string | null; onPassage: (key: string) => void; conversation: ReactNode; propose: ReactNode;
  onBack: () => void; onExport: () => void; exportDisabled: boolean;
}) {
  const studio = useAudioStudio(props), player = useAudioStudioPlayer(props), { snapshot } = studio;
  const [selected, setSelected] = useState<string | null>(null), [track, setTrack] = useState<string | null>(null), [at, setAt] = useState(0);
  const [solo, setSolo] = useState<string[]>([]), [replacing, setReplacing] = useState(false), [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState<ReturnType<typeof audioStudioReview> | null>(null);
  const [loop, setLoop] = useState(false), [from, setFrom] = useState(0), [to, setTo] = useState(0);
  const imported = useRef<string | null>(null), sourceRequest = useRef(0);
  const latest = useRef(snapshot); latest.current = snapshot;
  useEffect(() => () => { sourceRequest.current++; }, []);
  useEffect(() => subscribeQueueResults(result => {
    if (result.requestId !== imported.current) return;
    imported.current = null; setPreparing(false); studio.setProblem(result.failures.map(failure => failure.reason).join(" · ") || null); studio.refresh();
  }), [studio.refresh, studio.setProblem]);
  useEffect(() => { if (props.connection !== "open") { sourceRequest.current++; imported.current = null; setPreparing(false); } }, [props.connection]);
  const plan = snapshot ? resolveAudioArrangement(snapshot.state, snapshot.script) : null;
  const busy = studio.pending || preparing || props.connection !== "open", disabled = busy || review !== null;
  const select = (id: string) => { setSelected(id); setReplacing(false); const clip = snapshot?.state.clips.find(entry => entry.id === id); if (clip) { setTrack(clip.trackId); const passage = plan?.passages.find(entry => entry.id === clip.passageId); if (passage) props.onPassage(passage.key); } };
  const edit = (label: string, commands: AudioArrangementCommand[], base?: string) => { player.stop(); studio.edit({ kind: "commands", label, commands }, base); };
  const propose = (label: string, commands: AudioArrangementCommand[]) => {
    if (!snapshot || disabled) return;
    try { player.stop(); setReview(audioStudioReview(snapshot, { kind: "commands", label, commands })); studio.setProblem(null); }
    catch (error) { studio.setProblem(error instanceof Error ? error.message : String(error)); }
  };
  const add = (file: string, asSpeech: boolean, destination?: { trackId: string; at: number }) => {
    if (!snapshot || disabled) return;
    const held = snapshot, request = ++sourceRequest.current, replacement = replacing ? selected : null;
    setPreparing(true);
    studio.source(file, (source, problem) => {
      if (request !== sourceRequest.current) return;
      setPreparing(false);
      if (!source) { studio.setProblem(problem ?? "This source could not be prepared"); return; }
      if (latest.current?.base !== held.base) { studio.setProblem("The chapter changed while preparing audio; choose the source again"); return; }
      try {
        const commands: AudioArrangementCommand[] = replacement ? [{ kind: "replace-source", id: replacement, source }]
          : audioStudioAddition(held, source, { at: destination?.at ?? at, ...(destination ? { trackId: destination.trackId } : track ? { trackId: track } : {}), ...(asSpeech && props.passage ? { passageKey: props.passage } : {}) });
        if (asSpeech && !props.passage) throw new Error("Select the script passage this performance belongs to");
        player.stop();
        if (replacement || asSpeech) setReview(audioStudioReview(held, { kind: "commands", label: replacement ? "Replace source" : "Add passage performance", commands }));
        else studio.edit({ kind: "commands", label: "Add audio", commands }, held.base);
        setReplacing(false);
      } catch (error) { studio.setProblem(error instanceof Error ? error.message : String(error)); }
    });
  };
  const importMedia = (files?: File[], destination?: { trackId: string; at: number }) => {
    if (!snapshot || disabled) return;
    const result = importEditorMedia(props.worldId, undefined, files, props.productionId, { productionId: props.productionId, chapterFile: props.chapterFile, base: snapshot.base, destination: destination ?? "library" });
    if (result.requestId) { imported.current = result.requestId; setPreparing(true); } else studio.setProblem(result.reason ?? "Import could not start");
  };
  const play = (seconds: number) => {
    if (!snapshot || !plan) return;
    const start = loop ? audioSamples(from) : Math.max(0, audioSamples(seconds)), end = loop ? audioSamples(to) : plan.samples;
    if (end <= start || start < 0 || end > plan.samples) { studio.setProblem("Choose an audition range inside this chapter"); return; }
    player.play(snapshot.base, { solo, window: { from: start, to: end }, loop });
  };
  const position = player.at ?? at;
  const reviewCard = review && <section className="fy-tm__proposal fy-audio-review" aria-label="Review audio changes"><header><b>{review.edit.kind === "commands" ? review.edit.label : "Review audio"}</b><span>Current → Suggested</span></header>
    <p>Duration: {audioSeconds(review.current.samples).toFixed(3)} s → {audioSeconds(review.suggested.samples).toFixed(3)} s. Fixed cues keep their absolute positions.</p>
    {review.trimsReset && <p>Replacing this source resets its trims to the full new source. Review the new source window before applying.</p>}
    <ul>{review.changes.map(change => <li key={change.id}>{change.label}: {change.before === undefined ? "new" : `${audioSeconds(change.before).toFixed(3)} s`} → {audioSeconds(change.after).toFixed(3)} s · {audioSeconds(change.samples).toFixed(3)} s long</li>)}{review.removed.map(entry => <li key={entry.clip.id}>Remove {entry.clip.label}</li>)}</ul>
    {snapshot?.base !== review.base && <p role="status">The chapter changed. Keep Current, then prepare a new review.</p>}
    <div className="fy-audio-inspector__actions"><Button disabled={busy || snapshot?.base !== review.base || !review.current.samples} onClick={() => player.play(review.base, { solo })}>Listen to Current</Button><Button disabled={busy || snapshot?.base !== review.base || !review.suggested.samples} onClick={() => player.play(review.base, { edit: review.edit, solo })}>Listen to Suggested</Button>{(player.pending || player.playing) && <Button onClick={player.stop}>Stop</Button>}<Button onClick={() => { player.stop(); setReview(null); }}>Keep Current</Button><Button variant="primary" disabled={busy || snapshot?.base !== review.base} onClick={() => { player.stop(); if (studio.edit(review.edit, review.base)) setReview(null); }}>Apply Suggested</Button></div>
  </section>;
  return <ChapterAudioStudio book={props.book} title={props.title} rows={props.rows} timing={props.timing} selected={props.passage}
    onSelect={key => { props.onPassage(key); const passage = plan?.passages.find(entry => entry.key === key); const clip = snapshot?.state.clips.find(entry => entry.passageId === passage?.id && entry.role === "speech"); setSelected(clip?.id ?? null); setTrack(clip?.trackId ?? null); setReplacing(false); }}
    playhead={audioSeconds(position)} onPlayhead={seconds => { player.stop(); setAt(audioSamples(seconds)); }}
    audioClock={{ seconds: audioSeconds(plan?.samples ?? 0), passages: plan?.passages.map(entry => ({ key: entry.key, at: audioSeconds(entry.at), seconds: audioSeconds(entry.samples), made: entry.samples > 0 })) ?? [] }}
    playing={player.playing} pending={player.pending} reviewing={review !== null} canPlay={!!plan?.samples && !busy}
    onPlay={play} onStop={player.stop} onBack={props.onBack} onExport={props.onExport} exportDisabled={props.exportDisabled || disabled || !!plan?.issues.length}
    problem={studio.problem ?? player.problem ?? (snapshot ? player.issues.join(" · ") || null : "Opening Audio Studio…")}
    library={snapshot ? <AudioStudioLibrary snapshot={snapshot} selected={selected} disabled={disabled} replacing={replacing} onAdd={add} onImport={() => importMedia()} onCancelReplace={() => setReplacing(false)} onEdit={edit} /> : <p className="fy-audio-studio__propose">Loading Library…</p>}
    showInspector inspector={snapshot && <AudioStudioInspector snapshot={snapshot} selected={selected} trackId={track} disabled={disabled} onEdit={edit} onReplace={() => { setReplacing(true); studio.setProblem(null); }} />}
    proposal={reviewCard} propose={props.propose} conversation={props.conversation}
    timeline={snapshot && plan && <><AudioStudioRepairs snapshot={snapshot} plan={plan} disabled={disabled} onSelect={select} onReview={propose} />
      <div className="fy-audio-loop"><label><input type="checkbox" checked={loop} onChange={event => { setLoop(event.target.checked); if (!to) setTo(audioSeconds(plan.samples)); }} />Loop audition</label><label>From (s)<Input aria-label="Loop from seconds" type="number" min={0} step={.001} value={from} onChange={event => setFrom(event.target.valueAsNumber || 0)} /></label><label>To (s)<Input aria-label="Loop to seconds" type="number" min={0} step={.001} value={to} onChange={event => setTo(event.target.valueAsNumber || 0)} /></label>{solo.length > 0 && <Button size="sm" onClick={() => { player.stop(); setSolo([]); }}>Clear solo audition</Button>}</div>
      <AudioStudioTimeline state={snapshot.state} plan={plan} selected={selected} selectedTrack={track} onSelect={select} onTrack={id => { setTrack(id); setSelected(null); }} at={position} onSeek={samples => { player.stop(); setAt(samples); }} disabled={disabled}
        undo={snapshot.undo} redo={snapshot.redo} onHistory={kind => { player.stop(); studio.edit({ kind }); }} onEdit={edit} solo={solo} onSolo={id => { player.stop(); setSolo(held => held.includes(id) ? held.filter(value => value !== id) : [...held, id]); }}
        onDrop={(id, trackId, samples) => { const asset = snapshot.library.find(entry => entry.artifactId === id); if (asset) add(asset.file, false, { trackId, at: samples }); }} onFiles={(files, trackId, samples) => importMedia(files, { trackId, at: samples })} />
    </>} />;
}
