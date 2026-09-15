import {
  audiobookDoorLine,
  buildRenderPlan,
  deriveCut,
  guestsOf,
  isMediaOnly,
  pickableSheets,
  productionShape,
  resolvePictureTimeline,
  sortScenes,
  type ProductionBundle,
} from "@arke-studio/contracts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { AppChrome } from "../components/chrome.js";
import { ProductionConversation, StagedDecision } from "../components/conversation.js";
import {
  Book,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Film,
  Folder,
  Home,
  ListOrdered,
  Message,
  PanelLeft,
  Plus,
  Scroll,
  Sparkle,
  Speaker,
  Users,
  VideoMark,
} from "../components/icons.js";
import { Loading } from "../components/loading.js";
import { cx } from "../components/ui.js";
import { useWorldOpenRefusal, WorldOpenRefusal } from "../components/world-open-refusal.js";
import { productionShelf } from "../lib/artifact-view.js";
import { editorTimeline } from "../lib/editor-timeline.js";
import { runtimeSeconds } from "../lib/format.js";
import { defaultEpisodeFor } from "../lib/production-navigation.js";
import { useRailCollapsed } from "../lib/rail-collapsed.js";
import { nextEpisodeOrder, useProduction } from "../lib/selectors.js";
import { createEpisode, openAudiobook, useAudiobookDoors, useStore } from "../lib/store.js";
import { useAudiobookDoorStamp, useChapterReading } from "./audiobook.js";
import { exportViewFor } from "./editor-export.js";
import { NewChapterContext, NewSceneContext, useNewChapter, useNewScene } from "./production-story.js";

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
  /** The record the Cut edits and previews (`lib/editor-timeline.ts`), so the rail measures the same film. */
  let record: ReturnType<typeof editorTimeline> = null;
  if (production) {
    try {
      const timeline = production.timeline ?? { status: "absent" as const };
      if (timeline.status === "invalid") throw new Error(timeline.message);
      record = editorTimeline(production, timeline, world?.artifacts ?? []);
      cut = record === null
        ? deriveCut(production)
        : resolvePictureTimeline(production, { status: "ready", timeline: record }, world?.artifacts ?? []);
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
  if (mediaOnly && production && record !== null) {
    // The plan's length, off the same record the Cut header states — legacy placements folded
    // in until the first write saves them (issue 1159) — so the two never disagree again.
    const planned = buildRenderPlan({ production, timeline: { status: "ready", timeline: record }, artifacts: world?.artifacts ?? [], scope: { kind: "production" }, preset: "review-cut" });
    filmSec = planned.ok ? planned.plan.totalSec : 0;
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
  const audiobookStamp = useAudiobookDoorStamp(production, world);
  const audiobookReading = useChapterReading(worldId, prodId);
  useEffect(() => {
    if (!worldId || !prodId || !isStory || shellConnection !== "open" || (audiobookReading && audiobookDoor !== null)) return;
    openAudiobook(worldId, prodId);
  }, [worldId, prodId, isStory, shellConnection, audiobookReading, audiobookDoor === null, audiobookStamp]);
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
  // Position labels keep the rail unambiguous even if two on-disk orders collide. The warning
  // still exposes the data problem; displaying a position never rewrites an episode's order.
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
    ? `New scene in Episode ${episodes.indexOf(defaultSceneEpisode) + 1}: ${defaultSceneEpisode.title}`
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
                {episodes.map((episode, index) => {
                  const expansionKey = `${prodId ?? ""}:${episode.id}`;
                  const open = episodeExpansion[expansionKey] ?? episode.id === currentEpisodeId;
                  const duplicateOrder = duplicateEpisodeOrders.has(episode.order);
                  return (
                    <div key={episode.id} className="fy-prodrail__episode">
                      <button
                        type="button"
                        className="fy-prodrail__episode-toggle"
                        aria-expanded={open}
                        aria-label={`${open ? "Collapse" : "Expand"} Episode ${index + 1}: ${episode.title}${duplicateOrder ? " · duplicate number" : ""}`}
                        onClick={() =>
                          setEpisodeExpansion((current) => ({ ...current, [expansionKey]: !open }))
                        }
                      >
                        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                        <span className="fy-prodrail__episode-name">
                          {duplicateOrder && <span className="fy-dot fy-dot--warn" title="Duplicate number" />}
                          Episode {index + 1} · {episode.title}
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
                            aria-label={`New scene in Episode ${index + 1}: ${episode.title}`}
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
