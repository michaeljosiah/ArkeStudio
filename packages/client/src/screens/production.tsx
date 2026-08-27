import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import {
  assemblePrompt,
  deriveCut,
  deriveEpisodeCut,
  deriveSpineCut,
  exportAudioClips,
  exportOverlays,
  isMediaOnly,
  mediaCanvasSec,
  placedExtentSec,
  placedFilmSec,
  episodeExportRefusals,
  spineExportRefusals,
  trimCeilingSec,
  guestsOf,
  pendingGuestsOf,
  pendingSheets,
  frameDispatchFor,
  modelCapabilityCopy,
  nativeResolution,
  overrideStaleAgainst,
  pickableSheets,
  compilePasses,
  DEFAULT_SHOT_SEC,
  PRESETS,
  productionAspect,
  productionShape,
  promptFor,
  STANDARD_ASPECTS,
  DELIVERIES,
  legacyVoiceModel,
  supportedDeliveries,
  type CompiledPass,
  type CompiledReference,
  type Delivery,
  type PlanState,
  worldSheets,
  attachmentFor,
  type CharacterLook,
  type ProductionBundle,
  type Scene,
  type Sheet,
  type WorldBundle,
  type ArtifactSidecar,
  MAX_CLIP_LANE,
  type CutEntry,
  type CutOverlay,
  type Shot,
  type SpineCutSegment,
  type SizeTier,
} from "@arke-studio/contracts";
import { DegradedBanner, EmptyState, Screen } from "../components/layout.js";
import { Badge, Button, Callout, Card, Input, Textarea, cx } from "../components/ui.js";
import {
  Archive,
  Book,
  ChevronLeft,
  ChevronRight,
  Film,
  Folder,
  Home,
  ListOrdered,
  Message,
  PanelLeft,
  PauseSolid,
  Play,
  Plus,
  Scroll,
  Sparkle,
  Users,
  VideoMark,
  Waveform,
} from "../components/icons.js";
import { AppChrome } from "../components/chrome.js";
import { Composer } from "../components/composer.js";
import { ProductionConversation, StagedDecision } from "../components/conversation.js";
import { DispatchBar, resolveModel } from "../components/dispatch-bar.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { ClipPlayButton, clock } from "../components/player.js";
import { useRailCollapsed } from "../lib/rail-collapsed.js";
import { planForScene } from "../lib/scene-plan.js";
import { mediaUrl } from "../lib/media.js";
import { runtimeSeconds, seconds, usd } from "../lib/format.js";
import { acceptedTakeId, isDayOne, takeDecisions, takesForShot, useProduction } from "../lib/selectors.js";
import { lookTileLabel } from "./character-reference.js";
import { DevelopmentWorkspace } from "./development.js";
import { SceneReview, SceneSynopsis, StoryboardFoot, StoryboardStrip } from "./storyboard.js";
import { posterize, posterNameFor } from "../lib/poster.js";
import { useScrubDrag } from "../lib/timeline-drag.js";
import { onMediaReady, syncMediaElement, useTransport } from "../lib/playback-engine.js";
import { mediaSpans, mediaTimeFor, spanAt, spineSpans, storySpans, type PlaybackSpan } from "../lib/cut-playback.js";
import {
  MIN_CLIP_SEC,
  applyClipDrag,
  snapPointsFor,
  type ClipGesture,
  type ClipPlacement,
} from "../lib/clip-drag.js";
import {
  acceptTake,
  attachCharacterLook,
  cancelExport,
  compileSceneBoard,
  createSheetFromSentence,
  attachHostFiles,
  attachHostText,
  hostCanAttach,
  dispatchScene,
  draftScene,
  exportCut,
  exportSceneBoard,
  exportWorld,
  rejectTake,
  placeOverlay,
  removeOverlay,
  moveOverlay,
  rejoinOverlayAudio,
  splitOverlayAudio,
  uploadArtifacts,
  dispatchScenePlanned,
  listPlans,
  planCancel,
  planContinue,
  planReconfirm,
  setProductionAspect,
  setPromptOverride,
  setShotTrim,
  subscribePlanResults,
  subscribePlanStates,
  useExports,
  useStore,
  useWorld,
  requestVoiceLine,
  subscribeQueueResults,
  subscribeVoiceUploadConfirmations,
} from "../lib/store.js";

/** Production screens (§2.9), composed to the prototype frames 11a/14a/11b/24a/25a/25b/10b. */

// ---- small shared pieces ---------------------------------------------------

/**
 * The artifacts a production may see (SPEC-020 R-13): the world's own, plus the ones it owns.
 * Another production's scoped material is absent — selecting audio by kind alone would put one
 * production's scratch takes in every other production's Audio screen.
 */
function artifactsFor<T extends { production?: string }>(
  artifacts: readonly T[],
  productionId: string | undefined,
): T[] {
  return artifacts.filter((a) => a.production === undefined || a.production === productionId);
}

