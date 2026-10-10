import { useEffect, useRef, useState } from "react";
import { ulid, type AudiobookWordTimingState } from "@arke-studio/contracts";
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
  return (
    <div className="fy-wordtiming">
      <div className="fy-abv-opt">
        <b>Word timing</b>
        <span role="status">
          {state === null
            ? "Checking saved readings…"
            : state.running
              ? `Preparing ${state.done} of ${state.total} blocks…`
              : ready
                ? "Ready · matched to the current audio and words"
                : `${pending.length} blocks need timing`}
        </span>
        <span className="grow" />
        {state?.running ? (
          <Button variant="outline" onClick={() => request("stop")}>
            Stop
          </Button>
        ) : (
          !ready && (
            <Button variant="outline" disabled={state?.available !== true} onClick={() => request("prepare")}>
              Prepare word timing
            </Button>
          )
        )}
      </div>
      {state?.available === false && (
        <p className="fy-abv-note">{state.reason ?? "The local voice runtime is unavailable"}</p>
      )}
      {!ready && (
        <p className="fy-abv-note">
          Uses the saved audio on this machine. No new reading or API charge.{" "}
          {pending.length > 0 && (
            <button type="button" className="fy-abv-btn" onClick={() => setReview(true)}>
              Review blocks
            </button>
          )}
        </p>
      )}
      <EditorDialog
        open={review}
        onClose={() => setReview(false)}
        title="Word timing needs a check"
        subtitle="Export waits until every selected block is ready"
        width={680}
        panelClassName="fy-abmotion"
      >
        <div className="fy-wordtiming-list">
          {pending.map((block) => (
            <div key={`${block.chapterId}/${block.key}`}>
              <b>{block.label}</b>
              <p>{block.reason}</p>
              {block.file !== undefined && slug !== undefined && (
                <audio
                  controls
                  preload="none"
                  aria-label={`Saved reading · ${block.label}`}
                  src={mediaUrl(slug, block.file)}
                  onPlay={(event) => {
                    const audio = event.currentTarget;
                    claimRead(`word-timing-review:${block.chapterId}/${block.key}`, () => audio.pause());
                  }}
                  onPause={() => releaseRead(`word-timing-review:${block.chapterId}/${block.key}`)}
                  onEnded={() => releaseRead(`word-timing-review:${block.chapterId}/${block.key}`)}
                />
              )}
            </div>
          ))}
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
          <span />
          <Button
            variant="primary"
            disabled={state?.available !== true || state.running}
            onClick={() => {
              request("prepare");
              setReview(false);
            }}
          >
            Prepare again
          </Button>
        </div>
      </EditorDialog>
    </div>
  );
}
