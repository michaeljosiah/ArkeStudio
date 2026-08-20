import { useState } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import {
  seasonFindings,
  sortScenes,
  type Episode,
  type SeasonFinding,
  type StagedProposal,
} from "@arke-studio/contracts";
import { EmptyState } from "../components/layout.js";
import { Badge, Button, cx } from "../components/ui.js";
import { useProduction } from "../lib/selectors.js";
import { ProductionConversation } from "../components/conversation.js";
import { acceptProposal, proposeEpisode, reorderEpisodes } from "../lib/store.js";

/**
 * The season page (design turn 91; supersedes turn 48's four-view strip).
 *
 * A production is exactly one season — another season is another production — so there is
 * nothing to navigate between, and the Season view whose job was to say which season you were
 * in has become this page's own header. What is left as tabs are the two things that are
 * plural: Episodes and Arcs. Direction has lost its tab and kept its field, because nobody has
 * yet been able to say what it decides that the world's look and a scene's own description do
 * not, and a tab that cannot be explained is a tab that gets filled in wrongly.
 *
 * Everything here proposes through the gate; reorder is the one direct act, and it rewrites
 * order fields alone.
 */

type Tab = "episodes" | "arcs";

/** Two digits, so the board reads as an ordered season rather than a list. */
const pad = (n: number) => String(n).padStart(2, "0");

