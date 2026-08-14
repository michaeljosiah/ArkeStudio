import { useEffect, useState } from "react";
import { Button } from "./ui.js";
import { DispatchBar, resolveModel, usableModels } from "./dispatch-bar.js";
import { Portrait } from "./portrait.js";
import {
  discardWorldImage,
  generateWorldImage,
  uploadWorldImage,
  useStore,
  useWorldImage,
} from "../lib/store.js";

/**
 * The world's key image: generate it from the logline or bring your own, then keep or discard
 * what comes back.
 *
 * Shared rather than owned by the world hub, because the art-direction page needs the same
 * control. Somebody who has just set the master look on that page and finds the picker card
 * unchanged is not confused about caching — they are looking at the wrong image, and the right
 * one had no control on the screen they were standing on.
 *
 * The two images stay distinct: key art is a picture *of* the world and is what every card,
 * hero and scrim shows; a master look is a treatment carried into other work. This one is the
 * card.
 */
export function WorldKeyArt({
  worldId,
  slug,
  hasLogline,
}: {
  worldId: string;
  slug: string;
  hasLogline: boolean;
}) {
  const { state } = useStore();
  const world = state?.world;
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [choice, setChoice] = useState<{ modelId?: string }>({});
  // What can actually run, asked once and shared with the bar — the button's enabled state and
  // the picker's list have to be the same question. Judging it by the routed default alone meant
  // a usable model could be picked here while Generate stayed greyed out, and the only way
  // through was to go and change the global routing default first.
  // The same resolver the bar uses, so the button and the picker cannot disagree about which
  // model this surface will send — and a stranded default blocks rather than quietly running.
  // The id is sent explicitly even when nothing was picked: with no saved routing default the
  // bar shows the first usable model, while the coordinator's own fallback would take the first
  // row in the manifest — which can be a provider this machine has no key for.
  const offered = usableModels(state, "image");
  const resolved = resolveModel(state, "image", choice.modelId);
  const model = resolved.stranded === null ? resolved.model : null;
  const usable = model !== null;

  const mine = (state?.app.jobs ?? []).filter((j) => j.worldId === worldId && j.target.kind === "world-image");
  const running = mine.find((j) => j.status !== "succeeded" && j.status !== "failed" && j.status !== "cancelled");
  // Whether there is something to answer comes from the world itself, not from the job that
  // made it. A finished job stays in the queue log for good, so asking it "did you land a
  // file" answered yes on every visit — long after that file had been used or discarded.
  const waiting = state?.world?.keyArtCandidate ?? null;
  // The prompt is written by the harness before the job exists, so for a few seconds after the
  // click there is nothing in the queue to show. Without this the button looks like it missed.
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (asking && mine.length > 0) setAsking(false);
  }, [asking, mine.length]);
  const candidate = waiting !== null && !dismissed.includes(waiting) ? waiting : null;

  // A job that failed used to leave the button back at rest with nothing said — which is
  // exactly what "I clicked it and cannot see anything" looks like from the outside.
  const newest = [...mine].reverse()[0];
  const failed = newest?.status === "failed" && !dismissed.includes(newest.id) ? newest : undefined;
  if (failed && !candidate) {
    return (
      <div className="fy-keyart">
        <div className="fy-set__why">
          <span className="fy-set__dot fy-set__dot--warn" />
          <span>The key art did not come back — {failed.error ?? "the provider refused it"}</span>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            setDismissed((prev) => [...prev, failed.id]);
            generateWorldImage(worldId, model?.id);
          }}
        >
          Try again
        </Button>
        <Button variant="ghost" onClick={() => uploadWorldImage(worldId)}>
          Upload an image
        </Button>
        <button type="button" className="fy-set__link" onClick={() => setDismissed((prev) => [...prev, failed.id])}>
          Dismiss
        </button>
      </div>
    );
  }

  if (candidate) {
    return (
      <div className="fy-keyart">
        <div className="fy-keyart__shot">
          <Portrait worldSlug={slug} path={candidate} label="Key art, just made" radius={8} />
        </div>
        <div className="fy-keyart__ask">
          <span>Keep this as the world's key image?</span>
          <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button
              onClick={() => {
                useWorldImage(worldId);
                setDismissed((prev) => [...prev, candidate]);
              }}
            >
              Use this
            </Button>
            <button
              type="button"
              className="fy-set__link"
              onClick={() => {
                discardWorldImage(worldId);
                setDismissed((prev) => [...prev, candidate]);
              }}
            >
              Discard
            </button>
          </span>
        </div>
      </div>
    );
  }

  // Both reasons name the thing to go and fix, rather than greying out in silence. Only the
  // generate button is gated by them — an upload needs no logline and no provider at all, which
  // is exactly why it belongs beside a control that can be unavailable for either reason.
  const reason = !hasLogline
    ? "Give the world a logline first — it is what the image is made from"
    : !usable
      ? offered.length > 0
        ? "The default image model is switched off — pick another one here"
        : "Frames & stills has no provider with a key — set one in Settings"
      : undefined;
  return (
    <div className="fy-keyart">
      <Button
        variant="ghost"
        disabled={asking || running !== undefined || reason !== undefined}
        {...(reason ? { title: reason } : {})}
        onClick={() => {
          setAsking(true);
          generateWorldImage(worldId, model?.id);
        }}
      >
        {asking ? "Writing the prompt…" : running ? "Making the key art…" : "Generate key art from the logline"}
      </Button>
      <Button variant="ghost" onClick={() => uploadWorldImage(worldId)}>
        Upload an image
      </Button>
      {/* Model only: this request carries no output spec, so the provider's own size is what
          runs, and a size control that changed nothing would be worse than none. */}
      <DispatchBar variant="controls" size={false} workflow="main-photo" choice={choice} onChoice={setChoice} />
      <span className="fy-keyart__note">
        {reason ?? `World look v${world?.artDirection.version ?? 1} carries as text · comes back for a yes`}
      </span>
    </div>
  );
}
