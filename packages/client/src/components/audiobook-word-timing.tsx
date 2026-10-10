import { Fragment, useEffect, useRef, useState } from "react";
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
  const world = useStore().state?.world;
  const slug = world?.meta.slug;
  const [state, setState] = useState<AudiobookWordTimingState | null>(null);
  const [review, setReview] = useState(false);
  const [confirm, setConfirm] = useState<{ block?: { chapterId: string; key: string } } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const runningRequest = useRef<string | null>(null);
  const ready = state !== null && state.blocks.length > 0 && state.blocks.every((b) => b.ready);
  const scope = JSON.stringify(chapters ?? null);
  const request = (action: "read" | "prepare" | "stop", block?: { chapterId: string; key: string }) => {
    if (action !== "stop") asked.current = ulid();
    send({
      kind: "audiobook-word-timing",
      worldId,
      productionId,
      action,
      ...(chapters !== undefined ? { chapters } : {}),
      ...(block !== undefined ? { blocks: [{ chapterId: block.chapterId, key: block.key }] } : {}),
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
  useEffect(() => {
    onReady(ready);
  }, [ready]);
  useEffect(
    () => () => {
      for (const block of state?.blocks ?? [])
        releaseRead(`word-timing-review:${block.chapterId}/${block.key}`);
    },
    [review, state],
  );
  if (!enabled) return null;
  const pending = state?.blocks.filter((b) => !b.ready) ?? [];
  const chapterIds = [...new Set(state?.blocks.map((block) => block.chapterId) ?? chapters ?? [])];
  const chapter =
    chapterIds.length === 1
      ? world?.productions
          .find((production) => production.meta.id === productionId)
          ?.chapters.find((entry) => entry.id === chapterIds[0])
      : undefined;
  const scopeLabel = chapter === undefined ? "Current reading" : `Chapter ${chapter.order}`;
  const openReview = () => {
    setSelected(null);
    setReview(true);
  };
  return (
    <div className="fy-wordtiming">
      <div className="fy-abmotion-notice">
        <b>
          {state === null
            ? "Checking word timing…"
            : state.running
              ? "Preparing word timing"
              : ready
                ? "Word timing ready"
                : state.available
                  ? "Word timing not prepared"
                  : "Word timing unavailable"}
        </b>
        <p role="status">
          {state?.running
            ? `${state.done} of ${state.total} blocks`
            : ready
              ? `${state!.blocks.length} of ${state!.blocks.length} blocks · matches this reading`
              : state?.available === false
                ? (state.reason ?? "No supported word aligner on this desktop")
                : "Needed for current-word highlighting"}
        </p>
        {state?.running ? (
          <>
            <progress aria-label="Timing preparation" max={Math.max(1, state.total)} value={state.done} />
            <Button variant="outline" onClick={() => request("stop")}>
              Stop
            </Button>
          </>
        ) : ready ? (
          <button type="button" className="fy-wordtiming-link" onClick={openReview}>
            Review timing
          </button>
        ) : state?.available === false ? (
          <Button variant="outline" onClick={usePhrases}>
            Use phrase captions
          </Button>
        ) : (
          <Button variant="outline" disabled={state?.available !== true} onClick={() => setConfirm({})}>
            Prepare word timing
          </Button>
        )}
      </div>
      {!ready && (
        <p className="fy-abv-note">
          Uses the saved audio on this machine. No new reading or API charge.{" "}
          {pending.length > 0 && (
            <button type="button" className="fy-wordtiming-link" onClick={openReview}>
              Review blocks
            </button>
          )}
        </p>
      )}
      <EditorDialog
        open={review}
        onClose={() => setReview(false)}
        labelledBy="word-timing-title"
        width={720}
        panelClassName="fy-abmotion"
      >
        <div className="fy-abmotion-head">
          <div>
            <h3 id="word-timing-title">Word timing</h3>
            <p>
              {scopeLabel} · {state?.blocks.length ?? 0} blocks
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={() => setReview(false)}>
            ×
          </button>
        </div>
        <div className="fy-wordtiming-list">
          {pending.length > 0 && (
            <div className="fy-abmotion-notice fy-wordtiming-warning">
              <b>{pending.length} blocks need timing</b>
              <p>Highlighting waits until every selected block is ready. Phrase captions remain available.</p>
            </div>
          )}
          <div className="fy-abmotion-row">
            <b>{(state?.blocks.length ?? 0) - pending.length} blocks ready</b>
            <span className="grow" />
            <span className="fy-abmotion-meta">Current audio and words</span>
          </div>
          {(ready ? (state?.blocks ?? []) : pending).map((block) => (
            <Fragment key={`${block.chapterId}/${block.key}`}><div className="fy-wordtiming-block">
              <div>
                <b>{block.label}</b>
                <p>{block.ready ? "Matches this reading" : block.reason}</p>
              </div>
              {!block.ready && /changed|not prepared/i.test(block.reason ?? "") ? (
                <Button
                  variant="outline"
                  disabled={state?.available !== true || state.running}
                  onClick={() => {
                    setConfirm({ block });
                    setReview(false);
                  }}
                >
                  Prepare again
                </Button>
              ) : (
                <Button variant="outline" onClick={() => setSelected(`${block.chapterId}/${block.key}`)}>
                  Review
                </Button>
              )}
            </div>{selected === `${block.chapterId}/${block.key}` && slug !== undefined && <TimingLine block={block} slug={slug}/>}</Fragment>
          ))}
          <p>Prepared on this desktop from the saved reading. No new narration.</p>
        </div>
        <div className="fy-abmotion-foot">
          <Button
            variant="outline"
            onClick={() => {
              usePhrases();
              setReview(false);
            }}
          >
            Use phrase captions
          </Button>
          <span className="grow" />
          <Button variant="primary" onClick={() => setReview(false)}>
            Done
          </Button>
        </div>
      </EditorDialog>
      <EditorDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        labelledBy="word-timing-prepare-title"
        width={780}
        panelClassName="fy-abmotion fy-wordtiming-prepare"
      >
        <div className="fy-abmotion-head">
          <div>
            <h3 id="word-timing-prepare-title">Prepare word timings</h3>
            <p>
              {scopeLabel} · {confirm?.block === undefined ? pending.length : 1} blocks
            </p>
          </div>
          <button type="button" aria-label="Close" onClick={() => setConfirm(null)}>
            ×
          </button>
        </div>
        <div className="fy-abmotion-body">
          <div className="fy-abmotion-notice">Align these recordings to the exact words in their takes.</div>
          <div className="fy-wordtiming-block">
            <span>Processing</span>
            <span className="grow" />
            <b>On this device</b>
          </div>
          <div className="fy-wordtiming-block">
            <span>Provider charge</span>
            <span className="grow" />
            <b>None</b>
          </div>
          <p>Preparation uses the installed aligner. No new recording or download is made.</p>
        </div>
        <div className="fy-abmotion-foot">
          <Button variant="outline" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <span className="grow" />
          <Button
            variant="primary"
            disabled={state?.available !== true || state.running}
            onClick={() => {
              request("prepare", confirm?.block);
              setConfirm(null);
            }}
          >
            Prepare timings
          </Button>
        </div>
      </EditorDialog>
    </div>
  );
}

function TimingLine({ block, slug }: { block: AudiobookWordTimingState["blocks"][number]; slug: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const from = block.fromSec ?? 0,
    to = block.toSec ?? 0;
  const [at, setAt] = useState(from),
    [playing, setPlaying] = useState(false);
  const key = `word-timing-review:${block.chapterId}/${block.key}`;
  useEffect(
    () => () => {
      audio.current?.pause();
      releaseRead(key);
    },
    [key],
  );
  const play = () => {
    const element = audio.current;
    if (!element) return;
    if (playing) element.pause();
    else {
      if (element.currentTime < from || (to > 0 && element.currentTime >= to)) element.currentTime = from;
      void element.play().catch(() => setPlaying(false));
    }
  };
  const text = block.text ?? "";
  const parts =
    block.words === undefined
      ? [{ text, active: false }]
      : captionWordParts({ startSec: from, endSec: to, text, words: block.words }, at);
  return (
    <div>
      {text !== "" && (
        <div className="fy-wordtiming-line">
          {parts.map((part, index) =>
            part.active ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
          )}
        </div>
      )}
      <audio
        ref={audio}
        preload="metadata"
        aria-label={`Saved reading · ${block.label}`}
        src={block.file === undefined ? undefined : mediaUrl(slug, block.file)}
        onLoadedMetadata={() => {
          if (audio.current !== null) audio.current.currentTime = from;
        }}
        onPlay={() => {
          setPlaying(true);
          claimRead(key, () => audio.current?.pause());
        }}
        onPause={() => {
          setPlaying(false);
          releaseRead(key);
        }}
        onEnded={() => {
          setPlaying(false);
          releaseRead(key);
        }}
        onTimeUpdate={(event) => {
          setAt(event.currentTarget.currentTime);
          if (to > 0 && event.currentTarget.currentTime >= to) event.currentTarget.pause();
        }}
      />
      <div className="fy-abmotion-row">
        <Button variant="outline" disabled={block.file === undefined} onClick={play}>
          {playing ? "Pause" : "▶ Play line"}
        </Button>
        <b>
          {clockTime(Math.max(0, at - from))} / {clockTime(Math.max(0, to - from))}
        </b>
        <span className="grow" />
        <span className="fy-abmotion-meta">{block.ready ? "Timing preview" : "Timing not ready"}</span>
      </div>
      {to > from && (
        <input
          aria-label="Reading position"
          type="range"
          min={from}
          max={to}
          step={0.01}
          value={Math.min(to, Math.max(from, at))}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (audio.current) audio.current.currentTime = next;
            setAt(next);
          }}
        />
      )}
    </div>
  );
}
