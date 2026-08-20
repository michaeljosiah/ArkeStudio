import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { seasonFindings, sortScenes, type Episode, type SeasonFinding } from "@arke-studio/contracts";
import { EmptyState } from "../components/layout.js";
import { ProductionConversation } from "../components/conversation.js";
import { Badge, Button, Input, cx } from "../components/ui.js";
import { useProduction } from "../lib/selectors.js";
import { useTalkItThrough } from "../lib/talk-it-through.js";
import { proposeEpisode, reorderEpisodes } from "../lib/store.js";

/**
 * The Development workspace for an episodic production (turns 48, 53, 78; SPEC-023; issue 397).
 *
 * Four views, one tab strip — Season, Episodes, Arcs, Direction — and three tabs, not four
 * greyed, while no episodes exist (turn 48). Season and Direction author one object each and
 * keep the split; Episodes and Arcs are comparisons across the season and take the full
 * surface. Everything here proposes through the gate: reorder is the one direct act, and it
 * rewrites order fields alone.
 */

type Tab = "season" | "episodes" | "arcs" | "direction";

export function DevelopmentWorkspace() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const [tab, setTab] = useState<Tab>("season");
  if (!production) {
    return (
      <div className="fy-prodmain" data-screen="development">
        <EmptyState title="Opening Development…" />
      </div>
    );
  }
  const episodes = production.episodes;
  const hasEpisodes = episodes.length > 0;
  const shown: Tab = tab === "episodes" && !hasEpisodes ? "season" : tab;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "season", label: "Season" },
    ...(hasEpisodes ? [{ id: "episodes" as Tab, label: `Episodes · ${episodes.length}` }] : []),
    { id: "arcs", label: "Arcs" },
    { id: "direction", label: "Direction" },
  ];
  return (
    <div className="fy-prodmain" data-screen="development">
      <div className="fy-h1row">
        <h1 className="fy-h1">Development</h1>
        <span className="fy-h1row__meta">
          {production.season ? `season v${production.season.version}` : "no season record yet"}
        </span>
        <span className="fy-h1row__push" />
        <span className="fy-seg">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={cx("fy-seg__item", shown === t.id && "fy-seg__item--active")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </span>
      </div>
      {shown === "season" && <SeasonView />}
      {shown === "episodes" && hasEpisodes && <EpisodesBoard />}
      {shown === "arcs" && <ArcsView />}
      {shown === "direction" && <DirectionView />}
    </div>
  );
}

/** Season and Direction author one object, so they keep the split (turn 48). */
function SeasonView() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const season = production?.season ?? null;
  const series = world?.series.find((s) => prodId !== undefined && s.seasons.includes(prodId)) ?? null;
  const defaults = season?.defaults;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 470px", gap: 24 }}>
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        eyebrow="DEVELOPMENT · SEASON"
        heading="What is this season about?"
        placeholder="Keep shaping the season…"
        emptyLine="Nothing decided yet. Say what this season is about and how it ends, and the draft builds beside this."
      />
      <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
        {/* Inheritance is shown, not hidden (turn 48): the Series engine is read-only here, and
            editing it is the Series' own accept — never a side effect of a season edit. */}
        <div className="fy-draftcard">
          <div className="fy-eyebrow-sm">SERIES ENGINE · READ-ONLY</div>
          {series ? (
            <>
              <div style={{ font: "600 14px var(--font-sans)", marginTop: 6 }}>{series.title}</div>
              <div style={{ font: "400 12.5px/1.6 var(--font-sans)", marginTop: 6 }}>
                {series.engine ?? "The engine has not been written yet."}
              </div>
              <div className="fy-mono" style={{ marginTop: 10 }}>
                governs {series.seasons.length} season{series.seasons.length === 1 ? "" : "s"} · editing it is the
                Series’ own accept
              </div>
            </>
          ) : (
            <div style={{ font: "400 12.5px/1.6 var(--font-sans)", marginTop: 6 }}>
              This production belongs to no Series.
            </div>
          )}
        </div>
        {defaults && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {defaults.episodeCount !== undefined && <span className="fy-pill">{defaults.episodeCount} episodes</span>}
            {defaults.episodeSecondsMin !== undefined && defaults.episodeSecondsMax !== undefined && (
              <span className="fy-pill">
                {defaults.episodeSecondsMin}–{defaults.episodeSecondsMax}s each
              </span>
            )}
            {defaults.hookWindowSec !== undefined && <span className="fy-pill">hook in {defaults.hookWindowSec}s</span>}
            {defaults.episodeEnding !== undefined && <span className="fy-pill">{defaults.episodeEnding}</span>}
          </div>
        )}
        <NewEpisodeCard />
      </div>
    </div>
  );
}

