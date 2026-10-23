import { useEffect, useRef, useState } from "react";
import { bookPictureShapes, modelForCapability, pictureQuote, priceLabel, type AudiobookListening, type ManifestModel, type PictureShape, type ProductionBundle } from "@arke-studio/contracts";
import { lastAudiobookTallProgress, makeAudiobookTallPictures, openAudiobookListening, setAudiobookPictureShapes, stopAudiobookTallPictures, subscribeAudiobookListening, subscribeAudiobookTallProgress, useStore, type AudiobookTallProgress } from "../lib/store.js";
import { Toggle } from "./audiobook-video.js";
import { X } from "./icons.js";
import { Button } from "./ui.js";

/**
 * Pictures (design turn 235a, SPEC-047 R-195, R-199): the shapes the book's pictures are made in,
 * Wide for desktop and tablet and Tall for a phone, each with how many are made; the model and its
 * price; and `Make 290 tall` while Tall is on and pictures lack it, its run followed in place as
 * Illustrate's is. Counted from the book's own listening plan, as Export counts it.
 */
const SHAPES: ReadonlyArray<{ shape: PictureShape; name: string; ratio: string; shows: string }> = [
  { shape: "wide", name: "Wide", ratio: "16:9", shows: "desktop · tablet" },
  { shape: "tall", name: "Tall", ratio: "9:16", shows: "phone" },
];

/**
 * The model a book's pictures are made with now, as the coordinator resolves it: the world's own
 * choice, else Settings' route. A Tall is made on it whatever its Wide was made on, so it is priced
 * on it too (codex on PR 2166).
 */
export function pictureRouteModel(state: ReturnType<typeof useStore>["state"]): ManifestModel | null {
  const manifest = state?.app.manifest;
  return manifest ? modelForCapability(manifest, { ...state?.app.routing.defaults, ...state?.world?.meta.models }, "image") : null;
}

/** What the book's plan holds: its pictures, the Talls made from them, and those still to make. */
export function pictureCounts(plan: AudiobookListening): { pictures: number; tall: number; toMake: number } {
  const pictures = plan.chapters.flatMap((chapter) => chapter.pictures);
  const tall = pictures.filter((picture) => picture.tall !== undefined).length;
  return { pictures: pictures.length, tall, toMake: pictures.filter((picture) => picture.tall === undefined || picture.tallEarlier === true).length };
}

export function PicturesSheet({ worldId, production, onClose }: { worldId: string; production: ProductionBundle; onClose: () => void }) {
  const store = useStore();
  const connection = store.connection;
  const shapes = bookPictureShapes(production.audiobook);
  const [plan, setPlan] = useState<AudiobookListening | null>(null);
  // The run as the store keeps it, read each render: a snapshot clears it and the coordinator's
  // replay sets it again, so a reconnect never leaves a finished run showing Stop.
  const [, setHeard] = useState(0);
  const run: AudiobookTallProgress | null = lastAudiobookTallProgress(worldId, production.meta.id);
  const asked = useRef<string | null>(null);
  const shell = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = shell.current;
    if (!element) return;
    const opener = element.ownerDocument.activeElement as HTMLElement | null;
    element.focus();
    return () => {
      if (opener && opener.isConnected && typeof opener.focus === "function") opener.focus();
    };
  }, []);
  useEffect(() => {
    const offPlan = subscribeAudiobookListening((answer) => {
      if (answer.requestId === asked.current && answer.listening !== undefined) setPlan(answer.listening);
    });
    const offRun = subscribeAudiobookTallProgress((progress) => {
      if (progress.productionId !== production.meta.id) return;
      setHeard((count) => count + 1);
      // Each Tall landed shows in the counts: the plan is read again as the run goes and when it ends.
      asked.current = openAudiobookListening(worldId, production.meta.id);
    });
    asked.current = openAudiobookListening(worldId, production.meta.id);
    return () => {
      offPlan();
      offRun();
    };
  }, [worldId, production.meta.id]);

  const counts = plan === null ? null : pictureCounts(plan);
  const model = pictureRouteModel(store.state);
  const plan_ = model?.pricing.kind === "included-plan" ? ("included-plan" as const) : undefined;
  const tallQuote = model === null ? 0 : pictureQuote(model, 1, "9:16");
  const making = run?.state === "making";
  const toggle = (shape: PictureShape, on: boolean) => {
    const next = SHAPES.map((entry) => entry.shape).filter((candidate) => (candidate === shape ? on : shapes.includes(candidate)));
    if (next.length > 0) setAudiobookPictureShapes(worldId, production.meta.id, next);
  };
  const made = (shape: PictureShape) => (counts === null ? "…" : `${shape === "wide" ? counts.pictures : counts.tall} made`);

  return (
    <>
      <div className="fy-abshow__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={shell}
        className="fy-abshow__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audiobook-pictures-title"
        tabIndex={-1}
        data-testid="pictures-sheet"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="fy-abshow__sheet-hd">
          <h3 id="audiobook-pictures-title">Pictures</h3>
          <button type="button" className="fy-abshow__x" aria-label="Close" onClick={onClose}>
            <X size={15} stroke={1.9} />
          </button>
        </div>
        <div className="fy-abshow__sheet-bdy">
          {SHAPES.map((entry) => {
            const on = shapes.includes(entry.shape);
            return (
              <div key={entry.shape} className="fy-abshow__kv fy-pics__shape" data-testid={`pictures-shape-${entry.shape}`}>
                {/* The last shape on stays on: a book's pictures are made in at least one. */}
                <Toggle on={on} onChange={(next) => (connection === "open" && (next || shapes.length > 1) ? toggle(entry.shape, next) : undefined)}>
                  <b>{entry.name}</b>
                </Toggle>
                <span className="fy-abshow__mono">{entry.ratio}</span>
                <span className="fy-pics__grow" />
                <span className="fy-abshow__mono">{entry.shows}</span>
                <span className="fy-abshow__mono fy-pics__made">{made(entry.shape)}</span>
              </div>
            );
          })}
          {model !== null && (
            <div className="fy-abshow__kv fy-pics__shape">
              <b>Model</b>
              <span>{model.displayName}</span>
              <span className="fy-pics__grow" />
              <span className="fy-abshow__mono">{priceLabel(tallQuote, plan_)}</span>
            </div>
          )}
          {shapes.includes("tall") && counts !== null && (counts.toMake > 0 || making) && (
            <div className="fy-pics__make" data-testid="pictures-make-tall">
              <b>{making ? `Tall · ${run!.made} of ${run!.total}` : `Tall · ${counts.toMake} to make`}</b>
              <span className="fy-pics__grow" />
              {making ? (
                <Button variant="outline" size="sm" disabled={connection !== "open"} onClick={() => stopAudiobookTallPictures(worldId, production.meta.id)} data-testid="pictures-stop-tall">
                  Stop
                </Button>
              ) : (
                <Button variant="primary" size="sm" disabled={connection !== "open"} onClick={() => makeAudiobookTallPictures(worldId, production.meta.id, counts.toMake * tallQuote)} data-testid="pictures-start-tall">
                  Make {counts.toMake} tall
                </Button>
              )}
            </div>
          )}
          {run !== null && run.state !== "making" && (run.refused !== undefined || run.failed.length > 0) && (
            <p className="fy-abshow__mono fy-pics__w" data-testid="pictures-make-refused">
              {run.refused ?? `${run.failed.length} not made · ${run.failed[0]!.reason}`}
            </p>
          )}
        </div>
      </div>
    </>
  );
}
