import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { FrameRate } from "@arke-studio/contracts";
import type { CutSelection } from "./editor-inspector.js";
import type { Transport } from "./editor-transport.js";
import type { ActiveEffectReview, EffectReviewPosition } from "../lib/editor-effect-review-state.js";

export interface EffectReviewPositionOwner {
  active: Pick<ActiveEffectReview, "ref" | "position" | "activationSerial" | "comparison"> | null;
  rememberPosition: (position: EffectReviewPosition) => void;
}

/** Restore the chosen review on route resume; choosing another card while Cut is open never seeks. */
export function useEffectReviewPosition(review: EffectReviewPositionOwner, input: {
  ownerKey: string;
  frameRate: FrameRate; transport: Pick<Transport, "time" | "timeRef" | "seek">; canvas: RefObject<HTMLDivElement | null>;
  selected: CutSelection | null; onSelect: (selection: CutSelection | null) => void;
}) {
  const owner = useRef({ key: input.ownerKey, initiallyActive: !!review.active, restored: false });
  const skipSave = useRef(false);
  if (owner.current.key !== input.ownerKey) {
    owner.current = { key: input.ownerKey, initiallyActive: !!review.active, restored: false };
    skipSave.current = false;
  }
  const latest = useRef({ review, input }); latest.current = { review, input };
  useLayoutEffect(() => {
    if (owner.current.restored || !review.active) return;
    owner.current.restored = true;
    const position = review.active.position;
    if (!position || !owner.current.initiallyActive && review.active.activationSerial !== 0) return;
    skipSave.current = true;
    if (position.playheadFrame !== undefined) input.transport.seek(position.playheadFrame / input.frameRate);
    input.onSelect(position.selectedEffectId === undefined ? null : { kind: "effect", id: position.selectedEffectId });
    if (position.scrollLeft !== undefined && input.canvas.current) input.canvas.current.scrollLeft = position.scrollLeft;
  }, [input.ownerKey, review.active?.ref.familyId, review.active?.ref.versionId]);
  const save = () => {
    const { review: now, input: values } = latest.current;
    if (!now.active) return;
    now.rememberPosition({
      ...(values.selected?.kind === "effect" ? { selectedEffectId: values.selected.id } : {}),
      playheadFrame: Math.max(0, Math.round(values.transport.timeRef.current * values.frameRate)),
      scrollLeft: values.canvas.current?.scrollLeft ?? 0,
    });
  };
  useEffect(() => {
    if (skipSave.current) { skipSave.current = false; return; }
    save();
  }, [input.selected, input.transport.time, review.active?.ref.versionId, review.active?.comparison]);
  useEffect(() => {
    const element = input.canvas.current;
    const ownerKey = input.ownerKey;
    const remember = () => { if (latest.current.input.ownerKey === ownerKey) save(); };
    element?.addEventListener("scroll", remember, { passive: true });
    return () => { remember(); element?.removeEventListener("scroll", remember); };
  }, [input.ownerKey, input.canvas]);
}
