import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import {
  assemblePrompt,
  deriveCut,
  deriveEpisodeCut,
  deriveSpineCut,
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
  planScene,
  PRESETS,
  productionAspect,
  productionShape,
  promptFor,
  STANDARD_ASPECTS,
  type CompiledPass,
  type PlanState,
  worldSheets,
  type Scene,
  type Sheet,
  type ArtifactSidecar,
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
  Home,
  PauseSolid,
  Play,
  Plus,
  Sparkle,
  Users,
  VideoMark,
  Waveform,
} from "../components/icons.js";
import { AppChrome } from "../components/chrome.js";
import { DispatchBar, resolveModel } from "../components/dispatch-bar.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { ClipPlayButton, clock } from "../components/player.js";
import { mediaUrl } from "../lib/media.js";
import { CanonEntryRow } from "../domain/domain.js";
import { seconds, usd } from "../lib/format.js";
import { acceptedTakeId, isDayOne, takeDecisions, takesForShot, useProduction } from "../lib/selectors.js";
import { useTalkItThrough } from "../lib/talk-it-through.js";
import { DevelopmentWorkspace } from "./development.js";
import { posterize, posterNameFor } from "../lib/poster.js";
import { useScrubDrag } from "../lib/timeline-drag.js";
import { onMediaReady, syncMediaElement, useTransport } from "../lib/playback-engine.js";
import { mediaTimeFor, spanAt, spineSpans, storySpans, type PlaybackSpan } from "../lib/cut-playback.js";
import {
  acceptTake,
  cancelExport,
  compileSceneBoard,
  createSheetFromSentence,
  dispatchScene,
  draftScene,
  exportCut,
  exportSceneBoard,
  exportWorld,
  proposeStoryOverview,
  rejectTake,
  placeOverlay,
  removeOverlay,
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
} from "../lib/store.js";

/** Production screens (§2.9), composed to the prototype frames 11a/14a/11b/24a/25a/25b/10b. */

// ---- small shared pieces ---------------------------------------------------

/**
 * The artifacts a production may see (SPEC-020 R-13): the world's own, plus the ones it owns.
 * Another production's scoped material is absent — selecting audio by kind alone would put one
 * production's scratch takes in every other production's Audio screen.
 */
function artifactsFor<T extends { production?: string }>(artifacts: readonly T[], productionId: string | undefined): T[] {
  return artifacts.filter((a) => a.production === undefined || a.production === productionId);
}

