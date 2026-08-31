import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  DEFAULT_SHOT_SEC,
  assemblePrompt,
  orderedShots,
  overrideStaleAgainst,
  parseMentions,
  productionAspect,
  productionShape,
  promptFor,
  sceneDeleteBlockers,
  sceneFindings,
  shotCardState,
  shotCoverage,
  type ClientMessage,
  type Scene,
  type Shot,
  type ShotFraming,
  legacySceneView,
} from "@arke-studio/contracts";
import { EmptyState } from "../components/layout.js";
import { Button, Callout, Textarea, cx } from "../components/ui.js";
import { X } from "../components/icons.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { acceptedTakeId, takesForShot, useProduction } from "../lib/selectors.js";
import { deleteScene, restoreScene, sceneCommand } from "../lib/store.js";
import { Mentions, sceneFileOf } from "./production.js";
import { shotHasFrame } from "./scene-workspace/boards.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];
type EditShotCommand = Extract<Command, { kind: "edit-shot" }>;

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
// Camera vocabulary (14d). Display words, owned by SPEC-012 — the schema stays strings.
// ---------------------------------------------------------------------------

const CAMERA_FIELDS: Array<{ key: keyof ShotFraming; label: string; options: string[] }> = [
  { key: "size", label: "size", options: ["Extreme wide", "Wide", "Full", "Medium", "Medium close-up", "Close-up", "Extreme close-up", "Over the shoulder", "Two shot"] },
  { key: "angle", label: "angle", options: ["Eye level", "Low angle", "High angle", "Overhead", "Dutch tilt", "Ground level"] },
  { key: "lens", label: "lens", options: ["18mm", "24mm", "35mm", "50mm", "85mm", "135mm"] },
  { key: "focus", label: "focus", options: ["Deep focus", "Shallow", "Very shallow", "Rack focus"] },
  { key: "movement", label: "movement", options: ["Static", "Slow push-in", "Pull back", "Pan left", "Pan right", "Tilt up", "Tilt down", "Tracking, lateral", "Dolly, follow", "Crane up", "Orbit", "Handheld"] },
  { key: "pace", label: "pace", options: ["Very slow", "Slow", "Steady", "Brisk"] },
  { key: "lighting", label: "lighting", options: ["Blue hour", "Practical lantern", "Moonlight", "Overcast", "Firelight", "Backlit silhouette", "Hard noon", "Soft window"] },
  { key: "timeOfDay", label: "time", options: ["Dawn", "Day", "Dusk", "Night"] },
];

/** One press fills size, angle, lens, movement and pace (14d, Creative). */
const RECIPES: Array<{ name: string; set: ShotFraming }> = [
  { name: "Establishing", set: { size: "Extreme wide", angle: "High angle", lens: "24mm", movement: "Static", pace: "Very slow" } },
  { name: "Coverage · OTS", set: { size: "Over the shoulder", angle: "Eye level", lens: "50mm", movement: "Static", pace: "Steady" } },
  { name: "Reaction", set: { size: "Close-up", angle: "Eye level", lens: "85mm", movement: "Slow push-in", pace: "Slow" } },
  { name: "Insert", set: { size: "Extreme close-up", angle: "Overhead", lens: "85mm", movement: "Static", pace: "Steady" } },
  { name: "Hold", set: { size: "Wide", angle: "Eye level", lens: "35mm", movement: "Static", pace: "Very slow" } },
];

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

const shotNo = (shot: Shot) => shot.id.replace(/^sh_0*/, "");

// ---------------------------------------------------------------------------
// Inline editors — display renders mentions as chips; a click opens plain text
// ---------------------------------------------------------------------------

