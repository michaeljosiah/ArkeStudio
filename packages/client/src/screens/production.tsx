import { useMemo, useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate, useParams, useSearchParams } from "react-router";
import {
  assemblePrompt,
  deriveCut,
  modelCapabilityCopy,
  nativeResolution,
  overrideStaleAgainst,
  planScene,
  PRESETS,
  promptFor,
  type Scene,
  type Shot,
  type SizeTier,
} from "@arke-studio/contracts";
import { DegradedBanner, EmptyState, Screen } from "../components/layout.js";
import { Badge, Button, Callout, Textarea, cx } from "../components/ui.js";
import { ChevronLeft, ChevronRight, Play, Plus } from "../components/icons.js";
import { AppChrome } from "../components/chrome.js";
import { DispatchBar, resolveModel } from "../components/dispatch-bar.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { ClipPlayButton } from "../components/player.js";
import { mediaUrl } from "../lib/media.js";
import { CanonEntryRow } from "../domain/domain.js";
import { seconds, usd } from "../lib/format.js";
import { acceptedTakeId, isDayOne, takeDecisions, takesForShot, useProduction } from "../lib/selectors.js";
import {
  acceptTake,
  cancelExport,
  compileSceneBoard,
  dispatchScene,
  draftScene,
  exportCut,
  exportSceneBoard,
  exportWorld,
  rejectTake,
  setPromptOverride,
  useExports,
  useStore,
  useWorld,
} from "../lib/store.js";

/** Production screens (§2.9), composed to the prototype frames 11a/14a/11b/24a/25a/25b/10b. */

// ---- small shared pieces ---------------------------------------------------

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

/** A take's poster image: video takes keep a frame.png beside the clip, stills are their own poster. */
function takeMediaPath(prodId: string, take: { id: string; media?: string }): string | null {
  if (!take.media) return null;
  const poster = /\.(mp4|webm)$/i.test(take.media) ? "frame.png" : take.media;
  return `productions/${prodId}/takes/${take.id}/${poster}`;
}

/** Same convention for paths that arrive already assembled (the derived cut). */
function posterize(path: string): string {
  return path.replace(/[^/]+\.(mp4|webm)$/i, "frame.png");
}