/** Render @mentions the way the prototype does: quiet mono chips inside prose. */
export function Mentions({ text }: { text: string }) {
  const parts = text.split(/(@[A-Za-z0-9-]+)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith("@") ? (
          <span key={i} className="fy-mention">
            {p}
          </span>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

/** Deterministic decorative waveform — seeded by the label, no randomness. */
export function Wave({ seed, width = 290, height = 16 }: { seed: string; width?: number; height?: number }) {
  const bars: ReactNode[] = [];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  for (let x = 0; x + 3 <= width; x += 8) {
    h = (h * 1103515245 + 12345) >>> 0;
    const t = (h % 1000) / 1000;
    const bar = 3 + t * (height - 4);
    bars.push(<rect key={x} x={x} y={(height - bar) / 2} width={3} height={bar} rx={1.5} />);
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <g fill="currentColor">{bars}</g>
    </svg>
  );
}

/** A take's poster image, on the shared convention (lib/poster.ts). */
export function takeMediaPath(prodId: string, take: { id: string; media?: string }): string | null {
  if (!take.media) return null;
  return `productions/${prodId}/takes/${take.id}/${posterNameFor(take.media)}`;
}

/**
 * The scene's on-disk stem, from the bundle's scan-captured record (issue 387) — never a
 * reconstruction from number and slug, which goes blind the moment a file's name stops
 * matching. Null means the bundle predates the record; the senders skip rather than guess.
 */
export function sceneFileOf(
  production: { sceneFiles: Record<string, string> } | null | undefined,
  scene: Scene,
): string | null {
  return production?.sceneFiles[scene.id] ?? null;
}

function decisionTone(decision: string | undefined): "ok" | "warn" | "sketch" {
  if (decision === "accepted") return "ok";
  if (decision === "rejected") return "sketch";
  return "warn";
}

// ---- the production shell (frames 11a/14a left rail) -----------------------

export function ProductionLayout() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const location = useLocation();
  const exportsState = useExports();
  // The rail is the format's (design 54a): a surface the format cannot use is not present,
  // not greyed. A story production has nothing to dispatch, so its rail never says so.
  const shape = production ? productionShape(production.meta) : null;
  const isStory = shape?.hasChapters === true;
  const cut = production ? deriveCut(production) : null;
  /*
   * The rail and the switcher state a length, and it has to be the length the Cut screen states.
   *
   * A production with no story keeps its clock in the clips (issue 453), and the derived cut
   * reads zero there — so both of these advertised a `0s` cut for a film that plays and exports,
   * one panel away from a header saying how long it actually runs (issue 508).
   *
   * Gated exactly as the Cut and Exports screens gate it: a production with a spine is never
   * this, however unresolved that spine is, or the rail would call the clips the film while the
   * screen beside it still treated the song as authoritative.
   */
  const mediaOnly =
    cut !== null && isMediaOnly(cut) && exportViewFor(world, production).kind === "scene-order";
  const filmSec = mediaOnly ? placedFilmSec(production?.cut.overlays ?? [], world?.artifacts ?? []) : 0;
  const audioCount =
    (artifactsFor(world?.artifacts ?? [], prodId).filter((a) => a.kind === "audio").length ?? 0) +
    (production?.scenes
      .flatMap((s) => s.shots)
      .filter((s) => s.audio?.kind === "vo" || s.audio?.kind === "dialogue").length ?? 0);
  const exportCount = Object.values(exportsState).filter((e) => e.productionId === prodId).length;
  const guestCount = prodId
    ? guestsOf(world?.sheets ?? [], prodId).filter((s) => s.retired !== true).length
    : 0;
  const base = `/w/${worldId}/p/${prodId}`;
  /*
   * Folded (82a, then turn 101): the Cut opens the world's artifacts beside it, and the width has
   * to come from somewhere. It comes from the labels, never from the destinations — every place
   * the rail reached is still one click away, as a mark with its name on the tooltip.
   *
   * That was route-driven, which meant the width was the app's decision and not the person's. It
   * is a control now, remembered for the session — the module variable behind useRailCollapsed
   * says why it is not longer-lived; the Cut is only what it does before anybody has said
   * otherwise. `null` is "never asked", which is why this is not a plain boolean.
   */
  const [railChoice, setRailChoice] = useRailCollapsed();
  const folded = railChoice ?? location.pathname.endsWith("/cut");
  /*
   * A mark for every destination, without exception (turn 101). Folded, the label is the tooltip
   * and the mark is the whole item, so a rail entry with no mark is an entry that disappears —
   * which is what happened to `New scene` and `Story structure`, both drawn as a different shape.
   * One shape, one mark, one count: that is the whole of "standardised".
   */
  const MARKS: Record<string, (p: { size?: number }) => ReactNode> = {
    "": Home,
    cast: Users,
    story: Message,
    overview: Scroll,
    "story/chapters": Book,
    "story-structure": Folder,
    scenes: Film,
    "scenes/new": Plus,
    "branch-map": ListOrdered,
    generate: Sparkle,
    cut: VideoMark,
    audio: Waveform,
    exports: Archive,
  };
  /*
   * An episode is reached by drilling into the season, and both of its screens live outside the
   * `season` path — the chat under `story/episodes/:id`, the page under `episodes/:id` (turn 91).
   * Neither lights any rail item on its own, so the rail goes blank exactly when somebody is two
   * levels deep and most wants to know where they are. Season owns them: it is the level above.
   */
  const inEpisode = /\/episodes\//.test(location.pathname);
  /* `/season` keeps working as an address and now lands on the same screen as the index. */
  const inSeason = inEpisode || location.pathname.endsWith("/season");
  /* A scene's chat lives under `story/` beside the production's own, so Scenes owns it too. */
  // A scene's screens include the full shot underneath it (turn 94's ownership rule) — no `$`,
  // or the rail goes blank exactly at /scenes/:id/shots/:id, three levels deep.
  const inScene = /\/scenes\/[^/]+/.test(location.pathname);
  const item = (
    slug: string,
    label: string,
    count?: string,
    end?: boolean,
    also?: boolean,
    under?: boolean,
  ) => {
    const Mark = MARKS[slug];
    return (
      <NavLink
        key={slug || "dash"}
        to={`${base}${slug ? `/${slug}` : ""}`}
        end={end ?? slug === ""}
        title={folded ? label : undefined}
        className={({ isActive }) =>
          cx(
            "fy-prodrail__item",
            under && "fy-prodrail__item--under",
            (isActive || also) && "fy-prodrail__item--active",
          )
        }
      >
        {Mark !== undefined && (
          <span className="fy-prodrail__mark" aria-hidden={!folded}>
            <Mark size={15} />
          </span>
        )}
        <span className="fy-prodrail__label">{label}</span>
        {count !== undefined && <span className="fy-prodrail__count">{count}</span>}
      </NavLink>
    );
  };
  /*
   * Two figures, because the rail states the cut and the switcher states how much of it is
   * covered — and one figure for a production with no story, which has no shots to cover and only
   * ever had one length. It is written as a measurement, the way the Cut header and the Exports
   * button write it: a 0.4s film is real and exportable, and rounding it to `0s` would make it
   * look exactly like the empty production the export refuses.
   */
  const railFigure = mediaOnly ? runtimeSeconds(filmSec) : seconds(cut?.totalSec ?? 0);
  const cutFigure = mediaOnly
    ? runtimeSeconds(filmSec)
    : seconds((cut?.totalSec ?? 0) - (cut?.uncoveredSec ?? 0));
  // The switch card counts what the format counts: seconds of cut for video, chapters for story.
  const switchSub = production
    ? isStory
      ? `${shape!.displayLabel.toLowerCase()} · ${production.chapters.length} chapter${production.chapters.length === 1 ? "" : "s"}`
      : `${shape!.displayLabel.toLowerCase()}${cut ? ` · ${cutFigure} cut` : ""}`
    : "";
  return (
    <div className="fy-app">
      <AppChrome
        back={{ label: "World", to: `/w/${worldId}` }}
        context={{
          label: production && shape ? `${production.meta.title} · ${shape.displayLabel.toLowerCase()}` : "…",
          to: `/w/${worldId}/productions`,
        }}
      />
      <div className="fy-prod">
        <div className={cx("fy-prodrail", folded && "fy-prodrail--folded")}>
          {/* The person's own control (turn 101), where the prototype puts it. It sits above the
              switcher so folding never moves the thing you were about to press. */}
          <button
            type="button"
            className="fy-prodrail__collapse"
            title={folded ? "Expand the rail" : "Collapse the rail"}
            aria-label={folded ? "Expand the rail" : "Collapse the rail"}
            aria-expanded={!folded}
            onClick={() => setRailChoice(!folded)}
          >
            <PanelLeft size={14} />
          </button>
          <button
            type="button"
            className="fy-prodrail__switch"
            onClick={() => navigate(`/w/${worldId}/productions`)}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-prodrail__switchname">{production?.meta.title ?? "…"}</div>
              <div className="fy-prodrail__switchsub">{switchSub}</div>
            </div>
            <ChevronRight size={14} />
          </button>
          {shape?.isEpisodic
            ? item("", "Season", production?.season ? `v${production.season.version}` : "—", true, inSeason)
            : item("", "Dashboard")}
          {/* Arcs, themes, setups and payoffs — one item under Season and off the default
              walk (turn 99). It was a peer tab, which taught a second vocabulary to somebody
              who did not yet have a first episode. */}
          {shape?.isEpisodic && item("story-structure", "Story structure", undefined, true, false, true)}
          {/* Cast is on both formats' rails (SPEC-020 R-9): a story has a cast as much as a
              video does, and the count is the guests — the number the rail can say something
              true about, since the world's cast is shared and belongs to the world's own rail. */}
          {item("cast", "Cast", String(guestCount))}
          {isStory ? (
            <>
              {/* World Chat with a production for a subject (turn 89) — the name teaches the
                  model. Its details are their own item (turn 88), and it ends where Chapters
                  begins so the two never light together. */}
              {item("story", "Develop", "chat", true)}
              {item("overview", "Overview", production?.story ? `v${production.story.version}` : "—")}
              {item("story/chapters", "Chapters", String(production?.chapters.length ?? 0))}
              {item("audio", "Audio", String(audioCount))}
              {item("exports", "Exports", String(exportCount))}
            </>
          ) : (
            <>
              {/* World Chat with a production for a subject (turn 89): the same transcript, the
                  same points, the same wrap-up.
                  The item goes where the panel lands (turn 99). An episodic production carries
                  Arke docked on its season and its episodes, so a rail entry would be a second
                  door into the same thread; everything else still reaches it here, renamed from
                  Production Chat, which named an implementation. The route is untouched either
                  way — a rename is display, never wiring. */}
              {!shape?.isEpisodic && item("story", "Develop", "chat", true)}
              {/* An episodic production's front page is its season (turn 93), so Season is the
                  rail's first item — drawn above, in place of Dashboard — and there is no second
                  entry for it here. A production without a season keeps both. */}
              {!shape?.isEpisodic &&
                item("overview", "Overview", production?.story ? `v${production.story.version}` : "—")}
              {item("scenes", "Scenes", String(production?.scenes.length ?? 0), false, inScene)}
              {/* Interactive video's structural authority (epic 401): only this medium routes here. */}
              {shape?.isBranching &&
                item("branch-map", "Branch map", String(production?.routing?.choices.length ?? 0))}
              {item("scenes/new", "New scene", undefined, true, false, true)}
              {/* Stills is a lens on Generate now (design 55a), not a rail destination. */}
              {item("generate", "Generate", String(production?.takes.length ?? 0))}
              {item("cut", "Cut", cut ? railFigure : "0:00")}
              {item("audio", "Audio", String(audioCount))}
              {item("exports", "Exports", String(exportCount))}
            </>
          )}
          <div className="fy-prodrail__spacer" />
          <NavLink
            to={`/w/${worldId}`}
            className="fy-prodrail__foot"
            title={folded ? `Part of ${world?.meta.name ?? "the world"}` : undefined}
          >
            <ChevronLeft size={13} />
            {/* The label folds with every other label; the mark and its tooltip carry it. */}
            <span className="fy-prodrail__label">Part of {world?.meta.name ?? "the world"}</span>
          </NavLink>
        </div>
        <div className="fy-prodwrap">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

// ---- Cast (SPEC-020) -------------------------------------------------------

/**
 * The production's cast, in two bands: the guests it owns, and the world's cast it draws on.
 *
 * The bands are the whole point of the screen (R-9). Both sets of people are equally usable in a
 * shot — a guest is a full sheet, and resolution never asks who owns it (R-5) — so the only thing
 * separating them is what happens to them when this production ends. Naming that on the surface
 * is cheaper than discovering it later, when a one-off barman has quietly become part of the
 * world's permanent record.
 */
/**
 * What choosing this option would take it away from (design 67, codex round 1).
 *
 * A look holds one `attachedTo`, so picking one that is already spoken for is a *move*: the
 * other production silently drops back to its identity package, or a scene loses its override.
 * The option says where it currently rides, so the move is visible at the point of choice — a
 * label rather than a confirmation, because the change is one field and reattaching undoes it.
 *
 * The look this production already holds says nothing: it is the selected option, and "here" is
 * not news.
 */
export function lookOptionScope(
  look: CharacterLook,
  production: ProductionBundle,
  productions: readonly ProductionBundle[],
): string | null {
  const scope = look.attachedTo;
  if (!scope) return null;
  if (scope.productionId === production.meta.id) {
    if (scope.kind === "production") return null;
    const scene = production.scenes.find((candidate) => candidate.id === scope.sceneId);
    return scene ? `Sc ${scene.number}` : null;
  }
  const owner = productions.find((candidate) => candidate.meta.id === scope.productionId);
  if (!owner) return null;
  if (scope.kind === "production") return `in ${owner.meta.title}`;
  const scene = owner.scenes.find((candidate) => candidate.id === scope.sceneId);
  return scene ? `in ${owner.meta.title} Sc ${scene.number}` : `in ${owner.meta.title}`;
}

/**
 * What each character wears in this production (design 67).
 *
 * A look is attached on the character's own looks page, and until now the production it was
 * attached *to* had no idea: `production.tsx` never mentioned character looks, and the dispatch
 * dialog counts references without naming one. So the one decision that changes what a model
 * receives for this production was made on a screen belonging to the world, and confirmed
 * nowhere. This is the return path — the production says who it is sending, and lets the choice
 * be made where the consequence lives.
 *
 * Rows exist only for characters that have accepted looks: a character with no alternatives has
 * no choice to offer, and a row saying so is noise.
 */
function ProductionWardrobe({
  world,
  production,
  characters,
}: {
  world: WorldBundle;
  production: ProductionBundle;
  characters: Sheet[];
}) {
  const rows = characters
    .map((sheet) => {
      const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheet.id) ?? null;
      const looks = kit?.looks ?? [];
      return { sheet, kit, looks };
    })
    .filter((row) => row.looks.length > 0);
  if (rows.length === 0) return null;
  return (
    <>
      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        WARDROBE · IN {production.meta.title.toUpperCase()} · {rows.length}
      </div>
      <div className="fy-wardrobe">
        {rows.map(({ sheet, kit, looks }) => {
          // The file the dispatcher would actually attach, resolved by the same function it
          // resolves with — not a second opinion about what rides.
          const riding = attachmentFor(kit, sheet, "primary", { productionId: production.meta.id });
          const held = looks.find(
            (look) =>
              look.attachedTo?.kind === "production" &&
              look.attachedTo.productionId === production.meta.id,
          );
          /* Scene attachments are stated, not offered: this row is the production's altitude,
             and a scene's own choice belongs on the scene. Narrower scope wins at dispatch, so
             a row claiming to be the whole answer while a scene overrides it would be lying. */
          const perScene = looks.flatMap((look) => {
            const scope = look.attachedTo;
            if (scope?.kind !== "scene" || scope.productionId !== production.meta.id) return [];
            const scene = production.scenes.find((candidate) => candidate.id === scope.sceneId);
            return scene ? [{ id: look.id, scene, label: lookTileLabel(look.prompt, look.kind) }] : [];
          });
          return (
            <div className="fy-wardrobe__row" key={sheet.id}>
              <div className="fy-wardrobe__thumb">
                <Portrait
                  worldSlug={world.meta.slug}
                  path={riding.file ?? sheetPortraitPath(sheet.id)}
                  label={sheet.name}
                  radius={8}
                />
              </div>
              <div className="fy-wardrobe__who">
                <span className="fy-wardrobe__name">{sheet.name}</span>
                {perScene.length > 0 && (
                  <span className="fy-wardrobe__scenes">
                    {perScene.map((entry) => `Sc ${entry.scene.number} · ${entry.label}`).join("  ")}
                  </span>
                )}
              </div>
              <label className="fy-wardrobe__pick">
                <span>Wears</span>
                <select
                  value={held?.id ?? ""}
                  onChange={(event) => {
                    const chosen = event.target.value;
                    // One frame either way (issue 384's lesson about concurrent frames): choosing a
                    // look attaches it and the coordinator displaces the incumbent; choosing the
                    // identity package detaches the one that is held.
                    if (chosen === "") {
                      if (held) attachCharacterLook(world.meta.worldId, sheet.id, held.id, null);
                      return;
                    }
                    attachCharacterLook(world.meta.worldId, sheet.id, chosen, {
                      kind: "production",
                      productionId: production.meta.id,
                    });
                  }}
                >
                  <option value="">Identity package</option>
                  {looks.map((look) => {
                    const elsewhere = lookOptionScope(look, production, world.productions);
                    return (
                      <option key={look.id} value={look.id}>
                        {lookTileLabel(look.prompt, look.kind)}
                        {elsewhere ? ` · ${elsewhere}` : ""}
                      </option>
                    );
                  })}
                </select>
              </label>
            </div>
          );
        })}
      </div>
    </>
  );
}

export function ProductionCastScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const [drafting, setDrafting] = useState<{
    type: "character" | "location" | "faction";
    name: string;
    sentence: string;
  } | null>(null);

  if (!world || !production) {
    return (
      <Screen id="production-cast">
        <EmptyState title="Opening the cast…" />
      </Screen>
    );
  }
  const guests = guestsOf(world.sheets, production.meta.id).filter((s) => s.retired !== true);
  const fromWorld = worldSheets(world.sheets).filter((s) => s.retired !== true);
  // Guests under review are kept off the world's surfaces, so they have to be visible here or a
  // staged guest is nowhere at all until it is accepted (SPEC-020 R-8, R-9).
  const pendingGuests = (["character", "location", "faction"] as const).flatMap((kind) =>
    pendingGuestsOf(pendingSheets(world.proposals, kind), production.meta.id),
  );
  // Owned artifacts are off the world's shelf (R-13), so this is the only place they appear.
  const owned = world.artifacts.filter((a) => a.production === production.meta.id);
  const kindLabel = (sheet: Sheet) =>
    sheet.type === "character" ? "character" : sheet.type === "location" ? "location" : "faction";

  const card = (sheet: Sheet, guest: boolean) => (
    <button
      key={sheet.id}
      type="button"
      className="fy-gridcard fy-gridcard--media fy-gridcard--fixed"
      onClick={() =>
        navigate(`/w/${worldId}/${sheet.type === "character" ? "cast" : `${sheet.type}s`}/${sheet.id}`)
      }
    >
      <div className="fy-gridcard__frame" style={{ height: 210 }}>
        <Portrait worldSlug={world.meta.slug} path={sheetPortraitPath(sheet.id)} label={sheet.name} />
      </div>
      <div className="fy-gridcard__pad">
        <div className="fy-gridcard__title">
          <span className="fy-gridcard__name">{sheet.name}</span>
          <span
            className={`fy-dot fy-dot--${sheet.status === "locked" ? "ok" : "sketch"}`}
            style={{ width: 6, height: 6 }}
          />
        </div>
        <div className="fy-gridcard__body">{sheet.role ?? sheet.region ?? kindLabel(sheet)}</div>
        <div className="fy-gridcard__foot" style={{ marginTop: 9 }}>
          {guest ? `guest · v${sheet.version}` : `${kindLabel(sheet)} · v${sheet.version}`}
        </div>
      </div>
    </button>
  );

  const columns = (n: number) => ({
    gridTemplateColumns: `repeat(${Math.min(Math.max(n, 2), 4)}, minmax(0, 1fr))`,
  });

  return (
    <div data-screen="production-cast">
      <div className="fy-corner">
        <Button
          variant="primary"
          onClick={() =>
            setDrafting(drafting === null ? { type: "character", name: "", sentence: "" } : null)
          }
        >
          New guest
        </Button>
      </div>
      <div className="fy-hero">
        <div className="fy-eyebrow-sm">CAST · {production.meta.title.toUpperCase()}</div>
        <h1 className="fy-hero__title" style={{ fontSize: 52 }}>
          Cast
        </h1>
        <p className="fy-hero__lede" style={{ fontSize: 15, maxWidth: 520 }}>
          Guests belong to this production alone. The world's cast is shared with everything else{" "}
          {world.meta.name} holds — change one and every production sees it.
        </p>
      </div>

      {drafting !== null && (
        <Card className="scr-form">
          <div className="scr-field">
            <label className="scr-field__label">
              A guest of {production.meta.title} — a full sheet, kept out of the world's cast until you
              promote it
            </label>
            <div style={{ display: "flex", gap: "var(--space-2)", marginBottom: 8 }}>
              {(["character", "location", "faction"] as const).map((type) => (
                <Button
                  key={type}
                  variant={drafting.type === type ? "primary" : "ghost"}
                  onClick={() => setDrafting({ ...drafting, type })}
                >
                  {type}
                </Button>
              ))}
            </div>
            <Input
              placeholder="Name"
              value={drafting.name}
              onChange={(e) => setDrafting({ ...drafting, name: e.target.value })}
            />
          </div>
          <div className="scr-field">
            <label className="scr-field__label">
              One sentence — the agent drafts the rest inside the sketch
            </label>
            <Textarea
              rows={2}
              value={drafting.sentence}
              onChange={(e) => setDrafting({ ...drafting, sentence: e.target.value })}
            />
          </div>
          <div style={{ display: "flex", gap: "var(--space-2)" }}>
            <Button
              variant="primary"
              disabled={drafting.name.trim().length === 0 || drafting.sentence.trim().length === 0}
              onClick={() => {
                if (worldId) {
                  createSheetFromSentence(
                    worldId,
                    drafting.type,
                    drafting.name.trim(),
                    drafting.sentence.trim(),
                    false,
                    production.meta.id,
                  );
                }
                setDrafting(null);
              }}
            >
              Stage guest
            </Button>
            <Button variant="ghost" onClick={() => setDrafting(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        GUESTS · ONLY IN {production.meta.title.toUpperCase()} · {guests.length + pendingGuests.length}
      </div>
      {guests.length + pendingGuests.length === 0 ? (
        <div style={{ padding: "0 90px" }}>
          <EmptyState
            title="No guests yet"
            hint="People and places this production needs but the world does not — the barman with two lines, the room above the chandlery."
          />
        </div>
      ) : (
        <div className="fy-cardgrid" style={columns(guests.length + pendingGuests.length)}>
          {pendingGuests.map((p) => (
            <div
              key={p.proposalId}
              className="fy-gridcard fy-gridcard--media fy-gridcard--fixed fy-gridcard--quiet"
            >
              <div className="fy-gridcard__frame" style={{ height: 210 }} />
              <div className="fy-gridcard__pad">
                <div className="fy-gridcard__title">
                  <span className="fy-gridcard__name">{p.name}</span>
                </div>
                <div className="fy-gridcard__body">awaiting review</div>
                <div className="fy-gridcard__foot" style={{ marginTop: 9 }}>
                  guest · not yet accepted
                </div>
              </div>
            </div>
          ))}
          {guests.map((sheet) => card(sheet, true))}
        </div>
      )}

      <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
        FROM {world.meta.name.toUpperCase()} · SHARED · {fromWorld.length}
      </div>
      {fromWorld.length === 0 ? (
        <div style={{ padding: "0 90px" }}>
          <EmptyState
            title="The world has no cast yet"
            hint="Everything this production cites would be its own."
          />
        </div>
      ) : (
        <div className="fy-cardgrid" style={columns(fromWorld.length)}>
          {fromWorld.map((sheet) => card(sheet, false))}
        </div>
      )}

      <ProductionWardrobe
        world={world}
        production={production}
        characters={[...guests, ...fromWorld].filter((sheet) => sheet.type === "character")}
      />

      {owned.length > 0 && (
        <>
          <div className="fy-eyebrow-sm" style={{ padding: "10px 90px 0" }}>
            FILED HERE · ONLY IN {production.meta.title.toUpperCase()} · {owned.length}
          </div>
          <div style={{ padding: "8px 90px 30px", display: "grid", gap: 8 }}>
            {owned.map((artifact) => (
              <div
                key={artifact.id}
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  gap: 10,
                  padding: "9px 4px",
                  borderBottom: "1px solid var(--border)",
                }}
              >
                <span style={{ flex: 1, font: "400 13px var(--font-sans)" }}>{artifact.file}</span>
                <span className="fy-mono" style={{ color: "var(--muted-foreground)" }}>
                  {artifact.kind}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---- Dashboard (11a; day-one variant from 33a) -----------------------------

/**
 * The production's front page (design turn 93).
 *
 * An episodic production's is its season: turn 91 settled that a production is exactly one
 * season, so the production's address and the season's are the same address, and keeping them
 * apart is what let one screen say "nothing written yet" while the other said "3 written". Every
 * other medium keeps the dashboard, which has no season to be.
 *
 * The branch is a component boundary rather than an early return — returning before the
 * dashboard's own hooks breaks the Rules of Hooks the moment a production's shape settles after
 * first render, which is what happens on every cold open.
 */
export function ProductionHomeScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  if (production && productionShape(production.meta).isEpisodic) return <DevelopmentWorkspace />;
  return <ProductionDashboardScreen />;
}

export function ProductionDashboardScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  if (!world || !production) {
    return (
      <Screen id="production-dashboard">
        <EmptyState title="Opening production…" />
      </Screen>
    );
  }
  // The dashboard resumes the format's unit of work (design 54a). For story that is the
  // chapter, and nothing here mentions shots, takes, clips or dispatch.
  if (productionShape(production.meta).hasChapters) {
    const chapters = production.chapters;
    const drafted = chapters.filter((c) => (c.words ?? 0) > 0);
    const totalWords = chapters.reduce((sum, c) => sum + (c.words ?? 0), 0);
    const inHand = chapters.find((c) => !c.words) ?? null;
    const inHandIdx = inHand ? chapters.indexOf(inHand) : -1;
    // The design shows the neighbourhood of the chapter in hand, not the whole book —
    // the chapter tree is one click away for that.
    const windowStart =
      inHandIdx >= 0
        ? Math.max(0, Math.min(inHandIdx - 1, chapters.length - 4))
        : Math.max(0, chapters.length - 4);
    const nearby = chapters.slice(windowStart, windowStart + 4);
    return (
      <div className="fy-prodmain" data-screen="production-dashboard">
        <div className="fy-h1row">
          <h1 className="fy-h1">{chapters.length === 0 ? "Day one." : "Here's where you left off."}</h1>
          <span className="fy-h1row__meta">
            {chapters.length === 0
              ? "the spine comes first"
              : `${drafted.length} chapter${drafted.length === 1 ? "" : "s"} drafted${
                  inHand ? ` · chapter ${String(inHand.order).padStart(2, "0")} in hand` : ""
                } · ${totalWords.toLocaleString()} words`}
          </span>
        </div>
        <div className="fy-threadcard" style={{ flex: "none" }}>
          <div className="fy-threadcard__head">
            <span className="fy-threadcard__label">
              {chapters.length === 0
                ? "THE SPINE COMES FIRST"
                : inHand
                  ? `IN HAND · CHAPTER ${inHand.order} OF ${chapters.length}`
                  : `ALL ${chapters.length} CHAPTERS DRAFTED`}
            </span>
          </div>
          <div className="fy-threadcard__title">
            {chapters.length === 0 ? "Find the spine together" : (inHand?.title ?? "Nothing waits on you")}
          </div>
          <div className="fy-threadcard__sub">
            {chapters.length === 0
              ? "Talk the story into an overview; chapters hang beneath it."
              : inHand
                ? `${inHand.status}${production.story ? ` · against the overview at v${production.story.version}` : ""}`
                : "Every chapter has words. The overview steers whatever comes next."}
          </div>
          <div className="fy-threadcard__actions">
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/story`)}>
              {chapters.length === 0 ? "Open Production Chat" : "Continue in Production Chat"}
            </Button>
          </div>
        </div>
        {chapters.length > 0 && (
          <div>
            <div className="fy-listhead">
              Chapters
              <button
                type="button"
                className="fy-linkbtn"
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters`)}
              >
                All {chapters.length} chapter{chapters.length === 1 ? "" : "s"}
              </button>
            </div>
            {nearby.map((c) => (
              <div key={c.id} className="fy-listrow">
                <span className="fy-mono">{String(c.order).padStart(2, "0")}</span>
                <span className="fy-listrow__text" style={{ font: "600 13px var(--font-sans)" }}>
                  {c.title}
                </span>
                <Badge tone="outline">v{c.version}</Badge>
                <span className="fy-mono">{c.words ? `${c.words.toLocaleString()} words` : c.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
  const dayOne = isDayOne(production);
  const decisions = takeDecisions(production);
  const pending = production.takes.filter((t) => decisions[t.id] === "pending");
  const shots = production.scenes.flatMap((s) => s.shots);
  const acceptedShots = shots.filter((s) => acceptedTakeId(production, s.id)).length;
  const nextGap = production.scenes
    .flatMap((scene) => scene.shots.map((shot) => ({ scene, shot })))
    .find(({ shot }) => !acceptedTakeId(production, shot.id));
  const latest = [...production.takes]
    .sort((a, b) => (b.completedAt ?? b.dispatchedAt).localeCompare(a.completedAt ?? a.dispatchedAt))
    .slice(0, 4);
  const recentDecided = production.takes
    .filter((t) => decisions[t.id] !== "pending")
    .slice(-3)
    .reverse();

  return (
    <div className="fy-prodmain" data-screen="production-dashboard">
      {/* Day one is the production's own name and nothing else (turn 53b): the world it came from
          is on the rail, and saying so again here is the announcement that screen deliberately
          dropped. */}
      <div className="fy-h1row">
        <h1 className="fy-h1">{dayOne ? production.meta.title : "Here's where you left off."}</h1>
        {!dayOne && (
          <span className="fy-h1row__meta">
            {acceptedShots} of {shots.length} shots covered · {pending.length} need you
          </span>
        )}
      </div>
      {dayOne ? (
        <>
          <DayOne
            worldId={worldId!}
            prodId={prodId!}
            onOpen={(path, opening) =>
              navigate(`/w/${worldId}/p/${prodId}${path}`, opening ? { state: { opening } } : {})
            }
          />
          {/* Below the frame's content, not above it: 53b opens on the production's own name and
              a box to type in. Delivery postdates that drawing and is the app's own (issue 389),
              so it sits where it cannot interrupt the opening. */}
          <DeliveryAspect production={production} worldId={worldId} prodId={prodId} />
        </>
      ) : (
        <>
          <DeliveryAspect production={production} worldId={worldId} prodId={prodId} />
          <div className="fy-dashrow">
            <div className="fy-threadcard">
              <div className="fy-threadcard__head">
                <span className="fy-threadcard__label">
                  AWAITING REVIEW · {pending.length} TAKE{pending.length === 1 ? "" : "S"}
                </span>
              </div>
              <div className="fy-threadcard__title">
                {pending.length > 0 ? "Takes are back and waiting on your eye" : "Nothing waits on you"}
              </div>
              <div className="fy-threadcard__sub">
                {pending.length > 0
                  ? "Accept locks the clip into the cut; a rejection cites the sheet it drifted from."
                  : "Every take that came back has a decision. The next move is dispatch."}
              </div>
              <div className="fy-threadcard__actions">
                <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
                  {pending.length > 0 ? "Review takes" : "Open Generate"}
                </Button>
              </div>
            </div>
            {nextGap && (
              <div className="fy-nextcard">
                <div className="fy-nextcard__frame">
                  <Portrait
                    worldSlug={world.meta.slug}
                    path={
                      nextGap.scene.board
                        ? `productions/${production.meta.id}/${nextGap.scene.board.image}`
                        : (world.keyArt ?? "")
                    }
                    label={`${nextGap.shot.id.replace("sh_", "Shot ")}: frame`}
                    radius={0}
                  />
                </div>
                <div className="fy-nextcard__body">
                  <div className="fy-nextcard__title">
                    {nextGap.shot.id.replace("sh_", "Shot ")} has no clip yet
                    <span className="fy-dot fy-dot--warn" />
                  </div>
                  <div className="fy-nextcard__sub">
                    Scene {nextGap.scene.number} · {nextGap.shot.title} · {seconds(nextGap.shot.durationSec)}
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
                      Open in Generate
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="fy-listhead">
              Latest clips
              {/* The same keyboard rule as the chapter link: a destination is a button, not a span. */}
              <button
                type="button"
                className="fy-linkbtn"
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}
              >
                All {production.takes.length} takes
              </button>
            </div>
            <div className="fy-cliprow">
              {latest.map((t) => (
                <div
                  key={t.id}
                  className="fy-clip"
                  onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}
                >
                  <div className="fy-clip__frame">
                    <Portrait
                      worldSlug={world.meta.slug}
                      path={takeMediaPath(production.meta.id, t) ?? ""}
                      label={t.coversShots[0]?.replace("sh_", "shot ") ?? t.id}
                    />
                  </div>
                  <div className="fy-clip__meta">
                    <span className={`fy-dot fy-dot--${decisionTone(decisions[t.id])}`} />
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {t.coversShots.map((s) => s.replace("sh_", "shot ")).join(", ")}
                    </span>
                    <span className="fy-mono">
                      {seconds(
                        t.coversShots.reduce(
                          (sum, id) => sum + (shots.find((s) => s.id === id)?.durationSec ?? 0),
                          0,
                        ),
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {/* The pending queue is stated once, in the card above, which links to where it is
              decided (design 55). Re-listing the same takes here was a second copy to keep true. */}
          <div className="fy-dashrow">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-listhead">Activity</div>
              {recentDecided.length === 0 && <div className="fy-mono">no decisions yet</div>}
              {recentDecided.map((t) => (
                <div key={t.id} className="fy-listrow">
                  <span className={`fy-dot fy-dot--${decisions[t.id] === "accepted" ? "ok" : "sketch"}`} />
                  <span className="fy-listrow__text">
                    {t.coversShots.map((s) => s.replace("sh_", "shot ")).join(", ")} · {decisions[t.id]}
                  </span>
                  <span className="fy-mono">{usd(t.cost.actualMicroUsd ?? t.cost.estimatedMicroUsd)}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The one editable delivery-profile field (issue 389): validated and normalized server-side,
 * refused per route at dispatch, and every planning surface reads it.
 */
function DeliveryAspect({
  production,
  worldId,
  prodId,
}: {
  production: { meta: { aspect?: string } };
  worldId: string | undefined;
  prodId: string | undefined;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span className="fy-mono">Delivery</span>
      <select
        aria-label="Delivery aspect"
        value={productionAspect(production.meta)}
        onChange={(e) => worldId && prodId && setProductionAspect(worldId, prodId, e.target.value)}
        style={{
          font: "500 12px var(--font-sans)",
          padding: "4px 8px",
          borderRadius: 8,
          border: "1px solid var(--border)",
          background: "var(--background)",
          color: "inherit",
        }}
      >
        {STANDARD_ASPECTS.map((a) => (
          <option key={a} value={a}>
            {a}
          </option>
        ))}
      </select>
      {production.meta.aspect === undefined && <span className="fy-mono">default</span>}
    </div>
  );
}

/**
 * Day one (design turn 53b).
 *
 * A production that has nothing in it yet has one job: start writing. What stood here before was
 * frame 43b — the world's inventory read back, and a rail of canon seeds — which turn 53 cut and
 * turn 83 superseded in whole. The inventory announced what the rail already says, and the seeds
 * guessed at a way of working nobody had done; turn 83 leaves them a way back, but only once the
 * plain path has been used and found wanting.
 *
 * So: a heading, a box to type in, and two ways in. Typing changes nothing — the line beneath the
 * composer is the promise, and sending it opens the Production Chat thread rather than writing a word.
 */
function DayOne({
  worldId,
  prodId,
  onOpen,
}: {
  worldId: string;
  prodId: string;
  onOpen: (path: string, opening?: string) => void;
}) {
  const [message, setMessage] = useState("");
  // Nothing is being said to yet, so what is dropped here is filed as the production's own
  // artifact rather than attached to a conversation that does not exist.
  const attachTarget = { kind: "file-artifact", worldId, production: prodId } as const;
  const send = () => {
    const text = message.trim();
    if (!text) return;
    /*
     * The first thing said about a production is the opening line of its Production Chat thread,
     * not a note that lands nowhere. This screen used to create the conversation itself, which
     * named it and nothing more: creating does not take a turn, so the studio never answered the
     * first thing anybody said to it (turn 95). The line is handed to the chat, which opens the
     * thread and says it, through the one path that does both.
     */
    setMessage("");
    onOpen("/story", text);
  };
  return (
    <>
      <div style={{ font: "400 14px/1.6 var(--font-sans)", color: "var(--muted-foreground)", maxWidth: 560 }}>
        Nothing written yet. Say what happens, and the first scene takes shape here.
      </div>
      <div style={{ maxWidth: 640 }}>
        <Composer
          value={message}
          onChange={setMessage}
          onSubmit={send}
          placeholder="Someone finds the thing they were not meant to find…"
          agentLabel="story author"
          onAttach={() => uploadArtifacts(worldId)}
          onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
          {...(hostCanAttach()
            ? {
                onAttachFiles: (files: readonly File[]) => attachHostFiles(attachTarget, files),
                onAttachText: (text: string) => attachHostText(attachTarget, text, "pasted-note.txt"),
              }
            : {})}
          autoFocus
        />
        <div className="fy-mono" style={{ marginTop: 8 }}>
          talking writes nothing · you accept what you keep
        </div>
      </div>
      <div style={{ display: "flex", gap: 12, maxWidth: 640 }}>
        <button type="button" className="fy-radio" style={{ flex: 1 }} onClick={() => onOpen("/scenes/new")}>
          <div style={{ font: "600 13px var(--font-sans)" }}>Write the first scene</div>
          <div
            style={{
              font: "400 11.5px/1.5 var(--font-sans)",
              color: "var(--muted-foreground)",
              marginTop: 4,
            }}
          >
            Straight to a scene you can shoot.
          </div>
        </button>
        <button type="button" className="fy-radio" style={{ flex: 1 }} onClick={() => onOpen("/story")}>
          <div style={{ font: "600 13px var(--font-sans)" }}>Shape the whole thing first</div>
          <div
            style={{
              font: "400 11.5px/1.5 var(--font-sans)",
              color: "var(--muted-foreground)",
              marginTop: 4,
            }}
          >
            Decide what it is before writing any of it.
          </div>
        </button>
      </div>
    </>
  );
}

/**
 * Production Chat: World Chat with a production for a subject (design turns 88, 89).
 *
 * Turn 48 hung a conversation on each of four views, so one thread — R-20 says a production has
 * exactly one — wore four costumes, and every screen was half a place to make something and half
 * a place to read it. This screen is only the first half. What it sets up is read next door, on
 * Season or Overview, which is the other thing a person does and now has its own name on the rail.
 */
export function ProductionChatScreen() {
  const { worldId, prodId } = useParams();
  /** A line typed on day one, carried here by the navigation that opened this screen. */
  const opening = (useLocation().state as { opening?: string } | null)?.opening;
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const shape = production ? productionShape(production.meta) : null;
  const cast = pickableSheets(world?.sheets ?? [], prodId).filter((s) => s.type === "character").length;
  const details = shape?.isEpisodic ? "Season" : "Overview";
  const detailsPath = `/w/${worldId}/p/${prodId}/${shape?.isEpisodic ? "season" : "overview"}`;
  /*
   * What this conversation has already staged (turn 92). The season's own file for an episodic
   * production, the overview's for one without a season — a production has one of the two, never
   * both, so a single match is the whole answer.
   */
  const file = shape?.isEpisodic ? "season.json" : "story.json";
  const staged =
    (world?.proposals ?? []).find((sp) =>
      sp.proposal.targets.some((t) => t.path === `productions/${prodId}/${file}`),
    ) ?? null;
  return (
    <div className="fy-story" data-screen="production-chat">
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        openingNote="Develop · opening…"
        eyebrow={`DEVELOP · ${shape ? shape.displayLabel.toLowerCase() : ""}`}
        heading={shape?.isEpisodic ? "What is this season?" : "Find the spine together."}
        placeholder="Say what this is — what happens, who it costs, how it ends…"
        emptyLine={
          shape?.isEpisodic
            ? "Nothing decided yet. Say what this season answers, how it ends, and what its episodes are — everything you settle here lands in Season."
            : "Nothing decided yet. Say what this is — the spine, the acts, what it costs — and what you settle here lands in Overview."
        }
        footer={
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="fy-mono">in context:</span>
            <span className="fy-pill">
              all {production?.scenes.length ?? 0} scene{(production?.scenes.length ?? 0) === 1 ? "" : "s"}
            </span>
            <span className="fy-pill">{cast} cast sheets</span>
            {world?.meta.tone && <span className="fy-pill">Tone · {world.meta.tone}</span>}
            <span style={{ flex: 1 }} />
            {/* Where what is being said ends up, named and reachable from where it is said. */}
            <NavLink
              to={`/w/${worldId}/p/${prodId}/${shape?.isEpisodic ? "season" : "overview"}`}
              className="fy-linkbtn"
            >
              {details} &rarr;
            </NavLink>
          </div>
        }
        pointsEmpty="Nothing understood yet. As you talk, what the studio takes from it appears here — the season question, each episode, each arc — so you can see it thinking rather than wait for the end."
        {...(opening ? { openWith: opening } : {})}
        {...(staged
          ? {
              side: (
                <StagedDecision
                  worldId={worldId}
                  subject={shape?.isEpisodic ? "the season" : "the overview"}
                  staged={staged}
                  writes={`the gate writes ${file} · nothing else moves`}
                  onAccepted={() => navigate(detailsPath)}
                />
              ),
            }
          : {})}
      />
    </div>
  );
}

// ---- Story (10b) -----------------------------------------------------------

export function StoryScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  // An episodic production's details are the four-view workspace (turn 48; issue 397); a
  // non-episodic one keeps the single overview — no fake episode or season controls. The
  // branch is a component boundary, not an early return: returning before the overview's own
  // hooks broke the Rules of Hooks the moment a production's shape settled after first render.
  if (production && productionShape(production.meta).isEpisodic) return <DevelopmentWorkspace />;
  return <OverviewStoryScreen />;
}

function OverviewStoryScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const story = production?.story ?? null;
  /*
   * What is already waiting on a decision for this production's overview (turn 86).
   *
   * The rail marks each field the staged proposal would change, using the proposal's own
   * field-by-field review — computed from the captured base against the proposed file — so the
   * screen cannot claim a change the gate would not make.
   */
  const staged = (world?.proposals ?? []).find((sp) =>
    sp.proposal.targets.some((t) => t.path === `productions/${prodId}/story.json`),
  );
  /** Every field the staged proposal would change, flattened out of its per-target review. */
  const stagedFields = staged?.review?.targets.flatMap((t) => t.fields) ?? [];
  const spineLines = (story?.spine ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return (
    <div className="fy-story" data-screen="story-overview">
      {/* The details, not a conversation (turn 88): what the thread settled, read and worked
          with. Changing any of it is done next door, where it was decided. */}
      <div className="fy-story__chat">
        <div className="fy-story__chathead">
          <div className="fy-eyebrow-sm">
            OVERVIEW · {production ? productionShape(production.meta).displayLabel.toLowerCase() : ""}
          </div>
          <h1 className="fy-story__h1">{story ? "The story, as it stands" : "Nothing settled yet"}</h1>
        </div>
        <div className="fy-story__log">
          {story ? (
            <div style={{ display: "grid", gap: 14 }}>
              <div className="fy-draftcard">
                <div className="fy-eyebrow-sm">LOGLINE</div>
                <div className="fy-draftcard__logline">“{story.logline}”</div>
              </div>
              {spineLines.length > 0 && (
                <div className="fy-draftcard">
                  <div className="fy-eyebrow-sm">SPINE</div>
                  {spineLines.map((line) => (
                    <div key={line} style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4 }}>
                      {line}
                    </div>
                  ))}
                </div>
              )}
              {(story.acts ?? []).length > 0 && (
                <div className="fy-draftcard">
                  <div className="fy-eyebrow-sm">ACTS</div>
                  {(story.acts ?? []).map((act, i) => (
                    <div key={act.title} style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4 }}>
                      {i + 1}. {act.title}
                      {act.summary ? ` — ${act.summary}` : ""}
                    </div>
                  ))}
                </div>
              )}
              {production?.treatment && (
                <div className="fy-draftcard">
                  <div className="fy-eyebrow-sm">TREATMENT</div>
                  <div
                    style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 4, whiteSpace: "pre-wrap" }}
                  >
                    {production.treatment}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <EmptyState
              title="Nothing settled yet"
              hint="Production Chat is where this gets decided — say what the thing is, and what you settle lands here."
            />
          )}
        </div>
        <div
          style={{ flex: "none", padding: "14px 36px 22px", display: "flex", gap: 10, alignItems: "center" }}
        >
          <NavLink to={`/w/${worldId}/p/${prodId}/story`} className="fy-linkbtn">
            &larr; Production Chat
          </NavLink>
          <span className="fy-mono">
            the overview steers scene and chapter drafting · it never overwrites a scene you have locked
          </span>
        </div>
      </div>
      {/* The rail beside a details screen holds what is staged against it (turn 86/88) — the
          object itself is the screen, so repeating it here would be two copies of one thing. */}
      <div className="fy-story__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>Waiting on you</div>
          <span className="fy-mono" style={{ color: staged ? "var(--warning)" : undefined }}>
            {staged
              ? `${stagedFields.length} change${stagedFields.length === 1 ? "" : "s"}`
              : "nothing staged"}
          </span>
        </div>
        {staged ? (
          <div style={{ display: "grid", gap: 12 }}>
            {stagedFields.map((field) => (
              <div key={field.field} className="fy-draftcard">
                <div className="fy-draftcard__head">
                  <span className="fy-eyebrow-sm">{field.field}</span>
                  <Badge tone="warning">would change</Badge>
                </div>
                <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 6 }}>
                  {field.proposed ?? "(removed)"}
                </div>
                {field.before !== null && <div className="fy-draftcard__was">Accepted: “{field.before}”</div>}
              </div>
            ))}
            <div className="fy-mono">the conversation staged it · the gate writes it, in Proposals</div>
          </div>
        ) : (
          <div className="fy-emptycard">
            <div style={{ font: "400 13px/1.7 var(--font-sans)" }}>
              Nothing waiting. What Production Chat settles arrives here to be accepted before it lands.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function ChapterTreeScreen() {
  const { prodId, worldId } = useParams();
  const { production } = useProduction(worldId, prodId);
  return (
    <div className="fy-prodmain" data-screen="chapter-tree">
      <div className="fy-h1row">
        <h1 className="fy-h1">Chapter tree</h1>
        <span className="fy-h1row__meta">{production?.chapters.length ?? 0} chapters</span>
      </div>
      {production && production.chapters.length > 0 ? (
        <div>
          {production.chapters.map((c) => (
            <div key={c.id} className="fy-listrow">
              <span className="fy-mono">{String(c.order).padStart(2, "0")}</span>
              <span className="fy-listrow__text" style={{ font: "600 13px var(--font-sans)" }}>
                {c.title}
              </span>
              <Badge tone="outline">v{c.version}</Badge>
              <span className="fy-mono">{c.words ? `${c.words} words` : c.status}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          title={
            production && productionShape(production.meta).hasChapters
              ? "No chapters yet"
              : "Chapters belong to Story productions"
          }
          hint={
            production && productionShape(production.meta).hasChapters
              ? "Chapters hang beneath the overview and are drafted through the gate."
              : "This production's structure lives in Scenes."
          }
        />
      )}
    </div>
  );
}

// ---- Scenes ----------------------------------------------------------------

export function ScenesScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const totalSec =
    production?.scenes.reduce((s, sc) => s + sc.shots.reduce((x, sh) => x + (sh.durationSec ?? 0), 0), 0) ??
    0;
  return (
    <div className="fy-prodmain" data-screen="scenes">
      <div className="fy-h1row">
        <h1 className="fy-h1">Scenes</h1>
        <span className="fy-h1row__meta">
          {production?.scenes.length ?? 0} scenes · {seconds(totalSec)}
        </span>
        <span className="fy-h1row__push" />
        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/new`)}>
          New scene
        </Button>
      </div>
      {production && production.scenes.length > 0 ? (
        <div className="fy-ledger">
          {production.scenes.map((scene) => {
            const covered = scene.shots.filter((s) => acceptedTakeId(production, s.id)).length;
            return (
              <button
                key={scene.id}
                type="button"
                className="fy-row"
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/${scene.id}`)}
              >
                <div className="fy-row__thumb">
                  <Portrait
                    worldSlug={world?.meta.slug}
                    path={scene.board ? `productions/${production.meta.id}/${scene.board.image}` : ""}
                    label={String(scene.number)}
                    radius={6}
                  />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div className="fy-row__name">
                    {scene.number} · {scene.title}
                    <span
                      className={`fy-dot fy-dot--${covered === scene.shots.length && scene.shots.length > 0 ? "ok" : "warn"}`}
                    />
                  </div>
                  <div className="fy-row__sub">
                    {scene.shots.length} shots ·{" "}
                    {seconds(scene.shots.reduce((s, x) => s + (x.durationSec ?? 0), 0))}
                    {scene.inherits?.location ? ` · @${scene.inherits.location}` : ""}
                    {scene.inherits?.timeOfDay ? ` · ${scene.inherits.timeOfDay}` : ""}
                  </div>
                </div>
                <span className="fy-row__meta">
                  v{scene.version}
                  {scene.board ? ` · board v${scene.board.version}` : " · no board"}
                </span>
                <span className="fy-row__chev">
                  <ChevronRight size={15} />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState
          title="No scenes yet"
          hint="Draft a scene and its shots inherit location, time and tone."
        />
      )}
    </div>
  );
}

// ---- Scene detail (14a) ----------------------------------------------------

/**
 * Scene Chat, and the proposal it ends in (design turn 94; the shape of turns 91 and 92, one
 * level further down).
 *
 * The last of the three. A scene's conversation used to open World Chat on another screen, so the
 * pattern a person had just learned twice — talk here, accept here, land on the thing — stopped
 * working at exactly the level where the writing happens. Same component, same two rail states,
 * smaller subject.
 */
export function SceneChatScreen() {
  const { worldId, prodId, sceneId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const scene = production?.scenes.find((s) => s.id === sceneId);
  if (!production || !scene || !prodId || !sceneId) {
    return (
      <div className="fy-story" data-screen="scene-chat">
        <EmptyState title="Opening the scene…" />
      </div>
    );
  }
  const stem = sceneFileOf(production, scene);
  const staged = stem
    ? ((world?.proposals ?? []).find((sp) =>
        sp.proposal.targets.some((t) => t.path === `productions/${prodId}/scenes/${stem}.json`),
      ) ?? null)
    : null;
  return (
    <div className="fy-story" data-screen="scene-chat">
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        entry={{ kind: "scene", productionId: prodId, sceneId }}
        openingNote={`Scene Chat · ${scene.number} · opening…`}
        eyebrow={`SCENE CHAT · ${scene.number}`}
        heading="How does this one go?"
        emptyLine={`Nothing written for ${scene.title} yet. Say what happens in it — the script comes back in blocks that keep their ids.`}
        placeholder="Keep shaping the scene…"
        {...(staged
          ? {
              side: (
                <StagedDecision
                  worldId={worldId}
                  subject={`scene ${scene.number}`}
                  staged={staged}
                  writes="no shots are made · nothing else changes"
                  onAccepted={() => navigate(`/w/${worldId}/p/${prodId}/scenes/${scene.id}`)}
                />
              ),
            }
          : {
              pointsEmpty:
                "Nothing understood yet. As you talk, what the studio takes from it appears here — what happens, who is in it, what it has to establish — so you can see it thinking rather than wait for the end.",
            })}
      />
    </div>
  );
}

export function SceneDetailScreen() {
  const { worldId, prodId, sceneId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { state } = useStore();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"shots" | "board">("shots");
  /* Turn 102: a review is consulted and put away, and spending is a drawer over the work. */
  const [reviewing, setReviewing] = useState(false);
  const [generating, setGenerating] = useState(false);
  const scene = production?.scenes.find((s) => s.id === sceneId);
  if (!production || !scene) {
    return (
      <Screen id="scene-detail">
        <EmptyState title="Opening scene…" />
      </Screen>
    );
  }
  const slug = world?.meta.slug;
  const totalSec = scene.shots.reduce((s, x) => s + (x.durationSec ?? 0), 0);
  const model =
    (state?.app.manifest?.models ?? []).find(
      (m) => m.id === state?.app.routing.defaults["video"] && m.capability === "video",
    ) ??
    (state?.app.manifest?.models ?? []).find((m) => m.capability === "video") ??
    null;
  const boardStale = scene.board !== undefined && scene.board.version < scene.version;
  return (
    <div className="fy-prodmain" data-screen="scene-detail" style={{ minHeight: "100%" }}>
      <div>
        <div className="fy-h1row">
          <h1 className="fy-h1" style={{ fontSize: 32 }}>
            Scene {scene.number} · {scene.title}
          </h1>
          <span className="fy-h1row__meta">
            {scene.shots.length} shots · {seconds(totalSec)}
          </span>
          <span className="fy-h1row__push" />
          {/* The durable scene thread (SPEC-023 R-20, issue 400): script blocks are proposed
              there and land through the same gate as everything else. It opens in place now
              rather than on World Chat (turn 94) — a pattern a person has learned twice already
              should not stop working at the level where the writing happens. */}
          <Button
            variant="ghost"
            onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/scenes/${scene.id}`)}
          >
            Talk it through
          </Button>
          <span className="fy-seg">
            <button
              type="button"
              className={cx("fy-seg__item", tab === "shots" && "fy-seg__item--active")}
              onClick={() => setTab("shots")}
            >
              Shots
            </button>
            <button
              type="button"
              className={cx("fy-seg__item", tab === "board" && "fy-seg__item--active")}
              onClick={() => setTab("board")}
            >
              Board
            </button>
          </span>
          {/*
            Review, then generate, both where the shots are (turn 102). The plan was a screen for
            two turns, and a costing screen reached from the creative surface is layer three
            standing in front of layer one — the test turn 102 states. `Generation options` in the
            drawer is where the old screen went; it is the Advanced door, not the way through.
          */}
          <Button variant="ghost" onClick={() => setReviewing((on) => !on)}>
            {reviewing ? "Hide review" : "Review scene"}
          </Button>
          <Button onClick={() => setGenerating(true)}>Generate scene</Button>
        </div>
        {/* The line under the title (turn 97, 14c): the synopsis, edited where it reads. */}
        <div style={{ marginTop: 10, maxWidth: 660 }}>
          <SceneSynopsis worldId={worldId!} prodId={prodId!} scene={scene} />
        </div>
        <div className="fy-inherits" style={{ marginTop: 8 }} title="Shots inherit these">
          {scene.inherits?.location && (
            <span className="fy-pill">
              @{scene.inherits.location}
              {scene.inherits.timeOfDay ? `, ${scene.inherits.timeOfDay}` : ""}
            </span>
          )}
          {!scene.inherits?.location && scene.inherits?.timeOfDay && (
            <span className="fy-pill">{scene.inherits.timeOfDay}</span>
          )}
          {scene.inherits?.tone && <span className="fy-pill">Tone · {scene.inherits.tone}</span>}
          <span className="fy-pill">{productionAspect(production.meta)} · from the production</span>
          {model && (
            <span className="fy-mono">
              {model.displayName} · max {model.limits.maxDurationSec ?? "∞"}s / clip
            </span>
          )}
        </div>
      </div>
      {tab === "shots" ? (
        <>
          {/* Turn 97: the storyboard is the editor — 14a's read-only cards are superseded. */}
          {/* Above the shots, because that is what it is about (turn 102). */}
          {reviewing && <SceneReview scene={scene} onClose={() => setReviewing(false)} />}
          <StoryboardStrip worldId={worldId!} prodId={prodId!} scene={scene} />
          <StoryboardFoot worldId={worldId!} prodId={prodId!} scene={scene} />
          {generating && (
            <GenerateDrawer
              worldId={worldId!}
              prodId={prodId!}
              scene={scene}
              onClose={() => setGenerating(false)}
            />
          )}
        </>
      ) : (
        <div className="fy-boardsplit">
          <div className="fy-boardsheet">
            {scene.board ? (
              <Portrait
                worldSlug={slug}
                path={`productions/${production.meta.id}/${scene.board.image}`}
                label={`Scene ${scene.number}, compiled board sheet`}
                radius={0}
              />
            ) : (
              <EmptyState title="No board yet" hint="A board compiles from the scene at a point in time." />
            )}
          </div>
          <div className="fy-boardrail">
            <div className="fy-boardcard">
              <div className="fy-boardcard__head">
                {scene.board ? `Board v${scene.board.version}` : "No board"}
                <span
                  className="fy-boardcard__state"
                  style={{ color: boardStale ? "var(--warning)" : "var(--success)" }}
                >
                  {scene.board
                    ? boardStale
                      ? `stale — scene is at v${scene.version}`
                      : "in step with shots"
                    : ""}
                </span>
              </div>
              <div className="fy-boardcard__body">Frames, order, timings and labels, ready for dispatch.</div>
              <div className="fy-boardcard__mono">
                {scene.shots.length} shots · {seconds(totalSec)}
                {scene.board ? `\ncompiled ${scene.board.compiledAt}` : ""}
              </div>
            </div>
            <div className="fy-boardcard fy-boardcard--quiet">
              <div className="fy-boardcard__head">Where it goes</div>
              <div className="fy-boardcard__body">
                In one-pass dispatch this sheet rides along as the scene reference. Per-shot dispatch sends
                each frame instead.
              </div>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <Button
                onClick={() => {
                  const stem = sceneFileOf(production, scene);
                  if (worldId && prodId && stem) compileSceneBoard(worldId, prodId, stem);
                }}
              >
                Recompile · free, local
              </Button>
              <Button
                variant="ghost"
                disabled={!scene.board}
                onClick={() => {
                  const stem = sceneFileOf(production, scene);
                  if (worldId && prodId && stem) exportSceneBoard(worldId, prodId, stem);
                }}
              >
                Export sheet · PNG
              </Button>
            </div>
            <div style={{ flex: 1 }} />
            <span className="fy-mono">lands in artifacts on every compile</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function NewSceneScreen() {
  const { worldId, prodId } = useParams();
  const navigate = useNavigate();
  const world = useWorld();
  const [brief, setBrief] = useState("");
  // The example brief names one of this world's own cast, not the sample world's.
  const exampleName = world?.sheets[0]?.name ?? "Someone";
  return (
    <div className="fy-prodmain" data-screen="new-scene">
      <div className="fy-h1row">
        <h1 className="fy-h1">New scene</h1>
        <span className="fy-h1row__meta">
          a draft arrives as a proposal · accepting creates the shots, dispatches nothing
        </span>
      </div>
      <DegradedBanner component="harness" />
      <div className="scr-form" style={{ maxWidth: 620 }}>
        <div className="scr-field">
          <label className="scr-field__label">What happens</label>
          <Textarea
            placeholder={`${exampleName} keeps the night watch alone; what they feared arrives a season early…`}
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
          />
          <span className="scr-field__hint">
            Mention cast with @name — shots compute their cast from live references, never guesses.
          </span>
        </div>
        <div>
          <Button
            variant="primary"
            disabled={brief.trim().length === 0}
            onClick={() => {
              if (worldId && prodId) {
                draftScene(worldId, prodId, brief.trim());
                navigate(`/w/${worldId}/p/${prodId}`);
              }
            }}
          >
            Draft scene
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Generate workspace (11b) ----------------------------------------------

/**
 * The takes, watched (design turn 102, frame 102c).
 *
 * A thing you watch is shown, not described. One shot's takes sit side by side, the chosen one is
 * marked, every shot is a chip away, and accepting is one button at the foot. What used to be
 * here — the composer, the parameter rail, the model picker, the select of shots — is the bench,
 * behind Advanced: layer three, never deleted and never in front.
 *
 * Two ergonomics this fixes by construction. The shot picker was a select, which hides where you
 * are in a scene; and Accept take was disabled unless the take you were looking at happened to be
 * the pending one, which reads as broken. A marked tile and a row of chips have neither problem.
 */
function TakesView({
  worldId,
  prodId,
  askedFor,
  onAdvanced,
  onContact,
}: {
  worldId: string | undefined;
  prodId: string | undefined;
  /** The shot the press was about, carried in the address (`?shot=`). */
  askedFor: string | null;
  /* Both doors carry the shot with them (review 2026-08-22): pressing Advanced used to replace
     the whole query string, losing the shot one click after the address recovered it. */
  onAdvanced: (shotId: string | null) => void;
  onContact: (shotId: string | null) => void;
}) {
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const all = production?.scenes.flatMap((s) => s.shots) ?? [];
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  /*
   * The shot the storyboard sent, if it sent one (found by driving: `Generate frame` on shot 14
   * opened the workspace on shot 4, because the press asked for the workspace rather than for a
   * shot). A chip pressed here still wins — the address is where you arrived, not a lock.
   */
  const asked = askedFor !== null && all.some((s) => s.id === askedFor) ? askedFor : null;
  const shotId = selectedShotId ?? asked ?? all[0]?.id ?? null;
  const shot = all.find((s) => s.id === shotId) ?? null;
  const scene = production?.scenes.find((s) => s.shots.some((x) => x.id === shotId)) ?? null;
  /*
   * The chips are this scene's shots, not the production's (found by driving: a production with
   * two scenes drew three chips, two of them reading "Shot 1", because a shot's number is
   * scene-local and flattening the production makes it ambiguous). "Every shot" means every shot
   * of the thing you are looking at, which is what the frame draws.
   */
  const shots = scene?.shots ?? [];
  /* Every scene, one chip away (review 2026-08-22): the first cut could only reach the first
     scene's shots from the rail, and a three-scene production had no way to its second. */
  const scenes = production?.scenes ?? [];
  /*
   * Only takes there is something to watch. A per-shot charge-split record carries the
   * acceptance and no media of its own — the pixels live on the pass take covering the same
   * shot — and a grid of things you watch must not offer one, which read as `running…` for a
   * clip that finished ten days ago. Anything still in flight has no `completedAt` and stays.
   */
  const takes = (production && shotId ? takesForShot(production, shotId) : []).filter(
    (t) => t.media !== undefined || t.completedAt === undefined,
  );
  const acceptedId = production && shotId ? acceptedTakeId(production, shotId) : null;
  /*
   * The mark tells no lies (review 2026-08-22). The first cut of this view guessed: when the
   * acceptance sat on a filtered charge-split record it re-pointed ✓ at the newest take with
   * media — which marked takes that were never accepted, disabled Accept on them, and disagreed
   * with the cut, the chips and the exporter all at once. Now ✓ appears only on the take that
   * is literally accepted; when that record has no preview, the foot says so instead, and one
   * press of Accept on a visible take moves the selection somewhere honest.
   */
  const accepted = takes.find((t) => t.id === acceptedId)?.id ?? null;
  const acceptedHidden = acceptedId !== null && accepted === null;
  /* What is worth looking at: the one already accepted, or the newest that came back. */
  const [pickedId, setPickedId] = useState<string | null>(null);
  const picked =
    takes.find((t) => t.id === pickedId) ??
    takes.find((t) => t.id === accepted) ??
    takes[takes.length - 1] ??
    null;
  const acceptedCount = (scene?.shots ?? []).filter(
    (s) => production && acceptedTakeId(production, s.id) !== null,
  ).length;
  /* One pass over the takes for the chip dots, not one filter per chip (review 2026-08-22). */
  const coveredShotIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of production?.takes ?? []) for (const sid of t.coversShots) ids.add(sid);
    return ids;
  }, [production?.takes]);
  if (!production || !scene || !shot) {
    return (
      <div className="fy-prodmain" data-screen="generate-workspace">
        <EmptyState title="Nothing to review yet" hint="Generate a scene and its takes arrive here." />
      </div>
    );
  }
  return (
    <div className="fy-arkewrap">
      <div className="fy-prodmain fy-takes" data-screen="generate-workspace">
        <div className="fy-h1row">
          <h1 className="fy-h1">Shot {shot.number}</h1>
          <span className="fy-h1row__meta">
            {shot.title} · {seconds(shot.durationSec)}
          </span>
          <span className="fy-h1row__push" />
          <span className="fy-mono">
            {acceptedCount} of {shots.length} accepted
          </span>
        </div>
        {takes.length === 0 ? (
          <EmptyState
            title="No takes yet"
            hint="Generate this shot and its takes arrive here, side by side."
          />
        ) : (
          <div className="fy-takegrid">
            {takes.map((t, i) => {
              const path = takeMediaPath(production.meta.id, t);
              return (
                <button
                  key={t.id}
                  type="button"
                  className={cx("fy-take", picked?.id === t.id && "fy-take--on")}
                  onClick={() => setPickedId(t.id)}
                >
                  <span className="fy-take__frame">
                    {path ? (
                      <Portrait worldSlug={world?.meta.slug} path={path} label={`Take ${i + 1}`} radius={0} />
                    ) : (
                      <span className="fy-mono">running…</span>
                    )}
                    {path && (
                      <span className="fy-playbtn" aria-hidden style={{ pointerEvents: "none" }}>
                        <Play size={22} />
                      </span>
                    )}
                  </span>
                  <span className="fy-take__foot">
                    <span className="fy-take__name">Take {i + 1}</span>
                    <span style={{ flex: 1 }} />
                    <span className="fy-mono">
                      {t.id === accepted ? "✓ SELECTED" : seconds(shot.durationSec)}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {scenes.length > 1 && (
          <>
            <div className="fy-mono" style={{ letterSpacing: ".08em", marginTop: 8 }}>
              SCENES
            </div>
            <div className="fy-takechips">
              {scenes.map((sc) => (
                <button
                  key={sc.id}
                  type="button"
                  className={cx("fy-takechip", sc.id === scene.id && "fy-takechip--on")}
                  onClick={() => {
                    setSelectedShotId(sc.shots[0]?.id ?? null);
                    setPickedId(null);
                  }}
                >
                  Scene {sc.number}
                </button>
              ))}
            </div>
          </>
        )}
        {/* Every shot, one chip away — where you are in the scene, said out loud (turn 102). */}
        <div className="fy-mono" style={{ letterSpacing: ".08em", marginTop: 8 }}>
          EVERY SHOT
        </div>
        <div className="fy-takechips">
          {shots.map((s) => {
            const done = acceptedTakeId(production, s.id) !== null;
            const has = coveredShotIds.has(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className={cx("fy-takechip", s.id === shotId && "fy-takechip--on")}
                onClick={() => {
                  setSelectedShotId(s.id);
                  setPickedId(null);
                }}
              >
                <span
                  className="fy-dot"
                  style={{
                    background: done ? "var(--foreground)" : has ? "var(--warning)" : "var(--neutral-300)",
                  }}
                />
                Shot {s.number}
              </button>
            );
          })}
        </div>
        <div className="fy-takes__foot">
          {/* The two verdicts and the one thing that spends (review 2026-08-22): the first cut
              of this view had no way to generate and no way to reject, so "Generate frame" from
              the storyboard landed on a screen that told you to generate and offered nothing to
              press, and a drifted take could only be ignored — never taught from. */}
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}>
            Generate
          </Button>
          <Button
            disabled={!picked || picked.id === accepted}
            onClick={() => {
              if (worldId && prodId && shotId && picked) acceptTake(worldId, prodId, picked.id, shotId);
            }}
          >
            {picked ? `Accept take ${takes.indexOf(picked) + 1}` : "Accept take"}
          </Button>
          <Button
            variant="ghost"
            disabled={!picked || Object.keys(picked.provenance.sheets).length === 0}
            title="A rejection cites the sheet the take drifted from"
            onClick={() => {
              const sheet = picked ? Object.keys(picked.provenance.sheets)[0] : undefined;
              if (worldId && prodId && picked && sheet)
                rejectTake(
                  worldId,
                  prodId,
                  picked.id,
                  { sheet, field: "appearance", note: "rejected in review" },
                  shotId ?? undefined,
                );
            }}
          >
            Reject
          </Button>
          <span className="fy-mono">
            {acceptedHidden
              ? "accepted take holds no preview — accepting a visible one replaces it"
              : "accepting locks it into the cut · rejections teach the shot"}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="fy-linkbtn" onClick={() => onContact(shotId)}>
            Contact sheet
          </button>
          <button type="button" className="fy-linkbtn" onClick={() => onAdvanced(shotId)}>
            Advanced
          </button>
        </div>
      </div>
      {/* Layer two, in the same column it holds everywhere else (turns 99, 100, 102). */}
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        entry={{ kind: "scene", productionId: prodId ?? "", sceneId: scene.id }}
        dock={{
          title: `Arke · Shot ${shot.number}`,
          subject: `${shot.title} · ${takes.length} take${takes.length === 1 ? "" : "s"}`,
        }}
        openingNote="opening…"
        emptyLine={`${takes.length} take${takes.length === 1 ? "" : "s"} back on shot ${shot.number}. Say what to change and it runs again.`}
        placeholder="Say what to change · @ to reference"
        pointsEmpty="Nothing understood yet. As you talk, what the studio takes from it appears here."
      />
    </div>
  );
}

export function GenerateScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { state } = useStore();
  const navigate = useNavigate();
  // The workspace's second lens (design 55a): the same frame/still takes, seen as a set.
  // Deep-linkable — the retired /stills address redirects here with the lens on.
  const [searchParams, setSearchParams] = useSearchParams();
  const contactLens = searchParams.get("view") === "stills";
  const shots = production?.scenes.flatMap((s) => s.shots) ?? [];
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null);
  /* The bench honours the address the same way the takes view does (review 2026-08-22). */
  const benchAsked = searchParams.get("shot");
  const shotId =
    selectedShotId ??
    (benchAsked !== null && shots.some((s) => s.id === benchAsked) ? benchAsked : null) ??
    shots[0]?.id ??
    null;
  const shot = shots.find((s) => s.id === shotId) ?? null;
  const scene = production?.scenes.find((s) => s.shots.some((x) => x.id === shotId)) ?? null;
  const takes = production && shotId ? takesForShot(production, shotId) : [];
  const decisions = production ? takeDecisions(production) : {};
  const accepted = production && shotId ? acceptedTakeId(production, shotId) : null;
  const take =
    takes.find((t) => t.id === selectedTakeId) ??
    (accepted ? takes.find((t) => t.id === accepted) : undefined) ??
    takes[takes.length - 1] ??
    null;
  const slug = world?.meta.slug;
  const model =
    (state?.app.manifest?.models ?? []).find((m) => m.id === state?.app.routing.defaults["video"]) ??
    (state?.app.manifest?.models ?? []).find((m) => m.capability === "video") ??
    null;

  /*
   * Which lens the workspace opens on (turn 102). Takes are the thing here: once something has
   * been generated you are assessing rather than writing, so the takes themselves are the front
   * and the three-column bench — composer, parameters, model picker — is layer three behind
   * Advanced. Deep-linkable, so somebody who wants the bench can live in it.
   */
  const benchLens = searchParams.get("view") === "bench";

  if (contactLens) {
    return (
      <ContactSheet
        production={production}
        worldSlug={world?.meta.slug}
        worldId={worldId}
        prodId={prodId}
        onShotLens={() => setSearchParams({}, { replace: true })}
        onScene={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}
      />
    );
  }
  if (!benchLens) {
    return (
      <TakesView
        worldId={worldId}
        prodId={prodId}
        askedFor={searchParams.get("shot")}
        onAdvanced={(shotId) =>
          setSearchParams(shotId ? { view: "bench", shot: shotId } : { view: "bench" }, { replace: true })
        }
        onContact={(shotId) =>
          setSearchParams(shotId ? { view: "stills", shot: shotId } : { view: "stills" }, { replace: true })
        }
      />
    );
  }

  /*
   * Bench-only derivations live below the lens branch (review 2026-08-22): the previous frame,
   * the frame route, the boundary still and the cited sheets are the bench's furniture, and
   * computing them above the branch made every takes-view render pay for a bench nobody was
   * looking at. Plain consts, so they may sit under the returns; the hooks stay above.
   */
  const prevShot = (() => {
    if (!scene || !shot) return null;
    const i = scene.shots.findIndex((s) => s.id === shot.id);
    return i > 0 ? scene.shots[i - 1]! : null;
  })();
  const prevAccepted =
    prevShot && production
      ? production.takes.find((t) => t.id === acceptedTakeId(production, prevShot.id))
      : null;
  const prevFrame = prevAccepted && production ? takeMediaPath(production.meta.id, prevAccepted) : null;
  // Strict frame behaviour is promised exactly where the route supports and receives it (issue
  // 154): the model's first-frame route, and the shot's durable boundary still. Anything less is
  // steering, and the copy says so instead of promising what the dispatch cannot send.
  const frameRoute = model ? frameDispatchFor(model, 1) : null;
  const boundaryFrame = (() => {
    if (!shot || !production || !world) return null;
    const id = production.selections[shot.id]?.startFrameArtifactId ?? null;
    return id !== null ? (world.artifacts.find((a) => a.id === id) ?? null) : null;
  })();

  const citedSheets = (() => {
    if (!shot || !world) return [];
    const mentions = [...shot.description.matchAll(/@([A-Za-z0-9-]+)/g)].map((m) => m[1]!.toLowerCase());
    return world.sheets
      .filter((s) => s.type === "character")
      .filter((s) => mentions.some((m) => s.id.includes(m) || s.name.toLowerCase().includes(m)))
      .slice(0, 2);
  })();

  return (
    <div className="fy-gen" data-screen="generate-workspace">
      <div className="fy-gen__left">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="fy-seg">
            <span className="fy-seg__item fy-seg__item--active">Shot</span>
            <button
              type="button"
              className="fy-seg__item"
              onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}
            >
              Scene
            </button>
            <button
              type="button"
              className="fy-seg__item"
              onClick={() => setSearchParams({ view: "stills" }, { replace: true })}
            >
              Contact sheet
            </button>
          </span>
          <select
            value={shotId ?? ""}
            onChange={(e) => {
              setSelectedShotId(e.target.value);
              setSelectedTakeId(null);
            }}
            style={{
              flex: 1,
              minWidth: 0,
              font: "500 12px var(--font-sans)",
              padding: "6px 8px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--background)",
              color: "inherit",
            }}
          >
            {shots.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id.replace("sh_", "shot ")} · {s.title}
              </option>
            ))}
          </select>
        </div>
        <div className="fy-gen__label">
          References <span className="fy-mono">sent with every take</span>
        </div>
        <div className="fy-refstrip">
          <div className="fy-refstrip__wide">
            <Portrait
              worldSlug={slug}
              path={scene?.board ? `productions/${production!.meta.id}/${scene.board.image}` : ""}
              label={shot ? `${shot.id.replace("sh_", "Shot ")} frame` : "frame"}
              radius={0}
            />
          </div>
          {citedSheets.map((s) => (
            <div key={s.id} className="fy-refstrip__tile">
              <Portrait worldSlug={slug} path={sheetPortraitPath(s.id)} label={s.name} radius={0} />
            </div>
          ))}
          <button
            type="button"
            className="fy-refstrip__add"
            title="References ride from the kits"
            onClick={() => navigate(`/w/${worldId}/cast`)}
          >
            <Plus size={14} />
          </button>
        </div>
        <div className="fy-mono" style={{ marginTop: 6 }}>
          {shot
            ? `${shot.id.replace("sh_", "shot ")}${citedSheets.length > 0 ? ` · ${citedSheets.map((s) => `${s.name} model sheet v${s.version}`).join(" · ")}` : ""}`
            : ""}
        </div>
        <div className="fy-gen__label" style={{ marginTop: 16 }}>
          Frames{" "}
          <span className="fy-mono">
            {frameRoute !== null
              ? "start travels on the first-frame route"
              : "steering only · no frame route on this model"}
          </span>
        </div>
        {world && production && (
          <div className="fy-worldlook-line">
            <span>
              {shot?.promptOverride
                ? "Shot prompt override"
                : production.meta.styleOverride?.trim()
                ? "Production look"
                : `World look · v${world.artDirection.version}`}
            </span>
            <small>
              {shot?.promptOverride ? "edited by you" : production.meta.styleOverride?.trim() || "inherited"} · carries
              as text
            </small>
          </div>
        )}
        <div className="fy-framerow">
          {boundaryFrame ? (
            <div className="fy-frame">
              <Portrait
                worldSlug={slug}
                path={`artifacts/${boundaryFrame.file}`}
                label="Start frame"
                radius={0}
              />
              <span className="fy-frame__tag">
                START · BOUNDARY FRAME{frameRoute !== null ? "" : " (STEERS ONLY)"}
              </span>
            </div>
          ) : prevFrame ? (
            <div className="fy-frame">
              <Portrait worldSlug={slug} path={prevFrame} label="Start frame" radius={0} />
              <span className="fy-frame__tag">
                START · {prevShot!.id.replace("sh_", "SHOT ")}, LAST FRAME (PREVIEW)
              </span>
            </div>
          ) : (
            <div className="fy-frame fy-frame--empty">START · FROM THE BOARD</div>
          )}
          <div className="fy-frame fy-frame--empty">END · OPTIONAL</div>
        </div>
        {shot && production && world && scene && (
          <GeneratePromptEditor
            world={world}
            production={production}
            scene={scene}
            shot={shot}
            worldId={worldId!}
            prodId={prodId!}
          />
        )}
        <div className="fy-paramrow">
          {/* The production's delivery aspect (issue 389), never a hard-coded landscape. */}
          <span className="fy-param">{production ? productionAspect(production.meta) : "16:9"}</span>
          <span className="fy-param">720p</span>
          {shot && <span className="fy-param">{seconds(shot.durationSec)}</span>}
          {frameRoute !== null && boundaryFrame && (
            <span className="fy-param">opens on its boundary frame</span>
          )}
        </div>
        <div className="fy-gen__cta">
          {model && (
            <span className="fy-modelchip">
              {model.displayName}
              <span className="fy-mono">{modelCapabilityCopy(model)}</span>
            </span>
          )}
          <span className="fy-h1row__push" />
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}>
            Generate…
          </Button>
        </div>
      </div>
      <div className="fy-gen__center">
        {take ? (
          <>
            <div className="fy-gen__meta">
              <span className="fy-mono">
                take {takes.indexOf(take) + 1} · {take.model} · {seconds(shot?.durationSec)}
                {take.completedAt ? ` · finished ${take.completedAt.slice(11, 16)}` : ""}
              </span>
              <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span className={`fy-dot fy-dot--${decisionTone(decisions[take.id])}`} />
                <span className="fy-mono">{decisions[take.id] ?? "pending"}</span>
              </span>
            </div>
            <div className="fy-viewer">
              <Portrait
                worldSlug={slug}
                path={takeMediaPath(production!.meta.id, take) ?? ""}
                label={`Take: first frame`}
                radius={0}
              />
              <span className="fy-playbtn" aria-hidden style={{ pointerEvents: "none" }}>
                <Play size={22} />
              </span>
            </div>
            <div className="fy-scrub">
              <span className="fy-mono">0:00</span>
              <div className="fy-scrub__bar">
                <div className="fy-scrub__fill" style={{ width: "0%" }} />
              </div>
              <span className="fy-mono">{seconds(shot?.durationSec)}</span>
            </div>
            <div className="fy-gen__verdict">
              <Button
                variant="primary"
                disabled={!shotId || decisions[take.id] === "accepted"}
                onClick={() => worldId && prodId && shotId && acceptTake(worldId, prodId, take.id, shotId)}
              >
                Accept take
              </Button>
              <Button
                disabled={
                  Object.keys(take.provenance.sheets).length === 0 || decisions[take.id] === "rejected"
                }
                title="A rejection cites the sheet the take drifted from"
                onClick={() => {
                  const sheet = Object.keys(take.provenance.sheets)[0];
                  if (worldId && prodId && sheet)
                    rejectTake(
                      worldId,
                      prodId,
                      take.id,
                      { sheet, field: "appearance", note: "rejected in review" },
                      shotId ?? undefined,
                    );
                }}
              >
                Reject · cite the sheet
              </Button>
              <span className="fy-h1row__push" />
              <span className="fy-mono">rejections teach the shot · accepts lock the clip into the cut</span>
            </div>
          </>
        ) : (
          <EmptyState
            title="No takes for this shot yet"
            hint="Dispatch sends the shot out; takes land here for review."
          />
        )}
      </div>
      <div className="fy-gen__takes">
        <div className="fy-eyebrow-sm" style={{ textAlign: "center" }}>
          TAKES
        </div>
        {takes.map((t, i) => (
          <button
            key={t.id}
            type="button"
            className={cx("fy-taketile", take?.id === t.id && "fy-taketile--active")}
            onClick={() => setSelectedTakeId(t.id)}
          >
            <div className="fy-taketile__frame">
              <Portrait
                worldSlug={slug}
                path={takeMediaPath(production!.meta.id, t) ?? ""}
                label={`take ${i + 1}`}
                radius={0}
              />
            </div>
            <div className="fy-taketile__meta">
              <span>{i + 1}</span>
              <span
                className={`fy-dot fy-dot--${decisionTone(decisions[t.id])}`}
                style={{ width: 5, height: 5 }}
              />
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function GeneratePromptEditor({
  world,
  production,
  scene,
  shot,
  worldId,
  prodId,
}: {
  world: NonNullable<ReturnType<typeof useProduction>["world"]>;
  production: NonNullable<ReturnType<typeof useProduction>["production"]>;
  scene: Scene;
  shot: Shot;
  worldId: string;
  prodId: string;
}) {
  const style = production.meta.styleOverride?.trim() || world.artDirection.description;
  // Video previews stay capability-neutral so generated spatial/anchor blocks cannot be saved
  // into an override and then repeated by whole-scene assembly. Stills only need the temporal gate.
  const capability = productionShape(production.meta).dispatchCapability === "image" ? "image" : undefined;
  const assembled = assemblePrompt(world.meta, world.sheets, scene, shot, style, undefined, capability);
  const current = promptFor(world.meta, world.sheets, scene, shot, style, undefined, capability);
  const stale = overrideStaleAgainst(shot, world.sheets);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current.text;
  return (
    <>
      <div className="fy-gen__label" style={{ marginTop: 16 }}>
        Prompt{" "}
        <span className="fy-mono">
          {shot.promptOverride
            ? "edited for this shot"
            : `assembled from ${production.meta.styleOverride?.trim() ? "the production and world" : "the world"}, edit freely`}
        </span>
        <span
          style={{
            marginLeft: "auto",
            font: "400 11px var(--font-sans)",
            color: "var(--muted-foreground)",
            cursor: "pointer",
          }}
          onClick={() => {
            const stem = sceneFileOf(production, scene);
            if (!stem) return;
            setPromptOverride(worldId, prodId, stem, shot.id, null);
            setDraft(null);
          }}
        >
          Reset
        </span>
      </div>
      {stale.length > 0 && (
        <Callout tone="warning" title="This override no longer reflects the world">
          {stale.map((s) => `${s.sheetId} moved v${s.from} → v${s.to}`).join(" · ")}
        </Callout>
      )}
      <Textarea
        key={shot.id}
        value={value}
        onChange={(e) => setDraft(e.target.value)}
        style={{ minHeight: 120, font: "400 12.5px/1.65 var(--font-sans)" }}
      />
      {/* What the planner composes, the planner keeps (SPEC-019 R-3, R-13, D3/D4). An override
          replaces the body above and nothing else: the binding preamble and the negatives are
          added at dispatch, and a user debugging drifted identity or burned-in titles needs to
          see that they exist. The preamble's real text needs a chosen model — it names the
          images that model's budget actually carries — so it is described here and shown in
          full where the plan exists. */}
      <div
        style={{
          marginTop: 8,
          padding: "8px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          font: "400 11.5px/1.6 var(--font-sans)",
          color: "var(--muted-foreground)",
        }}
      >
        Added at dispatch, not editable here: a numbered line per reference image naming its subject and what
        it references, and — for video — <span className="fy-mono">no subtitles</span>
        {shot.audio?.kind === "silence" ? (
          <>
            {" "}
            and <span className="fy-mono">no audio</span>
          </>
        ) : (
          <>
            {" "}
            (plus <span className="fy-mono">no background music</span> where the cut carries its own score)
          </>
        )}
        .
      </div>
      {/* "Save override" says the edit is this shot's alone — the legend that repeated it is gone (design 54). */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
        <span className="fy-h1row__push" />
        <Button
          disabled={value.trim() === assembled || value.trim().length === 0}
          onClick={() => {
            const stem = sceneFileOf(production, scene);
            if (!stem) return;
            setPromptOverride(worldId, prodId, stem, shot.id, value.trim());
            setDraft(null);
          }}
        >
          Save override
        </Button>
      </div>
    </>
  );
}

// ---- Dispatch + voice-line dialogs ----------------------------------------

/**
 * The production's durable dispatch plans (SPEC-024): folded server-side from disk and the
 * queue, requested on mount and refreshed by push — never a timer. Blocked and awaiting states
 * are named, and the awaits are buttons, because they are the user's acts by definition.
 */
function PlansPanel({ worldId, prodId }: { worldId: string; prodId: string }) {
  const [states, setStates] = useState<PlanState[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  useEffect(() => {
    // A fresh production starts from nothing — keeping the previous production's states showed
    // A's plans gating B until B's first event arrived.
    setStates(null);
    setRefused(null);
    const offStates = subscribePlanStates((event) => {
      if (event.productionId === prodId) setStates(event.states);
    });
    // A refused plan creation must be visible where the buttons live: the coordinator answers
    // with production.plan-result, and a failure nobody renders is a button that fails silently.
    const offResults = subscribePlanResults((event) => {
      if (event.productionId !== prodId) return;
      // A later successful creation clears the warning — a refusal callout standing over a
      // live, healthy plan asserts two contradictory things at once.
      setRefused(event.disposition === "failed" ? (event.reason ?? "the plan could not be created") : null);
    });
    listPlans(worldId, prodId);
    return () => {
      offStates();
      offResults();
    };
  }, [worldId, prodId]);
  if ((!states || states.length === 0) && refused === null) return null;
  const passLine = (state: PlanState, pass: PlanState["passes"][number]): string => {
    const label = `pass ${pass.passIndex}`;
    if (pass.state === "blocked") return `${label} · blocked — ${pass.reason ?? "extraction failed"}`;
    if (pass.state === "failed") return `${label} · failed — ${pass.reason ?? "the job failed"}`;
    if (pass.state === "halted") return `${label} · will not run — ${pass.reason ?? state.haltReason ?? ""}`;
    return `${label} · ${pass.state}`;
  };
  return (
    <div style={{ marginTop: 14 }}>
      <div className="fy-listhead">Plans</div>
      {refused !== null && (
        <Callout tone="warning" title="Plan refused">
          {refused}
        </Callout>
      )}
      {(states ?? []).map((state) => (
        <div key={state.planId} className="fy-boardcard" style={{ marginTop: 8 }}>
          <div className="fy-boardcard__head">
            {state.policy === "review-gated" ? "Review-gated" : "Pre-authorized"} · {state.status} · cap{" "}
            {usd(state.capMicroUsd)}
          </div>
          <div className="fy-boardcard__mono">
            {state.passes.map((pass) => (
              <span key={pass.passIndex}>
                {passLine(state, pass)}
                {"\n"}
              </span>
            ))}
            {state.haltReason !== undefined && `halted: ${state.haltReason}`}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {state.next.kind === "await-continue" && (
              <Button
                variant="primary"
                onClick={() =>
                  planContinue(worldId, prodId, state.planId, (state.next as { passIndex: number }).passIndex)
                }
              >
                Continue · pass {state.next.passIndex} ·{" "}
                {usd(state.passes[state.next.passIndex]?.estimatedMicroUsd ?? 0)}
              </Button>
            )}
            {state.next.kind === "await-reconfirm" && (
              <Button
                variant="primary"
                onClick={() =>
                  planReconfirm(
                    worldId,
                    prodId,
                    state.planId,
                    (state.next as { passIndex: number }).passIndex,
                  )
                }
              >
                Reconfirm · pass {state.next.passIndex} runs past the {usd(state.capMicroUsd)} cap
              </Button>
            )}
            {state.status !== "completed" && state.status !== "cancelled" && (
              <Button variant="ghost" onClick={() => planCancel(worldId, prodId, state.planId)}>
                Cancel plan
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Generate scene, as a drawer over the work (design turn 102).
 *
 * The model and what it will cost, one button, and one way into everything else. The scene stays
 * behind it: spending is a moment in the middle of the work rather than a place you travel to,
 * which is what the plan screen made it for two turns. `Generation options` opens the dispatch
 * dialog — every strategy, every route, every retry unit — which is now the Advanced door rather
 * than the way through.
 */
function GenerateDrawer({
  worldId,
  prodId,
  scene,
  onClose,
}: {
  worldId: string;
  prodId: string;
  scene: Scene;
  onClose: () => void;
}) {
  const { world, production } = useProduction(worldId, prodId);
  const { state } = useStore();
  const navigate = useNavigate();
  const capability = production ? productionShape(production.meta).dispatchCapability : "video";
  const resolved = resolveModel(state, capability);
  const model = resolved.stranded === null ? resolved.model : null;
  // The same function the coordinator executes, on the same inputs (issue 244) — so the number
  // under the button is the number that will be spent, not a summary of one.
  const plan = useMemo(
    () =>
      world && production && model ? planForScene({ world, production, scene, model }, "whole-scene") : null,
    [world, production, scene, model],
  );
  const shots = scene.shots.length;
  const totalSec = scene.shots.reduce((sum, sh) => sum + (sh.durationSec ?? DEFAULT_SHOT_SEC), 0);
  return (
    <aside className="fy-gendrawer" data-drawer="generate">
      <div className="fy-gendrawer__head">
        <span className="fy-gendrawer__title">Generate scene</span>
        <span style={{ flex: 1 }} />
        <button type="button" className="fy-linkbtn" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="fy-gendrawer__body">
        <div className="fy-gendrawer__card">
          <div className="fy-gendrawer__model">{model?.displayName ?? "No model available"}</div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10 }}>
            <span className="fy-mono">ESTIMATED</span>
            <span className="fy-gendrawer__cost">
              {plan ? usd(plan.wholeScene.totalEstimatedMicroUsd) : "—"}
            </span>
          </div>
          <div className="fy-mono" style={{ marginTop: 6 }}>
            {shots} shot{shots === 1 ? "" : "s"} · {seconds(totalSec)} · attempt one
          </div>
        </div>
        <Button
          variant="primary"
          disabled={!plan}
          onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}
        >
          Generate
        </Button>
        {/* Layer three, behind its own door. Until the drawer can dispatch on its own, this is
            also where Generate goes — the dialog is the thing that spends, and sending somebody
            to a button they have already pressed would be worse than one more press. */}
        <button
          type="button"
          className="fy-gendrawer__more"
          onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}
        >
          Generation options
          <ChevronRight size={13} />
        </button>
        <span style={{ flex: 1 }} />
        <div className="fy-mono">retakes bill separately</div>
      </div>
    </aside>
  );
}

/**
 * Who rides, and who rides in a look (design 67).
 *
 * `refs ×3` said how many images travel and nothing about what they are — so the one decision a
 * production makes about a character's appearance reached the model without ever appearing on the
 * screen that authorises the spend. A look attached on the character's page changed the request
 * silently, and the only way to find out was to read the take that came back.
 *
 * Subjects are named once each; the count beside it still says how many images that is, which is
 * the other fact, and a subject carrying two references is one subject either way.
 */
export function carriedSubjects(references: readonly CompiledReference[]): string {
  // Keyed by sheet, displayed by name. Two sheets can carry one name — creation uniquifies the
  // slug, never the name — and keying by the name merged them into one entry whose `(look)`
  // could then belong to the other person entirely. Naming who rides is the whole point here.
  const subjects = new Map<string, { subject: string; look: boolean }>();
  for (const reference of references) {
    const held = subjects.get(reference.sheetId);
    subjects.set(reference.sheetId, {
      subject: reference.subject,
      look: (held?.look ?? false) || reference.mode === "scoped-look",
    });
  }
  return [...subjects.values()]
    .map((entry) => (entry.look ? `${entry.subject} (look)` : entry.subject))
    .join(", ");
}

/**
 * One pass, said as the dispatch it is: route, what rides, length, price.
 *
 * Module-level and pure, so the line can be read back in a test rather than re-spelled there —
 * a second copy of this format would be a second answer to what the dispatch is.
 */
export function passRow(pass: CompiledPass): string {
  const route =
    pass.route.kind === "frame"
      ? "first-frame route"
      : pass.route.kind === "reference"
        ? `reference route · refs ×${pass.references.length} · ${carriedSubjects(pass.references)}`
        : "text route";
  const length = pass.askedSec !== undefined ? ` · ${seconds(pass.askedSec)}` : "";
  return `${route}${length} · ${usd(pass.estimatedMicroUsd)}`;
}

export function DispatchDialogScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { state } = useStore();
  const navigate = useNavigate();
  const capability = production ? productionShape(production.meta).dispatchCapability : "video";
  const [sceneIdx, setSceneIdx] = useState(0);
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier; resolution?: string }>({});
  const scene = production?.scenes[sceneIdx] ?? null;
  // One resolver for the bar and its host, so the dialog cannot show one model and dispatch
  // another. Planning from every manifest row let a switched-off model be enqueued from the mode
  // buttons while the bar said UNAVAILABLE; stranded now means the cards stay away entirely,
  // because spending on a model the user never chose is worse than not dispatching.
  const resolved = resolveModel(state, capability, choice.modelId);
  const model = resolved.stranded === null ? resolved.model : null;
  // Video dispatch is sized by the provider's own word; stills by real dimensions, which the
  // plan derives from the tier. Both travel from here so the dialog and the job agree.
  const resolution =
    choice.resolution ??
    (model && choice.tier !== undefined ? nativeResolution(model, choice.tier) : undefined);

  // The whole plan, computed live from the world — the same function the coordinator executes.
  const plans = useMemo(() => {
    if (!world || !production || !scene || !model) return null;
    // The assembly moved to `planForScene` (turn 102): turn 102's drawer needs the same number
    // under a much smaller button, and two copies of it would be two answers to what this costs.
    return planForScene({
      world,
      production,
      scene,
      model,
      ...(resolution !== undefined ? { resolution } : {}),
      ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    });
  }, [world, production, scene, model, resolution, choice.tier]);

  // The compiled passes (issue 398): the same object the coordinator maps into queue requests,
  // so the rows below ARE the dispatch — route, length, references, estimate — not a summary
  // that can drift from it. Compilation refuses what dispatch would refuse; the warning rows
  // already say why, so a refusal here just leaves no rows to show.
  const compiled = useMemo(() => {
    if (!world || !production || !scene || !model || !plans) return null;
    const compile = (plan: typeof plans.perShot, chainWholeSceneFrames = false) => {
      try {
        return compilePasses({
          productionId: production.meta.id,
          scene,
          plan,
          model,
          world,
          chainWholeSceneFrames,
        });
      } catch {
        return null;
      }
    };
    return {
      perShot: compile(plans.perShot),
      wholeScene: compile(plans.wholeScene),
      // What the durable plan will actually authorize (SPEC-024): the server compiles the
      // continuity chain, so the plan buttons must price the chained passes, not the plain ones.
      chained: compile(plans.wholeScene, true),
    };
  }, [world, production, scene, model, plans]);
  const sceneFile = scene ? sceneFileOf(production, scene) : null;
  const warnings = plans?.perShot.warnings ?? null;
  // A shot no route can cover blocks rather than warns: the dispatch would be refused anyway,
  // and finding that out after pressing a priced button is the failure this dialog exists to
  // prevent. Named per shot, with the length that would fit.
  const overlong = plans?.perShot.warnings.overlongShots ?? [];
  const overlongPasses = plans?.wholeScene.warnings.overlongPasses ?? [];
  const warningRows: Array<{ key: string; text: string }> = [];
  if (warnings) {
    for (const s of warnings.shotsWithoutFrame)
      warningRows.push({ key: `nf-${s.shotId}`, text: `shot ${s.number} has no accepted frame` });
    // Issue 154: strict frame behaviour is promised exactly where the route receives it — the
    // shot opens on its durable boundary still, and the references that stepped aside are named.
    for (const f of warnings.framedShots)
      warningRows.push({
        key: `bf-${f.shotId}`,
        text: `shot ${f.number} opens on its boundary frame${
          f.setAside.length > 0
            ? ` — ${f.setAside.join(", ")} step aside, the frame route takes one image`
            : ""
        }`,
      });
    for (const f of warnings.staleFrames)
      warningRows.push({
        key: `sf-${f.shotId}`,
        text: `shot ${f.number}'s start frame is unusable: ${f.detail} — this blocks dispatch`,
      });
    // Issue 389: an impossible delivery shape refuses, consistently — composition throws the
    // same refusal server-side, so this row is the dialog saying it first.
    if (warnings.aspectUnsupported) {
      const a = warnings.aspectUnsupported;
      warningRows.push({
        key: "aspect",
        text: `${a.model} cannot deliver ${a.aspect} — it offers ${a.supported.join(", ")} — this blocks dispatch`,
      });
    }
    for (const name of warnings.sketchCitations)
      warningRows.push({ key: `sk-${name}`, text: `${name} is a sketch — dispatch cites an unlocked sheet` });
    for (const d of warnings.droppedReferences) {
      warningRows.push({
        key: `dr-${d.sheetId}-${d.referenceRole ?? "primary"}`,
        text:
          d.referenceRole === "secondary"
            ? `${d.sheetId}'s main photo is dropped — its character sheet still travels`
            : `${d.sheetId}'s reference is dropped — over the model's cap`,
      });
    }
    for (const g of warnings.staleModelSheets) warningRows.push({ key: `st-${g}`, text: g });
    for (const name of warnings.retiredCitations)
      warningRows.push({ key: `re-${name}`, text: `${name} is retired and still cited here` });
    for (const u of warnings.unknownMentions)
      warningRows.push({ key: `un-${u}`, text: `@${u} resolves to nothing — check the description` });
    // SPEC-020 R-6: the mention resolved, and the sheet belongs to another production. Named,
    // never blocked — borrowing somebody else's one-off is unusual, not wrong.
    for (const g of warnings.foreignGuests)
      warningRows.push({
        key: `fg-${g.name}`,
        text: `${g.name} belongs to ${g.owner}, not to this production`,
      });
    for (const o of warnings.overriddenStale)
      warningRows.push({
        key: `ov-${o.shotId}`,
        text: `shot ${o.number}'s prompt is overridden and ${o.against.map((a) => `${a.sheetId} moved v${a.from}→v${a.to}`).join(", ")} — the override will not pick that up`,
      });
    // SPEC-019 R-42: subjects past the model's reliable range are carried anyway and said so —
    // dropping a character the user wrote into the shot is the worse failure.
    if (warnings.subjectsOverRange) {
      warningRows.push({
        key: "subjects",
        text: `${warnings.subjectsOverRange.carried} subjects is past the ${warnings.subjectsOverRange.reliableTo} this model holds apart reliably — all are carried, and the take may be less stable`,
      });
    }
    // SPEC-019 R-21: the routed model can be overridden per dispatch, long after the scene was
    // drafted. Named rather than blocking — the shots are still shots, they were just written to
    // another family's conventions, and only the user knows whether that matters here.
    if (warnings.skillFamilyMismatch) {
      const { draftedFor, dispatchingTo } = warnings.skillFamilyMismatch;
      warningRows.push({
        key: "skill-family",
        text:
          dispatchingTo === null
            ? `these shots were drafted for ${draftedFor}; ${model?.displayName ?? "this model"} declares no family, so that guidance may not apply`
            : `these shots were drafted for ${draftedFor} and this dispatch goes to ${dispatchingTo}`,
      });
    }
  }

  return (
    <div className="fy-dialogwrap" data-screen="dispatch-dialog">
      <div className="fy-dialog">
        <div className="fy-h1row">
          <h1 className="fy-h1" style={{ fontSize: 22 }}>
            Dispatch
          </h1>
          {scene && (
            <span className="fy-h1row__meta">
              {scene.title} · {scene.shots.length} shots ·{" "}
              {seconds(scene.shots.reduce((s, x) => s + (x.durationSec ?? 4), 0))}
            </span>
          )}
          <span className="fy-h1row__push" />
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
            Close
          </Button>
        </div>
        <div className="fy-choicerow">
          {(production?.scenes ?? []).map((s, i) => (
            <Button
              key={s.id}
              variant={i === sceneIdx ? "primary" : "secondary"}
              onClick={() => setSceneIdx(i)}
            >
              {s.title}
            </Button>
          ))}
        </div>
        {/* SPEC-019 R-43, D37: the one condition here that is not merely named. A payload over
            the transport's ceiling is a request the client already refuses, so committing it
            would buy a certain failure — the dispatch buttons go away rather than warn. */}
        {plans?.perShot.warnings.payloadOverflow && (
          <Callout tone="danger" title="Too much to send">
            {plans.perShot.warnings.payloadOverflow.notice}
          </Callout>
        )}
        {/* SPEC-019 R-26: which pictures steer this dispatch, and why. Stated, never offered as a
            choice — storyboard input is loose where keyframe input aligns, and knowing which is
            stricter should not be a prerequisite for getting the better one. When neither is
            available the statement carries both reasons, including a stale board's redraw (R-27). */}
        {plans && (
          <Callout
            tone={plans.perShot.steering.mode === "none" ? "warning" : undefined}
            title={
              plans.perShot.steering.mode === "keyframes"
                ? "Steered by keyframes"
                : plans.perShot.steering.mode === "storyboard"
                  ? "Steered by the storyboard"
                  : "No reference images steer this scene"
            }
          >
            {plans.perShot.steering.statement}
          </Callout>
        )}
        {world && production && model && (
          <Callout
            title={
              production.meta.styleOverride?.trim()
                ? "Production look"
                : `World look · v${world.artDirection.version}`
            }
          >
            {production.meta.styleOverride?.trim()
              ? `This production overrides the world look with “${production.meta.styleOverride.trim()}”. It is carried by assembled prompts; a full shot prompt override keeps its own text. `
              : "Inherited from this world and carried in the prompt. "}
            {model.accepts.referenceImages === 0
              ? `${model.displayName} accepts no reference images. Those images are omitted; only existing sheet descriptions and art-direction text remain.`
              : "Identity references remain distinct from the visual style treatment."}
          </Callout>
        )}
        {/* Controls only: the two mode cards below each carry their own estimate, computed from
            the same plan the coordinator executes, and one figure up here could disagree with
            them. Size speaks the video vocabulary — 720p is what this surface means. */}
        <DispatchBar
          variant="controls"
          capability={capability}
          workflow="main-photo"
          choice={choice}
          onChoice={setChoice}
        />
        {(overlong.length > 0 || overlongPasses.length > 0) && (
          <Callout tone="warning" title="Too long for this model">
            <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
              {overlong.map((shot) => (
                <li key={shot.shotId}>
                  shot {shot.number} runs {seconds(shot.durationSec)} — {model?.displayName ?? "this model"}{" "}
                  makes at most {seconds(shot.longestSec)}
                  {shot.becauseReferences ? " on the reference route this shot will take" : ""}. Shorten the
                  shot, split it, or pick another model.
                </li>
              ))}
              {overlongPasses.map((pass) => (
                <li key={`pass-${pass.passIndex}`}>
                  scene pass {pass.passIndex} runs {seconds(pass.durationSec)} — the longest this route makes
                  is {seconds(pass.longestSec)}
                  {pass.becauseReferences ? ", because the pass carries references" : ""}.
                </li>
              ))}
            </ul>
          </Callout>
        )}
        {warningRows.length > 0 ? (
          <Callout
            tone="warning"
            title={`${warningRows.length} thing${warningRows.length === 1 ? "" : "s"} worth knowing — none blocks`}
          >
            <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
              {warningRows.map((w) => (
                <li key={w.key}>{w.text}</li>
              ))}
            </ul>
          </Callout>
        ) : (
          plans && (
            <Callout title="Clean dispatch">
              Every cited sheet is locked and current; every reference rides.
            </Callout>
          )
        )}
        {/* The bar says which model and why it cannot run; this says what that costs you here,
            rather than leaving the two dispatch cards to vanish without explanation. */}
        {!model && (
          <Callout tone="warning" title="Nothing to dispatch with">
            The model this production is set to cannot run. Pick one above, or fix it in Settings — nothing is
            re-routed for you.
          </Callout>
        )}
        {plans && overlong.length === 0 && !plans.perShot.warnings.payloadOverflow && (
          <div style={{ display: "flex", gap: 14 }}>
            <div className="fy-boardcard" style={{ flex: 1 }}>
              <div className="fy-boardcard__head">Per shot</div>
              <div className="fy-boardcard__body">
                One clip per shot, each seeded by its own frame. Any shot retries alone; cast stays pinned per
                shot.
              </div>
              <div className="fy-boardcard__mono">
                est. {usd(plans.perShot.totalEstimatedMicroUsd)}
                {compiled?.perShot?.map((pass) => (
                  <span key={pass.target.coversShots.join("-")}>
                    {"\n"}
                    {pass.target.kind === "shot"
                      ? `shot ${pass.target.coversShots[0]!.replace("sh_", "")}`
                      : "pass"}{" "}
                    · {passRow(pass)}
                  </span>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (worldId && prodId && sceneFile && model) {
                      dispatchScene(
                        worldId,
                        prodId,
                        sceneFile,
                        "per-shot",
                        model.id,
                        resolution,
                        choice.tier,
                      );
                      navigate(`/w/${worldId}/p/${prodId}/generate`);
                    }
                  }}
                >
                  Dispatch per shot · {usd(plans.perShot.totalEstimatedMicroUsd)}
                </Button>
              </div>
            </div>
            <div className="fy-boardcard" style={{ flex: 1 }}>
              <div className="fy-boardcard__head">Whole scene</div>
              <div className="fy-boardcard__body">
                Best motion continuity — but a retry re-runs its whole pass.
              </div>
              {plans.wholeScene.pack.ok && overlongPasses.length > 0 ? (
                <div className="fy-boardcard__body" style={{ color: "var(--destructive)" }}>
                  pass {overlongPasses[0]!.passIndex} runs {seconds(overlongPasses[0]!.durationSec)} — the
                  longest this route makes is {seconds(overlongPasses[0]!.longestSec)}
                  {overlongPasses[0]!.becauseReferences ? ", because the pass carries references" : ""}.
                  Shorten a shot or pick another model.
                </div>
              ) : plans.wholeScene.pack.ok ? (
                <>
                  <div className="fy-boardcard__mono">
                    {plans.wholeScene.pack.passes.length} pass
                    {plans.wholeScene.pack.passes.length === 1 ? "" : "es"} under the{" "}
                    {model!.limits.maxDurationSec ?? "∞"}s cap
                    {plans.wholeScene.pack.passes.map((p, i) => (
                      <span key={p.index}>
                        {"\n"}pass {p.index} · shots {p.plan.map((e) => e.number).join(", ")}
                        {compiled?.wholeScene?.[i]
                          ? ` · ${passRow(compiled.wholeScene[i]!)}`
                          : ` · ${seconds(p.durationSec)}`}
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <Button
                      variant="primary"
                      onClick={() => {
                        if (worldId && prodId && sceneFile && model) {
                          dispatchScene(
                            worldId,
                            prodId,
                            sceneFile,
                            "whole-scene",
                            model.id,
                            resolution,
                            choice.tier,
                          );
                          navigate(`/w/${worldId}/p/${prodId}/generate`);
                        }
                      }}
                    >
                      Dispatch whole scene · {usd(plans.wholeScene.totalEstimatedMicroUsd)}
                    </Button>
                    {/* SPEC-024: a plan chains each pass behind the previous pass's boundary
                        frame — offered exactly where a route exists to receive one, priced from
                        the CHAINED compile, because that is what the plan authorizes. */}
                    {model &&
                      frameDispatchFor(model, 1) !== null &&
                      plans.wholeScene.pack.passes.length > 1 &&
                      compiled?.chained && (
                        <>
                          <div className="fy-boardcard__mono">
                            {compiled.chained.map((pass, i) => (
                              <span key={pass.target.coversShots.join("-")}>
                                {"\n"}plan pass {i} · {passRow(pass)}
                              </span>
                            ))}
                          </div>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              if (worldId && prodId && sceneFile && model) {
                                dispatchScenePlanned(
                                  worldId,
                                  prodId,
                                  sceneFile,
                                  "whole-scene",
                                  model.id,
                                  "review-gated",
                                  resolution,
                                  choice.tier,
                                );
                              }
                            }}
                          >
                            Plan · continuity chain · ask before each pass
                          </Button>
                          <Button
                            variant="ghost"
                            onClick={() => {
                              if (worldId && prodId && sceneFile && model) {
                                dispatchScenePlanned(
                                  worldId,
                                  prodId,
                                  sceneFile,
                                  "whole-scene",
                                  model.id,
                                  "pre-authorized",
                                  resolution,
                                  choice.tier,
                                );
                              }
                            }}
                          >
                            Plan · continuity chain · pre-authorize{" "}
                            {usd(compiled.chained.reduce((sum, pass) => sum + pass.estimatedMicroUsd, 0))}
                          </Button>
                        </>
                      )}
                  </div>
                </>
              ) : (
                <Callout tone="warning" title="Whole-scene unavailable">
                  shot {plans.wholeScene.pack.oversizeShot.number} runs{" "}
                  {plans.wholeScene.pack.oversizeShot.durationSec}s — longer than the{" "}
                  {plans.wholeScene.pack.oversizeShot.capSec}s cap, and half a shot cannot be reviewed.
                </Callout>
              )}
            </div>
          </div>
        )}
        {worldId && prodId && <PlansPanel worldId={worldId} prodId={prodId} />}
      </div>
    </div>
  );
}

export function VoiceLineDialogScreen() {
  const { worldId, prodId } = useParams();
  const [params] = useSearchParams();
  const { world, production } = useProduction(worldId, prodId);
  const clientState = useStore().state;
  const navigate = useNavigate();
  const spoken =
    production?.scenes.flatMap((s) => s.shots).filter((s) => s.audio?.line && s.audio.speaker) ?? [];
  // The shot the row asked for. Without this the dialog showed whichever line came first, so
  // pressing Generate beside one character opened another character's line.
  const asked = params.get("shot");
  const shot = spoken.find((s) => s.id === asked) ?? spoken[0];
  const speaker = shot?.audio?.speaker ? world?.sheets.find((c) => c.id === shot.audio!.speaker) : undefined;
  const voiceModel = speaker?.voice
    ? clientState?.app.manifest?.models.find(
        (model) =>
          model.provider === speaker.voice!.provider &&
          model.capability === "voice-tts" &&
          model.id ===
            (speaker.voice!.model ??
              legacyVoiceModel(speaker.voice!.provider, speaker.voice!.voiceId, world?.clonedVoices ?? [])),
      )
    : undefined;
  const voiceDeliveries = supportedDeliveries(voiceModel);
  const voiceReadiness =
    speaker?.voice && voiceModel?.provider === "comfyui"
      ? clientState?.app.comfyui?.recipes.find((recipe) => recipe.recipeId === voiceModel.id)
      : null;
  const voiceUnavailableReason =
    voiceReadiness?.state === "disabled" ||
    (voiceReadiness?.state === "unknown" && clientState?.app.comfyui?.engine.locality === "local")
      ? (voiceReadiness.reason ?? "The assigned voice recipe is not ready.")
      : voiceModel === undefined && speaker?.voice
        ? "The assigned voice model is no longer available."
        : null;
  const [sending, setSending] = useState(false);
  const [delivery, setDelivery] = useState<Delivery | "">("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    destinationLabel: string;
    confirmationToken: string;
  } | null>(null);
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pending.current) return;
        pending.current = null;
        setSending(false);
        if (result.disposition === "accepted") navigate(`/w/${worldId}/p/${prodId}/audio`);
        else setRefusal(result.failures[0]?.reason ?? "The line could not be queued.");
      }),
    [navigate, worldId, prodId],
  );
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== pending.current) return;
        setUploadConfirmation(confirmation);
      }),
    [],
  );
  const generateLine = (voiceUploadConfirmedFor?: string) => {
    if (!worldId || !prodId || !shot) return;
    setRefusal(null);
    setSending(true);
    pending.current = requestVoiceLine({
      worldId,
      productionId: prodId,
      shotId: shot.id,
      ...(delivery ? { delivery } : {}),
      ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
    });
  };
  return (
    <div className="fy-dialogwrap" data-screen="voice-line-dialog">
      <div className="fy-dialog" style={{ maxWidth: 560 }}>
        <div className="fy-h1row">
          <h1 className="fy-h1" style={{ fontSize: 22 }}>
            Voice line
          </h1>
          <span className="fy-h1row__push" />
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
            Close
          </Button>
        </div>
        <DegradedBanner component="voice" />
        {shot && speaker ? (
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div style={{ width: 56, height: 64, flex: "none" }}>
              <Portrait
                worldSlug={world?.meta.slug}
                path={sheetPortraitPath(speaker.id)}
                label={speaker.name}
                radius={8}
              />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ font: "600 14px var(--font-sans)" }}>{speaker.name}</div>
              <div
                style={{
                  font: "400 13px/1.5 var(--font-sans)",
                  color: "var(--muted-foreground)",
                  fontStyle: "italic",
                  marginTop: 2,
                }}
              >
                “{shot.audio!.line}”
              </div>
              <div className="fy-mono" style={{ marginTop: 4 }}>
                {`voice · ${speaker.voice ? `${speaker.voice.label ?? speaker.voice.voiceId} (${speaker.voice.provider})` : "none assigned"}`}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="No spoken lines in this production yet" />
        )}
        {refusal !== null && <p className="fy-refusal">{refusal}</p>}
        {voiceUnavailableReason !== null && (
          <p className="fy-refusal">Assigned voice unavailable · {voiceUnavailableReason}</p>
        )}
        {speaker?.voice &&
          (voiceDeliveries.length > 0 ? (
            <select
              aria-label="Delivery"
              className="fy-bench__chip"
              value={delivery}
              onChange={(event) => setDelivery(event.target.value as Delivery | "")}
            >
              <option value="">delivery · default</option>
              {DELIVERIES.filter((item) => voiceDeliveries.includes(item)).map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          ) : (
            <span className="fy-mono">delivery · provider default only</span>
          ))}
        <div>
          <Button
            variant="primary"
            data-testid="voice-line-generate"
            disabled={
              shot === undefined ||
              speaker === undefined ||
              speaker.voice === undefined ||
              voiceUnavailableReason !== null ||
              sending
            }
            title={
              speaker !== undefined && speaker.voice === undefined
                ? `${speaker.name} has no assigned voice — choose one on their sheet`
                : (voiceUnavailableReason ?? undefined)
            }
            onClick={() => generateLine()}
          >
            {sending ? "Generating…" : "Generate line"}
          </Button>
        </div>
        {uploadConfirmation && (
          <RemoteVoiceUploadConfirmation
            destinationLabel={uploadConfirmation.destinationLabel}
            onCancel={() => {
              pending.current = null;
              setSending(false);
              setUploadConfirmation(null);
            }}
            onConfirm={() => {
              const token = uploadConfirmation.confirmationToken;
              setUploadConfirmation(null);
              generateLine(token);
            }}
          />
        )}
      </div>
    </div>
  );
}

// ---- Cut (24a) -------------------------------------------------------------

/** A tenth of a second: editorial rather than per-frame, and it lands on a frame at 10/20/30fps. */
const TRIM_STEP_SEC = 0.1;

/**
 * The cut, watchable (24a's "Watch from top", finally doing something).
 *
 * One `<video>` walked across the derived spans rather than a clip per element: the cut plays one
 * piece of picture at a time by construction, and a span that has nothing to show says so instead
 * of holding the previous frame.
 */
/** What a dropped artifact covers when nothing says otherwise: about a shot's worth. */
const CLIP_DEFAULT_SEC = 4;

/** One lane row plus the gap under it, which is what a drag has to cross to change lane. */
const LANE_PITCH_PX = 50;

/** The clip menu's own box, so a right-click near an edge opens somewhere it can be read. */
const CLIP_MENU_WIDTH_PX = 216;
const CLIP_MENU_HEIGHT_PX = 96;

/**
 * The world's artifacts, beside the cut (82a).
 *
 * Rows are drag sources and nothing else — the panel never places anything itself, because a
 * placement needs a time and only the lane knows one.
 */
function ArtifactPanel({
  worldId,
  artifacts,
  slug,
}: {
  worldId: string | undefined;
  artifacts: readonly ArtifactSidecar[];
  slug: string | undefined;
}) {
  return (
    <div className="fy-artpanel">
      <div className="fy-artpanel__head">
        <span className="fy-artpanel__title">Artifacts</span>
        <span className="fy-mono">{artifacts.length}</span>
        <span className="fy-h1row__push" />
        <Button
          variant="outline"
          size="sm"
          disabled={worldId === undefined}
          onClick={() => worldId && uploadArtifacts(worldId)}
        >
          Upload
        </Button>
      </div>
      <div className="fy-artpanel__list">
        {artifacts.length === 0 ? (
          <span className="fy-artpanel__empty">nothing filed in this world yet</span>
        ) : (
          artifacts.map((a) => (
            <div
              key={a.id}
              className="fy-artrow"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData("application/x-arke-artifact", a.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <span className="fy-artrow__swatch">
                {a.kind === "image" ? <Portrait worldSlug={slug} path={a.file} label="" radius={4} /> : null}
              </span>
              <span className="fy-artrow__body">
                <span className="fy-artrow__name">{a.file.split("/").pop()}</span>
                <span className="fy-artrow__meta">{a.kind}</span>
              </span>
            </div>
          ))
        )}
      </div>
      <div className="fy-artpanel__foot">
        <span className="fy-dot" />
        <span className="fy-mono">drag onto a lane to place</span>
      </div>
    </div>
  );
}

/**
 * One placed clip, with the three gestures a clip has (lanes).
 *
 * The draft is local and the commit is on release, which is the same shape the trim gesture
 * already uses: a drag that wrote on every pointer move would file a hundred placements for one
 * movement of the hand, and every one of them would be a commit in the world's history.
 */
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
}) {
  const [draft, setDraft] = useState<ClipPlacement | null>(null);
  const shown = draft ?? { startSec: clip.startSec, endSec: clip.endSec, lane: clip.lane ?? 0 };

  const begin = (gesture: ClipGesture) => (e: React.PointerEvent) => {
    if (e.button !== 0 || totalSec <= 0) return;
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
      className={cx("fy-ovclip", sound && "fy-ovclip--sound", draft && "fy-ovclip--dragging")}
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
      onContextMenu={(e) => {
        e.preventDefault();
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
        onClick={() => removeOverlay(worldId, prodId, clip.id)}
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
function ClipLanes({
  worldId,
  prodId,
  slug,
  totalSec,
  clips,
  artifacts,
  snapPoints,
}: {
  worldId: string;
  prodId: string;
  slug: string | undefined;
  totalSec: number;
  clips: readonly CutOverlay[];
  artifacts: readonly ArtifactSidecar[];
  snapPoints: readonly number[];
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
      if (e.key === "Escape") close();
    };
    // Capture, so a press that a clip's own handler stops still closes the menu above it.
    window.addEventListener("pointerdown", close, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    // `position: fixed` is viewport-anchored, so a scroll detaches the menu from its clip.
    window.addEventListener("scroll", close, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", close, { capture: true });
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
    e.preventDefault();
    setOver(null);
    const artifactId = e.dataTransfer.getData("application/x-arke-artifact");
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
          <span className="fy-track__label">L{lane}</span>
          <div
            className={cx("fy-track__lane", "fy-ovlane", over === lane && "fy-ovlane--over")}
            onDragOver={(e) => {
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

/**
 * Seek by dragging the ruler (24a's "1:26 / 2:40" made reachable).
 *
 * Proportional rather than pixels-per-second: the ruler spans the whole cut whatever the window
 * is doing, so the fraction of its width is the fraction of the film — the same arithmetic the
 * player dock already scrubs by.
 */
function CutScrubber({ totalSec, transport }: { totalSec: number; transport: Transport }) {
  const { time, seek, setPlaying } = transport;
  const seekToEvent = (e: React.PointerEvent | PointerEvent, el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    if (box.width <= 0 || totalSec <= 0) return;
    seek(((e.clientX - box.left) / box.width) * totalSec);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    // Scrubbing while it runs fights the transport for the same value; stop, then seek.
    setPlaying(false);
    seekToEvent(e, el);
    const move = (ev: PointerEvent) => seekToEvent(ev, el);
    const up = (ev: PointerEvent) => {
      el.releasePointerCapture(ev.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowRight") seek(time + 1);
    else if (e.key === "ArrowLeft") seek(time - 1);
    else if (e.key === "Home") seek(0);
    else if (e.key === "End") seek(totalSec);
    else return;
    e.preventDefault();
  };
  return (
    <div
      className="fy-timeline__ruler fy-scrub"
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(totalSec)}
      aria-valuenow={Math.round(time)}
      aria-valuetext={clock(time)}
    >
      <span className="fy-mono">0:00</span>
      <span className="fy-h1row__push" />
      <span className="fy-mono">{clock(totalSec / 2)}</span>
      <span className="fy-h1row__push" />
      <span className="fy-mono">{clock(totalSec)}</span>
    </div>
  );
}

interface Transport {
  playing: boolean;
  time: number;
  timeRef: React.MutableRefObject<number>;
  setPlaying: React.Dispatch<React.SetStateAction<boolean>>;
  seek: (seconds: number) => void;
}

/**
 * One clock for the screen (24a): the preview shows it and the timeline draws it, so it cannot
 * live inside either. `timeRef` is the hot value the frame loops read; `time` is what renders.
 */
function useCutTransport(totalSec: number): Transport {
  const timeRef = useRef(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  /*
   * A film can get shorter underneath the playhead (issue 453).
   *
   * On the story and song clocks the duration is authored and changes only when somebody edits
   * the story, but a media-only film is measured from its clips — trim the one that reaches
   * furthest, drag it earlier or delete it and the end moves back. `seek` clamps, and nothing was
   * calling `seek`: the viewer sat at `0:14 / 0:05` over no span at all, blank and stuck, until
   * the person happened to scrub or press play.
   */
  useEffect(() => {
    if (timeRef.current <= totalSec) return;
    timeRef.current = totalSec;
    setTime(totalSec);
  }, [totalSec]);
  useTransport({
    playing,
    durationSec: totalSec,
    timeRef,
    onTime: setTime,
    onEnded: () => setPlaying(false),
  });
  const seek = useCallback(
    (seconds: number) => {
      const at = Math.min(Math.max(0, seconds), totalSec);
      timeRef.current = at;
      setTime(at);
    },
    [totalSec],
  );
  return { playing, time, timeRef, setPlaying, seek };
}

function CutPreview({
  slug,
  spans,
  totalSec,
  soundSec = 0,
  restartToken,
  transport,
}: {
  slug: string | undefined;
  spans: PlaybackSpan[];
  totalSec: number;
  /** How far placed sound reaches, so a film with no picture is not reported as nothing. */
  soundSec?: number;
  restartToken: number;
  transport: Transport;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const { playing, time, timeRef, setPlaying, seek } = transport;

  // "Watch from top" (24a): rewind and run, without remounting the element and refetching media.
  useEffect(() => {
    if (restartToken === 0) return;
    seek(0);
    setPlaying(true);
  }, [restartToken]);

  const srcFor = (span: PlaybackSpan | null) => (span?.path && slug ? mediaUrl(slug, span.path) : null);
  /*
   * A still needs an element that decodes images (issue 453).
   *
   * Everything the story and the song clocks produce is footage, so one `<video>` was always
   * enough. A placed clip can be a plate or a board, and a browser does not decode a PNG as
   * video — handing one to the video element shows nothing while the export holds that frame for
   * the whole placement. So the two are separated at the source: the video never receives a
   * still, and the still is drawn over it by an `<img>` wearing the same class.
   */
  const videoSrcFor = (span: PlaybackSpan | null) => (span?.still ? null : srcFor(span));
  const stillSrcFor = (span: PlaybackSpan | null) => (span?.still ? srcFor(span) : null);

  /*
   * The still is painted off the frame clock too, for the reason the video already is.
   *
   * `time` reaches React four times a second; the video source is switched every frame from
   * `timeRef`. Selecting the still from the throttled value would leave the old plate covering a
   * video that had already started, or the old video showing under a plate that had already
   * begun — a quarter second of the wrong picture at every boundary between the two, which is
   * exactly the mistake the video loop exists to avoid.
   */
  const stillEl = useRef<HTMLImageElement>(null);
  const paintStill = useCallback((span: PlaybackSpan | null) => {
    const img = stillEl.current;
    const el = video.current;
    const src = span?.still && slug && span.path ? mediaUrl(slug, span.path) : null;
    if (img !== null) {
      // Assigning an identical src would restart the decode every frame.
      if (src !== null && img.getAttribute("src") !== src) img.setAttribute("src", src);
      img.style.opacity = src === null ? "0" : "1";
    }
    if (el !== null) el.style.opacity = videoSrcFor(span) === null ? "0" : "1";
  }, [slug]);

  /*
   * The sync runs on its own frame loop off `timeRef`, not off `time`.
   *
   * The transport reports to React four times a second, which is right for the clock and wrong
   * for the picture: a shot boundary could be up to 250ms late, which is a quarter second of the
   * previous shot playing under the next one's label. The ref is current every frame.
   */
  useEffect(() => {
    const el = video.current;
    if (el === null || !playing) return;
    let frame = 0;
    onMediaReady(el, () => {});
    const loop = (ts: number) => {
      const at = timeRef.current;
      const span = spanAt(spans, at);
      syncMediaElement(el, {
        src: videoSrcFor(span),
        targetSec: span ? mediaTimeFor(span, at) : 0,
        playing: true,
        nowMs: ts,
      });
      paintStill(span);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, spans, slug, paintStill]);

  // Paused: one sync, so a seek lands on the right frame without a loop running. A source that
  // was not ready when it was asked calls back through onMediaReady, since nothing else will.
  useEffect(() => {
    const el = video.current;
    if (el === null || playing) return;
    const push = () => {
      const at = timeRef.current;
      const span = spanAt(spans, at);
      syncMediaElement(el, {
        src: videoSrcFor(span),
        targetSec: span ? mediaTimeFor(span, at) : 0,
        playing: false,
        nowMs: 0,
      });
      paintStill(span);
    };
    onMediaReady(el, push);
    push();
  }, [playing, time, spans, slug, timeRef, paintStill]);

  const current = spanAt(spans, time);
  /*
   * A film can run on sound alone (issue 453). Its length counts placed sound, so an audio-only
   * production has a real runtime and no picture at any second of it — and "nothing here yet" is
   * then simply false, said to somebody who has placed something and can see it on a lane.
   */
  const soundOnly = soundSec > 0 && spans.length === 0;
  const showingVideo = videoSrcFor(current);
  const showingStill = stillSrcFor(current);
  const showing = showingVideo ?? showingStill;

  return (
    <div className="fy-cutviewer">
      <video
        ref={video}
        className="fy-cutviewer__video"
        playsInline
        muted
        style={{ opacity: showingVideo === null ? 0 : 1 }}
      />
      {/*
        * Always mounted, never conditional: `paintStill` reaches it through the ref on the frame
        * clock, and an element that came and went with a throttled render could not be painted at
        * the moment the picture actually changes.
        */}
      <img
        ref={stillEl}
        className="fy-cutviewer__video"
        alt=""
        style={{ opacity: showingStill === null ? 0 : 1 }}
        {...(showingStill !== null ? { src: showingStill } : {})}
      />
      {showing === null && (
        <span className="fy-cutviewer__empty">
          {current ? current.label : soundOnly ? "sound only" : "nothing here yet"}
        </span>
      )}
      <button
        type="button"
        className="fy-playbtn"
        aria-label={playing ? "Pause" : "Play"}
        onClick={() => {
          if (!playing && timeRef.current >= totalSec) seek(0);
          setPlaying((p) => !p);
        }}
      >
        {playing ? <PauseSolid size={22} /> : <Play size={22} />}
      </button>
      <span className="fy-viewer__tag">
        {clock(time)} / {clock(totalSec)}
        {current ? ` · ${current.label}` : ""}
      </span>
    </div>
  );
}

/**
 * The one authored edit, shared by both clocks (80a, 81a).
 *
 * What differs between them is the figures — the song fixes a window and the story authors a
 * slot — so those arrive as text and everything else is identical, which is what "switching
 * between a short film and a music video must not move a single row" means in practice.
 */
function TrimStrip({
  worldId,
  prodId,
  shotId,
  heading,
  title,
  figures,
  trim,
  ceiling,
}: {
  worldId: string;
  prodId: string;
  shotId: string;
  heading: string;
  title: string;
  figures: string;
  trim: number;
  ceiling: ReturnType<typeof trimCeilingSec> | null;
}) {
  // Something must survive the trim, so the last whole step before the ceiling is the ceiling here.
  const maxTrim =
    ceiling?.ok && ceiling.ceilingSec !== undefined
      ? Math.max(0, ceiling.ceilingSec - TRIM_STEP_SEC)
      : undefined;
  const trimmable = ceiling?.ok === true;
  const commit = (next: number) => {
    if (next !== trim) setShotTrim(worldId, prodId, shotId, next);
  };
  const stepTrim = (delta: number) => {
    const wanted = Math.round((trim + delta) * 1000) / 1000;
    commit(Math.max(0, maxTrim === undefined ? wanted : Math.min(wanted, maxTrim)));
  };
  /*
   * Dragging the figure is the gesture; the steppers stay for precision and for a keyboard.
   * `pixelsPerSecond` is deliberately coarse -- the strip is not a timeline, so a drag across it
   * is worth a few seconds rather than the whole cut.
   */
  const drag = useScrubDrag({
    value: trim,
    pixelsPerSecond: 40,
    min: 0,
    ...(maxTrim !== undefined ? { max: maxTrim } : {}),
    onCommit: commit,
  });
  return (
    <div className="fy-cutsel">
      <span className="fy-mono">{heading}</span>
      <span className="fy-cutsel__label">{title}</span>
      <span className="fy-h1row__push" />
      <span className="fy-mono">{figures}</span>
      <span className="fy-trim">
        <span className="fy-trim__label">TRIM IN</span>
        <button
          type="button"
          className="fy-trim__step"
          disabled={!trimmable || trim <= 0}
          aria-label="less trim"
          onClick={() => stepTrim(-TRIM_STEP_SEC)}
        >
          −
        </button>
        <span
          className={cx(
            "fy-trim__value",
            trimmable && "fy-trim__value--drag",
            drag.dragging && "fy-trim__value--dragging",
          )}
          onPointerDown={trimmable ? drag.onPointerDown : undefined}
          role={trimmable ? "slider" : undefined}
          aria-label={trimmable ? "trim in" : undefined}
          aria-valuenow={drag.display}
          aria-valuemin={0}
          {...(maxTrim !== undefined ? { "aria-valuemax": maxTrim } : {})}
        >
          {drag.display.toFixed(1)}s
        </span>
        <button
          type="button"
          className="fy-trim__step"
          disabled={!trimmable || (maxTrim !== undefined && trim >= maxTrim)}
          aria-label="more trim"
          onClick={() => stepTrim(TRIM_STEP_SEC)}
        >
          +
        </button>
      </span>
    </div>
  );
}

/**
 * The Cut on the song clock (80a): the track is the ruler, so the lane is the derived spine cut
 * laid out by position rather than the scene order — clips where an anchor is covered, slates
 * where a shot is anchored but has nothing to show, and black for the time no anchor claims.
 *
 * The one authored edit lives here: trim, on the selected clip, writing the selection (R-8).
 */
function SpineCutTrack({
  worldId,
  prodId,
  slug,
  cut,
  production,
}: {
  worldId: string;
  prodId: string;
  slug: string | undefined;
  cut: ReturnType<typeof deriveSpineCut>;
  production: Parameters<typeof trimCeilingSec>[0];
}) {
  const clips = cut.segments.filter(
    (seg): seg is SpineCutSegment & { shotId: string } => seg.kind === "clip" && !!seg.shotId,
  );
  const [picked, setPicked] = useState<string | null>(null);
  // The screen opens on a clip rather than on nothing: an empty strip below a full lane reads as
  // a control that is missing rather than one that is waiting.
  const selected = clips.find((c) => c.shotId === picked) ?? clips[0] ?? null;
  const ceiling = selected?.takeId ? trimCeilingSec(production, selected.shotId, selected.takeId) : null;
  const trim = selected ? (production.selections[selected.shotId]?.trimInSec ?? 0) : 0;
  return (
    <>
      <div className="fy-track">
        <span className="fy-track__label">V</span>
        <div className="fy-track__lane">
          {cut.segments.map((seg, i) => {
            const span = Math.max(seg.endSec - seg.startSec, 0.25);
            if (seg.kind === "clip") {
              const isSelected = selected !== null && seg.shotId === selected.shotId;
              return (
                <button
                  key={`${seg.kind}-${i}`}
                  type="button"
                  className={cx("fy-cutseg", "fy-cutseg--pick", isSelected && "fy-cutseg--selected")}
                  style={{ flex: span }}
                  aria-pressed={isSelected}
                  onClick={() => seg.shotId && setPicked(seg.shotId)}
                >
                  <Portrait
                    worldSlug={slug}
                    path={seg.media ? posterize(seg.media.path) : ""}
                    label={`SC ${seg.sceneNumber}`}
                    radius={0}
                  />
                  <span className="fy-cutseg__tag">SC {seg.sceneNumber}</span>
                </button>
              );
            }
            if (seg.kind === "slate") {
              return (
                <div
                  key={`${seg.kind}-${i}`}
                  className="fy-cutseg fy-cutseg--gap fy-cutseg--gap-warn"
                  style={{ flex: span }}
                >
                  {seg.label}
                </div>
              );
            }
            return (
              <div key={`${seg.kind}-${i}`} className="fy-cutseg fy-cutseg--black" style={{ flex: span }}>
                {seconds(seg.endSec - seg.startSec)}
              </div>
            );
          })}
        </div>
      </div>
      {selected && (
        <TrimStrip
          worldId={worldId}
          prodId={prodId}
          shotId={selected.shotId}
          heading={`SC ${selected.sceneNumber} · ${selected.shotId.replace("sh_", "shot ")}`}
          title={selected.label}
          figures={`${selected.takeId ?? "no take"} · budget ${(selected.endSec - selected.startSec).toFixed(1)}s`}
          trim={trim}
          ceiling={ceiling}
        />
      )}
    </>
  );
}

/**
 * The Cut on the story clock (81a): scenes band the ruler, shots fill the lane.
 *
 * 24a merged a scene's covered shots into one cell, which reads well and makes the only editable
 * thing unselectable -- a scene is not a clip. The scene keeps its grouping in the band, exactly
 * where the song's sections sit in 80a, and the lane carries the unit of work.
 */
function StoryCutTrack({
  worldId,
  prodId,
  slug,
  cut,
  production,
}: {
  worldId: string;
  prodId: string;
  slug: string | undefined;
  cut: ReturnType<typeof deriveCut>;
  production: Parameters<typeof trimCeilingSec>[0];
}) {
  const covered = cut.entries.filter((e) => e.media !== null);
  const [picked, setPicked] = useState<string | null>(null);
  const selected = covered.find((e) => e.shot.id === picked) ?? covered[0] ?? null;
  const ceiling = selected?.takeId ? trimCeilingSec(production, selected.shot.id, selected.takeId) : null;
  const trim = selected ? (production.selections[selected.shot.id]?.trimInSec ?? 0) : 0;
  // Absent is "not measured", never zero, so an unprobed take simply does not state a length.
  const takeSec = selected?.takeId
    ? production.takeMediaInfo[selected.takeId]?.mediaInfo.durationSec
    : undefined;

  const scenes: { number: number; span: number }[] = [];
  for (const e of cut.entries) {
    const last = scenes[scenes.length - 1];
    if (last && last.number === e.sceneNumber) last.span += e.durationSec;
    else scenes.push({ number: e.sceneNumber, span: e.durationSec });
  }

  /*
   * 24a's two gap cards, kept: a shot missing from a scene that has other coverage is amber and
   * named; a scene with nothing in it at all is one neutral card for the whole scene. They are
   * different facts -- work left inside a scene, against a scene not yet shot.
   */
  const scenesWithCoverage = new Set(covered.map((e) => e.sceneNumber));
  type Lane =
    | { kind: "shot"; entry: CutEntry; span: number; key: string }
    | { kind: "gap"; label: string; span: number; warn: boolean; scene: number; key: string };
  const lane: Lane[] = [];
  for (const e of cut.entries) {
    if (e.media !== null) {
      lane.push({ kind: "shot", entry: e, span: e.durationSec, key: e.shot.id });
      continue;
    }
    if (scenesWithCoverage.has(e.sceneNumber)) {
      lane.push({
        kind: "gap",
        label: `shot ${e.shot.number}`,
        span: e.durationSec,
        warn: true,
        scene: e.sceneNumber,
        key: e.shot.id,
      });
      continue;
    }
    const last = lane[lane.length - 1];
    if (last?.kind === "gap" && !last.warn && last.scene === e.sceneNumber) last.span += e.durationSec;
    else
      lane.push({
        kind: "gap",
        label: `scene ${e.sceneNumber}, no takes yet`,
        span: e.durationSec,
        warn: false,
        scene: e.sceneNumber,
        key: e.shot.id,
      });
  }

  return (
    <>
      <div className="fy-track">
        <span className="fy-track__label" />
        <div className="fy-scenes">
          {scenes.map((sc) => (
            <div key={sc.number} className="fy-scenes__band" style={{ flex: Math.max(sc.span, 0.25) }}>
              SC {sc.number}
            </div>
          ))}
        </div>
      </div>
      <div className="fy-track">
        <span className="fy-track__label">V</span>
        <div className="fy-track__lane">
          {lane.map((item) => {
            if (item.kind === "gap") {
              return (
                <div
                  key={item.key}
                  className={cx("fy-cutseg", "fy-cutseg--gap", item.warn && "fy-cutseg--gap-warn")}
                  style={{ flex: Math.max(item.span, 0.25) }}
                >
                  {item.label}
                </div>
              );
            }
            const isSelected = selected !== null && item.entry.shot.id === selected.shot.id;
            return (
              <button
                key={item.key}
                type="button"
                className={cx("fy-cutseg", "fy-cutseg--pick", isSelected && "fy-cutseg--selected")}
                style={{ flex: Math.max(item.span, 0.25) }}
                aria-pressed={isSelected}
                onClick={() => setPicked(item.entry.shot.id)}
              >
                <Portrait
                  worldSlug={slug}
                  path={item.entry.media ? posterize(item.entry.media.path) : ""}
                  label={`shot ${item.entry.shot.number}`}
                  radius={0}
                />
                <span className="fy-cutseg__tag">{item.entry.shot.number}</span>
              </button>
            );
          })}
        </div>
      </div>
      {selected && (
        <TrimStrip
          worldId={worldId}
          prodId={prodId}
          shotId={selected.shot.id}
          heading={`SC ${selected.sceneNumber} · ${selected.shot.id.replace("sh_", "shot ")}`}
          title={selected.shot.title}
          figures={`${selected.takeId ?? "no take"} · shot ${selected.durationSec.toFixed(1)}s${takeSec !== undefined ? ` · take ${takeSec.toFixed(1)}s` : ""}`}
          trim={trim}
          ceiling={ceiling}
        />
      )}
    </>
  );
}

export function CutScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const cut = production ? deriveCut(production) : null;
  // One Cut, two clocks (80a): the story orders the picture until a spine exists, and then the
  // song does. Exports already chose this way; a Cut tab that did not would state a different
  // film from the screen next to it.
  const view = exportViewFor(world, production);
  const spineCut = view.kind === "spine" ? view.cut : null;
  const slug = world?.meta.slug;
  const [watchToken, setWatchToken] = useState(0);
  const overlays = production?.cut.overlays ?? [];
  /*
   * A production with no story is the clips (issue 453), so they are the clock.
   *
   * Gated on the same `scene-order` the Exports screen uses, not merely on `spineCut` being null.
   * A spine whose track is missing, unmeasured or silent yields no spine cut either, and calling
   * that media-only would tell one screen the clips are the film while Exports still treats the
   * song as authoritative — and a track that later measured would yank the canvas out from under
   * somebody mid-edit. A production with a spine is never this, however unresolved that spine is.
   */
  const mediaOnly = cut !== null && view.kind === "scene-order" && isMediaOnly(cut);
  /*
   * Resolved exactly as the coordinator resolves them, because the screen must not advertise a
   * film the export will not produce: `exportOverlays` drops a document or a missing artifact and
   * `exportAudioClips` drops a video not known to carry sound, so measuring raw lane records
   * would let a document stretched to 60s claim a film that encodes as five seconds.
   */
  const artifacts = world?.artifacts ?? [];
  const placedPicture = mediaOnly ? exportOverlays(overlays, artifacts) : [];
  const placedSound = mediaOnly ? exportAudioClips(overlays, artifacts) : [];
  /*
   * Two lengths. The CANVAS is how much timeline to draw and must extend past the last clip or
   * there is nowhere to drop the next one; the FILM is how long the thing actually is. Trailing
   * editing headroom is not part of the film, so it is the film that plays and the film the
   * header states — presenting the canvas as the runtime would let "Watch from top" run on into
   * blank editor space the export never emits.
   */
  /*
   * The canvas is measured from the RAW placements, not the resolved ones.
   *
   * What the export can use decides how long the film is; what somebody dropped decides how much
   * timeline they need to reach it. A clip the export drops — a document, or a video not known to
   * carry sound — is still drawn on a lane, and sizing the canvas without it puts that clip past
   * 100% where it cannot be selected, moved or deleted. The case is not hypothetical: a cut
   * becomes media-only the moment its last shot is removed, and any placement inherited from the
   * old story timeline can sit well beyond the minimum canvas.
   */
  const canvasSec = spineCut
    ? spineCut.trackDurationSec
    : mediaOnly
      ? mediaCanvasSec(overlays)
      : (cut?.totalSec ?? 0);
  const filmSec = mediaOnly ? placedExtentSec([...placedPicture, ...placedSound]) : canvasSec;
  /** Lane layout and scrubbing get the canvas; playback and the readout get the film. */
  const totalSec = canvasSec;
  const transport = useCutTransport(filmSec);
  // Where the cuts are, so a dragged clip lands on a boundary rather than near one — the snap the
  // LTX port has always offered and nothing had yet asked for.
  /*
   * What the preview shows. A media-only production has no shots to walk, so its spans come from
   * the placed picture — without this the transport advanced over a film the viewer reported as
   * empty, because `storySpans` has no entries to build from.
   */
  const spans = spineCut
    ? spineSpans(spineCut)
    : mediaOnly
      ? mediaSpans(placedPicture)
      : cut
        ? storySpans(cut)
        : [];
  /*
   * What a person placed, which a split does not add to: splitting files a second record over the
   * same file, and counting both would report two clips for one piece of media still drawn as one
   * run on the timeline. The sound half is the half that is not counted, because the picture is
   * the one they dropped.
   */
  const clipCount = (production?.cut.overlays ?? []).filter((o) => (o.audio ?? "keep") !== "only").length;
  const snapPoints = snapPointsFor(
    spans.map((s) => s.startSec),
    totalSec,
  );

  return (
    <div className="fy-cutcols" data-screen="cut">
      <ArtifactPanel worldId={worldId} artifacts={world?.artifacts ?? []} slug={slug} />
      <div className="fy-prodmain" style={{ minHeight: "100%" }}>
        <div className="fy-h1row">
          <h1 className="fy-h1">The cut</h1>
          <span className="fy-h1row__meta">
            {spineCut
              ? `${seconds(spineCut.trackDurationSec)} · ${seconds(spineCut.trackDurationSec - spineCut.blackSec)} of ${seconds(spineCut.trackDurationSec)} covered · cut to the track`
              : mediaOnly
                ? // No shots to be covered or uncovered, so coverage is not a fact about this cut.
                  // What is true of it is how long it runs and what is on it, and nothing else.
                  `${runtimeSeconds(filmSec)} · no story · what you place is the film`
                : cut
                  ? `${seconds(cut.totalSec)} · ${cut.covered} of ${cut.entries.length} shots covered · assembled from accepted takes only`
                  : ""}
            {clipCount > 0 && ` · ${clipCount} clip${clipCount === 1 ? "" : "s"}`}
          </span>
          <span className="fy-h1row__push" />
          <Button onClick={() => setWatchToken((n) => n + 1)}>Watch from top</Button>
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/exports`)}>
            Export cut…
          </Button>
        </div>
        <CutPreview
          slug={slug}
          spans={spans}
          totalSec={filmSec}
          soundSec={mediaOnly ? placedExtentSec(placedSound) : 0}
          restartToken={watchToken}
          transport={transport}
        />
        <div className="fy-timeline">
          <CutScrubber totalSec={totalSec} transport={transport} />
          <div className="fy-tracks">
            {totalSec > 0 && (
              <div
                className="fy-playhead"
                style={{ left: `${Math.min(100, (transport.time / totalSec) * 100)}%` }}
                aria-hidden
              />
            )}
            {worldId && prodId && production && cut ? (
              spineCut ? (
                <SpineCutTrack
                  worldId={worldId}
                  prodId={prodId}
                  slug={slug}
                  cut={spineCut}
                  production={production}
                />
              ) : (
                <StoryCutTrack
                  worldId={worldId}
                  prodId={prodId}
                  slug={slug}
                  cut={cut}
                  production={production}
                />
              )
            ) : null}
            {/*
             * The A row that used to sit here listed the world's audio artifacts and could do
             * nothing with them — audio now lands on a lane like everything else, so a row that
             * only ever described the inventory would be repeating the panel beside it.
             */}
            {worldId && prodId && (
              <ClipLanes
                worldId={worldId}
                prodId={prodId}
                slug={slug}
                totalSec={totalSec}
                clips={production?.cut.overlays ?? []}
                artifacts={world?.artifacts ?? []}
                snapPoints={snapPoints}
              />
            )}
          </div>
          <div className="fy-cutfoot">
            <span className="fy-mono">
              {spineCut
                ? `${spineCut.segments.filter((seg) => seg.kind === "clip").length} of ${spineCut.segments.filter((seg) => seg.kind !== "black").length} anchors covered`
                : mediaOnly
                  ? // Nothing to say (issue 504). This line answers how much of the work is
                    // placed, and a production with no story has no work outstanding — "0 of 0
                    // shots placed · 0 gaps" reads as a film in trouble, counts nothing that
                    // exists, and calls eight uncovered seconds no gap in its own vocabulary.
                    // What is on the timeline the header already states: runtime and clips both.
                    ""
                  : cut
                    ? `${cut.covered} of ${cut.entries.length} shots placed · ${cut.gaps} gap${cut.gaps === 1 ? "" : "s"}`
                    : ""}
            </span>
            <span className="fy-h1row__push" />
            {spineCut
              ? spineCut.blackSec > 0 && (
                  <span className="fy-warnchip">
                    <span className="fy-dot fy-dot--warn" />
                    {spineCut.segments.filter((seg) => seg.kind === "black").length} black ·{" "}
                    {seconds(spineCut.blackSec)} uncovered
                  </span>
                )
              : cut &&
                cut.gaps > 0 && (
                  <span className="fy-warnchip">
                    <span className="fy-dot fy-dot--warn" />
                    {cut.gaps} gap{cut.gaps === 1 ? "" : "s"} · {seconds(cut.uncoveredSec)} uncovered
                  </span>
                )}
          </div>
        </div>
        <div style={{ marginTop: "auto" }}>
          {/*
           * What restoring an earlier cut would mean, which is not the same sentence for both
           * clocks (issue 504's neighbour). A derived cut holds nothing of its own, so the warning
           * is that the selections are what to keep. A production with no story derives nothing:
           * the placements ARE the record, and telling somebody their work recomputes from shot
           * selections they do not have is false about the one thing this note exists to say.
           */}
          <span className="fy-mono">
            {mediaOnly
              ? "the cut is what you placed — nothing recomputes it; the clips themselves are the record"
              : "the cut is a projection — it recomputes from shot selections; restoring an earlier cut means restoring the selections that produced it"}
          </span>
        </div>
      </div>
    </div>
  );
}

// ---- Audio (25a) -----------------------------------------------------------

export function AudioScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  // Spoken lines live on shots and their Generate is the voice-line dispatch — a video affair.
  // A story production keeps this pane for its audio artifacts alone (design 54a: nothing on a
  // story screen mentions shots or dispatch); narration comes later, as its own design.
  const isStory = production ? productionShape(production.meta).hasChapters : false;
  const linked = artifactsFor(world?.artifacts ?? [], prodId).filter((a) => a.kind === "audio");
  const voLines = isStory
    ? []
    : (production?.scenes
        .flatMap((s) => s.shots)
        .filter((s) => s.audio?.kind === "vo" || s.audio?.kind === "dialogue") ?? []);
  const speakerOf = (id: string | undefined) => world?.sheets.find((c) => c.id === id);
  return (
    <div className="fy-prodmain" data-screen="audio" style={{ minHeight: "100%" }}>
      <div className="fy-h1row">
        <h1 className="fy-h1">Audio</h1>
        <span className="fy-h1row__meta">
          {isStory
            ? `${linked.length} audio artifact${linked.length === 1 ? "" : "s"} · filed with the world, linkable to chapters`
            : `${voLines.length} spoken line${voLines.length === 1 ? "" : "s"} · ${linked.length} audio artifact${linked.length === 1 ? "" : "s"} · voices come from the sheets`}
        </span>
        <span className="fy-h1row__push" />
        {!isStory && (
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/voice-line`)}>
            Generate voice line…
          </Button>
        )}
      </div>
      {!isStory && (
        <div>
          <div className="fy-eyebrow-sm" style={{ margin: "0 0 2px" }}>
            DIALOGUE
          </div>
          {voLines.length === 0 && (
            <div className="fy-mono" style={{ padding: "10px 0" }}>
              no spoken lines in the shots yet
            </div>
          )}
          {voLines.map((s) => {
            const speaker = speakerOf(s.audio?.speaker);
            // The most recent spoken take covering this shot, if one has been made.
            const read = production
              ? [...takesForShot(production, s.id)].reverse().find((t) => t.kind === "voice")
              : undefined;
            return (
              <div key={s.id} className="fy-audiorow">
                {/* Nothing is generated for these lines yet, so there is no circle to press —
                  the status dot carries that, rather than a button that cannot sound. */}
                <div className="fy-audiorow__id">
                  <div className="fy-audiorow__title">
                    {speaker?.name ?? s.audio?.kind}, “{s.audio?.line}”
                  </div>
                  <div className="fy-audiorow__sub">
                    {s.id.replace("sh_", "shot ")}
                    {speaker ? ` · voice: ${speaker.name} sheet v${speaker.version}` : ""}
                    {speaker?.voice ? ` · ${speaker.voice.provider}` : ""}
                  </div>
                </div>
                <div className="fy-audiorow__wave">
                  <Wave seed={s.id + (s.audio?.line ?? "")} />
                </div>
                {/* What is actually here. "not generated" was hardcoded, so a line that had been
                  read landed in the production and the row went on claiming nothing existed —
                  with no way to hear it. */}
                {read === undefined ? (
                  <span className="fy-audiorow__status">
                    <span className="fy-dot fy-dot--warn" />
                    not generated
                  </span>
                ) : (
                  <span className="fy-audiorow__status">
                    <span className="fy-dot fy-dot--ok" />
                    {read.completedAt ? "read" : "reading…"}
                  </span>
                )}
                {read?.media && world ? (
                  <ClipPlayButton
                    small
                    clip={{
                      id: `take:${read.id}`,
                      url: mediaUrl(world.meta.slug, `productions/${prodId}/takes/${read.id}/${read.media}`),
                      title: `${speaker?.name ?? "line"} · ${s.id.replace("sh_", "shot ")}`,
                      sub: `voice line · ${speaker?.voice?.label ?? speaker?.voice?.provider ?? "voice"}`,
                    }}
                  />
                ) : null}
                <Button
                  onClick={() =>
                    navigate(`/w/${worldId}/p/${prodId}/generate/voice-line?shot=${encodeURIComponent(s.id)}`)
                  }
                >
                  {read === undefined ? "Generate" : "Again"}
                </Button>
              </div>
            );
          })}
        </div>
      )}
      <div>
        <div className="fy-eyebrow-sm" style={{ margin: "0 0 2px" }}>
          {isStory ? "AUDIO ARTIFACTS" : "BEDS AND STEMS"}
        </div>
        {linked.length === 0 && (
          <div className="fy-mono" style={{ padding: "10px 0" }}>
            no audio artifacts yet — imports land here
          </div>
        )}
        {linked.map((a) => (
          <div key={a.id} className="fy-audiorow">
            <ClipPlayButton
              clip={
                world
                  ? {
                      id: `artifact:${a.id}`,
                      url: mediaUrl(world.meta.slug, `artifacts/${a.file}`),
                      title: a.file.split("/").pop() ?? a.file,
                      sub: `artifact · ${a.file}`,
                    }
                  : null
              }
            />
            <div className="fy-audiorow__id">
              <div className="fy-audiorow__title">{a.file.split("/").pop()}</div>
              <div className="fy-audiorow__sub">artifact · {a.file}</div>
            </div>
            <div className="fy-audiorow__wave">
              <Wave seed={a.file} />
            </div>
            <span className="fy-audiorow__status">
              <span className="fy-dot fy-dot--ok" />
              in artifacts
            </span>
            <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/artifacts`)}>
              Open artifact
            </Button>
          </div>
        ))}
      </div>
      {/* Every row already names its sheet and voice — the legend that re-taught it is gone (design 54). */}
      <div className="fy-scenefoot">
        <span className="fy-h1row__push" />
        <span
          style={{
            font: "400 11px var(--font-sans)",
            color: "var(--muted-foreground)",
            cursor: "pointer",
            textDecoration: "underline",
            textUnderlineOffset: 3,
          }}
          onClick={() => navigate(`/w/${worldId}/cast`)}
        >
          Voice picker
        </span>
      </div>
    </div>
  );
}

// ---- Exports (25b) ---------------------------------------------------------

/**
 * Everything the Exports pane needs to say, decided in one place (issue 283, design 60c).
 *
 * Three review rounds found the same class of defect: a state the screen had not enumerated,
 * falling through a ternary to a number or a sentence belonging to a different state -- the
 * scene-order runtime printed beside "there is no timeline", every missing second called
 * "labelled black" when only slates carry labels, a shot anchored nowhere omitted from the film
 * and from the warning. Each was fixed where it appeared, and the next round found another.
 *
 * So the states are named once, exhaustively, and the runtime, the block and the wording are all
 * derived from the same value. A state that is not in this union cannot be rendered, and a
 * sentence cannot outlive the condition it was written for.
 */
type ExportView =
  | { kind: "scene-order" }
  | { kind: "no-track" }
  | { kind: "unmeasured" }
  | { kind: "silent"; durationSec: number }
  | { kind: "spine"; cut: ReturnType<typeof deriveSpineCut> };

function exportViewFor(
  world:
    | { artifacts: readonly { id: string; mediaInfo?: { durationSec: number; hasAudio: boolean } }[] }
    | null
    | undefined,
  production: Parameters<typeof deriveSpineCut>[0] | null | undefined,
): ExportView {
  const spine = production?.spine;
  if (!production || !spine || !world) return { kind: "scene-order" };
  const track = world.artifacts.find((a) => a.id === spine.trackArtifactId);
  // A spine naming an artifact this world does not have is not the same as one nobody measured:
  // the coordinator has no path to probe, so no export can succeed and none should be offered.
  if (track === undefined) return { kind: "no-track" };
  if (track.mediaInfo === undefined) return { kind: "unmeasured" };
  // Measured is not usable. A track with no audio stream refuses every preset in the coordinator.
  if (!track.mediaInfo.hasAudio) return { kind: "silent", durationSec: track.mediaInfo.durationSec };
  return { kind: "spine", cut: deriveSpineCut(production, spine, track.mediaInfo.durationSec) };
}

/** What the review will actually contain, in the exporter's terms rather than the screen's. */
function reviewNotes(cut: ReturnType<typeof deriveSpineCut>): string[] {
  const notes: string[] = [];
  if (cut.slateSec > 0)
    notes.push(`${seconds(cut.slateSec)} is a labelled slate naming the shot that is missing`);
  // Plain black carries no label: the exporter draws text on slates only.
  if (cut.blackSec > 0) notes.push(`${seconds(cut.blackSec)} is plain black, anchored to no shot at all`);
  if (cut.unanchoredShotIds.length > 0) {
    const n = cut.unanchoredShotIds.length;
    notes.push(
      `${n} shot${n === 1 ? "" : "s"} anchored nowhere in the song, so ${n === 1 ? "it is" : "they are"} not in the film at all`,
    );
  }
  if (cut.problems.length > 0) {
    notes.push(`unresolved: ${[...new Set(cut.problems.map((p) => p.kind))].sort().join(", ")}`);
  }
  return notes;
}

export function ExportsScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const exportsState = useExports();
  // A story has no cut to render, and a manuscript exporter does not exist yet — so this pane
  // offers neither rather than a zero-length video (design 54a). It stays on the story rail
  // because the world folder export lives here, and the chapters travel whole inside it.
  const isStory = production ? productionShape(production.meta).hasChapters : false;
  const cut = production ? deriveCut(production) : null;
  const view = exportViewFor(world, production);
  /*
   * No story to derive a picture from, so what was placed is the film (issue 453). Resolved
   * exactly as the coordinator resolves it, or this screen advertises a runtime the encode does
   * not produce — a document stretched to 60s beside a 5s image is a 5s film, and a lane holding
   * nothing but a document is not a film at all.
   */
  const overlays = production?.cut.overlays ?? [];
  const mediaOnly = cut !== null && view.kind === "scene-order" && isMediaOnly(cut);
  const placedArtifacts = world?.artifacts ?? [];
  const placedSec = mediaOnly ? placedFilmSec(overlays, placedArtifacts) : 0;
  const mine = Object.entries(exportsState).filter(([, e]) => e.productionId === prodId);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("review-cut");
  /*
   * Runtime, block and refusal all read from the one view, so none can describe a state the screen
   * is not in. The song's length is the runtime wherever there is a song (design 60, binding).
   */
  const refusal = view.kind === "spine" ? spineExportRefusals(view.cut, preset) : null;
  const runtimeSec =
    view.kind === "spine"
      ? view.cut.trackDurationSec
      : view.kind === "silent"
        ? view.durationSec
        : view.kind === "scene-order"
          ? // A production with no story runs as long as what was placed on it (issue 453), which
            // is the only length it has — `cut.totalSec` is zero there and would report 0s for a
            // film that plainly is not.
            mediaOnly
            ? placedSec
            : cut?.totalSec
          : undefined;
  /*
   * An unmeasured track does not block: exporting is what measures it, and the coordinator probes
   * an artifact with no stored measurement, then renders or refuses in words. A missing artifact
   * and a silent one do block, because no probe rescues either.
   */
  /*
   * Nothing the export can USE, which is not the same as nothing on the lanes: a production
   * holding only a document has a clip on screen and still has no film. Blocked either way,
   * because an empty plan becomes `concat=n=0`, which is not a filter graph — but the two are
   * told apart below, so somebody looking at a clip is not told there is nothing there.
   */
  const nothingPlaced = mediaOnly && placedSec === 0;
  const unusablePlacements = nothingPlaced && overlays.length > 0;
  const blocked = refusal !== null || view.kind === "no-track" || view.kind === "silent" || nothingPlaced;
  const presetCopy: Record<string, { label: string; sub: string }> = {
    "review-cut": {
      label: "Review cut",
      sub: `mp4 ${PRESETS["review-cut"].width}×${PRESETS["review-cut"].height} · timecode · fastest`,
    },
    master: { label: "Master", sub: `${PRESETS.master.width}×${PRESETS.master.height} · clean` },
    "social-excerpt": {
      label: "Social excerpt",
      sub: `${PRESETS["social-excerpt"].width}×${PRESETS["social-excerpt"].height} · 9:16 · captions`,
    },
  };
  const boardPath = production?.scenes.find((s) => s.board)?.board?.image;
  return (
    <div className="fy-prodmain" data-screen="exports" style={{ minHeight: "100%" }}>
      <div className="fy-h1row">
        <h1 className="fy-h1">Exports</h1>
        <span className="fy-h1row__meta">
          {isStory
            ? "the chapters travel in the world folder · a manuscript export is designed, not yet built"
            : "renders of the cut · the cut itself stays the source"}
        </span>
      </div>
      {!isStory && production && productionShape(production.meta).isEpisodic && (
        <div>
          <div className="fy-listhead">
            Episodes · each its own deliverable
            <Button
              variant="secondary"
              onClick={() => {
                // The season batch is one send per episode (issue 396): each encode is its own
                // export with its own progress and retry, so one failure never re-encodes the
                // rest. Refused episodes are skipped here and say why on their row.
                if (!worldId || !prodId) return;
                for (const episode of production.episodes) {
                  if (episodeExportRefusals(production, episode.id) === null) {
                    exportCut(worldId, prodId, preset, episode.id);
                  }
                }
              }}
            >
              Export the season · {preset}
            </Button>
          </div>
          {production.episodes.map((episode) => {
            const episodeCut = deriveEpisodeCut(production, episode.id);
            const episodeRefusal = episodeExportRefusals(production, episode.id);
            return (
              <div key={episode.id} className="fy-listrow">
                <span className="fy-mono">{String(episode.order).padStart(2, "0")}</span>
                <span className="fy-listrow__text" style={{ font: "600 13px var(--font-sans)" }}>
                  {episode.release?.title ?? episode.title}
                </span>
                <span className="fy-mono">
                  {seconds(episodeCut.totalSec)} · {episodeCut.covered} of {episodeCut.entries.length} covered
                  {episodeCut.gaps > 0
                    ? ` · ${episodeCut.gaps} gap${episodeCut.gaps === 1 ? "" : "s"} as slates`
                    : ""}
                </span>
                {episodeRefusal ? (
                  <span className="fy-mono" style={{ color: "var(--destructive)" }}>
                    {episodeRefusal.detail}
                  </span>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => worldId && prodId && exportCut(worldId, prodId, preset, episode.id)}
                  >
                    Export episode
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!isStory && (
        <>
          <div>
            <div className="fy-eyebrow-sm" style={{ margin: "0 0 2px" }}>
              DELIVERED
            </div>
            {mine.length === 0 && (
              <div className="fy-mono" style={{ padding: "10px 0" }}>
                nothing delivered yet
              </div>
            )}
            {mine.map(([id, e]) => (
              <div key={id} className="fy-exportrow">
                <div className="fy-exportrow__thumb">
                  <Portrait
                    worldSlug={world?.meta.slug}
                    path={boardPath && production ? `productions/${production.meta.id}/${boardPath}` : ""}
                    label="cut"
                    radius={0}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="fy-exportrow__title">
                    {production?.meta.title}
                    {e.episodeId !== undefined
                      ? ` · ${production?.episodes.find((ep) => ep.id === e.episodeId)?.title ?? e.episodeId}`
                      : ""}{" "}
                    · render {id.slice(0, 8)}
                  </div>
                  <div className="fy-exportrow__sub">
                    {e.status}
                    {e.status === "running" ? ` · ${Math.round(e.percent)}%` : ""}
                    {e.output ? ` · ${e.output}` : ""}
                    {e.error ? ` · ${e.error}` : ""}
                  </div>
                </div>
                {e.status === "running" && (
                  <Button variant="ghost" onClick={() => worldId && cancelExport(worldId, id)}>
                    Cancel
                  </Button>
                )}
              </div>
            ))}
          </div>
          <div>
            <div className="fy-eyebrow-sm">NEW EXPORT</div>
            <div className="fy-radiorow">
              {(Object.keys(presetCopy) as Array<keyof typeof PRESETS>).map((p) => (
                <button
                  key={p}
                  type="button"
                  className={cx("fy-radio", preset === p && "fy-radio--on")}
                  onClick={() => setPreset(p)}
                >
                  <div className="fy-radio__head">
                    <span className="fy-radio__dot" />
                    {presetCopy[p]!.label}
                  </div>
                  <div className="fy-radio__sub">{presetCopy[p]!.sub}</div>
                </button>
              ))}
            </div>
            {view.kind === "no-track" && (
              <div className="fy-notecard">
                <span className="fy-dot fy-dot--warn" />
                The spine names a track this world does not have, so there is nothing to measure or cut
                against. Assign a track again — the anchors are unaffected.
              </div>
            )}
            {view.kind === "silent" && (
              <div className="fy-notecard">
                <span className="fy-dot fy-dot--warn" />
                The master track has no audio stream, so there is no song to cut against. Assign a track that
                carries audio — nothing else about the production changes.
              </div>
            )}
            {nothingPlaced && (
              <div className="fy-notecard">
                <span className="fy-dot fy-dot--warn" />
                {unusablePlacements
                  ? // Saying "nothing on its lanes" to somebody looking at a clip is simply untrue,
                    // and leaves them with no idea why the button will not move.
                    "The lanes hold nothing this export can use — a document has no picture, and a video is only mixed in when it is known to carry sound. Place a video, an image or an audio file and it becomes the film."
                  : "This production has no story and nothing on its lanes, so there is no film to render yet. Drop something on the Cut and it becomes the film."}
              </div>
            )}
            {view.kind === "unmeasured" && (
              <div className="fy-notecard">
                <span className="fy-dot fy-dot--warn" />
                The master track has not been measured yet, so its length is not known here. Exporting
                measures it first and renders against it — or says why it cannot be read. Nothing about the
                production changes either way.
              </div>
            )}
            {view.kind === "spine" &&
              (() => {
                /*
                 * One sentence about what the review will contain, built from the cut rather than
                 * written per case. Three rounds were spent on copy that described a state the screen
                 * was not in -- gaps promised as labelled when only slates carry labels, shots
                 * anchored nowhere omitted from both the film and the warning, a refusal naming the
                 * master while another preset was selected.
                 */
                const notes = reviewNotes(view.cut);
                if (refusal === null && notes.length === 0) return null;
                return (
                  <div className="fy-notecard">
                    <span className="fy-dot fy-dot--warn" />
                    {refusal !== null && (
                      <>
                        {presetCopy[preset]?.label ?? "This export"} cannot be made yet — {refusal.detail}
                        .{" "}
                      </>
                    )}
                    {notes.length > 0 ? (
                      <>A review cut renders anyway: {notes.join("; ")}. An unfinished film still reviews.</>
                    ) : (
                      <>A review cut renders the whole song as it stands.</>
                    )}
                  </div>
                );
              })()}
            {view.kind === "scene-order" && cut && cut.gaps > 0 && (
              <div className="fy-notecard">
                <span className="fy-dot fy-dot--warn" />
                The cut has {cut.gaps} gap{cut.gaps === 1 ? "" : "s"} ({seconds(cut.uncoveredSec)}). They
                export as black slates carrying their labels and durations — an unfinished film still reviews.
              </div>
            )}
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <span className="fy-mono">renders locally · no provider call</span>
              <span className="fy-h1row__push" />
              <Button
                variant="primary"
                disabled={blocked}
                onClick={() => !blocked && worldId && prodId && exportCut(worldId, prodId, preset)}
              >
                {runtimeSec === undefined ? "Export" : <>Export · {mediaOnly ? runtimeSeconds(runtimeSec) : seconds(runtimeSec)}</>}
              </Button>
            </div>
          </div>
        </>
      )}
      {isStory && (
        <EmptyState
          title="No manuscript export yet"
          hint="Chapters live in the world folder as ordinary Markdown; the export below carries them whole."
        />
      )}
      <div className="fy-scenefoot">
        <span className="fy-mono">
          world export: a folder that reopens identically elsewhere — history kept, caches and locks stay
          behind · lands under ArkeStudio\exports
        </span>
        <span className="fy-h1row__push" />
        <Button variant="ghost" onClick={() => worldId && exportWorld(worldId)}>
          Export world folder
        </Button>
      </div>
    </div>
  );
}

// ---- Stills contact sheet --------------------------------------------------

/**
 * Generate's second lens (design 55a): the frame/still takes as a set, decided one at a time.
 * This was a rail destination of its own; a take is decided where it was made, so the contact
 * sheet now lives inside the workspace and the seg is the way between the lenses.
 */
function ContactSheet({
  production,
  worldSlug,
  worldId,
  prodId,
  onShotLens,
  onScene,
}: {
  production: ReturnType<typeof useProduction>["production"];
  worldSlug: string | undefined;
  worldId: string | undefined;
  prodId: string | undefined;
  onShotLens: () => void;
  onScene: () => void;
}) {
  const stills = useMemo(
    () => production?.takes.filter((t) => t.kind === "frame" || t.kind === "still") ?? [],
    [production],
  );
  const decisions = production ? takeDecisions(production) : {};
  return (
    <div className="fy-prodmain" data-screen="stills-contact-sheet">
      <div className="fy-h1row">
        <span className="fy-seg">
          <button type="button" className="fy-seg__item" onClick={onShotLens}>
            Shot
          </button>
          <button type="button" className="fy-seg__item" onClick={onScene}>
            Scene
          </button>
          <span className="fy-seg__item fy-seg__item--active">Contact sheet</span>
        </span>
        <span className="fy-h1row__meta">
          {stills.length} frame{stills.length === 1 ? "" : "s"} — judged as a set, accepted one at a time
        </span>
      </div>
      {stills.length === 0 ? (
        <EmptyState title="No stills yet" hint="Frames and stills land here as they are generated." />
      ) : (
        <div
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}
        >
          {stills.map((take) => {
            const decision = decisions[take.id];
            const shotId = take.coversShots[0];
            return (
              <div key={take.id} className="fy-shotcard">
                <div className="fy-shotcard__frame">
                  <Portrait
                    worldSlug={worldSlug}
                    path={takeMediaPath(production!.meta.id, take) ?? ""}
                    label={shotId?.replace("sh_", "shot ") ?? take.id}
                    radius={0}
                  />
                </div>
                <div className="fy-shotcard__body">
                  <div className="fy-shotcard__head">
                    <span className="fy-shotcard__num">{shotId?.replace("sh_", "") ?? "—"}</span>
                    <span className="fy-shotcard__title">{take.media ?? take.id}</span>
                    <span className={`fy-dot fy-dot--${decisionTone(decision)}`} />
                  </div>
                  <span className="fy-mono">
                    {take.model}
                    {decision && decision !== "pending" ? ` · ${decision}` : " · unreviewed"}
                  </span>
                  <div className="fy-shotcard__spacer" />
                  <div className="fy-shotcard__actions">
                    <Button
                      variant={decision === "accepted" ? "primary" : "ghost"}
                      disabled={!shotId}
                      onClick={() => {
                        // Accept = decision + selection in one commit (SPEC-013 R-9).
                        if (worldId && prodId && shotId) acceptTake(worldId, prodId, take.id, shotId);
                      }}
                    >
                      Accept
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={Object.keys(take.provenance.sheets).length === 0}
                      title="A rejection cites the sheet the take drifted from (R-10)"
                      onClick={() => {
                        const sheet = Object.keys(take.provenance.sheets)[0];
                        if (worldId && prodId && sheet)
                          rejectTake(
                            worldId,
                            prodId,
                            take.id,
                            { sheet, field: "appearance", note: "rejected from the contact sheet" },
                            shotId,
                          );
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
