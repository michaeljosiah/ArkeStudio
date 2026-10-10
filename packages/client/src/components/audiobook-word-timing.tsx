import { useEffect, useRef, useState } from "react";
import { captionWordParts, clockTime, ulid, type AudiobookWordTimingState } from "@arke-studio/contracts";
import { send, subscribeAudiobookWordTiming, useStore } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { claimRead, releaseRead } from "../lib/reply-reads.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";

/** Turn 208f: preparation reads saved audio locally; uncertain blocks never qualify for export. */
export function WordTimingControl({
  worldId,
  productionId,
  chapters,
  enabled,
  onReady,
  usePhrases,
}: {
  worldId: string;
  productionId: string;
  chapters?: string[];
  enabled: boolean;
  onReady: (ready: boolean) => void;
  usePhrases: () => void;
}) {
  const slug = useStore().state?.world?.meta.slug;
  const [state, setState] = useState<AudiobookWordTimingState | null>(null);
  const [review, setReview] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const runningRequest = useRef<string | null>(null);
  const ready = state !== null && state.blocks.length > 0 && state.blocks.every((b) => b.ready);
  const scope = JSON.stringify(chapters ?? null);
  const request = (action: "read" | "prepare" | "stop") => {
    if (action !== "stop") asked.current = ulid();
    send({
      kind: "audiobook-word-timing",
      worldId,
      productionId,
      action,
      ...(chapters !== undefined ? { chapters } : {}),
      requestId: action === "stop" ? ulid() : asked.current!,
    });
  };
  useEffect(
    () =>
      subscribeAudiobookWordTiming((event) => {
        if (
          event.worldId !== worldId ||
          event.productionId !== productionId ||
          (event.requestId !== asked.current && event.requestId !== runningRequest.current)
        )
          return;
        runningRequest.current = event.state.running
          ? (event.state.runningRequestId ?? event.requestId)
          : null;
        setState({
          ...event.state,
          blocks: event.state.blocks.filter(
            (block) => chapters === undefined || chapters.includes(block.chapterId),
          ),
        });
      }),
    [worldId, productionId, scope],
  );
  useEffect(() => {
    setState(null);
    runningRequest.current = null;
    if (enabled) request("read");
  }, [worldId, productionId, scope, enabled]);
  useEffect(() => { onReady(ready); }, [ready]);
  useEffect(
    () => () => {
      for (const block of state?.blocks ?? [])
        releaseRead(`word-timing-review:${block.chapterId}/${block.key}`);
    },
    [review, state],
  );
  if (!enabled) return null;
  const pending = state?.blocks.filter((b) => !b.ready) ?? [];
  const chosen = state?.blocks.find((block) => `${block.chapterId}/${block.key}` === selected);
  const openReview = () => { setSelected(null); setReview(true); };
  return <div className="fy-wordtiming">
    <div className="fy-abmotion-notice">
      <b>{state === null ? "Checking word timing…" : state.running ? "Preparing word timing" : ready ? "Word timing ready" : state.available ? "Word timing not prepared" : "Word timing unavailable"}</b>
      <p role="status">{state?.running ? `${state.done} of ${state.total} blocks` : ready ? `${state!.blocks.length} of ${state!.blocks.length} blocks · matches this reading` : state?.available === false ? state.reason ?? "No supported word aligner on this desktop" : "Needed for current-word highlighting"}</p>
      {state?.running ? <><progress aria-label="Timing preparation" max={Math.max(1, state.total)} value={state.done}/><Button variant="outline" onClick={() => request("stop")}>Stop</Button></> : ready ? <button type="button" className="fy-wordtiming-link" onClick={openReview}>Review timing</button> : state?.available === false ? <Button variant="outline" onClick={usePhrases}>Use phrase captions</Button> : <Button variant="outline" disabled={state?.available !== true} onClick={() => request("prepare")}>Prepare word timing</Button>}
    </div>
    {!ready && <p className="fy-abv-note">Uses the saved audio on this machine. No new reading or API charge. {pending.length > 0 && <button type="button" className="fy-wordtiming-link" onClick={openReview}>Review blocks</button>}</p>}
    <EditorDialog open={review} onClose={() => setReview(false)} labelledBy="word-timing-title" width={720} panelClassName="fy-abmotion">
      <div className="fy-abmotion-head"><div><h3 id="word-timing-title">Word timing</h3><p>{state?.blocks.length ?? 0} blocks · current audio and words</p></div><button type="button" aria-label="Close" onClick={() => setReview(false)}>×</button></div>
      <div className="fy-wordtiming-list">
        {pending.length > 0 && <div className="fy-abmotion-notice"><b>{pending.length} blocks need timing</b><p>Highlighting waits until every selected block is ready. Phrase captions remain available.</p></div>}
        <div className="fy-abmotion-row"><b>{(state?.blocks.length ?? 0) - pending.length} blocks ready</b><span className="grow"/><span className="fy-abmotion-meta">Current audio and words</span></div>
        {(ready ? state?.blocks ?? [] : pending).map((block) => <div className="fy-wordtiming-block" key={`${block.chapterId}/${block.key}`}><div><b>{block.label}</b><p>{block.ready ? "Matches this reading" : block.reason}</p></div><Button variant="outline" onClick={() => setSelected(`${block.chapterId}/${block.key}`)}>Review</Button></div>)}
        {chosen !== undefined && slug !== undefined && <TimingLine key={`${chosen.chapterId}/${chosen.key}`} block={chosen} slug={slug} />}
        <p>Prepared on this desktop from the saved reading. No new narration.</p>
      </div>
      <div className="fy-abmotion-foot"><Button variant="outline" onClick={() => { usePhrases(); setReview(false); }}>Use phrase captions</Button><span className="grow"/>{pending.length > 0 && <Button variant="outline" disabled={state?.available !== true || state.running} onClick={() => { request("prepare"); setReview(false); }}>Prepare again</Button>}<Button variant="primary" onClick={() => setReview(false)}>Done</Button></div>
    </EditorDialog>
  </div>;
}

