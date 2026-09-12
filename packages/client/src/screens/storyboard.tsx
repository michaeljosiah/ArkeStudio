import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  orderedShots,
  sceneDeleteBlockers,
  sceneFindings,
  shotCoverage,
  type Scene,
} from "@arke-studio/contracts";
import { Textarea, cx } from "../components/ui.js";
import { X } from "../components/icons.js";
import { useProduction } from "../lib/selectors.js";
import { deleteScene, restoreScene } from "../lib/store.js";
import { Mentions, sceneFileOf } from "./production.js";


/**
 * The storyboard (design turn 97, frame 14c) and the full shot behind each card (14d).
 *
 * The card is the editor: the script is typed on it, and everything else the card states is
 * derived — never a stored status. A hand edit saves where it stands (the bible's model,
 * master §4.5): every save cuts a version, and a save against a scene that moved is refused by
 * the coordinator, which this screen learns from the snapshot's version rather than a reply.
 * The scene workspace owns generation. Legacy cards keep their editing surface while their
 * generation links return to that owner rather than the retired takes/dispatch route.
 */

// ---------------------------------------------------------------------------
// Derivations — the maturity ladder and coverage, computed and never stored
// ---------------------------------------------------------------------------

/**
 * sha256 of every script block's current text, keyed by block id — what the Re-read chip
 * compares a shot's citations against. WebCrypto is async, so the map arrives a beat after
 * the scene; until it does (and in environments without subtle crypto) nothing shows stale,
 * which errs on the quiet side.
 *
 * Cached by the blocks array itself (review 2026-08-22): the strip, the review and the foot
 * each call this hook, and each instance was hashing the whole script again — same bytes,
 * three sweeps per render tree. The store hands every subscriber the same array reference per
 * frame, so a WeakMap on it makes the second and third callers free without changing anyone's
 * signature.
 */
const blockDigestCache = new WeakMap<readonly { id: string; text: string }[], Promise<Map<string, string>>>();

function digestBlocks(blocks: readonly { id: string; text: string }[]): Promise<Map<string, string>> {
  let hit = blockDigestCache.get(blocks);
  if (!hit) {
    hit = (async () => {
      const next = new Map<string, string>();
      for (const block of blocks) {
        const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(block.text));
        const hex = [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
        next.set(block.id, `sha256:${hex}`);
      }
      return next;
    })();
    blockDigestCache.set(blocks, hit);
  }
  return hit;
}

export function useBlockDigests(scene: Pick<Scene, "script"> | undefined): Map<string, string> {
  const [digests, setDigests] = useState<Map<string, string>>(() => new Map());
  const blocks = scene?.script?.blocks;
  useEffect(() => {
    if (!blocks || blocks.length === 0 || !globalThis.crypto?.subtle) {
      setDigests(new Map());
      return;
    }
    let cancelled = false;
    void digestBlocks(blocks).then((next) => {
      if (!cancelled) setDigests(next);
    });
    return () => {
      cancelled = true;
    };
  }, [blocks]);
  return digests;
}

// ---------------------------------------------------------------------------
// Inline editors — display renders mentions as chips; a click opens plain text
// ---------------------------------------------------------------------------

export function EditableText({
  value,
  placeholder,
  className,
  rows = 4,
  onCommit,
}: {
  value: string;
  placeholder: string;
  className?: string;
  rows?: number;
  onCommit: (next: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <div
        role="textbox"
        tabIndex={0}
        title="Type @ to reference"
        className={cx("fy-sbscript", value.trim() === "" && "fy-sbscript--blank", className)}
        onClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") setEditing(true);
        }}
      >
        {value.trim() === "" ? placeholder : <Mentions text={value} />}
      </div>
    );
  }
  return (
    <Textarea
      autoFocus
      defaultValue={value}
      rows={rows}
      style={{ font: "400 12.5px/1.7 var(--font-sans)" }}
      onBlur={(e) => {
        setEditing(false);
        const next = e.target.value.trim();
        if (next !== value) onCommit(next);
      }}
    />
  );
}