function sceneFileOf(scene: Scene): string {
  return `${String(scene.number).padStart(2, "0")}-${scene.slug}`;
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
  const exportsState = useExports();
  // The rail is the format's (design 54a): a surface the format cannot use is not present,
  // not greyed. A story production has nothing to dispatch, so its rail never says so.
  const isStory = production?.meta.format === "story";
  const cut = production ? deriveCut(production) : null;
  const audioCount =
    (world?.artifacts.filter((a) => a.kind === "audio").length ?? 0) +
    (production?.scenes.flatMap((s) => s.shots).filter((s) => s.audio?.kind === "vo" || s.audio?.kind === "dialogue")
      .length ?? 0);
  const exportCount = Object.values(exportsState).filter((e) => e.productionId === prodId).length;
  const base = `/w/${worldId}/p/${prodId}`;
  const item = (slug: string, label: string, count?: string, end?: boolean) => (
    <NavLink
      key={slug || "dash"}
      to={`${base}${slug ? `/${slug}` : ""}`}
      end={end ?? slug === ""}
      className={({ isActive }) => cx("fy-prodrail__item", isActive && "fy-prodrail__item--active")}
    >
      {label}
      {count !== undefined && <span className="fy-prodrail__count">{count}</span>}
    </NavLink>
  );
  // The switch card counts what the format counts: seconds of cut for video, chapters for story.
  const switchSub = production
    ? isStory
      ? `story · ${production.chapters.length} chapter${production.chapters.length === 1 ? "" : "s"}`
      : `${production.meta.format}${cut ? ` · ${seconds(cut.totalSec - cut.uncoveredSec)} cut` : ""}`
    : "";
  return (
    <div className="fy-app">
      <AppChrome
        back={{ label: "World", to: `/w/${worldId}` }}
        context={{
          label: production ? `${production.meta.title} · ${production.meta.format}` : "…",
          to: `/w/${worldId}/productions`,
        }}
      />
      <div className="fy-prod">
        <div className="fy-prodrail">
          <button type="button" className="fy-prodrail__switch" onClick={() => navigate(`/w/${worldId}/productions`)}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-prodrail__switchname">{production?.meta.title ?? "…"}</div>
              <div className="fy-prodrail__switchsub">{switchSub}</div>
            </div>
            <ChevronRight size={14} />
          </button>
          {item("", "Dashboard")}
          {isStory ? (
            <>
              {/* Story ends where Chapters begins, so the two never light together. */}
              {item("story", "Story", production?.story ? `v${production.story.version}` : "—", true)}
              {item("story/chapters", "Chapters", String(production?.chapters.length ?? 0))}
              {item("audio", "Audio", String(audioCount))}
              {item("exports", "Exports", String(exportCount))}
            </>
          ) : (
            <>
              {item("story", "Story", production?.story ? `v${production.story.version}` : "—")}
              {item("scenes", "Scenes", String(production?.scenes.length ?? 0))}
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
  if (production.meta.format === "story") {
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
                  inHand ? ` · chapter ${String(inHand.number).padStart(2, "0")} in hand` : ""
                } · ${totalWords.toLocaleString()} words`}
          </span>
        </div>
        <div className="fy-threadcard" style={{ flex: "none" }}>
          <div className="fy-threadcard__head">
            <span className="fy-threadcard__label">
              {chapters.length === 0
                ? "THE SPINE COMES FIRST"
                : inHand
                  ? `IN HAND · CHAPTER ${inHand.number} OF ${chapters.length}`
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
              {chapters.length === 0 ? "Open Story" : "Continue in Story"}
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
                <span className="fy-mono">{String(c.number).padStart(2, "0")}</span>
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
                        : `world-art.png`
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
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const story = production?.story ?? null;
  const spineLines = (story?.spine ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  const cast = world?.sheets.filter((s) => s.type === "character").length ?? 0;
  return (
    <div className="fy-story" data-screen="story-overview">
      <div className="fy-story__chat">
        <div className="fy-story__chathead">
          <div className="fy-eyebrow-sm">STORY OVERVIEW · {production?.meta.format ?? ""}</div>
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
              <div className="fy-bubble__note">the overview steers scene drafting and packing — it never overwrites a scene you've locked</div>
            </div>
          ) : (
            <div className="fy-bubble--gate">
              No story yet. The overview — spine, acts, gaps — is authored through the chat gate and steers drafting.
              <div className="fy-bubble__note">start it from a canon thread, or draft a scene and let the spine catch up</div>
            </div>
          )}
        </div>
        <div style={{ flex: "none", padding: "14px 36px 22px" }}>
          <div className="fy-composer">
            <span className="fy-composer__hint">Keep shaping the story… · authored through the gate</span>
            <span className="fy-mono">↵ send</span>
          </div>
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
        {story && (
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
        )}
        <div style={{ flex: 1 }} />
        <div style={{ display: "grid", gap: 8 }}>
          {production?.meta.format === "story" && (
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters`)}>
              Chapter tree · {production.chapters.length}
            </Button>
          )}
          <div style={{ font: "400 11px/1.5 var(--font-sans)", color: "var(--muted-foreground)", textAlign: "center" }}>
            The overview steers scene drafting and packing. It never overwrites a scene you've locked.
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
              <span className="fy-mono">{String(c.number).padStart(2, "0")}</span>
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
          title={production?.meta.format === "story" ? "No chapters yet" : "Chapters belong to story productions"}
          hint={
            production?.meta.format === "story"
              ? "Chapters hang beneath the overview and are drafted through the gate."
              : "This is a video production — its structure lives in Scenes."
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
              <Button onClick={() => worldId && prodId && compileSceneBoard(worldId, prodId, sceneFileOf(scene))}>
                Recompile · free, local
              </Button>
              <Button
                variant="ghost"
                disabled={!scene.board}
                onClick={() => worldId && prodId && exportSceneBoard(worldId, prodId, sceneFileOf(scene))}
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
          Frames <span className="fy-mono">start required · end optional</span>
        </div>
        {world && (
          <div className="fy-worldlook-line">
            <span>World look · v{world.artDirection.version}</span>
            <small>inherited · carries as text</small>
          </div>
        )}
        <div className="fy-framerow">
          {prevFrame ? (
            <div className="fy-frame">
              <Portrait worldSlug={slug} path={prevFrame} label="Start frame" radius={0} />
              <span className="fy-frame__tag">START · {prevShot!.id.replace("sh_", "SHOT ")}, LAST FRAME</span>
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
          <span className="fy-param">16:9</span>
          <span className="fy-param">720p</span>
          {shot && <span className="fy-param">{seconds(shot.durationSec)}</span>}
          {prevShot && prevFrame && <span className="fy-param">opens on {prevShot.id.replace("sh_", "shot ")}'s last frame</span>}
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
            setPromptOverride(worldId, prodId, sceneFileOf(scene), shot.id, null);
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
            setPromptOverride(worldId, prodId, sceneFileOf(scene), shot.id, value.trim());
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

export function DispatchDialogScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const { state } = useStore();
  const navigate = useNavigate();
  const capability = production?.meta.format === "stills" ? "image" : "video";
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
      sheets: world.sheets,
      kits: world.referenceKits,
      scene,
      selections: production.selections,
      model,
      ...(resolution !== undefined ? { resolution } : {}),
      ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
    };
    return { perShot: planScene(input, "per-shot"), wholeScene: planScene(input, "whole-scene") };
  }, [world, production, scene, model, resolution, choice.tier]);

  const sceneFile = scene ? sceneFileOf(scene) : null;
  const warnings = plans?.perShot.warnings ?? null;
  // A shot no route can cover blocks rather than warns: the dispatch would be refused anyway,
  // and finding that out after pressing a priced button is the failure this dialog exists to
  // prevent. Named per shot, with the length that would fit.
  const overlong = plans?.perShot.warnings.overlongShots ?? [];
  const warningRows: Array<{ key: string; text: string }> = [];
  if (warnings) {
    for (const s of warnings.shotsWithoutFrame) warningRows.push({ key: `nf-${s.shotId}`, text: `shot ${s.number} has no accepted frame` });
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
        {overlong.length > 0 && (
          <Callout tone="warning" title="Too long for this model">
            <ul style={{ margin: 0, paddingLeft: "1.2em" }}>
              {overlong.map((shot) => (
                <li key={shot.shotId}>
                  shot {shot.number} runs {seconds(shot.durationSec)} — {model?.displayName ?? "this model"} makes at
                  most {seconds(shot.longestSec)}. Shorten the shot, split it, or pick another model.
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
              <div className="fy-boardcard__mono">est. {usd(plans.perShot.totalEstimatedMicroUsd)}</div>
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
              {plans.wholeScene.pack.ok ? (
                <>
                  <div className="fy-boardcard__mono">
                    {plans.wholeScene.pack.passes.length} pass{plans.wholeScene.pack.passes.length === 1 ? "" : "es"} under the{" "}
                    {model!.limits.maxDurationSec ?? "∞"}s cap
                    {plans.wholeScene.pack.passes.map((p) => (
                      <span key={p.index}>
                        {"\n"}pass {p.index} · {seconds(p.durationSec)} · shots {p.plan.map((e) => e.number).join(", ")}
                      </span>
                    ))}
                  </div>
                  <div style={{ marginTop: 12 }}>
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
      </div>
    </div>
  );
}

export function VoiceLineDialogScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const shot = production?.scenes.flatMap((s) => s.shots).find((s) => s.audio?.line && s.audio.speaker);
  const speaker = shot?.audio?.speaker ? world?.sheets.find((c) => c.id === shot.audio!.speaker) : undefined;
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
        <div>
          <Button variant="primary" disabled title="Voice generation arrives with SPEC-011">
            Generate line
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Cut (24a) -------------------------------------------------------------

export function CutScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const cut = production ? deriveCut(production) : null;
  const slug = world?.meta.slug;
  const firstCovered = cut?.entries.find((e) => e.media);
  const audioBeds = world?.artifacts.filter((a) => a.kind === "audio") ?? [];

  // Group the derived cut per scene for the V track: contiguous covered runs render as
  // filmstrip cells; each gap is its own dashed cell — remaining work made visible.
  const sceneSegments = (production?.scenes ?? []).map((scene) => {
    const entries = cut?.entries.filter((e) => e.sceneNumber === scene.number) ?? [];
    const covered = entries.filter((e) => e.media);
    const gaps = entries.filter((e) => !e.media);
    const coveredSec = covered.reduce((s, e) => s + e.durationSec, 0);
    return { scene, covered, gaps, coveredSec, firstMedia: covered[0]?.media?.path ?? null };
  });

  return (
    <div className="fy-prodmain" data-screen="cut" style={{ minHeight: "100%" }}>
      <div className="fy-h1row">
        <h1 className="fy-h1">The cut</h1>
        <span className="fy-h1row__meta">
          {cut ? `${seconds(cut.totalSec)} · ${cut.covered} of ${cut.entries.length} shots covered · assembled from accepted takes only` : ""}
        </span>
        <span className="fy-h1row__push" />
        <Button disabled title="Playback arrives with the packaged player">
          Watch from top
        </Button>
        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/p/${prodId}/exports`)}>
          Export cut…
        </Button>
      </div>
      <div className="fy-cutviewer">
        <Portrait worldSlug={slug} path={firstCovered?.media ? posterize(firstCovered.media.path) : ""} label="Cut preview" radius={0} />
        <span className="fy-playbtn" aria-hidden style={{ pointerEvents: "none" }}>
          <Play size={22} />
        </span>
        {firstCovered && (
          <span className="fy-viewer__tag">
            0:00 / {seconds(cut?.totalSec)} · scene {firstCovered.sceneNumber}, {firstCovered.shot.id.replace("sh_", "shot ")}
          </span>
        )}
      </div>
      <div className="fy-timeline">
        <div className="fy-timeline__ruler">
          <span className="fy-mono">0:00</span>
          <span className="fy-h1row__push" />
          <span className="fy-mono">{seconds((cut?.totalSec ?? 0) / 2)}</span>
          <span className="fy-h1row__push" />
          <span className="fy-mono">{seconds(cut?.totalSec)}</span>
        </div>
        <div className="fy-track">
          <span className="fy-track__label">V</span>
          <div className="fy-track__lane">
            {sceneSegments.map(({ scene, covered, gaps, coveredSec, firstMedia }) => (
              <div key={scene.id} style={{ display: "flex", gap: 4, flex: Math.max(coveredSec + gaps.reduce((s, g) => s + g.durationSec, 0), 2), minWidth: 0 }}>
                {covered.length > 0 && (
                  <div className="fy-cutseg" style={{ flex: Math.max(coveredSec, 1) }}>
                    <Portrait worldSlug={slug} path={firstMedia ? posterize(firstMedia) : ""} label={`SC ${scene.number}`} radius={0} />
                    <span className="fy-cutseg__tag">
                      SC {scene.number} · {seconds(coveredSec)}
                    </span>
                  </div>
                )}
                {covered.length > 0
                  ? gaps.map((g) => (
                      <div key={g.shot.id} className="fy-cutseg fy-cutseg--gap fy-cutseg--gap-warn" style={{ flex: Math.max(g.durationSec, 1) }}>
                        {g.shot.id.replace("sh_", "shot ")}
                      </div>
                    ))
                  : (
                      <div className="fy-cutseg fy-cutseg--gap" style={{ flex: Math.max(gaps.reduce((s, g) => s + g.durationSec, 0), 2) }}>
                        scene {scene.number}, no takes yet
                      </div>
                    )}
              </div>
            ))}
          </div>
        </div>
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
        <div className="fy-cutfoot">
          <span className="fy-mono">
            {cut ? `${cut.covered} of ${cut.entries.length} shots placed · ${cut.gaps} gap${cut.gaps === 1 ? "" : "s"}` : ""}
          </span>
          <span className="fy-h1row__push" />
          {cut && cut.gaps > 0 && (
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
  const isStory = production?.meta.format === "story";
  const linked = world?.artifacts.filter((a) => a.kind === "audio") ?? [];
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
              <span className="fy-audiorow__status">
                <span className="fy-dot fy-dot--warn" />
                not generated
              </span>
              <Button onClick={() => navigate(`/w/${worldId}/p/${prodId}/generate/voice-line`)}>Generate</Button>
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

export function ExportsScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const exportsState = useExports();
  // A story has no cut to render, and a manuscript exporter does not exist yet — so this pane
  // offers neither rather than a zero-length video (design 54a). It stays on the story rail
  // because the world folder export lives here, and the chapters travel whole inside it.
  const isStory = production?.meta.format === "story";
  const cut = production ? deriveCut(production) : null;
  const mine = Object.entries(exportsState).filter(([, e]) => e.productionId === prodId);
  const [preset, setPreset] = useState<keyof typeof PRESETS>("review-cut");
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
                {production?.meta.title} · render {id.slice(0, 8)}
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
        {cut && cut.gaps > 0 && (
          <div className="fy-notecard">
            <span className="fy-dot fy-dot--warn" />
            The cut has {cut.gaps} gap{cut.gaps === 1 ? "" : "s"} ({seconds(cut.uncoveredSec)}). They export as black
            slates carrying their labels and durations — an unfinished film still reviews.
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
          <span className="fy-mono">renders locally · no provider call</span>
          <span className="fy-h1row__push" />
          <Button variant="primary" onClick={() => worldId && prodId && exportCut(worldId, prodId, preset)}>
            Export · {seconds(cut?.totalSec)}
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
