import { useEffect, useRef, useState, type ReactNode } from "react";
import { audioSamples, audioSeconds, resolveAudioArrangement, reviewCoverage, type AudioArrangementCommand, type ChapterTiming } from "@arke-studio/contracts";
import { Button, Input } from "../components/ui.js";
import { useAudioStudio, useAudioStudioPlayer } from "../lib/audio-studio.js";
import { useAudioStudioWaveforms } from "../lib/audio-studio-waveform.js";
import { audioStudioAddition, audioStudioReview } from "../lib/audio-studio-edit.js";
import { importEditorMedia, recordAudioHeard, subscribeQueueResults } from "../lib/store.js";
import { AudioStudioReviewStrip, heardClock, type ReviewPin } from "./audio-studio-review-strip.js";
import { ChapterAudioStudio } from "./chapter-audio-studio.js";
import { AudioStudioTimeline } from "./audio-studio-timeline.js";
import { AudioStudioInspector } from "./audio-studio-inspector.js";
import { AudioStudioLibrary } from "./audio-studio-library.js";
import { AudioStudioRepairs } from "./audio-studio-repairs.js";
import type { TimingRowLike } from "./chapter-timing.js";

export function AudioStudioWorkspace(props: {
  worldId: string; productionId: string; chapterId: string; chapterFile: string; slug: string; book: string; title: string;
  connection: string; stamp: unknown; rows: readonly TimingRowLike[]; timing: ChapterTiming;
  passage: string | null; onPassage: (key: string) => void; conversation: ReactNode | ((context: string) => ReactNode); propose: ReactNode;
  onBack: () => void; onExport: () => void; exportDisabled: boolean;
  /** Why the last export was refused, said where the studio says its problems. */
  exportProblem?: string | null;
  /** An episode's studio (issue 1883): Back to its script, and an episode's mix. */
  backLabel?: string; unit?: "Chapter" | "Episode";
  /**
   * An episode's one Review (230o, issue 1882): its scenes, its script's notes, and how each note
   * was decided. Given, the studio records what of the mix is heard and draws the review strip.
   */
  review?: {
    version: number;
    scenes: ReadonlyArray<{ key: string; n: number; title: string; firstLine: string }>;
    notes: ReadonlyArray<{ key: string; block: string | undefined; says: string; evidence: string }>;
    decided: Readonly<Record<string, string>>;
    onDecide: (key: string, decision: "intentional" | "dismissed") => void;
  };
}) {
  const studio = useAudioStudio(props), player = useAudioStudioPlayer(props), { snapshot } = studio;
  const waveform = useAudioStudioWaveforms(studio.source);
  const [selected, setSelected] = useState<string | null>(null), [track, setTrack] = useState<string | null>(null), [at, setAt] = useState(0);
  const [solo, setSolo] = useState<string[]>([]), [replacing, setReplacing] = useState(false), [preparing, setPreparing] = useState(false);
  const [review, setReview] = useState<(ReturnType<typeof audioStudioReview> & { proposal?: { id: string; version: number } }) | null>(null);
  const [suggested, setSuggested] = useState(false);
  const [loop, setLoop] = useState(false), [from, setFrom] = useState(0), [to, setTo] = useState(0);
  const imported = useRef<string | null>(null), sourceRequest = useRef(0);
  const latest = useRef(snapshot); latest.current = snapshot;
  useEffect(() => () => { sourceRequest.current++; }, []);
  useEffect(() => subscribeQueueResults(result => {
    if (result.requestId !== imported.current) return;
    imported.current = null; setPreparing(false); studio.setProblem(result.failures.map(failure => failure.reason).join(" · ") || null); studio.refresh();
  }), [studio.refresh, studio.setProblem]);
  useEffect(() => { if (props.connection !== "open") { sourceRequest.current++; imported.current = null; setPreparing(false); } }, [props.connection]);
  const shownSnapshot = snapshot && review && suggested ? { ...snapshot, state: review.next } : snapshot;
  const plan = shownSnapshot ? resolveAudioArrangement(shownSnapshot.state, shownSnapshot.script, new Set(snapshot?.unavailable?.map(entry => entry.file))) : null;
  const proposalFresh = !review?.proposal || snapshot?.proposals?.some(entry => entry.id === review.proposal!.id && entry.status === "pending" && entry.versions.at(-1)?.number === review.proposal!.version);
  const reviewFresh = snapshot?.base === review?.base && proposalFresh;
  const closeReview = () => { player.stop(); setReview(null); setSuggested(false); };
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
          : audioStudioAddition(held, source, { at: destination?.at ?? at, ...(destination ? { trackId: destination.trackId } : track ? { trackId: track } : {}), ...(props.passage ? asSpeech ? { passageKey: props.passage } : { anchorKey: props.passage } : {}) });
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
  // What of the saved mix plays whole is heard (230o, issue 1882): recorded when the listen stops,
  // seeks or jumps, on the base it was heard on. A play run to its end is heard to its end.
  const heardSpan = useRef<{ base: string; from: number; last: number; to: number } | null>(null);
  const closeHeard = () => {
    const span = heardSpan.current;
    heardSpan.current = null;
    if (!span || !props.review) return;
    const last = span.last >= span.to - audioSamples(0.5) ? span.to : span.last;
    if (last - span.from >= audioSamples(0.5)) recordAudioHeard(props.worldId, props.productionId, props.chapterFile, span.base, [[audioSeconds(span.from), audioSeconds(last)]]);
  };
  useEffect(() => {
    if (!props.review) return;
    const listen = player.listening, now = player.at, span = heardSpan.current;
    if (!listen || now === null) { closeHeard(); return; }
    if (span && span.base === listen.base && now >= span.last && now - span.last <= audioSamples(1.5)) { span.last = now; return; }
    closeHeard();
    heardSpan.current = { base: listen.base, from: now, last: now, to: Math.min(listen.to, plan?.samples ?? listen.to) };
  }, [player.at, player.listening]);
  useEffect(() => () => closeHeard(), []);
  // The review strip's own state: the window the timeline shows, and the note open in the Inspector.
  const [view, setView] = useState<readonly [number, number] | null>(null);
  const [openNote, setOpenNote] = useState<string | null>(null);
  const heard = snapshot?.heard;
  const lineAt = (key: string | undefined) => key === undefined ? undefined : plan?.passages.find((entry) => entry.key === key && entry.samples > 0)?.at;
  const audioNotes = (heard?.notes ?? []).filter((note) => props.review?.decided[note.key] === undefined);
  const pins: Array<ReviewPin & { audio?: (typeof audioNotes)[number]; script?: NonNullable<typeof props.review>["notes"][number] }> = props.review && plan ? [
    ...audioNotes.map((note) => ({ key: note.key, n: 0, at: note.from, title: `${note.observed} · heard ${heardClock(note.from)}–${heardClock(note.to)}`, audio: note })),
    ...props.review.notes.filter((note) => props.review!.decided[note.key] === undefined).flatMap((note) => {
      const samples = lineAt(note.block);
      return samples === undefined ? [] : [{ key: note.key, n: 0, at: audioSeconds(samples), title: `${note.says} · ${note.evidence}`, script: note }];
    }),
  ].sort((a, b) => a.at - b.at).map((pin, index) => ({ ...pin, n: index + 1 })) : [];
  const scenes = props.review && plan ? props.review.scenes.flatMap((scene) => {
    const from = lineAt(scene.firstLine);
    return from === undefined ? [] : [{ ...scene, from }];
  }).map((scene, index, all) => {
    const from = audioSeconds(scene.from), to = audioSeconds(all[index + 1]?.from ?? plan.samples);
    return { key: scene.key, n: scene.n, title: scene.title, from, to, on: position >= scene.from && position < (all[index + 1]?.from ?? plan.samples + 1) };
  }) : [];
  const opened = pins.find((pin) => pin.key === openNote) ?? null;
  const openPin = (key: string) => {
    const pin = pins.find((entry) => entry.key === key);
    if (!pin) return;
    setOpenNote(key); player.stop(); setAt(audioSamples(pin.at));
    const block = pin.audio?.block ?? pin.script?.block;
    const passage = plan?.passages.find((entry) => entry.key === block);
    const clip = snapshot?.state.clips.find((entry) => entry.passageId === passage?.id && entry.role === "speech");
    if (clip) select(clip.id);
  };
  const decideNote = (key: string, decision: "intentional" | "dismissed") => { props.review?.onDecide(key, decision); setOpenNote(null); };
  const noteSection = opened && (
    <section className="fy-audio-note" aria-label="Review note">
      <header><b>Review · note {opened.n} · {opened.audio ? "heard" : opened.script!.evidence}</b></header>
      {opened.audio ? <>
        <h4>“{opened.audio.quote.replace(/^[^:]{1,80}:\s*/u, "")}”</h4>
        <dl><dt>Heard</dt><dd>{heardClock(opened.audio.from)}–{heardClock(opened.audio.to)}</dd><dt>Observed</dt><dd>{opened.audio.observed}</dd><dt>Kind</dt><dd>Intelligibility</dd></dl>
      </> : <p>{opened.script!.says}</p>}
      <div className="fy-audio-inspector__actions">
        {opened.audio?.fix && <Button size="sm" variant="primary" disabled={disabled} onClick={() => propose(opened.audio!.fix!.label, opened.audio!.fix!.commands)}>Fix</Button>}
        <Button size="sm" onClick={() => decideNote(opened.key, "intentional")}>Intentional</Button>
        <Button size="sm" variant="ghost" onClick={() => decideNote(opened.key, "dismissed")}>Dismiss</Button>
      </div>
    </section>
  );
  const strip = props.review && plan && (
    <AudioStudioReviewStrip seconds={audioSeconds(plan.samples)} coverage={reviewCoverage(props.review.version, heard?.spans ?? [], heard?.seconds ?? audioSeconds(plan.samples))}
      scenes={scenes} heard={heard?.spans ?? []} pins={pins} view={view} open={openNote}
      onSeek={(seconds) => { player.stop(); setAt(audioSamples(seconds)); }} onOpen={openPin} onHearRest={(from) => play(from)} hearDisabled={busy || !plan.samples || review !== null} />
  );
  const reviewCard = review && <section className="fy-tm__proposal fy-audio-review" aria-label="Review audio changes"><header><b>{review.edit.kind === "commands" ? review.edit.label : "Review audio"}</b><span>Current → Suggested</span></header>
    <p><Button disabled={!suggested} onClick={() => { player.stop(); setSuggested(false); }}>Show Current</Button> <Button disabled={suggested} onClick={() => { player.stop(); setSuggested(true); }}>Show Suggested</Button></p>
    <p>Duration: {audioSeconds(review.current.samples).toFixed(3)} s → {audioSeconds(review.suggested.samples).toFixed(3)} s. Fixed cues keep their absolute positions.</p>
    {review.fixed.length > 0 && <p>Fixed cues: {review.fixed.map(entry => `${entry.clip.label} at ${audioSeconds(entry.at).toFixed(3)} s`).join(" · ")}</p>}
    {review.trimsReset && <p>Replacing this source resets its trims to the full new source. Review the new source window before applying.</p>}
    <ul>{review.details.map((detail, index) => <li key={`detail-${index}`}>{detail}</li>)}{review.changes.map(change => <li key={change.id}>{change.label}: {change.before === undefined ? "new" : `${audioSeconds(change.before).toFixed(3)} s`} → {audioSeconds(change.after).toFixed(3)} s · {audioSeconds(change.samples).toFixed(3)} s long</li>)}{review.removed.map(entry => <li key={entry.clip.id}>Remove {entry.clip.label}</li>)}</ul>
    {!reviewFresh && <p role="status">The chapter or proposal changed. Close this comparison and review the latest version.</p>}
    <div className="fy-audio-inspector__actions"><Button disabled={busy || !reviewFresh || !review.current.samples} onClick={() => { setSuggested(false); player.play(review.base, { solo }); }}>Listen to Current</Button><Button disabled={busy || !reviewFresh || !review.suggested.samples} onClick={() => { setSuggested(true); player.play(review.base, { edit: review.edit, solo }); }}>Listen to Suggested</Button>{(player.pending || player.playing) && <Button onClick={player.stop}>Stop</Button>}
      <Button disabled={busy || !proposalFresh} onClick={() => { if (!review.proposal || studio.decide(review.proposal.id, review.proposal.version, "keep")) closeReview(); }}>Keep Current</Button>
      <Button variant="primary" disabled={busy || !reviewFresh} onClick={() => { player.stop(); if (review.proposal ? studio.decide(review.proposal.id, review.proposal.version, "apply") : studio.edit(review.edit, review.base)) closeReview(); }}>Apply Suggested</Button>
      {review.proposal && <Button onClick={closeReview}>Close comparison</Button>}
    </div>
  </section>;
  return <ChapterAudioStudio book={props.book} title={props.title} rows={props.rows} timing={props.timing} selected={props.passage}
    onSelect={key => { props.onPassage(key); const passage = plan?.passages.find(entry => entry.key === key); const clip = snapshot?.state.clips.find(entry => entry.passageId === passage?.id && entry.role === "speech"); setSelected(clip?.id ?? null); setTrack(clip?.trackId ?? null); setReplacing(false); }}
    playhead={audioSeconds(position)} onPlayhead={seconds => { player.stop(); setAt(audioSamples(seconds)); }}
    audioClock={{ seconds: audioSeconds(plan?.samples ?? 0), passages: plan?.passages.map(entry => ({ key: entry.key, at: audioSeconds(entry.at), seconds: audioSeconds(entry.samples), made: entry.samples > 0 })) ?? [] }}
    playing={player.playing} pending={player.pending} reviewing={review !== null} canPlay={!!plan?.samples && !busy}
    {...(props.backLabel ? { backLabel: props.backLabel } : {})} unit={props.unit ?? "Chapter"}
    onPlay={play} onStop={player.stop} onBack={props.onBack} onExport={props.onExport} exportDisabled={props.exportDisabled || disabled || !!plan?.issues.length}
    problem={props.exportProblem ?? studio.problem ?? player.problem ?? (snapshot ? player.issues.join(" · ") || null : "Opening Audio Studio…")}
    library={snapshot ? <AudioStudioLibrary snapshot={snapshot} selected={selected} disabled={disabled} replacing={replacing} onAdd={add} onImport={() => importMedia()} onCancelReplace={() => setReplacing(false)} onEdit={edit} /> : <p className="fy-audio-studio__propose">{studio.problem === null ? "Loading Library…" : "Library unavailable"}</p>}
    showInspector inspector={<>{noteSection}{shownSnapshot && <AudioStudioInspector snapshot={shownSnapshot} selected={selected} trackId={track} disabled={disabled} unit={props.unit ?? "Chapter"} onEdit={edit} onReplace={() => { setReplacing(true); studio.setProblem(null); }} />}</>}
    proposal={reviewCard} propose={<>{props.propose}{snapshot?.proposals?.filter(entry => entry.status === "pending").map(entry => {
      const version = entry.versions.at(-1)!;
      return <section key={entry.id} className="fy-audio-studio__propose"><b>{version.summary}</b><p>Version {version.number} · {version.base === snapshot.base ? "Ready to compare" : "Arrangement changed; ask Arke to revise"}</p>
        <Button disabled={disabled || version.base !== snapshot.base} onClick={() => { try { setSuggested(false); setReview({ ...audioStudioReview(snapshot, { kind: "commands", label: version.summary, commands: version.commands }), proposal: { id: entry.id, version: version.number } }); } catch (error) { studio.setProblem(error instanceof Error ? error.message : String(error)); } }}>Review suggestion</Button>
        <Button disabled={disabled} onClick={() => studio.decide(entry.id, version.number, "keep")}>Keep Current</Button></section>;
    })}</>} conversation={typeof props.conversation === "function" ? props.conversation(props.unit === "Episode"
      // An episode is read and suggested by its stem (issue 1882), never as a chapter.
      ? `Audio Studio for ${props.chapterId}. Selected passage: ${props.passage ?? "none"}; clip: ${selected ?? "none"}; track: ${track ?? "none"}. Arrangement revision ${snapshot?.revision ?? "unread"}, base ${snapshot?.base ?? "unread"}. Read get_chapter with chapterId ${props.chapterId} and section audio-studio before proposing changes with production-audio-studio-propose and that chapterId.`
      : `Audio Studio for chapter ${props.chapterId}. Selected passage: ${props.passage ?? "none"}; clip: ${selected ?? "none"}; track: ${track ?? "none"}. Arrangement revision ${snapshot?.revision ?? "unread"}, base ${snapshot?.base ?? "unread"}. Read get_chapter section audio-studio before proposing changes with production-audio-studio-propose.`) : props.conversation}
    timeline={snapshot && plan && <>{strip}<AudioStudioRepairs snapshot={snapshot} plan={plan} disabled={disabled} onSelect={select} onReview={propose} />
      <div className="fy-audio-loop"><label><input type="checkbox" checked={loop} onChange={event => { setLoop(event.target.checked); if (!to) setTo(audioSeconds(plan.samples)); }} />Loop audition</label><label>From (s)<Input aria-label="Loop from seconds" type="number" min={0} step={.001} value={from} onChange={event => setFrom(event.target.valueAsNumber || 0)} /></label><label>To (s)<Input aria-label="Loop to seconds" type="number" min={0} step={.001} value={to} onChange={event => setTo(event.target.valueAsNumber || 0)} /></label>{solo.length > 0 && <Button size="sm" onClick={() => { player.stop(); setSolo([]); }}>Clear solo audition</Button>}</div>
      <AudioStudioTimeline waveform={waveform} state={shownSnapshot!.state} plan={plan} selected={selected} selectedTrack={track} onSelect={select} onTrack={id => { setTrack(id); setSelected(null); }} at={position} onSeek={samples => { player.stop(); setAt(samples); }} disabled={disabled}
        undo={snapshot.undo} redo={snapshot.redo} onHistory={kind => { player.stop(); studio.edit({ kind }); }} onEdit={edit} solo={solo} onSolo={id => { player.stop(); setSolo(held => held.includes(id) ? held.filter(value => value !== id) : [...held, id]); }}
        onDrop={(id, trackId, samples) => { const asset = snapshot.library.find(entry => entry.artifactId === id); if (asset) add(asset.file, false, { trackId, at: samples }); }} onFiles={(files, trackId, samples) => importMedia(files, { trackId, at: samples })}
        {...(props.review ? {
          regions: scenes.map((scene) => ({ key: scene.key, label: `${scene.n} · ${scene.title}`, at: audioSamples(scene.from), samples: audioSamples(scene.to - scene.from), on: scene.on })),
          marks: audioNotes.map((note) => ({ key: note.key, title: `${note.observed} · heard ${heardClock(note.from)}–${heardClock(note.to)}`, at: audioSamples(note.from), samples: audioSamples(note.to - note.from) })),
          onView: (from: number, to: number) => setView([audioSeconds(from), audioSeconds(to)]),
        } : {})} />
    </>} />;
}