/** Render @mentions the way the prototype does: quiet mono chips inside prose. */
function Mentions({ text }: { text: string }) {
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
function takeMediaPath(prodId: string, take: { id: string; media?: string }): string | null {
  if (!take.media) return null;
  return `productions/${prodId}/takes/${take.id}/${posterNameFor(take.media)}`;
}

/**
 * The scene's on-disk stem, from the bundle's scan-captured record (issue 387) — never a
 * reconstruction from number and slug, which goes blind the moment a file's name stops
 * matching. Null means the bundle predates the record; the senders skip rather than guess.
 */
function sceneFileOf(production: { sceneFiles: Record<string, string> } | null | undefined, scene: Scene): string | null {
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
  const audioCount =
    (artifactsFor(world?.artifacts ?? [], prodId).filter((a) => a.kind === "audio").length ?? 0) +
    (production?.scenes.flatMap((s) => s.shots).filter((s) => s.audio?.kind === "vo" || s.audio?.kind === "dialogue")
      .length ?? 0);
  const exportCount = Object.values(exportsState).filter((e) => e.productionId === prodId).length;
  const guestCount = prodId ? guestsOf(world?.sheets ?? [], prodId).filter((s) => s.retired !== true).length : 0;
  const base = `/w/${worldId}/p/${prodId}`;
  /*
   * Folded (82a): the Cut opens the world's artifacts beside it, and the width has to come from
   * somewhere. It comes from the labels, never from the destinations — every place the rail
   * reached is still one click away, as a mark with its name on the tooltip.
   */
  const folded = location.pathname.endsWith("/cut");
  const MARKS: Record<string, (p: { size?: number }) => ReactNode> = {
    "": Home,
    cast: Users,
    story: Book,
    scenes: Film,
    generate: Sparkle,
    cut: VideoMark,
    audio: Waveform,
    exports: Archive,
  };
  const item = (slug: string, label: string, count?: string, end?: boolean) => {
    const Mark = MARKS[slug];
    return (
      <NavLink
        key={slug || "dash"}
        to={`${base}${slug ? `/${slug}` : ""}`}
        end={end ?? slug === ""}
        title={folded ? label : undefined}
        className={({ isActive }) => cx("fy-prodrail__item", isActive && "fy-prodrail__item--active")}
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
  // The switch card counts what the format counts: seconds of cut for video, chapters for story.
  const switchSub = production
    ? isStory
      ? `${shape!.displayLabel.toLowerCase()} · ${production.chapters.length} chapter${production.chapters.length === 1 ? "" : "s"}`
      : `${shape!.displayLabel.toLowerCase()}${cut ? ` · ${seconds(cut.totalSec - cut.uncoveredSec)} cut` : ""}`
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
          <button type="button" className="fy-prodrail__switch" onClick={() => navigate(`/w/${worldId}/productions`)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-prodrail__switchname">{production?.meta.title ?? "…"}</div>
              <div className="fy-prodrail__switchsub">{switchSub}</div>
            </div>
            <ChevronRight size={14} />
          </button>
          {item("", "Dashboard")}
          {/* Cast is on both formats' rails (SPEC-020 R-9): a story has a cast as much as a
              video does, and the count is the guests — the number the rail can say something
              true about, since the world's cast is shared and belongs to the world's own rail. */}
          {item("cast", "Cast", String(guestCount))}
          {isStory ? (
            <>
              {/* Development ends where Chapters begins, so the two never light together. */}
              {item("story", "Development", production?.story ? `v${production.story.version}` : "—", true)}
              {item("story/chapters", "Chapters", String(production?.chapters.length ?? 0))}
              {item("audio", "Audio", String(audioCount))}
              {item("exports", "Exports", String(exportCount))}
            </>
          ) : (
            <>
              {/* The rail item reads Development; Story stays a family in the picker (turn 78).
                  The route keeps its name — the rename is display text, never wiring. */}
              {item("story", "Development", production?.story ? `v${production.story.version}` : "—")}
              {item("scenes", "Scenes", String(production?.scenes.length ?? 0))}
              {/* Interactive video's structural authority (epic 401): only this medium routes here. */}
              {shape?.isBranching &&
                item("branch-map", "Branch map", String(production?.routing?.choices.length ?? 0))}
              <NavLink to={`${base}/scenes/new`} className="fy-prodrail__sub">
                <Plus size={12} />
                New scene
              </NavLink>
              {/* Stills is a lens on Generate now (design 55a), not a rail destination. */}
              {item("generate", "Generate", String(production?.takes.length ?? 0))}
              {item("cut", "Cut", cut ? seconds(cut.totalSec) : "0:00")}
              {item("audio", "Audio", String(audioCount))}
              {item("exports", "Exports", String(exportCount))}
            </>
          )}
          <div className="fy-prodrail__spacer" />
          <NavLink to={`/w/${worldId}`} className="fy-prodrail__foot">
            <ChevronLeft size={13} />
            Part of {world?.meta.name ?? "the world"}
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
export function ProductionCastScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const [drafting, setDrafting] = useState<{ type: "character" | "location" | "faction"; name: string; sentence: string } | null>(
    null,
  );

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
  const kindLabel = (sheet: Sheet) => (sheet.type === "character" ? "character" : sheet.type === "location" ? "location" : "faction");

  const card = (sheet: Sheet, guest: boolean) => (
    <button
      key={sheet.id}
      type="button"
      className="fy-gridcard fy-gridcard--media fy-gridcard--fixed"
      onClick={() => navigate(`/w/${worldId}/${sheet.type === "character" ? "cast" : `${sheet.type}s`}/${sheet.id}`)}
    >
      <div className="fy-gridcard__frame" style={{ height: 210 }}>
        <Portrait worldSlug={world.meta.slug} path={sheetPortraitPath(sheet.id)} label={sheet.name} />
      </div>
      <div className="fy-gridcard__pad">
        <div className="fy-gridcard__title">
          <span className="fy-gridcard__name">{sheet.name}</span>
          <span className={`fy-dot fy-dot--${sheet.status === "locked" ? "ok" : "sketch"}`} style={{ width: 6, height: 6 }} />
        </div>
        <div className="fy-gridcard__body">{sheet.role ?? sheet.region ?? kindLabel(sheet)}</div>
        <div className="fy-gridcard__foot" style={{ marginTop: 9 }}>
          {guest ? `guest · v${sheet.version}` : `${kindLabel(sheet)} · v${sheet.version}`}
        </div>
      </div>
    </button>
  );

  const columns = (n: number) => ({ gridTemplateColumns: `repeat(${Math.min(Math.max(n, 2), 4)}, minmax(0, 1fr))` });

  return (
    <div data-screen="production-cast">
      <div className="fy-corner">
        <Button
          variant="primary"
          onClick={() => setDrafting(drafting === null ? { type: "character", name: "", sentence: "" } : null)}
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
              A guest of {production.meta.title} — a full sheet, kept out of the world's cast until you promote it
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
            <label className="scr-field__label">One sentence — the agent drafts the rest inside the sketch</label>
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
            <div key={p.proposalId} className="fy-gridcard fy-gridcard--media fy-gridcard--fixed fy-gridcard--quiet">
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
          <EmptyState title="The world has no cast yet" hint="Everything this production cites would be its own." />
        </div>
      ) : (
        <div className="fy-cardgrid" style={columns(fromWorld.length)}>
          {fromWorld.map((sheet) => card(sheet, false))}
        </div>
      )}

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
      inHandIdx >= 0 ? Math.max(0, Math.min(inHandIdx - 1, chapters.length - 4)) : Math.max(0, chapters.length - 4);
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
              {chapters.length === 0 ? "Open Development" : "Continue in Development"}
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
  const threads = world.canon.filter((c) => c.status === "open");
  const nextGap = production.scenes
    .flatMap((scene) => scene.shots.map((shot) => ({ scene, shot })))
    .find(({ shot }) => !acceptedTakeId(production, shot.id));
  const latest = [...production.takes]
    .sort((a, b) => (b.completedAt ?? b.dispatchedAt).localeCompare(a.completedAt ?? a.dispatchedAt))
    .slice(0, 4);
  const recentDecided = production.takes.filter((t) => decisions[t.id] !== "pending").slice(-3).reverse();

  return (
    <div className="fy-prodmain" data-screen="production-dashboard">
      <div className="fy-h1row">
        <h1 className="fy-h1">{dayOne ? "Day one. The world walked in with you." : "Here's where you left off."}</h1>
        <span className="fy-h1row__meta">
          {dayOne
            ? `${world.sheets.length} sheets · ${world.canon.length} canon entries · tone came along`
            : `${acceptedShots} of ${shots.length} shots covered · ${pending.length} need you`}
        </span>
      </div>
      {/* The one editable delivery-profile field (issue 389): validated and normalized
          server-side, refused per route at dispatch, and every planning surface reads it. */}
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
      {dayOne ? (
        <>
          <div className="fy-threadcard" style={{ flex: "none" }}>
            <div className="fy-threadcard__head">
              <span className="fy-threadcard__label">EVERYTHING {world.meta.name.toUpperCase()} KNOWS IS ALREADY HERE</span>
            </div>
            <div className="fy-threadcard__sub">
              Start from a seed below — an open thread worth pulling — or go straight to Scenes and draft the first one.
            </div>
            <div className="fy-threadcard__actions">
              <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/new`)}>
                Draft the first scene
              </Button>
            </div>
          </div>
          <div>
            <div className="fy-listhead">Seeds — open threads and loose ends</div>
            {threads.map((t) => (
              <CanonEntryRow key={t.id} entry={t} onOpen={() => navigate(`/w/${worldId}/canon/${t.id}/thread`)} />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="fy-dashrow">
            <div className="fy-threadcard">
              <div className="fy-threadcard__head">
                <span className="fy-threadcard__label">AWAITING REVIEW · {pending.length} TAKE{pending.length === 1 ? "" : "S"}</span>
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
                    <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>Open in Generate</Button>
                  </div>
                </div>
              </div>
            )}
          </div>
          <div>
            <div className="fy-listhead">
              Latest clips
              {/* The same keyboard rule as the chapter link: a destination is a button, not a span. */}
              <button type="button" className="fy-linkbtn" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
                All {production.takes.length} takes
              </button>
            </div>
            <div className="fy-cliprow">
              {latest.map((t) => (
                <div key={t.id} className="fy-clip" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
                  <div className="fy-clip__frame">
                    <Portrait
                      worldSlug={world.meta.slug}
                      path={takeMediaPath(production.meta.id, t) ?? ""}
                      label={t.coversShots[0]?.replace("sh_", "shot ") ?? t.id}
                    />
                  </div>
                  <div className="fy-clip__meta">
                    <span className={`fy-dot fy-dot--${decisionTone(decisions[t.id])}`} />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.coversShots.map((s) => s.replace("sh_", "shot ")).join(", ")}
                    </span>
                    <span className="fy-mono">{seconds(t.coversShots.reduce((sum, id) => sum + (shots.find((s) => s.id === id)?.durationSec ?? 0), 0))}</span>
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

// ---- Story (10b) -----------------------------------------------------------

export function StoryScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  // An episodic production's Development is the four-view workspace (turn 48; issue 397); a
  // non-episodic one keeps the single overview — no fake episode or season controls. The
  // branch is a component boundary, not an early return: returning before the overview's own
  // hooks broke the Rules of Hooks the moment a production's shape settled after first render.
  if (production && productionShape(production.meta).isEpisodic) return <DevelopmentWorkspace />;
  return <OverviewStoryScreen />;
}

function OverviewStoryScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const { talk, starting: talkStarting } = useTalkItThrough(worldId);
  const story = production?.story ?? null;
  // The direct overview editor (issue 385): fields staged through the gate, never written live.
  const [editing, setEditing] = useState(false);
  const [logline, setLogline] = useState("");
  const [spine, setSpine] = useState("");
  const [targetLength, setTargetLength] = useState("");
  const [actsText, setActsText] = useState("");
  const spineLines = (story?.spine ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  // What drafting can actually reach: the world's cast plus this production's guests, and not
  // another production's one-offs (SPEC-020 R-7).
  const cast = pickableSheets(world?.sheets ?? [], prodId).filter((s) => s.type === "character").length;
  return (
    <div className="fy-story" data-screen="story-overview">
      <div className="fy-story__chat">
        <div className="fy-story__chathead">
          <div className="fy-eyebrow-sm">
            DEVELOPMENT · {production ? productionShape(production.meta).displayLabel.toLowerCase() : ""}
          </div>
          <h1 className="fy-story__h1">Find the spine together.</h1>
        </div>
        <div className="fy-story__log">
          {production?.treatment ? (
            <div className="fy-bubble--gate" style={{ whiteSpace: "pre-wrap" }}>
              {production.treatment}
            </div>
          ) : story ? (
            <div className="fy-bubble--gate">
              {story.logline}
              <div className="fy-bubble__note">the overview steers scene and chapter drafting — it never overwrites a scene you've locked</div>
            </div>
          ) : (
            <div className="fy-bubble--gate">
              No story yet. The overview — spine, acts, gaps — is authored through the chat gate and steers drafting.
              <div className="fy-bubble__note">start it from a canon thread, or draft a scene and let the spine catch up</div>
            </div>
          )}
        </div>
        <div style={{ flex: "none", padding: "14px 36px 22px" }}>
          {/* The durable Development thread (SPEC-023 R-20, issue 400): one continuous
              conversation over the production, with the same wrap-up gate as world chat. */}
          <Button
            variant="primary"
            disabled={talkStarting || !prodId}
            onClick={() => prodId && talk(`Development · ${production?.meta.title ?? prodId}`, { kind: "production", productionId: prodId })}
          >
            {talkStarting ? "Opening the thread…" : "Talk it through · the Development thread"}
          </Button>
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="fy-mono">in context:</span>
            <span className="fy-pill">
              all {production?.scenes.length ?? 0} scene{(production?.scenes.length ?? 0) === 1 ? "" : "s"}
            </span>
            <span className="fy-pill">{cast} cast sheets</span>
            {world?.meta.tone && <span className="fy-pill">Tone · {world.meta.tone}</span>}
          </div>
        </div>
      </div>
      <div className="fy-story__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>Overview draft</div>
          <span className="fy-mono" style={{ color: story ? "var(--warning)" : undefined }}>
            {story ? `v${story.version}` : "not started"}
          </span>
        </div>
        {editing ? (
          <div style={{ display: "grid", gap: 10 }}>
            <Input placeholder="Logline · one sentence" value={logline} onChange={(e) => setLogline(e.target.value)} />
            <Textarea
              placeholder="Spine · the shape of the whole story"
              value={spine}
              onChange={(e) => setSpine(e.target.value)}
              rows={4}
            />
            <Textarea
              placeholder={"Acts · one per line, as Title: summary"}
              value={actsText}
              onChange={(e) => setActsText(e.target.value)}
              rows={3}
            />
            <Input
              placeholder="Target length · e.g. 90k words, 7 episodes"
              value={targetLength}
              onChange={(e) => setTargetLength(e.target.value)}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!logline.trim() && !spine.trim() && !actsText.trim() && !targetLength.trim()}
                onClick={() => {
                  if (!worldId || !prodId) return;
                  const acts = actsText
                    .split("\n")
                    .map((line) => line.trim())
                    .filter((line) => line.length > 0)
                    .map((line) => {
                      const split = line.indexOf(":");
                      const title = (split >= 0 ? line.slice(0, split) : line).trim();
                      const summary = split >= 0 ? line.slice(split + 1).trim() : "";
                      return { title: title || line, ...(summary ? { summary } : {}) };
                    });
                  proposeStoryOverview(worldId, prodId, {
                    ...(logline.trim() ? { logline: logline.trim() } : {}),
                    ...(spine.trim() ? { spine: spine.trim() } : {}),
                    ...(targetLength.trim() ? { targetLength: targetLength.trim() } : {}),
                    ...(acts.length > 0 ? { acts } : {}),
                  });
                  setEditing(false);
                }}
              >
                Propose overview
              </Button>
            </div>
            <div className="fy-mono">stages a proposal · nothing is written until you accept</div>
          </div>
        ) : (
          story && (
            <div className="fy-draftcard">
              <div className="fy-draftcard__logline">“{story.logline}”</div>
              {spineLines.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  {spineLines.map((line, i) => (
                    <div key={i} className="fy-actrow">
                      <span className="fy-actrow__label">{spineLines.length > 1 ? `ACT ${"I".repeat(Math.min(i + 1, 3))}` : "SPINE"}</span>
                      <span className="fy-actrow__text">{line}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: "grid", gap: 8 }}>
          {!editing && (
            <Button
              variant="secondary"
              onClick={() => {
                setLogline(story?.logline ?? "");
                setSpine(story?.spine ?? "");
                setTargetLength(story?.targetLength ?? "");
                setActsText((story?.acts ?? []).map((a) => `${a.title}${a.summary ? `: ${a.summary}` : ""}`).join("\n"));
                setEditing(true);
              }}
            >
              {story ? "Edit the overview" : "Start the overview"}
            </Button>
          )}
          {production && productionShape(production.meta).hasChapters && (
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters`)}>
              Chapter tree · {production.chapters.length}
            </Button>
          )}
          <div style={{ font: "400 11px/1.5 var(--font-sans)", color: "var(--muted-foreground)", textAlign: "center" }}>
            The overview steers scene and chapter drafting. It never overwrites a scene you've locked.
          </div>
        </div>
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
  const totalSec = production?.scenes.reduce((s, sc) => s + sc.shots.reduce((x, sh) => x + (sh.durationSec ?? 0), 0), 0) ?? 0;
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
                    <span className={`fy-dot fy-dot--${covered === scene.shots.length && scene.shots.length > 0 ? "ok" : "warn"}`} />
                  </div>
                  <div className="fy-row__sub">
                    {scene.shots.length} shots · {seconds(scene.shots.reduce((s, x) => s + (x.durationSec ?? 0), 0))}
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
        <EmptyState title="No scenes yet" hint="Draft a scene and its shots inherit location, time and tone." />
      )}
    </div>
  );
}

