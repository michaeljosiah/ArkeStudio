import { Loading } from "../components/loading.js";
import {
  resolvedAuthoredDuration,
  targetWords,
  storyProgressDay,
} from "@arke-studio/contracts";
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import {
  deriveCut,
  isMediaOnly,
  placedFilmSec,
  guestsOf,
  resolvePictureTimeline,
  seedFirstPictureTimeline,
  pickableSheets,
  productionAspect,
  productionShape,
  STANDARD_ASPECTS,
  type ProductionBundle,
  buildRenderPlan,
  orderedShots,
  sortScenes,
} from "@arke-studio/contracts";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import {
  Book,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Film,
  Folder,
  Speaker,
  Home,
  ListOrdered,
  Message,
  PanelLeft,
  Plus,
  Scroll,
  Search,
  Sparkle,
  Users,
  VideoMark,
} from "../components/icons.js";
import { AppChrome } from "../components/chrome.js";
import { useWorldOpenRefusal, WorldOpenRefusal } from "../components/world-open-refusal.js";
import { Composer } from "../components/composer.js";
import { ProductionConversation, StagedDecision } from "../components/conversation.js";
import { Portrait } from "../components/portrait.js";
import { useRailCollapsed } from "../lib/rail-collapsed.js";
import { runtimeSeconds, seconds, usd } from "../lib/format.js";
import { productionShelf } from "../lib/artifact-view.js";
import {
  acceptedTakeId,
  isDayOne,
  nextEpisodeOrder,
  takeDecisions,
  useProduction,
} from "../lib/selectors.js";
import { DevelopmentWorkspace } from "./development.js";
import {
  attachHostFiles,
  attachHostText,
  hostCanAttach,
  createEpisode,
  openAudiobook,
  uploadArtifacts,
  setProductionAspect,
  useAudiobookDoors,
  useStore,
} from "../lib/store.js";
import { audiobookDoorLine } from "@arke-studio/contracts";
import { takeMediaPath, type TakeEpisodeOption, episodeLabel, filterTakeEpisodes } from "./production-generate.js";
import { useNewScene, useNewChapter, NewSceneContext, useSharedNewScene, NewChapterContext, ChapterPlan, ChapterOutlineRow } from "./production-story.js";
import { exportViewFor } from "./editor-export.js";

/** The first accepted picture in an episode, derived from its authored scene order. */
export function episodeThumbnailPath(
  production: ProductionBundle,
  episode: Pick<ProductionBundle["episodes"][number], "scenes">,
): string | null {
  for (const sceneId of episode.scenes) {
    const scene = production.scenes.find((candidate) => candidate.id === sceneId);
    if (scene === undefined) continue;
    for (const shot of orderedShots(scene)) {
      const takeId = acceptedTakeId(production, shot.id);
      const take = takeId === null ? undefined : production.takes.find((candidate) => candidate.id === takeId);
      const path = take === undefined ? null : takeMediaPath(production, take);
      if (path !== null) return path;
    }
  }
  return null;
}

/**
 * Where a scene pressed outside any episode goes: the episode in view, else the last one, else
 * nowhere — a film has no episodes and its scenes belong to none.
 */
export function defaultEpisodeFor(
  production: { episodes: readonly { id: string; order: number }[] } | null | undefined,
  currentEpisodeId?: string,
): string | undefined {
  if (!production) return undefined;
  if (currentEpisodeId !== undefined && production.episodes.some((episode) => episode.id === currentEpisodeId)) {
    return currentEpisodeId;
  }
  return [...production.episodes].sort((a, b) => a.order - b.order).at(-1)?.id;
}

export function decisionTone(decision: string | undefined): "ok" | "warn" | "sketch" {
  if (decision === "accepted") return "ok";
  if (decision === "rejected") return "sketch";
  return "warn";
}

const SWITCH_MENU_WIDTH_PX = 268;

/**
 * The production switcher, as a menu that actually switches.
 *
 * It wore `ChevronsUpDown` on an episodic production — the glyph that means *a menu opens here* —
 * and navigated to the Productions screen instead, so the one control in the workspace that looks
 * like a picker was the one that left it. Same button, same behaviour, two different promises
 * depending on the format.
 *
 * Fixed rather than absolute: the rail is `overflow-y: auto`, so a menu positioned inside it is
 * clipped by its own container and scrolls away from the button that opened it.
 */