/**
 * The scene's own review, above the shots it is about (design turn 102).
 *
 * Turns 98 and 101 put this on a page of its own, and a costing page reached from the creative
 * surface is layer three standing in front of layer one — the test turn 102 states. So it is a
 * strip here instead: what was found, in the scene's own words, beside the shots that would fix
 * it. Nothing blocks; a review is something you consulted, not a gate you passed.
 *
 * The findings are derived, not an agent's: what the scene already knows about itself. The
 * Director turn 98 asked for would say more, and would say it here.
 */
export function SceneReview({ scene, onClose }: { scene: Scene; onClose: () => void }) {
  const digests = useBlockDigests(scene);
  const stale = orderedShots(scene).filter((s) => shotCoverage(s, digests) === "changed").map((s) => s.id);
  const found = sceneFindings(scene, stale);
  return (
    <div className="fy-review" data-review="scene">
      <div className="fy-review__what">
        <span className="fy-review__title">Ready to generate</span>
        <span className="fy-mono">
          {found.length === 0
            ? "nothing to flag"
            : `${found.length} suggestion${found.length === 1 ? "" : "s"} · nothing blocking`}
        </span>
      </div>
      <div className="fy-review__list">
        {found.length === 0 ? (
          <span className="fy-review__line">Every shot has something to generate from.</span>
        ) : (
          found.map((f, i) => (
            <span key={`${f.kind}-${f.about ?? i}`} className="fy-review__line">
              {f.message}
            </span>
          ))
        )}
      </div>
      <button type="button" className="fy-review__close" title="Put the review away" aria-label="Put the review away" onClick={onClose}>
        <X size={13} />
      </button>
    </div>
  );
}

export function StoryboardFoot({
  worldId,
  prodId,
  scene,
}: {
  worldId: string;
  prodId: string;
  scene: Scene;
}) {
  const { production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const digests = useBlockDigests(scene);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** Asked once, in the same place, before anything goes (the delete is a version away back). */
  const [confirming, setConfirming] = useState(false);
  if (!production) return null;
  const stem = sceneFileOf(production, scene);
  /*
   * What deletion would take with it, said before it is pressed rather than after. The
   * coordinator refuses on exactly these grounds and its refusal reaches the toaster; saying it
   * here as well means the person never has to press a button to find out they cannot.
   */
  const blockers = sceneDeleteBlockers(production, scene);
  /*
   * The same arithmetic as SceneReview (review 2026-08-22): this line counted by its own rule —
   * empty description or stale, promptOverride ignored — so the foot could say "1 to review"
   * over a review strip saying "nothing to flag". One place decides what needs a look.
   */
  const stale = orderedShots(scene).filter((s) => shotCoverage(s, digests) === "changed").map((s) => s.id);
  const attention = sceneFindings(scene, stale).length;
  return (
    <div className="fy-sbfoot" data-testid="storyboard-foot">
      <span className="fy-sbdot" style={{ background: attention === 0 ? "var(--success)" : "var(--warning)" }} />
      <span style={{ font: "500 12px var(--font-sans)" }}>
        {attention === 0 ? "Ready to generate" : `${attention} to review`}
      </span>
      <span style={{ flex: 1 }} />
      {/* Delete sits beside the history, because the history is what makes it survivable. */}
      <span className="fy-mono" style={{ position: "relative" }} data-testid="scene-delete">
        {confirming ? (
          <>
            Delete scene {scene.number}?{" "}
            <button
              type="button"
              className="fy-sblink"
              onClick={() => {
                if (stem) deleteScene(worldId, prodId, stem);
                setConfirming(false);
                navigate(`/w/${worldId}/p/${prodId}/scenes`);
              }}
            >
              Delete
            </button>{" "}
            <button type="button" className="fy-sblink" onClick={() => setConfirming(false)}>
              Keep
            </button>
          </>
        ) : blockers.length > 0 ? (
          <span title={blockers.join(" · ")}>cannot delete · {blockers[0]}</span>
        ) : (
          <button type="button" className="fy-sblink" onClick={() => setConfirming(true)}>
            Delete scene
          </button>
        )}
      </span>
      <span className="fy-mono" style={{ position: "relative" }}>
        scene {scene.number} · v{scene.version} ·{" "}
        <button type="button" className="fy-sblink" onClick={() => setHistoryOpen((v) => !v)}>
          version history
        </button>
        {historyOpen && scene.version > 1 && stem && (
          <span className="fy-sbmenu" style={{ right: 0, bottom: 22 }} data-testid="scene-history">
            {Array.from({ length: scene.version - 1 }, (_, i) => scene.version - 1 - i).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => {
                  restoreScene(worldId, prodId, stem, v);
                  setHistoryOpen(false);
                }}
              >
                Restore v{v}
              </button>
            ))}
          </span>
        )}
        {historyOpen && scene.version <= 1 && (
          <span className="fy-sbmenu" style={{ right: 0, bottom: 22 }}>
            <span style={{ display: "block", padding: "7px 9px", color: "var(--muted-foreground)", font: "400 11px var(--font-sans)" }}>
              v1 is the whole history
            </span>
          </span>
        )}
      </span>
    </div>
  );
}

