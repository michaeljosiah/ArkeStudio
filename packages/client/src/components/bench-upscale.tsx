import { useEffect, useRef, useState } from "react";
import {
  benchUpscalePlan,
  engineFloorClause,
  upscaleCropCopy,
  upscaleFrameCopy,
  upscaleTimeCopy,
  type BenchTake,
  type ManifestModel,
  type RecipeReadiness,
  type UpscaleRateSample,
} from "@arke-studio/contracts";
import { Upscale as UpscaleGlyph } from "./icons.js";
import { Button, cx } from "./ui.js";
import { sendBenchUpscale, subscribeQueueResults, useStore } from "../lib/store.js";

/**
 * Upscale to 1080p (design turn 178a, as the icon turn 180 made it): a glyph among the take's
 * tools that opens a popover stating, as data, what the press will do — the size, the frame, the
 * crop, the model and its time on this machine — before anything runs.
 *
 * The time is this machine's measured rate times the source's length, and a dash until one
 * upscale has completed here. An engine below the recipe's floor is said in the same clause the
 * coordinator refuses with, and the press is held there rather than sent to be refused.
 */

/** The installed upscaler's row, if the manifest carries one. */
export function upscalerFor(manifest: { models: readonly ManifestModel[] } | null | undefined): ManifestModel | null {
  return manifest?.models.find((model) => model.upscale !== undefined && model.provider === "comfyui") ?? null;
}

/** Why the engine cannot run the upscaler now, in one clause, or null when nothing says so. */
export function upscaleHeld(model: ManifestModel, readiness: RecipeReadiness | undefined): string | null {
  if (readiness === undefined || readiness.state !== "disabled") return null;
  if (readiness.reasonKind === "engine" && model.upscale !== undefined) return engineFloorClause(model.upscale.minEngineVersion);
  return readiness.reason ?? "Not ready on this machine";
}

/** The popover's rows (178a), pure so the words can be asserted without a screen. */
export function upscaleRows(
  take: BenchTake,
  model: ManifestModel,
  rates: Readonly<Record<string, readonly UpscaleRateSample[]>> | undefined,
): Array<[string, string]> | null {
  const plan = benchUpscalePlan(take);
  if (plan === null) return null;
  const time = upscaleTimeCopy(rates?.[model.id], take.media?.info?.durationSec ?? 0);
  return [
    ["Size", "1080p"],
    ["Frame", upscaleFrameCopy(plan)],
    ["Crop", upscaleCropCopy(plan.crop)],
    ["Model", model.displayName],
    ["Time", time === "—" ? time : `${time} · GPU time`],
  ];
}

export function UpscaleTool({
  worldId,
  sessionId,
  take,
  model,
  initialOpen = false,
}: {
  worldId: string;
  sessionId: string;
  take: BenchTake;
  model: ManifestModel;
  /** Rendered open, for a server-rendered test of the popover; the screen always starts closed. */
  initialOpen?: boolean;
}) {
  const { state } = useStore();
  const [open, setOpen] = useState(initialOpen);
  const [pending, setPending] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const root = useRef<HTMLSpanElement>(null);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;
  useEffect(() => {
    setOpen(initialOpen);
    setRefusal(null);
    setPending(null);
  }, [take.id]);
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pendingRef.current) return;
        setPending(null);
        if (result.disposition === "rejected") setRefusal(result.failures[0]?.reason ?? "That could not be upscaled");
        else setOpen(false);
      }),
    [],
  );
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const rows = upscaleRows(take, model, state?.app.localSampling?.rates);
  if (rows === null) return null;
  const readiness = state?.app.comfyui?.recipes.find((recipe) => recipe.recipeId === model.id);
  const held = upscaleHeld(model, readiness);
  const clause = held ?? refusal;
  return (
    <span className="fy-upscale" ref={root}>
      <button
        type="button"
        className="fy-bench__rowicon fy-tip"
        data-tip="Upscale to 1080p"
        aria-label="Upscale to 1080p"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setRefusal(null);
          setOpen(!open);
        }}
      >
        <UpscaleGlyph size={14} />
      </button>
      {open && (
        <span className="fy-upscale__pop" role="dialog" aria-label={`Upscale Take ${take.n}`} data-testid="upscale-popover">
          <b className="fy-upscale__title">{`Upscale Take ${take.n}`}</b>
          <span className="fy-upscale__rows">
            {rows.map(([label, value]) => (
              <span key={label} className="fy-upscale__row">
                <span>{label}</span>
                <span className={cx(label !== "Model" && "fy-upscale__mono")}>{value}</span>
              </span>
            ))}
          </span>
          {clause !== null && (
            <span role="alert" className="fy-upscale__why" data-testid="upscale-refusal">
              {clause}
            </span>
          )}
          <span className="fy-upscale__foot">
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              data-testid="upscale-confirm"
              disabled={held !== null || pending !== null}
              onClick={() => {
                setRefusal(null);
                setPending(sendBenchUpscale(worldId, sessionId, take.id));
              }}
            >
              Upscale
            </Button>
          </span>
        </span>
      )}
    </span>
  );
}
