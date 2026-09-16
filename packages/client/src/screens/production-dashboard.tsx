import {
  orderedShots,
  productionAspect,
  productionShape,
  resolvedAuthoredDuration,
  STANDARD_ASPECTS,
  storyProgressDay,
  targetWords,
} from "@arke-studio/contracts";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Composer } from "../components/composer.js";
import { EmptyState, Screen } from "../components/layout.js";
import { Portrait } from "../components/portrait.js";
import { Button } from "../components/ui.js";
import { seconds, usd } from "../lib/format.js";
import { acceptedTakeId, isDayOne, takeDecisions, useProduction } from "../lib/selectors.js";
import {
  attachHostFiles,
  attachHostText,
  hostCanAttach,
  setProductionAspect,
  uploadArtifacts,
} from "../lib/store.js";
import { decisionTone, takeMediaPath } from "../lib/take-presentation.js";
import { DevelopmentWorkspace } from "./development.js";
import { ChapterOutlineRow, ChapterPlan, useNewScene, useSharedNewScene } from "./production-story.js";

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