function ProductionSwitcher({
  world,
  production,
  sub,
  folded,
  chevron,
}: {
  world: { productions: readonly ProductionBundle[] } | null;
  production: ProductionBundle | null;
  sub: string;
  folded: boolean;
  chevron: ReactNode;
}) {
  const navigate = useNavigate();
  const { worldId } = useParams();
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const others = world?.productions ?? [];

  useEffect(() => {
    if (at === null) return;
    const close = () => setAt(null);
    // Capture-phase, matching the editor's clip menu: a press elsewhere closes even when that
    // element stops propagation, but a press inside the menu is the menu being used.
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(".fy-switchmenu")) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        event.stopImmediatePropagation();
        button.current?.focus();
      }
    };
    window.addEventListener("pointerdown", closeOutside, { capture: true });
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", closeOutside, { capture: true });
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [at]);

  const open = () => {
    const rect = button.current?.getBoundingClientRect();
    if (rect === undefined) return;
    setAt({ x: rect.left, y: rect.bottom + 6 });
  };
  const go = (id: string) => {
    setAt(null);
    if (id !== production?.meta.id) navigate(`/w/${worldId}/p/${id}`);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="fy-prodrail__switch"
        aria-label={`Switch production. Current production: ${production?.meta.title ?? "loading"}`}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        title={folded ? `Switch production · ${production?.meta.title ?? "loading"}` : undefined}
        onClick={() => (at === null ? open() : setAt(null))}
      >
        <span className="fy-prodrail__switchmark" aria-hidden>
          {(production?.meta.title ?? "P").trim().charAt(0).toUpperCase() || "P"}
        </span>
        <div className="fy-prodrail__switchcopy">
          <div className="fy-prodrail__switchname">{production?.meta.title ?? "…"}</div>
          <div className="fy-prodrail__switchsub">{sub}</div>
        </div>
        <span className="fy-prodrail__switchchevron">{chevron}</span>
      </button>
      {at !== null && (
        <div
          className="fy-switchmenu"
          role="menu"
          aria-label="Productions in this world"
          ref={(node) => node?.querySelector<HTMLElement>("[role='menuitem']")?.focus()}
          style={{
            left: Math.min(at.x, Math.max(0, window.innerWidth - SWITCH_MENU_WIDTH_PX - 8)),
            top: at.y,
          }}
          // `role="menu"` promises the arrows work, so they do. Without this the role is a
          // claim the widget does not honour, which is worse than plain buttons would have been.
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']"),
            ];
            const from = items.indexOf(document.activeElement as HTMLElement);
            const step = event.key === "ArrowDown" ? 1 : -1;
            const next = (from + step + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {others.map((candidate) => {
            const shape = productionShape(candidate.meta);
            const current = candidate.meta.id === production?.meta.id;
            return (
              <button
                key={candidate.meta.id}
                type="button"
                role="menuitem"
                className={cx("fy-switchmenu__item", current && "fy-switchmenu__item--on")}
                aria-current={current ? "true" : undefined}
                onClick={() => go(candidate.meta.id)}
              >
                <span className="fy-switchmenu__mark" aria-hidden>
                  {candidate.meta.title.trim().charAt(0).toUpperCase() || "P"}
                </span>
                <span className="fy-switchmenu__copy">
                  <span className="fy-switchmenu__name">{candidate.meta.title}</span>
                  <span className="fy-switchmenu__sub">{shape.displayLabel.toLowerCase()}</span>
                </span>
                {/* Where you are is said the way the rail says it — the selected background and
                    weight — rather than with a tick this icon set does not have. */}
                {current && <span className="fy-switchmenu__here">here</span>}
              </button>
            );
          })}
          <span className="fy-switchmenu__rule" aria-hidden />
          {/* The old destination keeps a way in: the Productions screen carries the key art and
              the counts, which a menu row cannot. */}
          <button
            type="button"
            role="menuitem"
            className="fy-switchmenu__item fy-switchmenu__item--all"
            onClick={() => {
              setAt(null);
              navigate(`/w/${worldId}/productions`);
            }}
          >
            All productions
          </button>
        </div>
      )}
    </>
  );
}

// ---- the production shell (frames 11a/14a left rail) -----------------------

