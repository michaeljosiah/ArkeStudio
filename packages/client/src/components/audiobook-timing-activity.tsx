import { useEffect, useSyncExternalStore } from "react";
import { ulid, type ClientState } from "@arke-studio/contracts";
import {
  send,
  subscribeAudiobookWordTiming,
  useStore,
  type AudiobookWordTimingAnswer,
} from "../lib/store.js";
import { Button } from "./ui.js";

// Timing prepares existing audio. It must never inherit a narration job's label or spend.
let running: readonly AudiobookWordTimingAnswer[] = [];
const listeners = new Set<() => void>();
subscribeAudiobookWordTiming((event) => {
  running = [
    ...running.filter((held) => held.worldId !== event.worldId || held.productionId !== event.productionId),
    ...(event.state.running ? [event] : []),
  ];
  for (const listener of listeners) listener();
});
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => running;

/** Reopened Activity asks the current coordinator, so another window's preparation is visible. */
export function useWordTimingActivity(
  state: ClientState,
  scope: "active" | "all",
  activeWorldId: string | null,
) {
  const connection = useStore().connection;
  const entries = useSyncExternalStore(subscribe, snapshot, snapshot);
  const worldId = state.world?.meta.worldId;
  const productionIds =
    state.world?.productions
      .filter((production) => production.meta.format === "story")
      .map((production) => production.meta.id) ?? [];
  const key = JSON.stringify(productionIds);
  useEffect(() => {
    if (connection !== "open" || worldId === undefined) return;
    for (const productionId of productionIds)
      send({ kind: "audiobook-word-timing", worldId, productionId, action: "read", requestId: ulid() });
  }, [worldId, key, connection]);
  return entries.filter(
    // Closing a world aborts its local preparation. A cached transient event is not a
    // running job in another world, and must disappear before its final reply arrives.
    (entry) => entry.worldId === worldId &&
      (scope === "all" || activeWorldId === null || entry.worldId === activeWorldId),
  );
}

export function WordTimingActivityRow({
  entry,
  state,
}: {
  entry: AudiobookWordTimingAnswer;
  state: ClientState;
}) {
  const connection = useStore().connection;
  const production =
    state.world?.meta.worldId === entry.worldId
      ? state.world.productions.find((production) => production.meta.id === entry.productionId)
      : undefined;
  const chapter =
    entry.state.chapters?.length === 1
      ? production?.chapters.find((chapter) => chapter.id === entry.state.chapters![0])
      : undefined;
  return (
    <div className="fy-ap__row fy-ap__row--top fy-abactivity" data-testid="word-timing-activity-row">
      <span className="fy-ap__dot fy-ap__dot--live" aria-hidden />
      <div className="fy-ap__main">
        <div className="fy-ap__rowtitle">
          Preparing word timings{chapter === undefined ? "" : ` · Chapter ${chapter.order}`}
        </div>
        <div className="fy-ap__rowsub">{production?.meta.title ?? entry.productionId}</div>
        <p role="status">
          {entry.state.done} of {entry.state.total} blocks · on this device
        </p>
        <div
          className="fy-abactivity__progress"
          role="progressbar"
          aria-label="Word timing preparation"
          aria-valuenow={entry.state.done}
          aria-valuemin={0}
          aria-valuemax={Math.max(1, entry.state.total)}
        >
          <i style={{ width: `${Math.min(100, Math.max(0, entry.state.done / Math.max(1, entry.state.total) * 100))}%` }} />
        </div>
        <p className="fy-ap__rowsub">The current recordings stay unchanged.</p>
        {connection !== "open" && <p className="fy-ap__reason">Reconnect to see current progress.</p>}
        <div className="fy-ap__actions">
          <Button
            size="sm"
            variant="outline"
            disabled={connection !== "open"}
            onClick={() =>
              send({
                kind: "audiobook-word-timing",
                worldId: entry.worldId,
                productionId: entry.productionId,
                action: "stop",
                requestId: ulid(),
              })
            }
          >
            Stop
          </Button>
        </div>
      </div>
    </div>
  );
}