// ---- Scene detail (14a) ----------------------------------------------------

export function SceneDetailScreen() {
  const { worldId, prodId, sceneId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { state } = useStore();
  const navigate = useNavigate();
  const { talk, starting: talkStarting } = useTalkItThrough(worldId);
  const [tab, setTab] = useState<"shots" | "board">("shots");
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
  const model = (state?.app.manifest?.models ?? []).find(
    (m) => m.id === state?.app.routing.defaults["video"] && m.capability === "video",
  ) ?? (state?.app.manifest?.models ?? []).find((m) => m.capability === "video") ?? null;
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
              here and land through the same gate as everything else. */}
          <Button
            variant="ghost"
            disabled={talkStarting || !prodId}
            onClick={() => prodId && talk(`Scene · ${scene.title}`, { kind: "scene", productionId: prodId, sceneId: scene.id })}
          >
            {talkStarting ? "Opening…" : "Talk it through"}
          </Button>
          <span className="fy-seg">
            <button type="button" className={cx("fy-seg__item", tab === "shots" && "fy-seg__item--active")} onClick={() => setTab("shots")}>
              Shots
            </button>
            <button type="button" className={cx("fy-seg__item", tab === "board" && "fy-seg__item--active")} onClick={() => setTab("board")}>
              Board
            </button>
          </span>
          <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}>Generate scene…</Button>
        </div>
        <div className="fy-inherits" style={{ marginTop: 12 }}>
          <span className="fy-mono">every shot inherits:</span>
          {scene.inherits?.location && <span className="fy-pill">@{scene.inherits.location}{scene.inherits.timeOfDay ? `, ${scene.inherits.timeOfDay}` : ""}</span>}
          {!scene.inherits?.location && scene.inherits?.timeOfDay && <span className="fy-pill">{scene.inherits.timeOfDay}</span>}
          {scene.inherits?.tone && <span className="fy-pill">Tone · {scene.inherits.tone}</span>}
          <span className="fy-mono">v{scene.version}</span>
        </div>
      </div>
      {tab === "shots" ? (
        <>
          <div className="fy-shotrow">
            {scene.shots.map((shot) => {
              const takes = takesForShot(production, shot.id);
              const accepted = acceptedTakeId(production, shot.id);
              const acceptedTake = accepted ? production.takes.find((t) => t.id === accepted) : null;
              const media = acceptedTake ? takeMediaPath(production.meta.id, acceptedTake) : null;
              return (
                <div key={shot.id} className="fy-shotcard">
                  <div className="fy-shotcard__frame">
                    <Portrait
                      worldSlug={slug}
                      path={media ?? (scene.board ? `productions/${production.meta.id}/${scene.board.image}` : "")}
                      label={`Shot ${shot.id.replace(/^sh_0*/, "")}: ${accepted ? "frame" : "generate or drop a frame"}`}
                      radius={0}
                    />
                  </div>
                  <div className="fy-shotcard__body">
                    <div className="fy-shotcard__head">
                      <span className="fy-shotcard__num">{shot.id.replace(/^sh_0*/, "")}</span>
                      <span className="fy-shotcard__title">{shot.title}</span>
                      <span className={`fy-dot fy-dot--${accepted ? "ok" : "warn"}`} />
                    </div>
                    <div className="fy-shotcard__desc" title="Edited through the gate — @ references a sheet">
                      <Mentions text={shot.description} />
                    </div>
                    <div className="fy-shotcard__tech">
                      {shot.camera && <span>cam: {shot.camera}</span>}
                      {shot.audio?.line && <span>aud: {shot.audio.speaker ? `${shot.audio.speaker}, ` : ""}“{shot.audio.line}”</span>}
                    </div>
                    <div className="fy-shotcard__spacer" />
                    <span className="fy-mono">
                      {seconds(shot.durationSec)} · {takes.length} take{takes.length === 1 ? "" : "s"}
                    </span>
                    <div className="fy-shotcard__actions">
                      {takes.length > 0 ? (
                        <>
                          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}>
                            Regenerate
                          </Button>
                          <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>To clip</Button>
                        </>
                      ) : (
                        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
                          Generate frame
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
            <button type="button" className="fy-addcol" title="New scene" onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/new`)}>
              <Plus size={16} />
            </button>
          </div>
          <div className="fy-scenefoot">
            <span className="fy-h1row__push" />
            {model && (
              <span className="fy-modelchip">
                {model.displayName}
                <span className="fy-mono">max {model.limits.maxDurationSec ?? "∞"}s / clip</span>
                <span
                  style={{ font: "400 11px var(--font-sans)", color: "var(--muted-foreground)", cursor: "pointer" }}
                  onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}
                >
                  Change
                </span>
              </span>
            )}
            <span className="fy-mono">continuity: each clip opens on the last frame before it</span>
          </div>
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
                <span className="fy-boardcard__state" style={{ color: boardStale ? "var(--warning)" : "var(--success)" }}>
                  {scene.board ? (boardStale ? `stale — scene is at v${scene.version}` : "in step with shots") : ""}
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
                In one-pass dispatch this sheet rides along as the scene reference. Per-shot dispatch sends each frame
                instead.
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
        <span className="fy-h1row__meta">a draft arrives as a proposal · accepting creates the shots, dispatches nothing</span>
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
  const shotId = selectedShotId ?? shots[0]?.id ?? null;
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
  const model = (state?.app.manifest?.models ?? []).find((m) => m.id === state?.app.routing.defaults["video"]) ??
    (state?.app.manifest?.models ?? []).find((m) => m.capability === "video") ?? null;

  const prevShot = (() => {
    if (!scene || !shot) return null;
    const i = scene.shots.findIndex((s) => s.id === shot.id);
    return i > 0 ? scene.shots[i - 1]! : null;
  })();
  const prevAccepted = prevShot && production ? production.takes.find((t) => t.id === acceptedTakeId(production, prevShot.id)) : null;
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
  return (
    <div className="fy-gen" data-screen="generate-workspace">
      <div className="fy-gen__left">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span className="fy-seg">
            <span className="fy-seg__item fy-seg__item--active">Shot</span>
            <button type="button" className="fy-seg__item" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/dispatch`)}>
              Scene
            </button>
            <button type="button" className="fy-seg__item" onClick={() => setSearchParams({ view: "stills" }, { replace: true })}>
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
          <button type="button" className="fy-refstrip__add" title="References ride from the kits" onClick={() => navigate(`/w/${worldId}/cast`)}>
            <Plus size={14} />
          </button>
        </div>
        <div className="fy-mono" style={{ marginTop: 6 }}>
          {shot ? `${shot.id.replace("sh_", "shot ")}${citedSheets.length > 0 ? ` · ${citedSheets.map((s) => `${s.name} model sheet v${s.version}`).join(" · ")}` : ""}` : ""}
        </div>
        <div className="fy-gen__label" style={{ marginTop: 16 }}>
          Frames{" "}
          <span className="fy-mono">
            {frameRoute !== null ? "start travels on the first-frame route" : "steering only · no frame route on this model"}
          </span>
        </div>
        {world && (
          <div className="fy-worldlook-line">
            <span>World look · v{world.artDirection.version}</span>
            <small>inherited · carries as text</small>
          </div>
        )}
        <div className="fy-framerow">
          {boundaryFrame ? (
            <div className="fy-frame">
              <Portrait worldSlug={slug} path={`artifacts/${boundaryFrame.file}`} label="Start frame" radius={0} />
              <span className="fy-frame__tag">START · BOUNDARY FRAME{frameRoute !== null ? "" : " (STEERS ONLY)"}</span>
            </div>
          ) : prevFrame ? (
            <div className="fy-frame">
              <Portrait worldSlug={slug} path={prevFrame} label="Start frame" radius={0} />
              <span className="fy-frame__tag">START · {prevShot!.id.replace("sh_", "SHOT ")}, LAST FRAME (PREVIEW)</span>
            </div>
          ) : (
            <div className="fy-frame fy-frame--empty">START · FROM THE BOARD</div>
          )}
          <div className="fy-frame fy-frame--empty">END · OPTIONAL</div>
        </div>
        {shot && production && world && scene && (
          <GeneratePromptEditor world={world} production={production} scene={scene} shot={shot} worldId={worldId!} prodId={prodId!} />
        )}
        <div className="fy-paramrow">
          {/* The production's delivery aspect (issue 389), never a hard-coded landscape. */}
          <span className="fy-param">{production ? productionAspect(production.meta) : "16:9"}</span>
          <span className="fy-param">720p</span>
          {shot && <span className="fy-param">{seconds(shot.durationSec)}</span>}
          {frameRoute !== null && boundaryFrame && <span className="fy-param">opens on its boundary frame</span>}
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
              <Portrait worldSlug={slug} path={takeMediaPath(production!.meta.id, take) ?? ""} label={`Take: first frame`} radius={0} />
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
                disabled={Object.keys(take.provenance.sheets).length === 0 || decisions[take.id] === "rejected"}
                title="A rejection cites the sheet the take drifted from"
                onClick={() => {
                  const sheet = Object.keys(take.provenance.sheets)[0];
                  if (worldId && prodId && sheet)
                    rejectTake(worldId, prodId, take.id, { sheet, field: "appearance", note: "rejected in review" }, shotId ?? undefined);
                }}
              >
                Reject · cite the sheet
              </Button>
              <span className="fy-h1row__push" />
              <span className="fy-mono">rejections teach the shot · accepts lock the clip into the cut</span>
            </div>
          </>
        ) : (
          <EmptyState title="No takes for this shot yet" hint="Dispatch sends the shot out; takes land here for review." />
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
              <Portrait worldSlug={slug} path={takeMediaPath(production!.meta.id, t) ?? ""} label={`take ${i + 1}`} radius={0} />
            </div>
            <div className="fy-taketile__meta">
              <span>{i + 1}</span>
              <span className={`fy-dot fy-dot--${decisionTone(decisions[t.id])}`} style={{ width: 5, height: 5 }} />
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
  const assembled = assemblePrompt(world.meta, world.sheets, scene, shot);
  const current = promptFor(world.meta, world.sheets, scene, shot);
  const stale = overrideStaleAgainst(shot, world.sheets);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? current.text;
  return (
    <>
      <div className="fy-gen__label" style={{ marginTop: 16 }}>
        Prompt <span className="fy-mono">assembled from the world, edit freely</span>

        <span
          style={{ marginLeft: "auto", font: "400 11px var(--font-sans)", color: "var(--muted-foreground)", cursor: "pointer" }}
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
        Added at dispatch, not editable here: a numbered line per reference image naming its
        subject and what it references, and — for video —{" "}
        <span className="fy-mono">no subtitles</span>
        {shot.audio?.kind === "silence" ? (
          <>
            {" "}
            and <span className="fy-mono">no audio</span>
          </>
        ) : (
          <>
            {" "}
            (plus <span className="fy-mono">no background music</span> where the cut carries its own
            score)
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
      if (event.productionId === prodId && event.disposition === "failed") {
        setRefused(event.reason ?? "the plan could not be created");
      }
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
                onClick={() => planContinue(worldId, prodId, state.planId, (state.next as { passIndex: number }).passIndex)}
              >
                Continue · pass {state.next.passIndex} ·{" "}
                {usd(state.passes[state.next.passIndex]?.estimatedMicroUsd ?? 0)}
              </Button>
            )}
            {state.next.kind === "await-reconfirm" && (
              <Button
                variant="primary"
                onClick={() => planReconfirm(worldId, prodId, state.planId, (state.next as { passIndex: number }).passIndex)}
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
    choice.resolution ?? (model && choice.tier !== undefined ? nativeResolution(model, choice.tier) : undefined);

  // The whole plan, computed live from the world — the same function the coordinator executes.
  const plans = useMemo(() => {
    if (!world || !production || !scene || !model) return null;
    const input = {
      world: world.meta,
      artDirection: world.artDirection,
      productionId: production.meta.id,
      // The production's standing constraints, so the dialog plans what the coordinator executes
      // (issue 244, round 3). Without it the preview showed a prompt missing the production's own
      // negatives while the server sent them — and this screen's whole claim is that it runs the
      // same function on the same inputs.
      production: {
        ...(production.meta.musicPolicy !== undefined ? { musicPolicy: production.meta.musicPolicy } : {}),
        failureModes: production.meta.failureModes,
      },
      sheets: world.sheets,
      kits: world.referenceKits,
      scene,
      selections: production.selections,
      model,
      // The world's shelf, so a durable boundary frame resolves here exactly as it will at the
      // coordinator (issue 154) — the dialog's claim is that it runs the same function.
      artifacts: world.artifacts,
      // The production's delivery aspect (issue 389), on the same same-function claim.
      ...(production.meta.aspect !== undefined ? { aspect: production.meta.aspect } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    };
    return { perShot: planScene(input, "per-shot"), wholeScene: planScene(input, "whole-scene") };
  }, [world, production, scene, model, resolution, choice.tier]);

  // The compiled passes (issue 398): the same object the coordinator maps into queue requests,
  // so the rows below ARE the dispatch — route, length, references, estimate — not a summary
  // that can drift from it. Compilation refuses what dispatch would refuse; the warning rows
  // already say why, so a refusal here just leaves no rows to show.
  const compiled = useMemo(() => {
    if (!world || !production || !scene || !model || !plans) return null;
    const compile = (plan: typeof plans.perShot, chainWholeSceneFrames = false) => {
      try {
        return compilePasses({ productionId: production.meta.id, scene, plan, model, world, chainWholeSceneFrames });
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
  const passRow = (pass: CompiledPass): string => {
    const route =
      pass.route.kind === "frame"
        ? "first-frame route"
        : pass.route.kind === "reference"
          ? `reference route · refs ×${pass.references.length}`
          : "text route";
    const length = pass.askedSec !== undefined ? ` · ${seconds(pass.askedSec)}` : "";
    return `${route}${length} · ${usd(pass.estimatedMicroUsd)}`;
  };

  const sceneFile = scene ? sceneFileOf(production, scene) : null;
  const warnings = plans?.perShot.warnings ?? null;
  // A shot no route can cover blocks rather than warns: the dispatch would be refused anyway,
  // and finding that out after pressing a priced button is the failure this dialog exists to
  // prevent. Named per shot, with the length that would fit.
  const overlong = plans?.perShot.warnings.overlongShots ?? [];
  const overlongPasses = plans?.wholeScene.warnings.overlongPasses ?? [];
  const warningRows: Array<{ key: string; text: string }> = [];
  if (warnings) {
    for (const s of warnings.shotsWithoutFrame) warningRows.push({ key: `nf-${s.shotId}`, text: `shot ${s.number} has no accepted frame` });
    // Issue 154: strict frame behaviour is promised exactly where the route receives it — the
    // shot opens on its durable boundary still, and the references that stepped aside are named.
    for (const f of warnings.framedShots)
      warningRows.push({
        key: `bf-${f.shotId}`,
        text: `shot ${f.number} opens on its boundary frame${
          f.setAside.length > 0 ? ` — ${f.setAside.join(", ")} step aside, the frame route takes one image` : ""
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
    for (const name of warnings.sketchCitations) warningRows.push({ key: `sk-${name}`, text: `${name} is a sketch — dispatch cites an unlocked sheet` });
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
    for (const name of warnings.retiredCitations) warningRows.push({ key: `re-${name}`, text: `${name} is retired and still cited here` });
    for (const u of warnings.unknownMentions) warningRows.push({ key: `un-${u}`, text: `@${u} resolves to nothing — check the description` });
    // SPEC-020 R-6: the mention resolved, and the sheet belongs to another production. Named,
    // never blocked — borrowing somebody else's one-off is unusual, not wrong.
    for (const g of warnings.foreignGuests)
      warningRows.push({ key: `fg-${g.name}`, text: `${g.name} belongs to ${g.owner}, not to this production` });
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
              {scene.title} · {scene.shots.length} shots · {seconds(scene.shots.reduce((s, x) => s + (x.durationSec ?? 4), 0))}
            </span>
          )}
          <span className="fy-h1row__push" />
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate`)}>
            Close
          </Button>
        </div>
        <div className="fy-choicerow">
          {(production?.scenes ?? []).map((s, i) => (
            <Button key={s.id} variant={i === sceneIdx ? "primary" : "secondary"} onClick={() => setSceneIdx(i)}>
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
        {world && model && (
          <Callout title={`World look · v${world.artDirection.version}`}>
            Inherited from this world and carried in the prompt. {model.accepts.referenceImages === 0
              ? `${model.displayName} accepts no reference images. Those images are omitted; only existing sheet descriptions and art-direction text remain.`
              : "Identity references remain distinct from the world's style treatment."}
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
                  shot {shot.number} runs {seconds(shot.durationSec)} — {model?.displayName ?? "this model"} makes at
                  most {seconds(shot.longestSec)}
                  {shot.becauseReferences ? " on the reference route this shot will take" : ""}. Shorten the shot,
                  split it, or pick another model.
                </li>
              ))}
              {overlongPasses.map((pass) => (
                <li key={`pass-${pass.passIndex}`}>
                  scene pass {pass.passIndex} runs {seconds(pass.durationSec)} — the longest this route makes is{" "}
                  {seconds(pass.longestSec)}
                  {pass.becauseReferences ? ", because the pass carries references" : ""}.
                </li>
              ))}
            </ul>
          </Callout>
        )}
        {warningRows.length > 0 ? (
          <Callout tone="warning" title={`${warningRows.length} thing${warningRows.length === 1 ? "" : "s"} worth knowing — none blocks`}>
            <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
              {warningRows.map((w) => (
                <li key={w.key}>{w.text}</li>
              ))}
            </ul>
          </Callout>
        ) : (
          plans && <Callout title="Clean dispatch">Every cited sheet is locked and current; every reference rides.</Callout>
        )}
        {/* The bar says which model and why it cannot run; this says what that costs you here,
            rather than leaving the two dispatch cards to vanish without explanation. */}
        {!model && (
          <Callout tone="warning" title="Nothing to dispatch with">
            The model this production is set to cannot run. Pick one above, or fix it in Settings —
            nothing is re-routed for you.
          </Callout>
        )}
        {plans && overlong.length === 0 && !plans.perShot.warnings.payloadOverflow && (
          <div style={{ display: "flex", gap: 14 }}>
            <div className="fy-boardcard" style={{ flex: 1 }}>
              <div className="fy-boardcard__head">Per shot</div>
              <div className="fy-boardcard__body">
                One clip per shot, each seeded by its own frame. Any shot retries alone; cast stays pinned per shot.
              </div>
              <div className="fy-boardcard__mono">
                est. {usd(plans.perShot.totalEstimatedMicroUsd)}
                {compiled?.perShot?.map((pass) => (
                  <span key={pass.target.coversShots.join("-")}>
                    {"\n"}
                    {pass.target.kind === "shot" ? `shot ${pass.target.coversShots[0]!.replace("sh_", "")}` : "pass"} ·{" "}
                    {passRow(pass)}
                  </span>
                ))}
              </div>
              <div style={{ marginTop: 12 }}>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (worldId && prodId && sceneFile && model) {
                      dispatchScene(worldId, prodId, sceneFile, "per-shot", model.id, resolution, choice.tier);
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
              <div className="fy-boardcard__body">Best motion continuity — but a retry re-runs its whole pass.</div>
              {plans.wholeScene.pack.ok && overlongPasses.length > 0 ? (
                <div className="fy-boardcard__body" style={{ color: "var(--destructive)" }}>
                  pass {overlongPasses[0]!.passIndex} runs {seconds(overlongPasses[0]!.durationSec)} — the longest this
                  route makes is {seconds(overlongPasses[0]!.longestSec)}
                  {overlongPasses[0]!.becauseReferences ? ", because the pass carries references" : ""}. Shorten a
                  shot or pick another model.
                </div>
              ) : plans.wholeScene.pack.ok ? (
                <>
                  <div className="fy-boardcard__mono">
                    {plans.wholeScene.pack.passes.length} pass{plans.wholeScene.pack.passes.length === 1 ? "" : "es"} under the{" "}
                    {model!.limits.maxDurationSec ?? "∞"}s cap
                    {plans.wholeScene.pack.passes.map((p, i) => (
                      <span key={p.index}>
                        {"\n"}pass {p.index} · shots {p.plan.map((e) => e.number).join(", ")}
                        {compiled?.wholeScene?.[i] ? ` · ${passRow(compiled.wholeScene[i]!)}` : ` · ${seconds(p.durationSec)}`}
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 8 }}>
                    <Button
                      variant="primary"
                      onClick={() => {
                        if (worldId && prodId && sceneFile && model) {
                          dispatchScene(worldId, prodId, sceneFile, "whole-scene", model.id, resolution, choice.tier);
                          navigate(`/w/${worldId}/p/${prodId}/generate`);
                        }
                      }}
                    >
                      Dispatch whole scene · {usd(plans.wholeScene.totalEstimatedMicroUsd)}
                    </Button>
                    {/* SPEC-024: a plan chains each pass behind the previous pass's boundary
                        frame — offered exactly where a route exists to receive one, priced from
                        the CHAINED compile, because that is what the plan authorizes. */}
                    {model && frameDispatchFor(model, 1) !== null && plans.wholeScene.pack.passes.length > 1 && compiled?.chained && (
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
                              dispatchScenePlanned(worldId, prodId, sceneFile, "whole-scene", model.id, "review-gated", resolution, choice.tier);
                            }
                          }}
                        >
                          Plan · continuity chain · ask before each pass
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            if (worldId && prodId && sceneFile && model) {
                              dispatchScenePlanned(worldId, prodId, sceneFile, "whole-scene", model.id, "pre-authorized", resolution, choice.tier);
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
                  shot {plans.wholeScene.pack.oversizeShot.number} runs {plans.wholeScene.pack.oversizeShot.durationSec}s — longer than
                  the {plans.wholeScene.pack.oversizeShot.capSec}s cap, and half a shot cannot be reviewed.
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
  const navigate = useNavigate();
  const spoken = production?.scenes.flatMap((s) => s.shots).filter((s) => s.audio?.line && s.audio.speaker) ?? [];
  // The shot the row asked for. Without this the dialog showed whichever line came first, so
  // pressing Generate beside one character opened another character's line.
  const asked = params.get("shot");
  const shot = spoken.find((s) => s.id === asked) ?? spoken[0];
  const speaker = shot?.audio?.speaker ? world?.sheets.find((c) => c.id === shot.audio!.speaker) : undefined;
  const [sending, setSending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const pending = useRef<string | null>(null);
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
              <Portrait worldSlug={world?.meta.slug} path={sheetPortraitPath(speaker.id)} label={speaker.name} radius={8} />
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ font: "600 14px var(--font-sans)" }}>{speaker.name}</div>
              <div style={{ font: "400 13px/1.5 var(--font-sans)", color: "var(--muted-foreground)", fontStyle: "italic", marginTop: 2 }}>
                “{shot.audio!.line}”
              </div>
              <div className="fy-mono" style={{ marginTop: 4 }}>
                voice · {speaker.voice ? `${speaker.voice.label ?? speaker.voice.voiceId} (${speaker.voice.provider})` : "none assigned"}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState title="No spoken lines in this production yet" />
        )}
        {refusal !== null && <p className="fy-refusal">{refusal}</p>}
        <div>
          <Button
            variant="primary"
            data-testid="voice-line-generate"
            disabled={shot === undefined || speaker === undefined || speaker.voice === undefined || sending}
            title={
              speaker !== undefined && speaker.voice === undefined
                ? `${speaker.name} has no assigned voice — choose one on their sheet`
                : undefined
            }
            onClick={() => {
              if (!worldId || !prodId || !shot) return;
              setRefusal(null);
              setSending(true);
              pending.current = requestVoiceLine({ worldId, productionId: prodId, shotId: shot.id });
            }}
          >
            {sending ? "Generating…" : "Generate line"}
          </Button>
        </div>
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
const OVERLAY_DEFAULT_SEC = 4;

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
        <Button variant="outline" size="sm" disabled={worldId === undefined} onClick={() => worldId && uploadArtifacts(worldId)}>
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
        <span className="fy-mono">drag onto the OV lane to place</span>
      </div>
    </div>
  );
}

/**
 * The overlay lane (82a): the one place on the cut where position is the author's.
 *
 * A drop reads its own x, which is why the lane computes the time rather than the panel — and
 * why `V` can stay derived while this one is stored.
 */
function OverlayLane({
  worldId,
  prodId,
  totalSec,
  overlays,
  artifacts,
}: {
  worldId: string;
  prodId: string;
  totalSec: number;
  overlays: readonly CutOverlay[];
  artifacts: readonly ArtifactSidecar[];
}) {
  const [over, setOver] = useState(false);
  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    setOver(false);
    const artifactId = e.dataTransfer.getData("application/x-arke-artifact");
    if (!artifactId || totalSec <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const at = Math.max(0, Math.min(((e.clientX - box.left) / box.width) * totalSec, Math.max(0, totalSec - 0.1)));
    const end = Math.min(at + OVERLAY_DEFAULT_SEC, totalSec);
    // A drop at the very end would ask for a window with no length; give it what is left.
    placeOverlay(worldId, prodId, artifactId, Math.round(at * 1000) / 1000, Math.round(Math.max(end, at + 0.1) * 1000) / 1000);
  };
  return (
    <div className="fy-track">
      <span className="fy-track__label">OV</span>
      <div
        className={cx("fy-track__lane", "fy-ovlane", over && "fy-ovlane--over")}
        onDragOver={(e) => {
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        {overlays.length === 0 && <span className="fy-ovlane__empty">drop an artifact to lay it over the picture</span>}
        {overlays.map((o) => {
          const file = artifacts.find((a) => a.id === o.artifactId)?.file;
          return (
            <div
              key={o.id}
              className="fy-ovclip"
              style={{
                left: `${(o.startSec / totalSec) * 100}%`,
                width: `${Math.max(((o.endSec - o.startSec) / totalSec) * 100, 1.5)}%`,
              }}
              title={`${file ?? o.artifactId} · ${o.startSec.toFixed(1)}s → ${o.endSec.toFixed(1)}s`}
            >
              <span className="fy-ovclip__name">{file?.split("/").pop() ?? "missing artifact"}</span>
              <button
                type="button"
                className="fy-ovclip__x"
                aria-label="Remove overlay"
                onClick={() => removeOverlay(worldId, prodId, o.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
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
  useTransport({ playing, durationSec: totalSec, timeRef, onTime: setTime, onEnded: () => setPlaying(false) });
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
  restartToken,
  transport,
}: {
  slug: string | undefined;
  spans: PlaybackSpan[];
  totalSec: number;
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

  const srcFor = (span: PlaybackSpan | null) =>
    span?.path && slug ? mediaUrl(slug, span.path) : null;

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
        src: srcFor(span),
        targetSec: span ? mediaTimeFor(span, at) : 0,
        playing: true,
        nowMs: ts,
      });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, spans, slug]);

  // Paused: one sync, so a seek lands on the right frame without a loop running. A source that
  // was not ready when it was asked calls back through onMediaReady, since nothing else will.
  useEffect(() => {
    const el = video.current;
    if (el === null || playing) return;
    const push = () => {
      const at = timeRef.current;
      const span = spanAt(spans, at);
      syncMediaElement(el, {
        src: srcFor(span),
        targetSec: span ? mediaTimeFor(span, at) : 0,
        playing: false,
        nowMs: 0,
      });
    };
    onMediaReady(el, push);
    push();
  }, [playing, time, spans, slug, timeRef]);

  const current = spanAt(spans, time);
  const showing = srcFor(current);

  return (
    <div className="fy-cutviewer">
      <video ref={video} className="fy-cutviewer__video" playsInline muted style={{ opacity: showing === null ? 0 : 1 }} />
      {showing === null && (
        <span className="fy-cutviewer__empty">{current ? current.label : "nothing here yet"}</span>
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
  const maxTrim = ceiling?.ok && ceiling.ceilingSec !== undefined ? Math.max(0, ceiling.ceilingSec - TRIM_STEP_SEC) : undefined;
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
          className={cx("fy-trim__value", trimmable && "fy-trim__value--drag", drag.dragging && "fy-trim__value--dragging")}
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
  const clips = cut.segments.filter((seg): seg is SpineCutSegment & { shotId: string } => seg.kind === "clip" && !!seg.shotId);
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
                  <Portrait worldSlug={slug} path={seg.media ? posterize(seg.media.path) : ""} label={`SC ${seg.sceneNumber}`} radius={0} />
                  <span className="fy-cutseg__tag">SC {seg.sceneNumber}</span>
                </button>
              );
            }
            if (seg.kind === "slate") {
              return (
                <div key={`${seg.kind}-${i}`} className="fy-cutseg fy-cutseg--gap fy-cutseg--gap-warn" style={{ flex: span }}>
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
  const takeSec = selected?.takeId ? production.takeMediaInfo[selected.takeId]?.mediaInfo.durationSec : undefined;

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
      lane.push({ kind: "gap", label: `shot ${e.shot.number}`, span: e.durationSec, warn: true, scene: e.sceneNumber, key: e.shot.id });
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
  const totalSec = spineCut ? spineCut.trackDurationSec : (cut?.totalSec ?? 0);
  const transport = useCutTransport(totalSec);
  const audioBeds = artifactsFor(world?.artifacts ?? [], prodId).filter((a) => a.kind === "audio");


  return (
    <div className="fy-cutcols" data-screen="cut">
      <ArtifactPanel worldId={worldId} artifacts={world?.artifacts ?? []} slug={slug} />
      <div className="fy-prodmain" style={{ minHeight: "100%" }}>
      <div className="fy-h1row">
        <h1 className="fy-h1">The cut</h1>
        <span className="fy-h1row__meta">
          {spineCut
            ? `${seconds(spineCut.trackDurationSec)} · ${seconds(spineCut.trackDurationSec - spineCut.blackSec)} of ${seconds(spineCut.trackDurationSec)} covered · cut to the track`
            : cut
              ? `${seconds(cut.totalSec)} · ${cut.covered} of ${cut.entries.length} shots covered · assembled from accepted takes only`
              : ""}
          {(production?.cut.overlays.length ?? 0) > 0 && ` · ${production!.cut.overlays.length} overlay`}
        </span>
        <span className="fy-h1row__push" />
        <Button onClick={() => setWatchToken((n) => n + 1)}>Watch from top</Button>
        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/exports`)}>
          Export cut…
        </Button>
      </div>
      <CutPreview
        slug={slug}
        spans={spineCut ? spineSpans(spineCut) : cut ? storySpans(cut) : []}
        totalSec={totalSec}
        restartToken={watchToken}
        transport={transport}
      />
      <div className="fy-timeline">
        <CutScrubber totalSec={totalSec} transport={transport} />
        <div className="fy-tracks">
          {totalSec > 0 && (
            <div className="fy-playhead" style={{ left: `${Math.min(100, (transport.time / totalSec) * 100)}%` }} aria-hidden />
          )}
        {worldId && prodId && production && cut ? (
          spineCut ? (
            <SpineCutTrack worldId={worldId} prodId={prodId} slug={slug} cut={spineCut} production={production} />
          ) : (
            <StoryCutTrack worldId={worldId} prodId={prodId} slug={slug} cut={cut} production={production} />
          )
        ) : null}
        {worldId && prodId && (
          <OverlayLane
            worldId={worldId}
            prodId={prodId}
            totalSec={totalSec}
            overlays={production?.cut.overlays ?? []}
            artifacts={world?.artifacts ?? []}
          />
        )}
        <div className="fy-track">
          <span className="fy-track__label">A</span>
          <div className="fy-track__lane">
            {audioBeds.length > 0 ? (
              audioBeds.slice(0, 2).map((a) => (
                <div key={a.id} className="fy-audioseg" style={{ flex: 1 }}>
                  <span style={{ flex: "none", display: "inline-flex" }}>
                    <Wave seed={a.file} width={120} height={14} />
                  </span>
                  {a.file.split("/").pop()}
                </div>
              ))
            ) : (
              <div className="fy-audioseg" style={{ flex: 1 }}>
                no beds yet · audio artifacts land here
              </div>
            )}
          </div>
        </div>
        </div>
        <div className="fy-cutfoot">
          <span className="fy-mono">
            {spineCut
              ? `${spineCut.segments.filter((seg) => seg.kind === "clip").length} of ${spineCut.segments.filter((seg) => seg.kind !== "black").length} anchors covered`
              : cut
                ? `${cut.covered} of ${cut.entries.length} shots placed · ${cut.gaps} gap${cut.gaps === 1 ? "" : "s"}`
                : ""}
          </span>
          <span className="fy-h1row__push" />
          {spineCut
            ? spineCut.blackSec > 0 && (
                <span className="fy-warnchip">
                  <span className="fy-dot fy-dot--warn" />
                  {spineCut.segments.filter((seg) => seg.kind === "black").length} black · {seconds(spineCut.blackSec)} uncovered
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
        <span className="fy-mono">
          the cut is a projection — it recomputes from shot selections; restoring an earlier cut means restoring the
          selections that produced it
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
    : (production?.scenes.flatMap((s) => s.shots).filter((s) => s.audio?.kind === "vo" || s.audio?.kind === "dialogue") ??
      []);
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
        {voLines.length === 0 && <div className="fy-mono" style={{ padding: "10px 0" }}>no spoken lines in the shots yet</div>}
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
              <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/voice-line?shot=${encodeURIComponent(s.id)}`)}>
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
        {linked.length === 0 && <div className="fy-mono" style={{ padding: "10px 0" }}>no audio artifacts yet — imports land here</div>}
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
          style={{ font: "400 11px var(--font-sans)", color: "var(--muted-foreground)", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}
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
  world: { artifacts: readonly { id: string; mediaInfo?: { durationSec: number; hasAudio: boolean } }[] } | null | undefined,
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
  if (cut.slateSec > 0) notes.push(`${seconds(cut.slateSec)} is a labelled slate naming the shot that is missing`);
  // Plain black carries no label: the exporter draws text on slates only.
  if (cut.blackSec > 0) notes.push(`${seconds(cut.blackSec)} is plain black, anchored to no shot at all`);
  if (cut.unanchoredShotIds.length > 0) {
    const n = cut.unanchoredShotIds.length;
    notes.push(`${n} shot${n === 1 ? "" : "s"} anchored nowhere in the song, so ${n === 1 ? "it is" : "they are"} not in the film at all`);
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
          ? cut?.totalSec
          : undefined;
  /*
   * An unmeasured track does not block: exporting is what measures it, and the coordinator probes
   * an artifact with no stored measurement, then renders or refuses in words. A missing artifact
   * and a silent one do block, because no probe rescues either.
   */
  const blocked = refusal !== null || view.kind === "no-track" || view.kind === "silent";
  const presetCopy: Record<string, { label: string; sub: string }> = {
    "review-cut": { label: "Review cut", sub: `mp4 ${PRESETS["review-cut"].width}×${PRESETS["review-cut"].height} · timecode · fastest` },
    master: { label: "Master", sub: `${PRESETS.master.width}×${PRESETS.master.height} · clean` },
    "social-excerpt": { label: "Social excerpt", sub: `${PRESETS["social-excerpt"].width}×${PRESETS["social-excerpt"].height} · 9:16 · captions` },
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
                  {episodeCut.gaps > 0 ? ` · ${episodeCut.gaps} gap${episodeCut.gaps === 1 ? "" : "s"} as slates` : ""}
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
        {mine.length === 0 && <div className="fy-mono" style={{ padding: "10px 0" }}>nothing delivered yet</div>}
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
            <button key={p} type="button" className={cx("fy-radio", preset === p && "fy-radio--on")} onClick={() => setPreset(p)}>
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
            The spine names a track this world does not have, so there is nothing to measure or cut against. Assign a
            track again — the anchors are unaffected.
          </div>
        )}
        {view.kind === "silent" && (
          <div className="fy-notecard">
            <span className="fy-dot fy-dot--warn" />
            The master track has no audio stream, so there is no song to cut against. Assign a track that carries audio
            — nothing else about the production changes.
          </div>
        )}
        {view.kind === "unmeasured" && (
          <div className="fy-notecard">
            <span className="fy-dot fy-dot--warn" />
            The master track has not been measured yet, so its length is not known here. Exporting measures it first and
            renders against it — or says why it cannot be read. Nothing about the production changes either way.
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
                    {presetCopy[preset]?.label ?? "This export"} cannot be made yet — {refusal.detail}.{" "}
                  </>
                )}
                {notes.length > 0 ? (
                  <>
                    A review cut renders anyway: {notes.join("; ")}. An unfinished film still reviews.
                  </>
                ) : (
                  <>A review cut renders the whole song as it stands.</>
                )}
              </div>
            );
          })()}
        {view.kind === "scene-order" && cut && cut.gaps > 0 && (
          <div className="fy-notecard">
            <span className="fy-dot fy-dot--warn" />
            The cut has {cut.gaps} gap{cut.gaps === 1 ? "" : "s"} ({seconds(cut.uncoveredSec)}). They export as black
            slates carrying their labels and durations — an unfinished film still reviews.
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
            {runtimeSec === undefined ? "Export" : <>Export · {seconds(runtimeSec)}</>}
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
          world export: a folder that reopens identically elsewhere — history kept, caches and locks stay behind · lands
          under ArkeStudio\exports
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
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14 }}>
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
                          rejectTake(worldId, prodId, take.id, { sheet, field: "appearance", note: "rejected from the contact sheet" }, shotId);
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