export function DevelopmentWorkspace() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const [tab, setTab] = useState<Tab>("episodes");
  if (!production) {
    return (
      <div className="fy-prodmain" data-screen="development">
        <EmptyState title="Opening the season…" />
      </div>
    );
  }
  const season = production.season ?? null;
  const episodes = production.episodes;
  const arcs = season?.arcs ?? [];
  const defaults = season?.defaults;
  // The season promises a number of episodes on the day it is made (turn 87), so the board is
  // that many wide from the start — never however many happen to exist.
  const declared = Math.max(defaults?.episodeCount ?? 0, episodes.length);
  const written = episodes.filter((e) => e.promise?.opens || e.promise?.closes).length;
  const series = world?.series.find((s) => prodId !== undefined && s.seasons.includes(prodId)) ?? null;
  const tabs: Array<{ id: Tab; label: string }> = [
    { id: "episodes", label: `Episodes · ${declared}` },
    { id: "arcs", label: `Arcs · ${arcs.length}` },
  ];
  return (
    <div className="fy-prodmain" data-screen="development">
      <div className="fy-h1row">
        <h1 className="fy-h1">{production.meta.title}</h1>
        <span className="fy-h1row__meta">{season ? `season v${season.version}` : "no season record yet"}</span>
        <span className="fy-h1row__push" />
        <span className="fy-seg">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              className={cx("fy-seg__item", tab === t.id && "fy-seg__item--active")}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className="fy-pill">{declared} episodes</span>
        <span className="fy-pill">{written} written</span>
        <span className="fy-pill">
          {production.scenes.length} scene{production.scenes.length === 1 ? "" : "s"}
        </span>
        {defaults?.episodeSecondsMin !== undefined && defaults.episodeSecondsMax !== undefined && (
          <span className="fy-pill">
            {defaults.episodeSecondsMin}–{defaults.episodeSecondsMax}s each
          </span>
        )}
        {defaults?.hookWindowSec !== undefined && <span className="fy-pill">hook in {defaults.hookWindowSec}s</span>}
        {defaults?.episodeEnding !== undefined && <span className="fy-pill">{defaults.episodeEnding}</span>}
      </div>
      {/* The season record itself, in the header rather than behind a tab of its own (turn 91).
          Inheritance is shown, not hidden (turn 48): the Series engine is read-only here, and
          editing it is the Series' own accept, never a side effect of a season edit. */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) 260px", gap: 24 }}>
        <div>
          <div className="fy-mono">THE QUESTION IT ANSWERS</div>
          <div style={{ font: "400 13px/1.6 var(--font-sans)", marginTop: 5 }}>
            {season?.question ?? "Not asked yet."}
          </div>
        </div>
        <div>
          <div className="fy-mono">HOW IT ENDS</div>
          <div style={{ font: "400 13px/1.6 var(--font-sans)", marginTop: 5 }}>
            {season?.ending ?? "Not settled yet."}
          </div>
        </div>
        <div>
          <div className="fy-mono">SERIES ENGINE · READ-ONLY</div>
          <div
            style={{ font: "400 12.5px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 5 }}
          >
            {series
              ? (series.engine ?? `${series.title} has no engine written yet.`)
              : "This production belongs to no Series."}
          </div>
        </div>
      </div>
      {tab === "episodes" ? <EpisodesBoard /> : <ArcsView />}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <NavLink to={`/w/${worldId}/p/${prodId}/story`} className="fy-linkbtn">
          &larr; Production Chat
        </NavLink>
        <span className="fy-mono">
          opening an episode opens its own chat · nothing here writes — every change is a proposal
        </span>
      </div>
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
  const declared = Math.max(production?.season?.defaults?.episodeCount ?? 0, episodes.length);
  /** The episodes the season promised and nobody has started (turn 87). */
  const blanks = Array.from({ length: Math.max(0, declared - episodes.length) }, (_, i) => episodes.length + i + 1);
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
              <span className="fy-mono">{pad(episode.order)}</span>
              <button
                type="button"
                className="fy-linkbtn"
                style={{ font: "600 14px var(--font-sans)", textAlign: "left" }}
                /*
                 * An episode with nothing written opens its chat, because there is nothing yet to
                 * look at; one that has a promise opens its page, which carries a way back into
                 * the same thread. Day one's rule, one level down (turns 53b, 91).
                 */
                onClick={() =>
                  navigate(
                    episode.promise?.opens || episode.promise?.closes
                      ? `/w/${worldId}/p/${prodId}/episodes/${episode.id}`
                      : `/w/${worldId}/p/${prodId}/story/episodes/${episode.id}`,
                  )
                }
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
        {/*
          Making an episode happens in the grid, where the others already are (turn 87): no screen
          asks for a title before there is anything to title, so opening a blank tile stages the
          episode under its number and the conversation is what names it.
        */}
        {blanks.map((order) => (
          <button
            key={`blank-${order}`}
            type="button"
            className="fy-emptycard"
            style={{ display: "grid", gap: 8, textAlign: "left", cursor: "pointer", minHeight: 118 }}
            onClick={() => {
              if (!worldId || !prodId) return;
              proposeEpisode(worldId, prodId, { title: `Episode ${pad(order)}`, order });
            }}
          >
            <span className="fy-mono">{pad(order)}</span>
            <span style={{ font: "400 12.5px var(--font-sans)", color: "var(--muted-foreground)" }}>
              Not written yet.
            </span>
            <span className="fy-mono">OPEN TO START IT</span>
          </button>
        ))}
      </div>
      {blanks.length > 0 && (
        <div className="fy-mono">
          {blanks.length} of {declared} promised by the season and not started · starting one stages it for the gate
        </div>
      )}
      <FindingsPanel findings={findings} />
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
          hint="An arc lane names the episode it lands in, so episodes come first. Production Chat is where they get decided."
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
    </div>
  );
}

/*
 * Direction had a view here until turn 91 retired its tab. The field survives on season.json and
 * the conversation may still settle it; what went is the screen insisting on it, because nobody
 * could say what Direction decides that the world's look and a scene's own description do not.
 * It returns when there is a reason, which is turn 53's rule applied to something already drawn.
 */

/**
 * Episode Chat, and the proposal it ends in (design turn 91; supersedes 53c).
 *
 * 53c drew an episode as a conversation and a promise editor sharing one surface — the same
 * half-and-half screen turn 88 broke apart at season level. Here the episode is talked through
 * and the rail is what the talking settled: points while it is still soft, and once wrap-up has
 * staged something, the proposal itself under one Accept. Never both, because a screen showing
 * thinking beside a decision claims a point is a proposal, which is the promise the gate keeps.
 */
export function EpisodeChatScreen() {
  const { worldId, prodId, episodeId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const episode = production?.episodes.find((e) => e.id === episodeId);
  if (!production || !episode || !prodId || !episodeId) {
    return (
      <div className="fy-story" data-screen="episode-chat">
        <EmptyState title="Opening the episode…" />
      </div>
    );
  }
  // Every episode reachable from the board is on disk, so its stem is known and the match is
  // exact — a looser one would show episode 4's proposal while episode 3 was open.
  const stem = production.episodeFiles[episode.id];
  const staged = stem
    ? ((world?.proposals ?? []).find((sp) =>
        sp.proposal.targets.some((t) => t.path === `productions/${prodId}/episodes/${stem}.json`),
      ) ?? null)
    : null;
  return (
    <div className="fy-story" data-screen="episode-chat">
      <ProductionConversation
        worldId={worldId}
        productionId={prodId}
        entry={{ kind: "episode", productionId: prodId, episodeId }}
        openingNote={`Episode Chat · ${pad(episode.order)} · opening…`}
        eyebrow={`EPISODE CHAT · ${pad(episode.order)}`}
        heading="What happens in this one?"
        emptyLine={`Nothing written for ${episode.title} yet. Say how it opens, where it turns and how it closes — the scenes it needs come with it.`}
        placeholder="Keep shaping the episode…"
        {...(staged
          ? { side: <StagedEpisode worldId={worldId} episode={episode} staged={staged} /> }
          : {
              pointsEmpty:
                "Nothing understood yet. As you talk, what the studio takes from it appears here — how this episode opens, where it turns, the scenes it needs — so you can see it thinking rather than wait for the end.",
            })}
      />
    </div>
  );
}

/**
 * The rail in its second state: the staged proposal, field by field, under one action.
 *
 * “Turn this into a proposal” is retired (turn 91) — by the time a person is reading what the
 * conversation settled it already is one, and a button converting a noun into another noun names
 * an implementation step rather than the decision being made. The fields come from the gate's own
 * per-target review, so this screen cannot claim a change the gate would not make.
 */
function StagedEpisode({
  worldId,
  episode,
  staged,
}: {
  worldId: string | undefined;
  episode: Episode;
  staged: StagedProposal;
}) {
  const navigate = useNavigate();
  const { prodId } = useParams();
  const fields = staged.review?.targets.flatMap((t) => t.fields) ?? [];
  return (
    <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ font: "600 15px var(--font-sans)" }}>Ready to accept</div>
        <span className="fy-mono">episode {pad(episode.order)}</span>
      </div>
      <div className="fy-mono" style={{ marginTop: 6 }}>
        this is the proposal · nothing above it has been written
      </div>
      <div style={{ display: "grid", gap: 12, marginTop: 12 }}>
        {fields.map((field) => (
          <div key={field.field} className="fy-draftcard">
            <div className="fy-draftcard__head">
              <span className="fy-eyebrow-sm">{field.field}</span>
              <Badge tone="warning">would change</Badge>
            </div>
            <div style={{ font: "400 13px/1.7 var(--font-sans)", marginTop: 6 }}>{field.proposed ?? "(removed)"}</div>
            {field.before !== null && <div className="fy-draftcard__was">Accepted: “{field.before}”</div>}
          </div>
        ))}
        {fields.length === 0 && (
          <div className="fy-emptycard">
            <div style={{ font: "400 13px/1.7 var(--font-sans)" }}>
              A proposal is staged for this episode and the gate reports no field-by-field review
              for it. Read it whole in Proposals before accepting.
            </div>
          </div>
        )}
        <Button
          variant="primary"
          disabled={!worldId}
          onClick={() => {
            if (!worldId) return;
            acceptProposal(worldId, staged.proposal.id);
            // Accepting lands you on the thing you accepted (turn 91).
            navigate(`/w/${worldId}/p/${prodId}/episodes/${episode.id}`);
          }}
        >
          Accept Proposal
        </Button>
        <div className="fy-mono">the gate writes it · nothing else moves</div>
      </div>
    </>
  );
}

