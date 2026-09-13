import { useEffect, useState } from "react";
import {
  type ArtifactSidecar,
  MAX_CLIP_LANE,
  type CutOverlay,
} from "@arke-studio/contracts";
import { Button, cx } from "../components/ui.js";
import { Portrait } from "../components/portrait.js";
import {
  MIN_CLIP_SEC,
  applyClipDrag,
  type ClipGesture,
  type ClipPlacement,
} from "../lib/clip-drag.js";
import { ARTIFACT_DRAG_TYPE } from "./editor-audio.js";
import {
  placeOverlay,
  removeOverlay,
  moveOverlay,
  rejoinOverlayAudio,
  splitOverlayAudio,
} from "../lib/store.js";
import { Wave } from "../components/wave.js";

/**
 * The cut, watchable (24a's "Watch from top", finally doing something).
 *
 * One `<video>` walked across the derived spans rather than a clip per element: the cut plays one
 * piece of picture at a time by construction, and a span that has nothing to show says so instead
 * of holding the previous frame.
 */
/** What a dropped artifact covers when nothing says otherwise: about a shot's worth. */
export const CLIP_DEFAULT_SEC = 4;

/** One lane row plus the gap under it, which is what a drag has to cross to change lane. */
const LANE_PITCH_PX = 50;

/** The clip menu's own box, so a right-click near an edge opens somewhere it can be read. */
const CLIP_MENU_WIDTH_PX = 216;
const CLIP_MENU_HEIGHT_PX = 96;


function ClipView({
  worldId,
  prodId,
  clip,
  artifact,
  slug,
  totalSec,
  maxLane,
  snapPoints,
  onMenu,
  selected,
  onSelect,
}: {
  worldId: string;
  prodId: string;
  clip: CutOverlay;
  artifact: ArtifactSidecar | undefined;
  slug: string | undefined;
  totalSec: number;
  maxLane: number;
  snapPoints: readonly number[];
  onMenu: (clip: CutOverlay, at: { x: number; y: number }) => void;
  selected: boolean;
  onSelect: (clipId: string) => void;
}) {
  const [draft, setDraft] = useState<ClipPlacement | null>(null);
  const shown = draft ?? { startSec: clip.startSec, endSec: clip.endSec, lane: clip.lane ?? 0 };

  const begin = (gesture: ClipGesture) => (e: React.PointerEvent) => {
    if (e.button !== 0 || totalSec <= 0) return;
    onSelect(clip.id);
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    /*
     * Seconds per pixel come from the lane the clip sits in, never from the column of lanes: the
     * column also carries the label gutter, so measuring that makes every drag fall behind the
     * pointer by exactly the gutter's share of the width.
     */
    const laneWidth = el.closest(".fy-track__lane")?.getBoundingClientRect().width ?? 0;
    if (laneWidth <= 0) return;
    const originX = e.clientX;
    const originY = e.clientY;
    const origin: ClipPlacement = { startSec: clip.startSec, endSec: clip.endSec, lane: clip.lane ?? 0 };
    let last = origin;
    const move = (ev: PointerEvent) => {
      // Lanes are drawn highest-first, so dragging upward is dragging to a nearer lane.
      const lanes = gesture === "move" ? -Math.round((ev.clientY - originY) / LANE_PITCH_PX) : 0;
      const seconds = ((ev.clientX - originX) / laneWidth) * totalSec;
      last = applyClipDrag(origin, gesture, seconds, lanes, { totalSec, maxLane, snapPoints });
      setDraft(last);
    };
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      setDraft(null);
      // Nothing moved is nothing to file: a click that selects should not write history.
      if (last.startSec !== origin.startSec || last.endSec !== origin.endSec || last.lane !== origin.lane) {
        moveOverlay(worldId, prodId, clip.id, last.startSec, last.endSec, last.lane);
      }
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const name = artifact?.file.split("/").pop() ?? "missing artifact";
  const mode = clip.audio ?? "keep";
  const sound = mode === "only";
  return (
    <div
      className={cx(
        "fy-ovclip",
        sound && "fy-ovclip--sound",
        selected && "fy-ovclip--selected",
        draft && "fy-ovclip--dragging",
      )}
      style={{
        left: `${(shown.startSec / totalSec) * 100}%`,
        width: `${Math.max(((shown.endSec - shown.startSec) / totalSec) * 100, 1.5)}%`,
        /*
         * The row a clip is drawn in is decided by its *committed* lane, so a cross-lane drag
         * would otherwise slide along its old row and only jump after the round-trip — no
         * confirmation the lane even registered until it was too late to change your mind.
         * Lanes are drawn highest-first, so a higher target lane is one row up.
         */
        ...(draft && draft.lane !== (clip.lane ?? 0)
          ? { transform: `translateY(${((clip.lane ?? 0) - draft.lane) * LANE_PITCH_PX}px)` }
          : {}),
      }}
      title={`${name} · ${shown.startSec.toFixed(1)}s → ${shown.endSec.toFixed(1)}s${mode === "keep" ? "" : ` · ${mode === "only" ? "sound only" : "muted"}`}`}
      onPointerDown={begin("move")}
      onClick={() => onSelect(clip.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        onSelect(clip.id);
        onMenu(clip, { x: e.clientX, y: e.clientY });
      }}
    >
      <span
        className="fy-ovclip__grip fy-ovclip__grip--start"
        onPointerDown={begin("trim-start")}
        aria-label="trim the head"
      />
      {artifact?.kind === "image" || artifact?.kind === "board" ? (
        <span className="fy-ovclip__swatch">
          <Portrait worldSlug={slug} path={artifact.file} label="" radius={3} />
        </span>
      ) : sound || artifact?.kind === "audio" ? (
        <span className="fy-ovclip__swatch fy-ovclip__swatch--wave">
          <Wave seed={name} width={34} height={12} />
        </span>
      ) : null}
      <span className="fy-ovclip__name">{name}</span>
      {mode !== "keep" && <span className="fy-ovclip__badge">{sound ? "A" : "MUTE"}</span>}
      <button
        type="button"
        className="fy-ovclip__x"
        aria-label="Remove clip"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          removeOverlay(worldId, prodId, clip.id);
        }}
      >
        ×
      </button>
      <span
        className="fy-ovclip__grip fy-ovclip__grip--end"
        onPointerDown={begin("trim-end")}
        aria-label="trim the tail"
      />
    </div>
  );
}