/** The line under the title (14c): the synopsis, edited in place. */
export function SceneSynopsis({
  scene,
  onCommit,
}: {
  scene: Scene;
  onCommit: (synopsis: string | null) => void;
}) {
  return (
    <EditableText
      value={scene.synopsis ?? ""}
      placeholder="What happens"
      className="fy-sbsynopsis"
      rows={2}
      onCommit={(next) => {
        const scrubbed = next.trim();
        onCommit(scrubbed === "" ? null : scrubbed);
      }}
    />
  );
}

/**
 * The name in the header (SPEC-036 R-2, amended 2026-09-02): typed where it reads, like the
 * synopsis under it.
 *
 * A scene is born `Untitled` (R-37) and named here or by Arke, and either way it is the same
 * `edit-scene` write. Enter commits, Escape puts the old name back, and an empty box commits
 * nothing: a scene cannot be nameless, so a blank is read as "leave it", not as a clear.
 */
export function SceneTitle({
  title,
  locked = false,
  onCommit,
}: {
  title: string;
  locked?: boolean;
  onCommit: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  // Enter and Escape both unmount the input, and the blur that unmounting fires must not commit
  // a second time — or commit at all after an Escape. One flag, set by whichever key settled it.
  const settled = useRef(false);
  // The name the box opened on. A rename landing from elsewhere while it is open — another
  // window, Arke — re-renders `title` under an input still holding the old words, and a blur
  // would then write the old name over the new one against the new version (codex, PR 708).
  // The box closes on the newer name instead, and nothing it held is written.
  const openedOn = useRef(title);
  useEffect(() => {
    if (editing && title !== openedOn.current) {
      settled.current = true;
      setEditing(false);
    }
  }, [editing, title]);
  const open = () => {
    settled.current = false;
    openedOn.current = title;
    setEditing(true);
  };
  if (!editing) {
    return (
      <span
        role="textbox"
        tabIndex={locked ? -1 : 0}
        aria-readonly={locked ? true : undefined}
        title={locked ? undefined : "Rename"}
        className={cx("fy-sw__title-text", locked && "fy-sw__title-text--locked")}
        onClick={() => {
          if (!locked) open();
        }}
        onKeyDown={(e) => {
          if (locked || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          open();
        }}
      >
        {title}
      </span>
    );
  }
  const commit = (input: HTMLInputElement) => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const next = input.value.trim();
    if (next !== "" && next !== openedOn.current && title === openedOn.current) onCommit(next);
  };
  return (
    <input
      autoFocus
      className="fy-sw__title-input"
      aria-label="Scene title"
      defaultValue={title}
      maxLength={200}
      onFocus={(e) => e.currentTarget.select()}
      onBlur={(e) => commit(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit(e.currentTarget);
        } else if (e.key === "Escape") {
          e.preventDefault();
          settled.current = true;
          setEditing(false);
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// The full shot (14d) — behind the card, never on it
// ---------------------------------------------------------------------------