function NewEpisodeCard() {
  const { worldId, prodId } = useParams();
  const [title, setTitle] = useState("");
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <Input placeholder="New episode · name it" value={title} onChange={(e) => setTitle(e.target.value)} />
      <Button
        variant="secondary"
        disabled={title.trim().length === 0}
        onClick={() => {
          if (!worldId || !prodId) return;
          proposeEpisode(worldId, prodId, { title: title.trim() });
          setTitle("");
        }}
      >
        Propose the episode
      </Button>
    </div>
  );
}

/** Episodes compare across the season, so the board takes the full surface (turn 48). */
function EpisodesBoard() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const episodes = production?.episodes ?? [];
  const findings = production ? seasonFindings(production, world?.sheets ?? []) : [];
  const move = (index: number, delta: number) => {
    if (!worldId || !prodId) return;
    const ids = episodes.map((e) => e.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorderEpisodes(worldId, prodId, ids);
  };
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
        {episodes.map((episode, index) => (
          <div key={episode.id} className="fy-draftcard" style={{ cursor: "pointer" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <span className="fy-mono">{String(episode.order).padStart(2, "0")}</span>
              <button
                type="button"
                className="fy-linkbtn"
                style={{ font: "600 14px var(--font-sans)", textAlign: "left" }}
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/episodes/${episode.id}`)}
              >
                {episode.title}
              </button>
              <span style={{ marginLeft: "auto", display: "flex", gap: 2 }}>
                <button type="button" className="fy-linkbtn" aria-label="Move earlier" onClick={() => move(index, -1)}>
                  ↑
                </button>
                <button type="button" className="fy-linkbtn" aria-label="Move later" onClick={() => move(index, 1)}>
                  ↓
                </button>
              </span>
            </div>
            {/* The card says its gaps in words (turn 53): never a colour doing the work alone. */}
            <div className="fy-mono" style={{ marginTop: 10 }}>
              HOOK · {episode.promise?.opens ? episode.promise.opens.slice(0, 60) : "NO HOOK YET"}
            </div>
            <div className="fy-mono" style={{ marginTop: 4 }}>
              CLIFF · {episode.promise?.closes ? episode.promise.closes.slice(0, 60) : "NO ENDING YET"}
            </div>
            <div style={{ marginTop: 10 }}>
              <Badge tone="outline">
                {episode.scenes.length} scene{episode.scenes.length === 1 ? "" : "s"}
              </Badge>
            </div>
          </div>
        ))}
      </div>
      <FindingsPanel findings={findings} />
      {/* A comparison keeps the surface; the conversation becomes a row at its foot (turn 48). */}
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        placeholder="This episode needs a reason to exist…"
        emptyLine="No episodes yet. Say what the season breaks into and the tiles build beside it."
      />
    </div>
  );
}

/** Named findings, never a score (turn 78; Scope §04). Empty is said, not hidden. */
function FindingsPanel({ findings }: { findings: SeasonFinding[] }) {
  return (
    <div data-testid="season-findings">
      <div className="fy-listhead">Season findings</div>
      {findings.length === 0 ? (
        <div className="fy-mono">Nothing to flag — every check that can run came back clean.</div>
      ) : (
        findings.map((finding, i) => (
          <div key={`${finding.kind}-${finding.about}-${i}`} className="fy-listrow">
            <Badge tone="outline">{finding.kind}</Badge>
            <span className="fy-listrow__text">{finding.message}</span>
            <span className="fy-mono">{finding.about}</span>
          </div>
        ))
      )}
    </div>
  );
}

/** Arc lanes are things that change, not characters (turn 48): SETUP, TURN, PAYOFF in words. */
function ArcsView() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const episodes = production?.episodes ?? [];
  const arcs = production?.season?.arcs ?? [];
  const stalled = arcs.filter((a) => a.setup !== undefined && a.payoff === undefined);
  return (
    <div style={{ display: "grid", gap: 14 }}>
      {stalled.length > 0 && (
        <div className="fy-mono" style={{ color: "var(--destructive)" }}>
          {stalled.map((a) => `"${a.title}" has no payoff`).join(" · ")}
        </div>
      )}
      {arcs.length === 0 ? (
        <EmptyState
          title="No arcs yet"
          hint="Arc lanes live on the season. Propose them from the Season view or talk them through."
        />
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", minWidth: 480 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "6px 10px" }} className="fy-mono">
                  ARC
                </th>
                {episodes.map((e) => (
                  <th key={e.id} style={{ padding: "6px 10px" }} className="fy-mono">
                    {String(e.order).padStart(2, "0")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {arcs.map((arc) => (
                <tr key={arc.id}>
                  <td style={{ padding: "6px 10px", font: "600 13px var(--font-sans)" }}>{arc.title}</td>
                  {episodes.map((e) => {
                    const cell =
                      arc.setup === e.id ? "SETUP" : arc.turn === e.id ? "TURN" : arc.payoff === e.id ? "PAYOFF" : "";
                    return (
                      <td
                        key={e.id}
                        className="fy-mono"
                        style={{
                          padding: "6px 10px",
                          textAlign: "center",
                          ...(cell === "" && arc.payoff === undefined && e.id === episodes[episodes.length - 1]?.id
                            ? { color: "var(--destructive)" }
                            : {}),
                        }}
                      >
                        {cell || (arc.payoff === undefined && e.id === episodes[episodes.length - 1]?.id ? "—" : "")}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* A comparison keeps the surface; the conversation becomes a row at its foot (turn 48). */}
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        placeholder="A lane needs to land somewhere…"
        emptyLine="No lanes yet. Say what changes across this season and the grid builds beside it."
      />
    </div>
  );
}

function DirectionView() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const season = production?.season ?? null;
  const look = world?.artDirection ?? null;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 470px", gap: 24 }}>
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        eyebrow="DEVELOPMENT · DIRECTION"
        heading="What this season does differently."
        placeholder="Keep shaping the direction…"
        emptyLine="Nothing narrowed yet. This season inherits the world's look; say what it does differently and the lines build beside this."
      />
      <div style={{ display: "grid", gap: 12, alignContent: "start" }}>
        {/* The world look first, always (turn 48): a season narrows it and never replaces it, so
            what is being narrowed has to be on the screen doing the narrowing. */}
        <div className="fy-draftcard">
          <div className="fy-draftcard__head">
            <span className="fy-eyebrow-sm">{world?.meta.name ?? "The world"} · master look</span>
            <Badge tone="neutral">inherited</Badge>
          </div>
          <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 6 }}>
            {look?.description ?? "This world has no look written yet."}
          </div>
        </div>
        <div className="fy-draftcard">
          <div className="fy-eyebrow-sm">THIS SEASON NARROWS IT</div>
          <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 6 }}>
            {season?.direction ?? "Not written yet."}
          </div>
        </div>
        {/* Stated, not implied: the reach of this decision is one season, and a person about to
            write it needs to know that before they do. */}
        <div className="fy-emptycard">
          <div className="fy-eyebrow-sm">WHAT THIS DOES NOT DO</div>
          <div style={{ font: "400 12.5px/1.6 var(--font-sans)", marginTop: 6 }}>
            {world?.meta.name ?? "The world"}’s look is unchanged, and no other production moves.
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One episode screen where there were two (turn 53c): the conversation on the left, the promise
 * and the scenes in order on the right. A script belongs to a scene and to nothing above it.
 */
export function EpisodeDetailScreen() {
  const { worldId, prodId, episodeId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const { talk, starting } = useTalkItThrough(worldId);
  const [editing, setEditing] = useState(false);
  const [opens, setOpens] = useState("");
  const [turn, setTurn] = useState("");
  const [closes, setCloses] = useState("");
  const episode: Episode | undefined = production?.episodes.find((e) => e.id === episodeId);
  if (!production || !episode) {
    return (
      <div className="fy-prodmain" data-screen="episode-detail">
        <EmptyState title="Opening episode…" />
      </div>
    );
  }
  const scenesById = new Map(production.scenes.map((s) => [s.id, s]));
  const unassigned = sortScenes(production.scenes).filter(
    (s) => !production.episodes.some((e) => e.scenes.includes(s.id)),
  );
  return (
    <div className="fy-prodmain" data-screen="episode-detail">
      <div className="fy-h1row">
        <h1 className="fy-h1" style={{ fontSize: 32 }}>
          {String(episode.order).padStart(2, "0")} · {episode.title}
        </h1>
        <span className="fy-h1row__meta">v{episode.version}</span>
        <span className="fy-h1row__push" />
        <Button
          variant="ghost"
          disabled={starting || !prodId}
          onClick={() =>
            prodId && talk(`Episode · ${episode.title}`, { kind: "episode", productionId: prodId, episodeId: episode.id })
          }
        >
          {starting ? "Opening…" : "Talk it through"}
        </Button>
        <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/story`)}>
          Back to the board
        </Button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 470px", gap: 24 }}>
        <div style={{ display: "grid", gap: 10, alignContent: "start" }}>
          {/* The promise is three lines: how it opens, where it turns, how it closes (turn 53). */}
          {editing ? (
            <>
              <Input placeholder="OPENS" value={opens} onChange={(e) => setOpens(e.target.value)} />
              <Input placeholder="TURN" value={turn} onChange={(e) => setTurn(e.target.value)} />
              <Input placeholder="CLOSES" value={closes} onChange={(e) => setCloses(e.target.value)} />
              <div style={{ display: "flex", gap: 8 }}>
                <Button variant="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  onClick={() => {
                    if (!worldId || !prodId) return;
                    proposeEpisode(worldId, prodId, {
                      episodeId: episode.id,
                      promise: {
                        ...(opens.trim() ? { opens: opens.trim() } : {}),
                        ...(turn.trim() ? { turn: turn.trim() } : {}),
                        ...(closes.trim() ? { closes: closes.trim() } : {}),
                      },
                    });
                    setEditing(false);
                  }}
                >
                  Propose the promise
                </Button>
              </div>
            </>
          ) : (
            <>
              {(["opens", "turn", "closes"] as const).map((part) => (
                <div key={part} className="fy-actrow">
                  <span className="fy-actrow__label">{part.toUpperCase()}</span>
                  <span className="fy-actrow__text">{episode.promise?.[part] ?? "—"}</span>
                </div>
              ))}
              <Button
                variant="secondary"
                onClick={() => {
                  setOpens(episode.promise?.opens ?? "");
                  setTurn(episode.promise?.turn ?? "");
                  setCloses(episode.promise?.closes ?? "");
                  setEditing(true);
                }}
              >
                Edit the promise
              </Button>
            </>
          )}
        </div>
        <div style={{ display: "grid", gap: 6, alignContent: "start" }}>
          <div className="fy-listhead">Scenes, in order</div>
          {episode.scenes.length === 0 && <div className="fy-mono">No scenes yet.</div>}
          {episode.scenes.map((sceneId) => {
            const scene = scenesById.get(sceneId);
            return (
              <div key={sceneId} className="fy-listrow">
                <span className="fy-mono">{sceneId}</span>
                <span className="fy-listrow__text">{scene ? scene.title : "not a scene in this production"}</span>
                <button
                  type="button"
                  className="fy-linkbtn"
                  onClick={() => {
                    if (!worldId || !prodId) return;
                    proposeEpisode(worldId, prodId, {
                      episodeId: episode.id,
                      scenes: episode.scenes.filter((id) => id !== sceneId),
                    });
                  }}
                >
                  remove
                </button>
              </div>
            );
          })}
          {unassigned.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="fy-eyebrow-sm">UNASSIGNED SCENES</div>
              {unassigned.map((scene) => (
                <div key={scene.id} className="fy-listrow">
                  <span className="fy-mono">{scene.id}</span>
                  <span className="fy-listrow__text">{scene.title}</span>
                  <button
                    type="button"
                    className="fy-linkbtn"
                    onClick={() => {
                      if (!worldId || !prodId) return;
                      proposeEpisode(worldId, prodId, {
                        episodeId: episode.id,
                        scenes: [...episode.scenes, scene.id],
                      });
                    }}
                  >
                    add
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="fy-mono" style={{ marginTop: 8 }}>
            every change stages a proposal · nothing lands until you accept
          </div>
        </div>
      </div>
    </div>
  );
}