export function ProductionLayout() {
  const { worldId, prodId, episodeId, sceneId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const refusal = useWorldOpenRefusal(worldId);
  const location = useLocation();
  // The rail is the format's (design 54a): a surface the format cannot use is not present,
  // not greyed. A story production has nothing to dispatch, so its rail never says so.
  const shape = production ? productionShape(production.meta) : null;
  const isStory = shape?.hasChapters === true;
  let cut: ReturnType<typeof deriveCut> | null = null;
  if (production) {
    try {
      const timeline = production.timeline ?? { status: "absent" as const };
      cut = production.spine && timeline.status !== "ready"
        ? deriveCut(production)
        : resolvePictureTimeline(production, timeline.status === "absent"
          ? { status: "ready", timeline: seedFirstPictureTimeline(production) }
          : timeline, world?.artifacts ?? []);
    } catch {
      // Invalid timeline state is stated in the editor and Exports; the rail must not substitute
      // the legacy runtime while those screens correctly block it.
    }
  }
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
  let filmSec = 0;
  if (mediaOnly && production) {
    if (production.timeline?.status === "ready") {
      const planned = buildRenderPlan({ production, timeline: production.timeline, artifacts: world?.artifacts ?? [], scope: { kind: "production" }, preset: "review-cut" });
      filmSec = planned.ok ? planned.plan.totalSec : 0;
    } else filmSec = placedFilmSec(production.cut.overlays, world?.artifacts ?? []);
  }
  /*
   * The row's count is its own page's set (design 134): the world's shelf plus what this
   * production owns. It used to count `production === undefined` — the world's number, on a
   * production row, pointing at a world screen that could not have shown the difference.
   */
  const artifactCount = productionShelf(world?.artifacts ?? [], prodId).length;
  /*
   * The rail's read count (turn 146, SPEC-047 R-29): chapters read of those with prose, which
   * only the coordinator can say — a chapter is read when every block's take is current, and
   * the bundle carries the record's stamp alone. So a story production asks the door once
   * when it is shown, and the rail reads the answer; the door itself asks again as the book
   * changes.
   */
  const audiobookDoor = useAudiobookDoors()[prodId ?? ""]?.door ?? null;
  const shellConnection = useStore().connection;
  const audiobookStamp = production === null ? "" : JSON.stringify(production.chapters.map((c) => [c.id, c.version, c.bodyHash ?? "", c.audiobook ?? null]));
  useEffect(() => {
    if (!worldId || !prodId || !isStory || shellConnection !== "open") return;
    openAudiobook(worldId, prodId);
  }, [worldId, prodId, isStory, shellConnection, audiobookStamp]);
  const audiobookCount = audiobookDoor === null ? "—" : (() => {
    const line = audiobookDoorLine(audiobookDoor.rows);
    return `${line.read}/${line.withProse}`;
  })();
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
  const [episodeExpansion, setEpisodeExpansion] = useState<Record<string, boolean>>({});
  const newScene = useNewScene(worldId, prodId);
  const newChapter = useNewChapter(worldId, prodId);
  // A chapter opened is a workspace as much as a scene opened is (turn 126), and folds by the
  // same default: the manuscript wants the width, and the width is the person's afterwards. The
  // shot's page (turn 145) is the scene's workspace one level down, and folds with it.
  const sceneDetailDefault =
    /\/scenes\/[^/]+(\/shots\/[^/]+)?\/?$/.test(location.pathname) || /\/story\/chapters\/[^/]+\/?$/.test(location.pathname);
  const folded = railChoice ?? (location.pathname.endsWith("/cut") || sceneDetailDefault);
  /*
   * A mark for every destination, without exception (turn 101). Folded, the label is the tooltip
   * and the mark is the whole item, so a rail entry with no mark is an entry that disappears —
   * which is what happened to `New scene` and `Story structure`, both drawn as a different shape.
   * One shape, one mark, one count: that is the whole of "standardised".
   */
  const MARKS: Record<string, (p: { size?: number }) => ReactNode> = {
    "": Home,
    artifacts: Folder,
    cast: Users,
    story: Message,
    overview: Scroll,
    narrative: Scroll,
    season: Film,
    "story/chapters": Book,
    "story/audiobook": Speaker,
    "story-structure": Folder,
    scenes: Film,
    "branch-map": ListOrdered,
    takes: VideoMark,
    generate: Sparkle,
    cut: VideoMark,
  };
  /*
   * An episode is reached by drilling into the episode tree, and both of its screens live outside
   * the `season` path — the chat under `story/episodes/:id`, the page under `episodes/:id` (turn 91).
   * Neither lights the Episodes item on its own, so the tree claims both child routes explicitly.
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
    destination?: string,
    active?: boolean,
  ) => {
    const Mark = MARKS[slug];
    return (
      <NavLink
        key={`${slug || "dash"}:${label}`}
        to={destination ?? `${base}${slug ? `/${slug}` : ""}`}
        end={end ?? slug === ""}
        title={folded ? label : undefined}
        aria-current={active === undefined ? undefined : active ? "page" : "false"}
        className={({ isActive }) =>
          cx(
            "fy-prodrail__item",
            under && "fy-prodrail__item--under",
            (active ?? (isActive || also)) && "fy-prodrail__item--active",
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
  const railFigure = runtimeSeconds(mediaOnly ? filmSec : cut?.totalSec ?? 0);
  const cutFigure = mediaOnly
    ? runtimeSeconds(filmSec)
    : runtimeSeconds((cut?.totalSec ?? 0) - (cut?.uncoveredSec ?? 0));
  // The switch card counts what the format counts: seconds of cut for video, chapters for story.
  const switchSub = production
    ? shape?.isEpisodic
      ? `series · ${production.episodes.length} episode${production.episodes.length === 1 ? "" : "s"} · ${production.scenes.length} scene${production.scenes.length === 1 ? "" : "s"}`
      : isStory
      ? `${shape!.displayLabel.toLowerCase()} · ${production.chapters.length} chapter${production.chapters.length === 1 ? "" : "s"}`
      : `${shape!.displayLabel.toLowerCase()}${cut ? ` · ${cutFigure} cut` : ""}`
    : "";
  const currentEpisodeId =
    episodeId ?? production?.episodes.find((episode) => sceneId !== undefined && episode.scenes.includes(sceneId))?.id;
  const episodes = [...(production?.episodes ?? [])].sort((a, b) => a.order - b.order);
  // A duplicate order should never be minted (issue 947), but if one lands on disk the rail
  // says so rather than drawing two rows both reading "Episode 1".
  const episodeOrderCounts = new Map<number, number>();
  for (const episode of episodes) episodeOrderCounts.set(episode.order, (episodeOrderCounts.get(episode.order) ?? 0) + 1);
  const duplicateEpisodeOrders = new Set([...episodeOrderCounts].filter(([, count]) => count > 1).map(([order]) => order));
  const orderedScenes = sortScenes(production?.scenes ?? []);
  const scenesById = new Map(orderedScenes.map((scene) => [scene.id, scene]));
  const assignedSceneIds = new Set(episodes.flatMap((episode) => episode.scenes));
  const unassignedScenes = orderedScenes.filter((scene) => !assignedSceneIds.has(scene.id));
  const currentSceneIsUnassigned = sceneId !== undefined && unassignedScenes.some((scene) => scene.id === sceneId);
  const unassignedExpansionKey = `${prodId ?? ""}:__rail_unassigned__`;
  const unassignedOpen =
    episodeExpansion[unassignedExpansionKey] ?? (currentSceneIsUnassigned || episodes.length === 0);
  const generateView = new URLSearchParams(location.search).get("view");
  const inGenerate = location.pathname.endsWith("/generate");
  const takesActive = inGenerate && generateView !== "bench";
  const generateActive = inGenerate && generateView === "bench";
  const defaultSceneEpisodeId = defaultEpisodeFor(production, currentEpisodeId);
  const defaultSceneEpisode = episodes.find((episode) => episode.id === defaultSceneEpisodeId);
  const newSceneLabel = defaultSceneEpisode
    ? `New scene in Episode ${defaultSceneEpisode.order}: ${defaultSceneEpisode.title}`
    : "New unassigned scene";
  const sceneItem = (scene: ProductionBundle["scenes"][number]) => (
    <NavLink
      key={scene.id}
      to={`${base}/scenes/${scene.id}`}
      className={({ isActive }) => cx("fy-prodrail__scene", isActive && "fy-prodrail__scene--active")}
    >
      <span className="fy-prodrail__scene-name">
        {scene.number} · {scene.title}
      </span>
      <span className="fy-prodrail__scene-dot" aria-hidden />
    </NavLink>
  );
  const newSceneItem = (
    <button
      type="button"
      className="fy-prodrail__item fy-prodrail__item--under fy-prodrail__item--press"
      title={folded ? "New scene" : undefined}
      aria-label={newSceneLabel}
      disabled={newScene.pending}
      onClick={() => newScene.create(defaultSceneEpisodeId)}
    >
      <span className="fy-prodrail__mark" aria-hidden={!folded}>
        <Plus size={15} />
      </span>
      <span className="fy-prodrail__label">New scene</span>
    </button>
  );
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
        <div
          className={cx(
            "fy-prodrail",
            shape?.isEpisodic && "fy-prodrail--episodic",
            folded && "fy-prodrail--folded",
          )}
        >
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
          <ProductionSwitcher
            world={world}
            production={production}
            sub={switchSub}
            folded={folded}
            chevron={shape?.isEpisodic ? <ChevronsUpDown size={13} /> : <ChevronRight size={14} />}
          />
          <span className="fy-prodrail__fold-divider" aria-hidden />
          {shape?.isEpisodic ? (
            <>
              {item("", "Overview", undefined, true)}
              {item(
                "season",
                "Episodes",
                String(production?.episodes.length ?? 0),
                true,
                inSeason || inScene,
              )}
              <div className="fy-prodrail__episodes">
                {episodes.map((episode) => {
                  const expansionKey = `${prodId ?? ""}:${episode.id}`;
                  const open = episodeExpansion[expansionKey] ?? episode.id === currentEpisodeId;
                  const duplicateOrder = duplicateEpisodeOrders.has(episode.order);
                  return (
                    <div key={episode.id} className="fy-prodrail__episode">
                      <button
                        type="button"
                        className="fy-prodrail__episode-toggle"
                        aria-expanded={open}
                        aria-label={`${open ? "Collapse" : "Expand"} Episode ${episode.order}: ${episode.title}${duplicateOrder ? " · duplicate number" : ""}`}
                        onClick={() =>
                          setEpisodeExpansion((current) => ({ ...current, [expansionKey]: !open }))
                        }
                      >
                        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="fy-prodrail__episode-name">
                          {duplicateOrder && <span className="fy-dot fy-dot--warn" title="Duplicate number" />}
                          Episode {episode.order} · {episode.title}
                        </span>
                        <span className="fy-prodrail__episode-count">{episode.scenes.length}</span>
                      </button>
                      {open && (
                        <div className="fy-prodrail__scenes">
                          {episode.scenes.map((id, index) => {
                            const scene = scenesById.get(id);
                            return scene === undefined ? (
                              <span key={id} className="fy-prodrail__scene fy-prodrail__scene--missing">
                                {index + 1} · Missing scene
                              </span>
                            ) : (
                              sceneItem(scene)
                            );
                          })}
                          <button
                            type="button"
                            className="fy-prodrail__new-scene"
                            aria-label={`New scene in Episode ${episode.order}: ${episode.title}`}
                            disabled={newScene.pending}
                            onClick={() => newScene.create(episode.id)}
                          >
                            <Plus size={11} />
                            New scene
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {unassignedScenes.length > 0 && (
                  <div className="fy-prodrail__episode">
                    <button
                      type="button"
                      className="fy-prodrail__episode-toggle"
                      aria-expanded={unassignedOpen}
                      aria-label={`${unassignedOpen ? "Collapse" : "Expand"} Unassigned scenes`}
                      onClick={() =>
                        setEpisodeExpansion((current) => ({
                          ...current,
                          [unassignedExpansionKey]: !unassignedOpen,
                        }))
                      }
                    >
                      {unassignedOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      <span className="fy-prodrail__episode-name">Unassigned</span>
                      <span className="fy-prodrail__episode-count">{unassignedScenes.length}</span>
                    </button>
                    {unassignedOpen && <div className="fy-prodrail__scenes">{unassignedScenes.map(sceneItem)}</div>}
                  </div>
                )}
                {production && (
                  <button
                    type="button"
                    className="fy-prodrail__new-episode"
                    onClick={() => {
                      if (!worldId || !prodId) return;
                      // Order has to count episodes staged but not yet accepted too, or this
                      // and a season wrap-up can each land the same number (issue 947).
                      const order = nextEpisodeOrder(world, prodId, production);
                      createEpisode(worldId, prodId, {
                        title: `Episode ${String(order).padStart(2, "0")}`,
                        order,
                      });
                    }}
                  >
                    <Plus size={11} />
                    New episode
                  </button>
                )}
              </div>
              {newSceneItem}
              <span className="fy-prodrail__section-divider" aria-hidden="true" />
              {item(
                "takes",
                "Takes",
                String(production?.takes.length ?? 0),
                false,
                false,
                false,
                `${base}/generate`,
                takesActive,
              )}
              {item("artifacts", "Artifacts", String(artifactCount))}
              {item(
                "generate",
                "Generate",
                String(production?.takes.length ?? 0),
                false,
                false,
                false,
                `${base}/generate?view=bench`,
                generateActive,
              )}
              {item("cut", "Cut", cut ? railFigure : "0:00")}
            </>
          ) : (
            <>
              {item("", "Dashboard")}
              {/* Cast is on both formats' rails (SPEC-020 R-9): a story has a cast as much as a
                  video does, and the count is the guests — the number the rail can say something
                  true about, since the world's cast is shared and belongs to the world's own rail. */}
              {item("cast", "Cast", String(guestCount))}
              {isStory ? (
                <>
                  {item("story", "Develop", "chat", true)}
                  {item("overview", "Overview", production?.story ? `v${production.story.version}` : "—")}
                  {item("story/chapters", "Chapters", String(production?.chapters.length ?? 0))}
                  {/* The reading (turn 146, SPEC-047 R-29): chapters read of those with prose, from the door's last answer. */}
                  {item("story/audiobook", "Audiobook", audiobookCount)}
                  <span className="fy-prodrail__section-divider" aria-hidden="true" />
                  {item("artifacts", "Artifacts", String(artifactCount))}
                </>
              ) : (
                <>
                  {item("story", "Develop", "chat", true)}
                  {item("narrative", "Overview", production?.narrative ? `v${production.narrative.version}` : "—")}
                  {item("scenes", "Scenes", String(production?.scenes.length ?? 0), false, inScene)}
                  {orderedScenes.length > 0 && (
                    <div className="fy-prodrail__scenes fy-prodrail__scenes--production">
                      {orderedScenes.map(sceneItem)}
                    </div>
                  )}
                  {/* Interactive video's structural authority (epic 401): only this Video kind routes here. */}
                  {shape?.isBranching &&
                    item("branch-map", "Branch map", String(production?.routing?.choices.length ?? 0))}
                  {/* A press, not a destination (SPEC-036 R-37): it makes the scene and opens it. */}
                  {newSceneItem}
                  <span className="fy-prodrail__section-divider" aria-hidden="true" />
                  {/* Every format files references, recordings and documents, so the row is on
                      every rail rather than the episodic one alone (design 134). */}
                  {item("artifacts", "Artifacts", String(artifactCount))}
                  {/* Stills is a lens on Generate now (design 55a), not a rail destination. */}
                  {item("generate", "Generate", String(production?.takes.length ?? 0))}
                  {item("cut", "Cut", cut ? railFigure : "0:00")}
                </>
              )}
            </>
          )}
          <div className="fy-prodrail__spacer" />
          <NavLink
            to={`/w/${worldId}`}
            end
            className="fy-prodrail__foot"
            title={folded ? `Part of ${world?.meta.name ?? "the world"}` : undefined}
          >
            <ChevronLeft size={13} />
            {/* The label folds with every other label; the mark and its tooltip carry it. */}
            <span className="fy-prodrail__label">Part of {world?.meta.name ?? "the world"}</span>
          </NavLink>
        </div>
        <div className="fy-prodwrap">
          {/* The production tree is a sibling of the world tree, not a child of it (App.tsx), so
              the world-open refusal has to be stated here too — otherwise a reload or deep link
              onto a production leaves every screen under it on its loader forever (issue 571). */}
          {refusal ? (
            <WorldOpenRefusal worldId={worldId!} reason={refusal.reason} />
          ) : !world ? (
            <Loading label="opening the world" />
          ) : (
            <NewSceneContext.Provider value={newScene}>
              <NewChapterContext.Provider value={newChapter}>
                <Outlet />
              </NewChapterContext.Provider>
            </NewSceneContext.Provider>
          )}
        </div>
      </div>
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
  const newScene = useSharedNewScene(worldId, prodId);
  const [today, setToday] = useState(() => storyProgressDay(new Date()));
  useEffect(() => {
    const now = new Date();
    const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timer = setTimeout(() => setToday(storyProgressDay(new Date())), midnight.getTime() - now.getTime() + 100);
    return () => clearTimeout(timer);
  }, [today]);
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
    const chapters = production.chapters.filter((c) => !c.retired);
    const drafted = chapters.filter((c) => (c.words ?? 0) > 0);
    const totalWords = chapters.reduce((sum, c) => sum + (c.words ?? 0), 0);
    const inHand = chapters.find((c) => !c.words) ?? chapters.at(-1) ?? null;
    const target = targetWords(production.story?.targetLength, chapters.length);
    const progress = production.progress;
    const wordsToday = progress && "unreadable" in progress ? null : progress?.days[today] ?? 0;
    const inHandIdx = inHand ? chapters.indexOf(inHand) : -1;
    // The design shows the neighbourhood of the chapter in hand, not the whole book —
    // the chapter tree is one click away for that.
    const windowStart =
      inHandIdx >= 0
        ? Math.max(0, Math.min(inHandIdx - 1, chapters.length - 4))
        : Math.max(0, chapters.length - 4);
    const nearby = chapters.slice(windowStart, windowStart + 4).filter((chapter) => chapter !== inHand);
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
        <div className="fy-h1row__meta">
          {wordsToday === null ? "Words today unavailable" : `${wordsToday.toLocaleString()} words today`}
          {` · ${totalWords.toLocaleString()}${target === null ? "" : ` / ${target.toLocaleString()}`} words in the book`}
        </div>
        <div className="fy-threadcard" style={{ flex: "none" }}>
          <div className="fy-threadcard__head">
            <span className="fy-threadcard__label">
              {chapters.length === 0
                ? "THE SPINE COMES FIRST"
                : inHand
                  ? `IN HAND · CHAPTER ${inHand.order}`
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
                ? <ChapterPlan chapter={inHand} world={world} story={production.story} />
                : "Every chapter has words. The overview steers whatever comes next."}
          </div>
          <div className="fy-threadcard__actions">
            <Button variant="primary" onClick={() => navigate(inHand ? `/w/${worldId}/p/${prodId}/story/chapters/${encodeURIComponent(inHand.id)}` : `/w/${worldId}/p/${prodId}/story`)}>
              {inHand ? "Continue chapter" : "Open Production Chat"}
            </Button>
          </div>
        </div>
        {nearby.length > 0 && (
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
            {nearby.map((c) => <ChapterOutlineRow key={c.id} chapter={c} world={world} story={production.story} inHand={c === inHand}
              onOpen={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters/${encodeURIComponent(c.id)}`)} />)}
          </div>
        )}
      </div>
    );
  }
  const dayOne = isDayOne(production);
  const decisions = takeDecisions(production);
  const pending = production.takes.filter((t) => decisions[t.id] === "pending");
  const shots = production.scenes.flatMap((s) => orderedShots(s));
  const acceptedShots = shots.filter((s) => acceptedTakeId(production, s.id)).length;
  const nextGap = production.scenes
    .flatMap((scene) => orderedShots(scene).map((shot) => ({ scene, shot })))
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
            newScene={newScene}
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
                      path={takeMediaPath(production, t) ?? ""}
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
                          (sum, id) => sum + resolvedAuthoredDuration(shots.find((s) => s.id === id) ?? {}),
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
  newScene,
}: {
  worldId: string;
  prodId: string;
  onOpen: (path: string, opening?: string) => void;
  newScene: ReturnType<typeof useNewScene>;
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
      </div>
      <div style={{ display: "flex", gap: 12, maxWidth: 640 }}>
        <button type="button" className="fy-radio" style={{ flex: 1 }} disabled={newScene.pending} onClick={() => newScene.create()}>
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
  const contextCount = shape?.hasChapters
    ? production?.chapters.filter((chapter) => !chapter.retired).length ?? 0
    : production?.scenes.length ?? 0;
  const contextUnit = shape?.hasChapters ? "chapter" : "scene";
  const details = shape?.isEpisodic ? "Season" : "Overview";
  const detailsPath = `/w/${worldId}/p/${prodId}/${shape?.isEpisodic ? "season" : shape?.medium === "video" ? "narrative" : "overview"}`;
  /*
   * What this conversation has already staged (turn 92). The season's own file for an episodic
   * production, the overview's for one without a season — a production has one of the two, never
   * both, so a single match is the whole answer.
   */
  const file = shape?.isEpisodic ? "season.json" : "story.json";
  // The style the book is written in is settled here too (turn 128), in its own file.
  const staged =
    (world?.proposals ?? []).find((sp) =>
      sp.proposal.targets.some((t) => t.path === `productions/${prodId}/${file}`),
    ) ??
    (shape?.isEpisodic
      ? null
      : (world?.proposals ?? []).find((sp) =>
          sp.proposal.targets.some((t) => t.path === `productions/${prodId}/prose-style.json`),
        ) ?? null);
  const stagedStyle = staged?.proposal.targets.some((t) => t.path.endsWith("/prose-style.json")) ?? false;
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
            ? "Develop this season here. Shape what it answers, how it ends, and what its episodes are."
            : shape?.medium === "video"
              ? "Develop this film here. Its dramatic question, through-line and ending are edited in Overview."
              : "Develop this story here. Shape the spine, the acts, and what it costs."
        }
        footer={
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="fy-mono">in context:</span>
            <span className="fy-pill">
              all {contextCount} {contextUnit}{contextCount === 1 ? "" : "s"}
            </span>
            <span className="fy-pill">{cast} cast sheets</span>
            {world?.meta.tone && <span className="fy-pill">Tone · {world.meta.tone}</span>}
            <span style={{ flex: 1 }} />
            {/* Where what is being said ends up, named and reachable from where it is said. */}
            <NavLink
              to={detailsPath}
              className="fy-linkbtn"
            >
              {details} &rarr;
            </NavLink>
          </div>
        }
        pointsEmpty={shape?.hasChapters
          ? "New conversation notes appear here. Accepted work is in Overview and Chapters."
          : shape?.isEpisodic
            ? "New conversation notes appear here. Accepted work is in Season and Episodes."
            : "New conversation notes appear here. Accepted work is in Overview and Scenes."}
        {...(opening ? { openWith: opening } : {})}
        {...(staged
          ? {
              side: (
                <StagedDecision
                  worldId={worldId}
                  subject={stagedStyle ? "the style" : shape?.isEpisodic ? "the season" : "the overview"}
                  staged={staged}
                  onAccepted={() => navigate(detailsPath)}
                />
              ),
            }
          : {})}
      />
    </div>
  );
}

export function EpisodePicker({
  episodes,
  selected,
  production,
  worldSlug,
  disabled,
  onSelect,
}: {
  episodes: readonly TakeEpisodeOption[];
  selected: TakeEpisodeOption;
  production: ProductionBundle;
  worldSlug: string | undefined;
  disabled: boolean;
  onSelect: (episode: TakeEpisodeOption) => void;
}) {
  const listId = useId();
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const matches = filterTakeEpisodes(episodes, query);
  const highlighted = Math.min(active, Math.max(0, matches.length - 1));

  useEffect(() => {
    const row = list.current?.children[highlighted] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [highlighted]);

  const show = () => {
    if (open) return;
    setQuery("");
    setActive(Math.max(0, episodes.findIndex((episode) => episode.id === selected.id)));
    setOpen(true);
  };
  const choose = (episode: TakeEpisodeOption) => {
    setQuery("");
    setOpen(false);
    if (episode.id !== selected.id) onSelect(episode);
  };
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (!open && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      show();
      return;
    }
    if (!open) return;
    if (event.key === "ArrowDown" && matches.length > 0) {
      event.preventDefault();
      setActive((index) => (index + 1) % matches.length);
    } else if (event.key === "ArrowUp" && matches.length > 0) {
      event.preventDefault();
      setActive((index) => (index - 1 + matches.length) % matches.length);
    } else if ((event.key === "Enter" || event.key === "Tab") && matches[highlighted] !== undefined) {
      event.preventDefault();
      choose(matches[highlighted]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setOpen(false);
    }
  };

  return (
    <div className="fy-takes__episode-picker">
      <input
        type="text"
        role="combobox"
        aria-label="Episode"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-haspopup="listbox"
        {...(open && matches[highlighted] !== undefined
          ? { "aria-activedescendant": `${listId}-${matches[highlighted]!.id}` }
          : {})}
        className="fy-takes__episode-input"
        value={open ? query : episodeLabel(selected)}
        title={episodeLabel(selected)}
        disabled={disabled}
        onFocus={show}
        onClick={show}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setQuery("");
          setOpen(false);
        }}
      />
      <span className="fy-takes__episode-search" aria-hidden><Search size={13} /></span>
      {open && (
        <ul ref={list} id={listId} role="listbox" aria-label="Episodes" className="fy-takes__episode-menu">
          {matches.length === 0 ? (
            <li className="fy-takes__episode-empty">No matching episodes</li>
          ) : (
            matches.map((episode, index) => {
              const image = episodeThumbnailPath(production, episode);
              return (
                <li
                  key={episode.id}
                  id={`${listId}-${episode.id}`}
                  role="option"
                  aria-selected={episode.id === selected.id}
                  className={cx("fy-takes__episode-option", index === highlighted && "fy-takes__episode-option--active")}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(episode)}
                >
                  <span className="fy-takes__episode-thumb" aria-hidden>
                    {image === null ? (
                      <span>{episode.order === null ? "UN" : String(episode.order).padStart(2, "0")}</span>
                    ) : (
                      <Portrait worldSlug={worldSlug} path={image} label="" radius={0} loading="lazy" />
                    )}
                  </span>
                  <span className="fy-takes__episode-copy">
                    <strong>{episodeLabel(episode)}</strong>
                    <span>{episode.scenes.length} scene{episode.scenes.length === 1 ? "" : "s"}</span>
                  </span>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
