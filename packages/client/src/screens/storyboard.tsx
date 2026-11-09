import { useEffect, useState } from "react";
import {
  orderedShots,
  sceneFindings,
  shotCoverage,
  type Scene,
  type SceneRecord,
} from "@arke-studio/contracts";
import { X } from "../components/icons.js";
import { EditableText } from "../components/fields.js";


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
 * Cached by the blocks array itself (review 2026-08-22): several surfaces call this hook, and
 * each instance was hashing the whole script again — same bytes, one sweep per caller. The
 * store hands every subscriber the same array reference per frame, so a WeakMap on it makes
 * every caller after the first free without changing anyone's signature.
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
export function SceneReview({ scene, onClose }: { scene: SceneRecord; onClose: () => void }) {
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

/** The line under the title (14c): the synopsis, edited in place. */
export function SceneSynopsis({
  scene,
  onCommit,
}: {
  scene: SceneRecord;
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

// ---------------------------------------------------------------------------
// The full shot (14d) — behind the card, never on it
// ---------------------------------------------------------------------------