/**
 * The lanes (82a, extended).
 *
 * A lane has no type. What a clip does is read from the artifact it cites, so the same row holds
 * a plate, an insert and a music bed — and splitting a video's sound puts two clips over one file
 * on two lanes rather than inventing an audio track that only audio may enter.
 *
 * Drawn highest-first, because a higher lane composites nearer the viewer and every editor this
 * cut can be handed to already draws it that way round. That is also what makes "split the sound
 * to the lane below" mean the row the eye expects.
 */
export function ClipLanes({
  worldId,
  prodId,
  slug,
  totalSec,
  clips,
  artifacts,
  snapPoints,
  selectedClipId,
  onSelectClip,
}: {
  worldId: string;
  prodId: string;
  slug: string | undefined;
  totalSec: number;
  clips: readonly CutOverlay[];
  artifacts: readonly ArtifactSidecar[];
  snapPoints: readonly number[];
  selectedClipId: string | null;
  onSelectClip: (clipId: string) => void;
}) {
  const [over, setOver] = useState<number | null>(null);
  const [added, setAdded] = useState(0);
  const [menu, setMenu] = useState<{ clip: CutOverlay; x: number; y: number } | null>(null);

  /*
   * Dismissed from anywhere, not only from inside the lanes (review). A menu whose only escape
   * was a press on the column it came from stayed painted over whatever the person moved on to,
   * with its buttons still live against a clip they were no longer looking at.
   */
  useEffect(() => {
    if (menu === null) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        close();
        e.stopImmediatePropagation();
      }
    };
    // Capture, so a press that a clip's own handler stops still closes the menu above it — but
    // not a press inside the menu, which would unmount the item before its click could fire.
    const closeOutside = (e: PointerEvent) => {
      if (e.target instanceof Element && e.target.closest(".fy-clipmenu")) return;
      close();
    };
    window.addEventListener("pointerdown", closeOutside, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    // `position: fixed` is viewport-anchored, so a scroll detaches the menu from its clip.
    window.addEventListener("scroll", close, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", closeOutside, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [menu]);

  // Two lanes at rest: one to drop a picture on and one under it for the sound, which is the
  // shape every split leaves behind and the one people arrive expecting.
  const used = clips.reduce((high, c) => Math.max(high, c.lane ?? 0), 0);
  const laneCount = Math.min(Math.max(2, used + 1, added), MAX_CLIP_LANE + 1);
  const maxLane = laneCount - 1;

  const drop = (lane: number) => (e: React.DragEvent) => {
    // A desktop file is not an overlay. Left alone it goes on up to the chrome, which appends it
    // to the record (issue 1035); claimed here, it went nowhere, since the chrome stands down for
    // a drop a lane has answered.
    if (e.dataTransfer.files?.length) {
      setOver(null);
      return;
    }
    e.preventDefault();
    setOver(null);
    const artifactId = e.dataTransfer.getData(ARTIFACT_DRAG_TYPE);
    if (!artifactId || totalSec <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const at = Math.max(
      0,
      Math.min(((e.clientX - box.left) / box.width) * totalSec, Math.max(0, totalSec - MIN_CLIP_SEC)),
    );
    const end = Math.min(at + CLIP_DEFAULT_SEC, totalSec);
    // A drop at the very end would ask for a window with no length; give it what is left.
    placeOverlay(
      worldId,
      prodId,
      artifactId,
      Math.round(at * 1000) / 1000,
      Math.round(Math.max(end, at + MIN_CLIP_SEC) * 1000) / 1000,
      lane,
    );
  };

  /*
   * Why a split is or is not on offer, in the same words the coordinator refuses in — the menu
   * used to offer it for any video and let the write fail into the app log, which is a refusal
   * nobody reading the screen ever sees.
   */
  const splitState = ((): { ok: boolean; why: string } => {
    if (menu === null) return { ok: false, why: "" };
    const mode = menu.clip.audio ?? "keep";
    if (mode === "only") return { ok: false, why: "this is already the sound half" };
    if (mode === "mute") return { ok: false, why: "already split" };
    const artifact = artifacts.find((a) => a.id === menu.clip.artifactId);
    if (artifact === undefined) return { ok: false, why: "this clip cites nothing this world has" };
    if (artifact.kind !== "video") return { ok: false, why: `a ${artifact.kind} has no sound to split` };
    if (artifact.mediaInfo === undefined) return { ok: false, why: "not measured yet — try again shortly" };
    if (!artifact.mediaInfo.hasAudio)
      return { ok: false, why: "measured as silent, so there is nothing to split" };
    return { ok: true, why: "" };
  })();
  const rejoinable = menu !== null && (menu.clip.audio ?? "keep") === "mute";

  return (
    <div className="fy-clanes" onPointerDown={() => setMenu(null)}>
      {Array.from({ length: laneCount }, (_, i) => maxLane - i).map((lane) => (
        <div className="fy-track" key={lane}>
          <span className="fy-track__label">Overlay L{lane}</span>
          <div
            className={cx("fy-track__lane", "fy-ovlane", over === lane && "fy-ovlane--over")}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes("Files")) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
              setOver(lane);
            }}
            onDragLeave={() => setOver((l) => (l === lane ? null : l))}
            onDrop={drop(lane)}
          >
            {clips.every((c) => (c.lane ?? 0) !== lane) && (
              <span className="fy-ovlane__empty">
                {lane === 0
                  ? "drop a bed here, or split a clip's sound down to it"
                  : "drop an artifact to place it"}
              </span>
            )}
            {clips
              .filter((c) => (c.lane ?? 0) === lane)
              .map((c) => (
                <ClipView
                  key={c.id}
                  worldId={worldId}
                  prodId={prodId}
                  clip={c}
                  artifact={artifacts.find((a) => a.id === c.artifactId)}
                  slug={slug}
                  totalSec={totalSec}
                  maxLane={maxLane}
                  snapPoints={snapPoints}
                  onMenu={(clip, at) => setMenu({ clip, x: at.x, y: at.y })}
                  selected={selectedClipId === c.id}
                  onSelect={onSelectClip}
                />
              ))}
          </div>
        </div>
      ))}
      <div className="fy-clanes__foot">
        <Button
          variant="ghost"
          size="sm"
          disabled={laneCount > MAX_CLIP_LANE}
          onClick={() => setAdded(laneCount + 1)}
        >
          Add lane
        </Button>
        <span className="fy-mono">
          a higher lane sits nearer the viewer · right-click a clip to split its sound
        </span>
      </div>
      {menu && (
        <div
          className="fy-clipmenu"
          /* Kept inside the viewport: a right-click near an edge would otherwise open the menu
             off the side of the window, where it can be neither read nor reached. */
          style={{
            left: Math.min(menu.x, Math.max(0, window.innerWidth - CLIP_MENU_WIDTH_PX - 8)),
            top: Math.min(menu.y, Math.max(0, window.innerHeight - CLIP_MENU_HEIGHT_PX - 8)),
          }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {rejoinable ? (
            <button
              type="button"
              className="fy-clipmenu__item"
              onClick={() => {
                rejoinOverlayAudio(worldId, prodId, menu.clip.id);
                setMenu(null);
              }}
            >
              Rejoin its sound
            </button>
          ) : (
            <button
              type="button"
              className="fy-clipmenu__item"
              disabled={!splitState.ok}
              onClick={() => {
                splitOverlayAudio(worldId, prodId, menu.clip.id);
                setMenu(null);
              }}
            >
              Split audio to the lane below
            </button>
          )}
          <button
            type="button"
            className="fy-clipmenu__item"
            onClick={() => {
              removeOverlay(worldId, prodId, menu.clip.id);
              setMenu(null);
            }}
          >
            Remove clip
          </button>
          {!rejoinable && !splitState.ok && <span className="fy-clipmenu__note">{splitState.why}</span>}
        </div>
      )}
    </div>
  );
}