/**
 * The episode page (design turn 91): what this episode is in its header, and the one plural thing
 * below it. The same shape as the season page, one level down.
 *
 * There is no promise editor here. Turn 91 put authoring in the conversation and reading here, so
 * the way to change the promise is `Talk it through`, which enters this episode's own thread — an
 * accept is not the end of a subject, and a page that cannot be talked to again turns it into a
 * one-way door.
 */
export function EpisodeDetailScreen() {
  const { worldId, prodId, episodeId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
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
          {pad(episode.order)} · {episode.title}
        </h1>
        <span className="fy-h1row__meta">v{episode.version}</span>
        <span className="fy-h1row__push" />
        <NavLink to={`/w/${worldId}/p/${prodId}/season`} className="fy-linkbtn">
          &larr; Season
        </NavLink>
        <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/episodes/${episode.id}`)}>
          Talk it through
        </Button>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span className="fy-pill">
          {episode.scenes.length} scene{episode.scenes.length === 1 ? "" : "s"}
        </span>
        <span className="fy-pill">{episode.promise?.opens ? "hook written" : "no hook yet"}</span>
        <span className="fy-pill">{episode.promise?.closes ? "ending written" : "no ending yet"}</span>
      </div>
      {/* The promise is three lines: how it opens, where it turns, how it closes (turn 53). */}
      <div style={{ maxWidth: 900 }}>
        {(["opens", "turn", "closes"] as const).map((part) => (
          <div key={part} className="fy-actrow">
            <span className="fy-actrow__label">{part.toUpperCase()}</span>
            <span className="fy-actrow__text">{episode.promise?.[part] ?? "—"}</span>
          </div>
        ))}
      </div>
      {/* One plural child, so it is a heading rather than a strip of one tab (turn 91). */}
      <div className="fy-listhead">Scenes · in order</div>
      {episode.scenes.length === 0 && <div className="fy-mono">No scenes yet.</div>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 14 }}>
        {episode.scenes.map((sceneId, index) => {
          const scene = scenesById.get(sceneId);
          return (
            <div key={sceneId} className="fy-draftcard">
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span className="fy-mono">{pad(index + 1)}</span>
                <button
                  type="button"
                  className="fy-linkbtn"
                  style={{ font: "600 13px var(--font-sans)", textAlign: "left" }}
                  disabled={!scene}
                  onClick={() => navigate(`/w/${worldId}/p/${prodId}/scenes/${sceneId}`)}
                >
                  {scene ? scene.title : "not a scene in this production"}
                </button>
              </div>
              <div className="fy-mono" style={{ marginTop: 8 }}>
                {scene ? sceneId : "MISSING"}
              </div>
            </div>
          );
        })}
      </div>
      {/*
       * Until turn 87's cascade lands — an episode's own proposal creating the scenes it needs —
       * scenes are drafted elsewhere and adopted here, which runs the arrow backwards. Said out
       * loud rather than dressed up, so the band reads as the stopgap it is.
       */}
      {unassigned.length > 0 && (
        <div>
          <div className="fy-eyebrow-sm">DRAFTED ELSEWHERE · NOT IN ANY EPISODE</div>
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
                add to this episode
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="fy-mono">
        opening a scene opens its own chat · a script belongs to a scene · every change is a proposal
      </div>
    </div>
  );
}