function EditableText({
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
      placeholder="What happens, in a line or two."
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

export function ShotSheetScreen() {
  const { worldId, prodId, sceneId, shotId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const record = production?.scenes.find((s) => s.id === sceneId);
  // The shot sheet edits and saves the whole scene, so it works in the writer's view; the
  // order inside it comes through the one boundary (`orderedShots`).
  const scene = record === undefined ? undefined : legacySceneView(record);
  const shot = record === undefined ? undefined : orderedShots(record).find((candidate) => candidate.id === shotId);
  const digests = useBlockDigests(scene);
  const [promptDraft, setPromptDraft] = useState<string | null>(null);
  const [addingRef, setAddingRef] = useState(false);

  const back = `/w/${worldId}/p/${prodId}/scenes/${sceneId}`;
  const stem = production && scene ? sceneFileOf(production, scene) : null;

  // One save for every field on this sheet — the same direct write the cards use.
  const send = (command: Command) => {
    if (!record || !stem || !worldId || !prodId) return false;
    return sceneCommand({
      worldId,
      productionId: prodId,
      sceneFile: stem,
      sceneId: record.id,
      baseVersion: record.version,
      command,
    });
  };
  const patch = (patch: Partial<Shot>) => {
    if (!shot) return;
    const change = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as EditShotCommand["change"];
    const clear = Object.entries(patch)
      .filter(([, value]) => value === undefined)
      .map(([field]) => field) as NonNullable<EditShotCommand["clear"]>;
    send({
      kind: "edit-shot",
      shotId: shot.id,
      change,
      ...(clear.length === 0 ? {} : { clear }),
    });
  };

  /*
   * One place that knows when `continuity` collapses to nothing.
   *
   * Written inline, each of its controls has to remember the other two, and the one that forgets
   * deletes an authored field when its own is cleared. That is exactly what happened to `audio`
   * (review 2026-08-22) — emptying the last text box dropped a `silence` nobody had touched — and
   * a third key made the odds of repeating it worse rather than better.
   */
  const continuitySet = (change: Partial<NonNullable<Shot["continuity"]>>) => {
    if (!shot) return;
    const merged: Record<string, unknown> = { ...shot.continuity, ...change };
    for (const [key, value] of Object.entries(merged)) if (value === undefined) delete merged[key];
    patch({
      continuity:
        Object.keys(merged).length > 0 ? (merged as NonNullable<Shot["continuity"]>) : undefined,
    });
  };

  const framingSet = (key: keyof ShotFraming, value: string | undefined) => {
    if (!shot) return;
    const framing = { ...shot.framing };
    if (value === undefined) delete framing[key];
    else framing[key] = value;
    patch({ framing: Object.keys(framing).length > 0 ? framing : undefined });
  };

  if (!world || !production || !record || !scene || !shot || !worldId || !prodId) {
    return (
      <div className="fy-prodmain" data-screen="shot-sheet">
        <EmptyState title="Opening the shot…" />
      </div>
    );
  }

  const takes = takesForShot(production, shot.id);
  const accepted = acceptedTakeId(production, shot.id);
  const acceptedTake = accepted === null ? undefined : takes.find((take) => take.id === accepted);
  const state = shotCardState({
    blankScript: shot.description.trim() === "",
    clipAccepted: acceptedTake?.kind === "clip",
    hasFrame: shotHasFrame(production, world.artifacts, shot.id),
    coverage: shotCoverage(shot, digests),
  });
  const style = production.meta.styleOverride?.trim() || world.artDirection.description;
  // Video previews stay capability-neutral so generated spatial/anchor blocks cannot be saved
  // into an override and then repeated by whole-scene assembly. Stills only need the temporal gate.
  const capability = productionShape(production.meta).dispatchCapability === "image" ? "image" : undefined;
  const assembled = assemblePrompt(world.meta, world.sheets, scene, shot, style, undefined, capability);
  const current = promptFor(world.meta, world.sheets, scene, shot, style, undefined, capability);
  const stale = overrideStaleAgainst(shot, world.sheets);
  const promptValue = promptDraft ?? current.text;
  const mentioned = parseMentions(shot.description);
  const refs = world.sheets.filter((s) => mentioned.some((m) => s.id === m || s.id.includes(m)));
  const addable = world.sheets.filter((s) => !refs.some((r) => r.id === s.id));
  const prev = (() => {
    const ordered = orderedShots(record);
    const i = ordered.findIndex((s) => s.id === shot.id);
    return i > 0 ? ordered[i - 1]! : null;
  })();

  return (
    <div className="fy-prodmain" data-screen="shot-sheet" style={{ minHeight: "100%" }}>
      <div className="fy-sheethead">
        <span className="fy-mono">shot {shotNo(shot)} of scene {scene.number}</span>
        <input
          className="fy-sheettitle"
          defaultValue={shot.title}
          key={shot.id + shot.title}
          onBlur={(e) => {
            const next = e.target.value.trim();
            if (next !== "" && next !== shot.title) patch({ title: next });
          }}
        />
        <span className="fy-mono">{state}</span>
        <span style={{ flex: 1 }} />
        <Button
          variant="ghost"
          onClick={() => {
            send({ kind: "duplicate-shot", shotId: shot.id });
            navigate(back);
          }}
        >
          Duplicate
        </Button>
        <Button
          variant="ghost"
          disabled={orderedShots(record).length < 2}
          onClick={() => {
            send({ kind: "delete-shot", shotId: shot.id });
            navigate(back);
          }}
        >
          Delete
        </Button>
        <Button variant="ghost" onClick={() => navigate(back)} aria-label="Close">
          ✕
        </Button>
      </div>

      <div className="fy-sheetbody">
        <div className="fy-sheetmain">
          <div className="fy-sheetsec">
            <div className="fy-sheetlabel">Shot script</div>
            <EditableText
              value={shot.description}
              placeholder="Write what happens, or ask Arke."
              rows={6}
              onCommit={(next) => patch({ description: next })}
            />
          </div>

          <div className="fy-sheetsec">
            <div className="fy-sheetlabel">
              Image prompt <span className="fy-mono">from script, references, camera</span>
              <span style={{ flex: 1 }} />
              {shot.promptOverride && (
                <button
                  type="button"
                  className="fy-sblink"
                  onClick={() => {
                    send({ kind: "set-prompt-override", shotId: shot.id, text: null });
                    setPromptDraft(null);
                  }}
                >
                  Rebuild
                </button>
              )}
            </div>
            {stale.length > 0 && (
              <Callout tone="warning" title="This override no longer reflects the world">
                {stale.map((s) => `${s.sheetId} moved v${s.from} → v${s.to}`).join(" · ")}
              </Callout>
            )}
            <Textarea
              value={promptValue}
              rows={4}
              style={{ font: "400 11.5px/1.7 var(--font-mono)" }}
              onChange={(e) => setPromptDraft(e.target.value)}
              onBlur={() => {
                const next = promptValue.trim();
                if (next === current.text.trim()) return;
                send({
                  kind: "set-prompt-override",
                  shotId: shot.id,
                  text: next === assembled.trim() || next === "" ? null : next,
                });
                setPromptDraft(null);
              }}
            />
            <div className="fy-mono">{shot.promptOverride ? "prompt · edited by you" : "prompt · auto"}</div>
          </div>

          <div className="fy-sheetsec">
            <div className="fy-sheetlabel">Cinematic intent</div>
            <EditableText
              value={shot.intent ?? ""}
              placeholder="How it should feel."
              rows={2}
              onCommit={(next) => patch({ intent: next === "" ? undefined : next })}
            />
            <div className="fy-mono">Guides the camera · hand settings win.</div>
          </div>

          <div className="fy-sheetsec">
            {/* A beat is a word from the craft; a section heading should be the plainest true
                word (turn 101). The rows underneath are still beats, and still named that in
                the record — this is the label, not the model. */}
            <div className="fy-sheetlabel">Timing</div>
            <div className="fy-sheetbeats">
              {/* Keyed by list shape as well as index (review 2026-08-22): the inputs are
                  uncontrolled, so after a splice React's index reuse left a deleted beat's
                  text on screen and the next blur wrote it onto the survivor. A key that
                  changes with the length remounts every row against the real record. */}
              {(shot.beats ?? []).map((beat, i) => (
                <div key={`${(shot.beats ?? []).length}:${i}`} className="fy-sheetbeat">
                  {/* A blur that changed nothing writes nothing (review 2026-08-22): these
                      patched on every tab-through, and each patch is a saved scene version. */}
                  <input
                    className="fy-sheetbeat__span"
                    defaultValue={beat.span}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next === "" || next === beat.span) return;
                      const beats = [...(shot.beats ?? [])];
                      beats[i] = { ...beats[i]!, span: next };
                      patch({ beats });
                    }}
                  />
                  <input
                    className="fy-sheetbeat__text"
                    defaultValue={beat.text}
                    onBlur={(e) => {
                      const next = e.target.value.trim();
                      if (next === beat.text) return;
                      const beats = [...(shot.beats ?? [])];
                      if (next === "") beats.splice(i, 1);
                      else beats[i] = { ...beats[i]!, text: next };
                      patch({ beats: beats.length > 0 ? beats : undefined });
                    }}
                  />
                </div>
              ))}
              <button
                type="button"
                className="fy-sblink"
                style={{ alignSelf: "flex-start" }}
                onClick={() => patch({ beats: [...(shot.beats ?? []), { span: "0–2s", text: "Describe the beat" }] })}
              >
                + Add beat
              </button>
            </div>
          </div>

          <div className="fy-sheetsec">
            <div className="fy-sheetlabel">
              References <span className="fy-mono">from @ in the script</span>
            </div>
            <div className="fy-sheetrefs">
              {refs.map((r, i) => (
                <div key={r.id} className="fy-sheetref">
                  <span className="fy-mono">@{i + 1}</span>
                  <span className="fy-sbref__thumb" style={{ width: 24, height: 24 }}>
                    <Portrait worldSlug={world.meta.slug} path={sheetPortraitPath(r.id)} label={r.name} radius={6} />
                  </span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "block", font: "500 11.5px var(--font-sans)" }}>{r.name}</span>
                    <span className="fy-mono">
                      {r.type} · v{r.version}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="fy-sblink"
                    aria-label={`Remove ${r.name}`}
                    onClick={() => {
                      // Removing the chip removes the mention: the script is the reference list.
                      const cleaned = shot.description
                        .replaceAll(`@${r.id}`, "")
                        .replace(/ {2,}/g, " ")
                        .trim();
                      patch({ description: cleaned });
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {addingRef ? (
                <select
                  autoFocus
                  className="fy-sheetselect"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value !== "")
                      patch({ description: `${shot.description.replace(/\s*$/, "")} @${e.target.value}`.trim() });
                    setAddingRef(false);
                  }}
                  onBlur={() => setAddingRef(false)}
                >
                  <option value="" disabled>
                    Pick a sheet…
                  </option>
                  {addable.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.type}
                    </option>
                  ))}
                </select>
              ) : (
                <button type="button" className="fy-sheetaddref" onClick={() => setAddingRef(true)}>
                  + Add a reference
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="fy-sheetside">
          <div className="fy-sheetside__sec">
            <div className="fy-sheetside__head">Creative</div>
            <div className="fy-mono" style={{ marginBottom: 4 }}>start from a recipe</div>
            <div className="fy-sbrefs">
              {RECIPES.map((r) => (
                <button
                  key={r.name}
                  type="button"
                  className="fy-sbchip"
                  title="Fills size, angle, lens, movement and pace"
                  onClick={() => patch({ framing: { ...shot.framing, ...r.set } })}
                >
                  {r.name}
                </button>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, alignItems: "end", marginTop: 10 }}>
              <div>
                <div className="fy-mono" style={{ marginBottom: 4 }}>duration</div>
                <div className="fy-sheetstep">
                  <button
                    type="button"
                    aria-label="Shorter"
                    onClick={() => patch({ durationSec: Math.max(0.5, (shot.durationSec ?? DEFAULT_SHOT_SEC) - 0.5) })}
                  >
                    −
                  </button>
                  {/* The planner's default, not a third number (review 2026-08-22): the sheet
                      said 3.0s while every estimate and dispatch used 4s, so the first press of
                      + silently shortened the shot. */}
                  <span>{(shot.durationSec ?? DEFAULT_SHOT_SEC).toFixed(1)}s</span>
                  <button
                    type="button"
                    aria-label="Longer"
                    onClick={() => patch({ durationSec: Math.min(15, (shot.durationSec ?? DEFAULT_SHOT_SEC) + 0.5) })}
                  >
                    +
                  </button>
                </div>
              </div>
              <div>
                <div className="fy-mono" style={{ marginBottom: 4 }}>aspect</div>
                <div className="fy-mono" style={{ padding: "6px 0 9px" }}>
                  {productionAspect(production.meta)} · from the production
                </div>
              </div>
            </div>
          </div>

          <div className="fy-sheetside__sec">
            <div className="fy-sheetside__head">Camera</div>
            {CAMERA_FIELDS.map((field) => {
              const own = shot.framing?.[field.key];
              const inherited = scene.defaults?.[field.key];
              return (
                <div key={field.key} className="fy-sheetcam">
                  <span className="fy-mono" style={{ width: 68, flex: "none" }}>
                    {field.label}
                    {own !== undefined && <span className="fy-sheetcam__dot" title="overrides the scene" />}
                  </span>
                  <select
                    className="fy-sheetselect"
                    value={own ?? ""}
                    onChange={(e) => framingSet(field.key, e.target.value === "" ? undefined : e.target.value)}
                  >
                    <option value="">{inherited !== undefined ? `${inherited} · from scene` : "—"}</option>
                    {field.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
            <div className="fy-sheetcam">
              <span className="fy-mono" style={{ width: 68, flex: "none" }}>grade</span>
              <input
                className="fy-sheetselect"
                defaultValue={shot.framing?.grade ?? ""}
                placeholder={scene.defaults?.grade ?? "—"}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next === (shot.framing?.grade ?? "")) return;
                  framingSet("grade", next === "" ? undefined : next);
                }}
              />
            </div>
          </div>

          <div className="fy-sheetside__sec">
            <div className="fy-sheetside__head">Sound</div>
            {(
              [
                ["line", "dialogue / V.O.", shot.audio?.line ?? ""],
                ["ambience", "ambience", shot.audio?.ambience ?? ""],
                ["effects", "effects", shot.audio?.effects ?? ""],
              ] as const
            ).map(([key, label, value]) => (
              <div key={key} className="fy-sheetcam">
                <span className="fy-mono" style={{ width: 68, flex: "none" }}>{label}</span>
                <input
                  className="fy-sheetselect"
                  defaultValue={value}
                  onBlur={(e) => {
                    const next = e.target.value.trim();
                    if (next === value) return;
                    const audio = { kind: shot.audio?.kind ?? "sfx", ...shot.audio, [key]: next === "" ? undefined : next };
                    if (next === "") delete (audio as Record<string, unknown>)[key];
                    /*
                     * The kind survives a cleared field (review 2026-08-22). `kind` is the one
                     * required field and the one this test forgot, so emptying the last text box
                     * deleted an authored `silence` or `dialogue` outright — and retyping seeded
                     * it back as "sfx". Only a shot that never had audio collapses to none.
                     */
                    const has = audio.line || audio.ambience || audio.effects || audio.speaker;
                    patch({ audio: has || shot.audio?.kind !== undefined ? audio : undefined });
                  }}
                />
              </div>
            ))}
          </div>

          <div className="fy-sheetside__sec">
            <div className="fy-sheetside__head">Continuity</div>
            <label className="fy-sheetcam" style={{ cursor: prev ? "pointer" : "default" }}>
              <input
                type="checkbox"
                disabled={!prev}
                checked={shot.continuity?.openOnPrevious ?? false}
                onChange={(e) => continuitySet({ openOnPrevious: e.target.checked || undefined })}
              />
              <span style={{ font: "400 11.5px var(--font-sans)", flex: 1 }}>
                {prev ? `Open on the last frame of shot ${shotNo(prev)}` : "First shot — nothing before it"}
              </span>
            </label>
            {/*
              SPEC-019 R-50. The stronger neighbour of the box above: a frame keeps the
              composition and loses the motion and the audio under it. Whether the dispatch can
              honour it depends on the model and on what is accepted, and the dispatch dialog is
              where that is named — this box records the intent, exactly as the one above does.
            */}
            <label className="fy-sheetcam" style={{ cursor: prev ? "pointer" : "default" }}>
              <input
                type="checkbox"
                disabled={!prev}
                checked={shot.continuity?.continuesPrevious ?? false}
                onChange={(e) => continuitySet({ continuesPrevious: e.target.checked || undefined })}
              />
              <span style={{ font: "400 11.5px var(--font-sans)", flex: 1 }}>
                {prev ? `Continue the footage of shot ${shotNo(prev)}` : "First shot — nothing to continue"}
              </span>
            </label>
            <div className="fy-sheetcam">
              <span className="fy-mono" style={{ width: 68, flex: "none" }}>keep out</span>
              <input
                className="fy-sheetselect"
                defaultValue={shot.continuity?.keepOut ?? ""}
                placeholder="Modern boats, text, lens flare"
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next === (shot.continuity?.keepOut ?? "")) return;
                  continuitySet({ keepOut: next === "" ? undefined : next });
                }}
              />
            </div>
          </div>
        </div>
      </div>

      <div className="fy-sbfoot">
        <span className="fy-mono">
          {takes.length} take{takes.length === 1 ? "" : "s"}
          {accepted ? " · one accepted" : ""}
        </span>
        <span style={{ flex: 1 }} />
        <Button variant="ghost" onClick={() => navigate(back)}>
          Back to the storyboard
        </Button>
        <Button variant="primary" onClick={() => navigate(`${back}?shot=${shot.id}`)}>
          Back to shot
        </Button>
      </div>
    </div>
  );
}