function TimingLine({ block, slug }: { block: AudiobookWordTimingState["blocks"][number]; slug: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const from = block.fromSec ?? 0, to = block.toSec ?? 0;
  const [at, setAt] = useState(from), [playing, setPlaying] = useState(false);
  const key = `word-timing-review:${block.chapterId}/${block.key}`;
  useEffect(() => () => { audio.current?.pause(); releaseRead(key); }, [key]);
  const play = () => { const element = audio.current; if (!element) return; if (playing) element.pause(); else { if (element.currentTime < from || to > 0 && element.currentTime >= to) element.currentTime = from; void element.play().catch(() => setPlaying(false)); } };
  const text = block.text ?? "";
  const parts = block.words === undefined ? [{ text, active: false }] : captionWordParts({ startSec: from, endSec: to, text, words: block.words }, at);
  return <div>
    {text !== "" && <div className="fy-wordtiming-line">{parts.map((part, index) => part.active ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>)}</div>}
    <audio ref={audio} preload="metadata" aria-label={`Saved reading · ${block.label}`} src={block.file === undefined ? undefined : mediaUrl(slug, block.file)} onLoadedMetadata={() => { if (audio.current !== null) audio.current.currentTime = from; }} onPlay={() => { setPlaying(true); claimRead(key, () => audio.current?.pause()); }} onPause={() => { setPlaying(false); releaseRead(key); }} onEnded={() => { setPlaying(false); releaseRead(key); }} onTimeUpdate={(event) => { setAt(event.currentTarget.currentTime); if (to > 0 && event.currentTarget.currentTime >= to) event.currentTarget.pause(); }} />
    <div className="fy-abmotion-row"><Button variant="outline" disabled={block.file === undefined} onClick={play}>{playing ? "Pause" : "▶ Play line"}</Button><b>{clockTime(Math.max(0, at - from))} / {clockTime(Math.max(0, to - from))}</b><span className="grow"/><span className="fy-abmotion-meta">{block.ready ? "Timing preview" : "Timing not ready"}</span></div>
    {to > from && <input aria-label="Reading position" type="range" min={from} max={to} step={0.01} value={Math.min(to, Math.max(from, at))} onChange={(event) => { const next = Number(event.target.value); if (audio.current) audio.current.currentTime = next; setAt(next); }} />}
  </div>;
}
