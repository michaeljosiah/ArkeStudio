import { useState, type ReactNode } from "react";
import { NavLink, useNavigate, useParams } from "react-router";
import {
  orderedShots,
  seasonFindings,
  sortScenes,
  legacySceneView,
  type ArtifactSidecar,
  type Episode,
  type ProductionBundle,
  type SceneRecord,
  type SeasonFinding,
} from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import { Pin } from "../components/icons.js";
import { EmptyState } from "../components/layout.js";
import { Badge } from "../components/ui.js";
import { ReadAloud } from "../components/read-aloud.js";
import { useProduction } from "../lib/selectors.js";
import { ProductionConversation, StagedDecision } from "../components/conversation.js";
import { SingleActFeedback, useSingleAct } from "../components/single-act.js";
import { createEpisode, proposeEpisode, reorderEpisodes } from "../lib/store.js";
import { useBlockDigests } from "./storyboard.js";
import { sceneIsComplete } from "./scene-workspace/completion.js";

/**
 * The season page (design turn 91; supersedes turn 48's four-view strip).
 *
 * A production is exactly one season — another season is another production — so there is
 * nothing to navigate between, and the Season view whose job was to say which season you were
 * in has become this page's own header.
 *
 * There are no tabs left (turn 99): a season is its episodes. Arcs was a peer tab, which taught
 * a second vocabulary to somebody who did not yet have a first episode; the grid is unchanged
 * and lives behind Story structure, one rail item under Season and off the default walk.
 * Direction lost its tab two turns earlier and kept its field, because nobody has yet been able
 * to say what it decides that the world's look and a scene's own description do not.
 *
 * Everything here proposes through the gate; reorder is the one direct act, and it rewrites
 * order fields alone.
 */

/** Two digits, so the board reads as an ordered season rather than a list. */
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Arke's edge on a page that has one (design turns 120 and 122): the docked panel, or the strip
 * it collapses to.
 *
 * `dock.onPutAway` is optional and the season and the episode both omitted it, so on the two
 * pages here the assistant could not be dismissed at all — a third of the frame the person had
 * no way to reclaim. The strip is not a new control either: it is the scene workspace's own
 * `.fy-sw__rail`, lifted unchanged, because somebody who learned the affordance on a scene must
 * meet the same one here.
 */
function ArkeEdge({ children }: { children: (putAway: () => void) => ReactNode }) {
  const [docked, setDocked] = useState(true);
  if (docked) return <>{children(() => setDocked(false))}</>;
  return (
    <button type="button" className="fy-sw__rail" title="Pin the assistant back" onClick={() => setDocked(true)}>
      <span className="fy-sw__rail-dot" aria-hidden="true" />
      <span className="fy-sw__rail-label">Ask Arke</span>
      <span className="fy-sw__rail-pin">
        <Pin size={13} />
      </span>
    </button>
  );
}

/**
 * The frame an episode is drawn at (design turn 120) — the first frame filed anywhere in it.
 *
 * The board is a rack of the format's own shape, so a written episode shows the picture it
 * already has. There is no separate "episode key art" to choose from and inventing one would be
 * a second artifact to keep in step with the shots; the first frame the episode covered is the
 * one it opens on, which is what a rack of thumbnails is read for.
 */
function episodeFrame(
  production: ProductionBundle,
  artifacts: readonly ArtifactSidecar[],
  slug: string | undefined,
  episode: Episode,
): string | null {
  if (slug === undefined) return null;
  for (const sceneId of episode.scenes) {
    const scene = production.scenes.find((candidate) => candidate.id === sceneId);
    if (scene === undefined) continue;
    for (const shot of orderedShots(scene)) {
      const selection = production.selections[shot.id];
      const artifactId = selection?.startFrameArtifactId;
      const artifact = artifactId === undefined ? undefined : artifacts.find((a) => a.id === artifactId);
      if (artifact !== undefined) return mediaUrl(slug, `artifacts/${artifact.file}`);
      const accepted = selection?.acceptedTakeId;
      const take = accepted === undefined ? undefined : production.takes.find((t) => t.id === accepted);
      if ((take?.kind === "frame" || take?.kind === "still") && take.media !== undefined) {
        return mediaUrl(slug, `productions/${production.meta.id}/takes/${take.id}/${take.media}`);
      }
    }
  }
  return null;
}

/**
 * One tile of the rack. Written, staged and unwritten are the same box at the same size.
 *
 * The frame is the control and it is a link where it navigates (turn 92: a tile always opens
 * its page), so the reorder arrows have to be siblings of it rather than children — a button
 * inside a button is neither valid nor reachable by keyboard.
 */
function SeasonTile({
  number,
  title,
  hook,
  cliff,
  scenes,
  frame,
  state,
  to,
  onOpen,
  controls,
}: {
  number: number | null;
  title?: string;
  hook?: string;
  cliff?: string;
  scenes?: number;
  frame?: string | null;
  state: "written" | "staged" | "blank";
  to?: string;
  onOpen?: () => void;
  controls?: ReactNode;
}) {
  const label = number === null ? "··" : pad(number);
  const bare = state !== "written" || !frame;
  const described =
    state === "blank"
      ? `Episode ${label}, not written yet`
      : `Episode ${label}${title === undefined ? "" : `, ${title}`}${state === "staged" ? ", staged" : ""}`;
  const inner = (
    <div
      className={`fy-seasontile__frame${bare ? " fy-seasontile__frame--bare" : ""}${
        state === "staged" ? " fy-seasontile__frame--staged" : ""
      }`}
    >
      {state === "written" && frame ? (
        <>
          <img className="fy-seasontile__img" src={frame} alt="" />
          <span className="fy-seasontile__scrim" aria-hidden="true" />
          {hook === undefined ? null : <span className="fy-seasontile__hook">{hook}</span>}
        </>
      ) : (
        <>
          {state === "staged" ? <span className="fy-seasontile__flag">STAGED</span> : null}
          <span className="fy-seasontile__num" aria-hidden="true">
            {label}
          </span>
        </>
      )}
    </div>
  );
  return (
    <div className="fy-seasontile">
      <div style={{ position: "relative" }}>
        {to === undefined ? (
          <button type="button" className="fy-seasontile__press" aria-label={described} onClick={onOpen}>
            {inner}
          </button>
        ) : (
          <NavLink to={to} className="fy-seasontile__press" aria-label={described}>
            {inner}
          </NavLink>
        )}
        {controls}
      </div>
      {/* An unwritten tile carries its number and nothing else: the empty frame is already the
          sentence, and four copies of an instruction is noise on a board of seven. */}
      {state === "blank" ? null : (
        <div className="fy-seasontile__cap">
          <div className="fy-seasontile__name">
            <span className="fy-mono" style={{ color: "var(--neutral-400)" }}>
              {label}
            </span>
            <span
              style={{
                font: "600 13px/1.3 var(--font-sans)",
                ...(title === undefined ? { color: "var(--muted-foreground)" } : {}),
              }}
            >
              {title ?? "No title yet"}
            </span>
          </div>
          {state === "staged" ? (
            <div className="fy-seasontile__wait">waiting on the gate</div>
          ) : (
            <>
              <div className="fy-seasontile__cliff">{cliff ?? ""}</div>
              <div className="fy-seasontile__scenes">
                {scenes ?? 0} scene{scenes === 1 ? "" : "s"}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function DevelopmentWorkspace() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  if (!production) {
    return (
      <div className="fy-prodmain" data-screen="development">
        <EmptyState title="Opening the season…" />
      </div>
    );
  }
  const season = production.season ?? null;
  const episodes = production.episodes;
  const defaults = season?.defaults;
  // The season promises a number of episodes on the day it is made (turn 87), so the board is
  // that many wide from the start — never however many happen to exist.
  const declared = Math.max(defaults?.episodeCount ?? 0, episodes.length);
  const written = episodes.filter((e) => e.promise?.opens || e.promise?.closes).length;
  const series = world?.series.find((s) => prodId !== undefined && s.seasons.includes(prodId)) ?? null;
  return (
    <div className="fy-arkewrap">
    <div className="fy-prodmain" data-screen="development">
      {/*
        The counts were six outlined pills repeating what the rail and the board already say
        (turn 120). What survives is a seven-segment meter in episode order — the rack's own
        shape at header size — filled for written and amber for staged.
      */}
      <div className="fy-h1row">
        <h1 className="fy-h1">{production.meta.title}</h1>
        <span style={{ flex: 1 }} />
        <span style={{ textAlign: "right" }}>
          <span className="fy-seasonmeter" aria-hidden="true">
            {Array.from({ length: declared }, (_, i) => (
              <span key={i} {...(i < written ? { "data-state": "written" } : {})} />
            ))}
          </span>
          <span className="fy-h1row__meta" style={{ display: "block", marginTop: 6 }}>
            {written} of {declared} written
          </span>
        </span>
      </div>
      {/* The season record itself, in the header rather than behind a tab of its own (turn 91).
          Inheritance is shown, not hidden (turn 48): the Series engine is read-only here, and
          editing it is the Series' own accept, never a side effect of a season edit. */}
      {/* Each of the three is a block somebody reads, so each carries its own read-aloud
          (issue 857); an unwritten one renders no control, because there is nothing to hear. */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr) 260px", gap: 24 }}>
        <div className="fy-texthost">
          <div className="fy-mono">THE QUESTION IT ANSWERS</div>
          <div style={{ font: "400 13px/1.6 var(--font-sans)", marginTop: 5 }}>
            {season?.question ?? "Not asked yet."}
          </div>
          <ReadAloud
            source={{ of: "season", productionId: prodId ?? "", field: "question" }}
            title={`${production.meta.title} · the question it answers`}
            text={season?.question ?? ""}
          />
        </div>
        <div className="fy-texthost">
          <div className="fy-mono">HOW IT ENDS</div>
          <div style={{ font: "400 13px/1.6 var(--font-sans)", marginTop: 5 }}>
            {season?.ending ?? "Not settled yet."}
          </div>
          <ReadAloud
            source={{ of: "season", productionId: prodId ?? "", field: "ending" }}
            title={`${production.meta.title} · how it ends`}
            text={season?.ending ?? ""}
          />
        </div>
        <div className="fy-texthost">
          <div className="fy-mono">SERIES ENGINE · READ-ONLY</div>
          <div
            style={{ font: "400 12.5px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 5 }}
          >
            {series
              ? (series.engine ?? `${series.title} has no engine written yet.`)
              : "This production belongs to no Series."}
          </div>
          {series && (
            <ReadAloud
              source={{ of: "series", seriesId: series.id }}
              title={`${series.title} · engine`}
              text={series.engine ?? ""}
            />
          )}
        </div>
      </div>
      {/*
        This screen is the production's front page (turn 93), so it is also its day one — and the
        card that used to stand here saying where the season gets shaped is gone with turn 99,
        because the place it pointed at is now the panel on the right. A board of dashed tiles
        says what is missing; the panel is what to do about it.
      */}
      <EpisodesBoard />
    </div>
      <ArkeEdge>{(putAway) => <SeasonDock onPutAway={putAway} />}</ArkeEdge>
    </div>
  );
}

/**
 * Arke, docked beside the season (design turn 99). The chat stops being a place you go to: the
 * board keeps its width, the thread takes a column beside it, and a proposal staged against
 * `season.json` appears here under one Accept rather than on a screen you have to be sent to.
 *
 * The thread is the same thread — same context, same points, same wrap-up, same gate — so this
 * is where it is shown, not what it is.
 */
function SeasonDock({ onPutAway }: { onPutAway: () => void }) {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const staged =
    (world?.proposals ?? []).find((sp) =>
      sp.proposal.targets.some((t) => t.path === `productions/${prodId}/season.json`),
    ) ?? null;
  const version = production?.season ? `v${production.season.version}` : "nothing decided";
  return (
    <ProductionConversation
      worldId={worldId}
      productionId={prodId}
      dock={{ title: `Arke · ${production?.meta.title ?? "…"}`, subject: `season · ${version}`, onPutAway }}
      openingNote="opening…"
      emptyLine="Let’s shape the season. What is it about?"
      placeholder="Ask about the season"
      {...(staged
        ? {
            side: (
              <StagedDecision
                worldId={worldId}
                subject="the season"
                staged={staged}
                writes="nothing else changes"
              />
            ),
          }
        : {
            pointsEmpty:
              "Nothing understood yet. As you talk, what the studio takes from it appears here — the season question, each episode, each arc.",
          })}
    />
  );
}

/** The same panel one level down (design turn 100), with the episode as its subject. */
function EpisodeDock({ episode, onPutAway }: { episode: Episode; onPutAway: () => void }) {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const stem = production?.episodeFiles[episode.id];
  const staged = stem
    ? ((world?.proposals ?? []).find((sp) =>
        sp.proposal.targets.some((t) => t.path === `productions/${prodId}/episodes/${stem}.json`),
      ) ?? null)
    : null;
  return (
    <ProductionConversation
      worldId={worldId}
      productionId={prodId}
      entry={{ kind: "episode", productionId: prodId ?? "", episodeId: episode.id }}
      dock={{ title: `Arke · Episode ${pad(episode.order)}`, subject: `${episode.title} · v${episode.version}`, onPutAway }}
      openingNote="opening…"
      emptyLine={`Nothing written for ${episode.title} yet. Say how it opens, where it turns and how it closes — the scenes it needs come with it.`}
      placeholder="Ask about the episode"
      {...(staged
        ? {
            side: (
              <StagedDecision
                worldId={worldId}
                subject={`episode ${pad(episode.order)}`}
                staged={staged}
                writes="the scenes come with it · nothing else changes"
              />
            ),
          }
        : {
            pointsEmpty:
              "Nothing understood yet. As you talk, what the studio takes from it appears here — how this episode opens, where it turns, the scenes it needs.",
          })}
    />
  );
}

/** Episodes compare across the season, so the board takes the full surface (turn 48). */
function EpisodesBoard() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  /*
   * The press is answered before the round trip is. Staging goes to the coordinator and comes
   * back as a proposal a moment later; until it does, the tile that was pressed says so itself
   * rather than leaving the board looking untouched (turn 92).
   */
  const [starting, setStarting] = useState<Set<number>>(() => new Set());
  const episodes = production?.episodes ?? [];
  /* A pressed tile yields to the episode it became (review 2026-08-22): nothing removed a
     number from `starting` once the proposal was accepted, so a phantom STARTING tile stood
     beside the real episode forever. */
  const startingOpen = new Set([...starting].filter((n) => !episodes.some((e) => e.order === n)));
  const findings = production ? seasonFindings(production, world?.sheets ?? []) : [];
  const declared = Math.max(production?.season?.defaults?.episodeCount ?? 0, episodes.length);
  /*
   * Episodes that have been started and are waiting on the gate (turn 92). A staged proposal
   * against a file that is not yet an episode on disk is a started one: it has a name and an
   * order and no record, so it belongs on the board between the written and the untouched.
   * Without this the press that staged it changed nothing anybody could see.
   */
  const stems = new Set(Object.values(production?.episodeFiles ?? {}));
  const startedByPress = starting;
  const started = (world?.proposals ?? []).flatMap((sp) =>
    sp.proposal.targets.flatMap((t) => {
      // Prefix and suffix rather than a built pattern: a production id interpolated into a
      // regular expression is a pattern the caller did not write, and `\.` inside a template
      // literal is just a dot, so the escape that looked like it was there never was.
      const prefix = `productions/${prodId}/episodes/`;
      if (!t.path.startsWith(prefix) || !t.path.endsWith(".json")) return [];
      const stem = t.path.slice(prefix.length, -".json".length);
      if (stem.length === 0 || stem.includes("/") || stems.has(stem)) return [];
      // The gate labels its review fields for reading — "Title", "Order" — so they are matched
      // case-insensitively rather than by the record's own key names.
      const fields = sp.review?.targets.flatMap((rt) => rt.fields) ?? [];
      const field = (name: string) => fields.find((f) => f.field.toLowerCase() === name)?.proposed;
      const title = field("title") ?? sp.proposal.summary;
      const order = Number(field("order") ?? Number.NaN);
      return [{ id: sp.proposal.id, title, order: Number.isFinite(order) ? order : null }];
    }),
  );
  /** The episodes the season promised and nobody has started (turn 87). */
  const untouched = Math.max(0, declared - episodes.length - started.length);
  const firstBlank = episodes.length + started.length + 1;
  const blanks = Array.from({ length: untouched }, (_, i) => firstBlank + i).filter(
    (order) => !startedByPress.has(order),
  );
  const move = (index: number, delta: number) => {
    if (!worldId || !prodId) return;
    const ids = episodes.map((e) => e.id);
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    reorderEpisodes(worldId, prodId, ids);
  };
  const artifacts: readonly ArtifactSidecar[] = world?.artifacts ?? [];
  const slug = world?.meta.slug;
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <div className="fy-seasonrack">
        {episodes.map((episode, index) => (
          <SeasonTile
            key={episode.id}
            number={episode.order}
            title={episode.title}
            state="written"
            frame={episodeFrame(production!, artifacts, slug, episode)}
            {...(episode.promise?.opens ? { hook: episode.promise.opens } : {})}
            {...(episode.promise?.closes ? { cliff: episode.promise.closes } : {})}
            scenes={episode.scenes.length}
            to={`/w/${worldId}/p/${prodId}/episodes/${episode.id}`}
            controls={
              <span className="fy-seasontile__move">
                <button type="button" aria-label="Move earlier" onClick={() => move(index, -1)}>
                  ↑
                </button>
                <button type="button" aria-label="Move later" onClick={() => move(index, 1)}>
                  ↓
                </button>
              </span>
            }
          />
        ))}
        {/* Started, and waiting on the gate (turn 92): the tile the press changed. */}
        {started.map((one) => (
          <SeasonTile key={one.id} number={one.order} title={one.title} state="staged" />
        ))}
        {[...startingOpen]
          .filter((order) => !started.some((one) => one.order === order))
          .map((order) => (
            <SeasonTile key={`starting-${order}`} number={order} title={`Episode ${pad(order)}`} state="staged" />
          ))}
        {/*
          Making an episode happens in the rack, where the others already are (turn 87): no screen
          asks for a title before there is anything to title, so opening a blank frame stages the
          episode under its number and the conversation is what names it. The tile writes it live
          (issue 728): the press is the decision, and a proposal here waited on a screen elsewhere.
        */}
        {blanks.map((order) => (
          <SeasonTile
            key={`blank-${order}`}
            number={order}
            state="blank"
            onOpen={() => {
              if (!worldId || !prodId) return;
              createEpisode(worldId, prodId, { title: `Episode ${pad(order)}`, order });
              setStarting((prev) => new Set(prev).add(order));
            }}
          />
        ))}
      </div>
      {(blanks.length > 0 || started.length > 0) && (
        <div className="fy-mono">
          {started.length > 0 &&
            `${started.length} started and waiting on the gate — accept them in Proposals · `}
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

/**
 * Story structure (turn 99): arcs, and in time themes and setups/payoffs. Off the default walk,
 * because a season is its episodes — reached from one rail item under Season by somebody who has
 * gone looking for it, which is the only person the vocabulary helps.
 *
 * Arc lanes are things that change, not characters (turn 48): SETUP, TURN, PAYOFF in words.
 */
export function StoryStructureScreen() {
  const { worldId, prodId } = useParams();
  const { production } = useProduction(worldId, prodId);
  if (!production) {
    return (
      <div className="fy-prodmain" data-screen="story-structure">
        <EmptyState title="Opening the season…" />
      </div>
    );
  }
  return (
    <div className="fy-prodmain" data-screen="story-structure">
      <div className="fy-h1row">
        <h1 className="fy-h1">Story structure</h1>
        <span className="fy-h1row__meta">{production.meta.title}</span>
      </div>
      <ArcsView />
    </div>
  );
}

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
          hint="An arc lane names the episode it lands in, so episodes come first. Develop is where they get decided."
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
  const navigate = useNavigate();
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
          ? {
              side: (
                <StagedDecision
                  worldId={worldId}
                  subject={`episode ${pad(episode.order)}`}
                  staged={staged}
                  writes="the scenes come with it · nothing else changes"
                  onAccepted={() => navigate(`/w/${worldId}/p/${prodId}/episodes/${episode.id}`)}
                />
              ),
            }
          : {
              pointsEmpty:
                "Nothing understood yet. As you talk, what the studio takes from it appears here — how this episode opens, where it turns, the scenes it needs — so you can see it thinking rather than wait for the end.",
            })}
      />
    </div>
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
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const edit = useSingleAct();
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
    <div className="fy-arkewrap">
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
        {/* `Talk it through` is gone (turn 100): there is nowhere to be sent, because the thread
            is docked on the right. It was the last control on the last level that treated a
            conversation as a destination. */}
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
          return scene === undefined || world === null ? (
            <div key={sceneId} className="fy-draftcard">
              <span className="fy-mono">{pad(index + 1)} · MISSING</span>
              <div>not a scene in this production</div>
            </div>
          ) : (
            <EpisodeSceneCard
              key={sceneId}
              scene={scene}
              production={production}
              artifacts={world.artifacts}
              ordinal={index + 1}
              onOpen={() => navigate(`/w/${worldId}/p/${prodId}/scenes/${sceneId}`)}
            />
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
                  edit.track(proposeEpisode(worldId, prodId, {
                    episodeId: episode.id,
                    scenes: [...episode.scenes, scene.id],
                  }));
                }}
              >
                add to this episode
              </button>
            </div>
          ))}
        </div>
      )}
      <SingleActFeedback result={edit.result} undoLabel="Restore episode" onUndo={edit.undo} />
    </div>
      <ArkeEdge>{(putAway) => <EpisodeDock episode={episode} onPutAway={putAway} />}</ArkeEdge>
    </div>
  );
}

function EpisodeSceneCard({
  scene,
  production,
  artifacts,
  ordinal,
  onOpen,
}: {
  scene: SceneRecord;
  production: ProductionBundle;
  artifacts: readonly ArtifactSidecar[];
  ordinal: number;
  onOpen: () => void;
}) {
  const digests = useBlockDigests(legacySceneView(scene));
  const complete = sceneIsComplete(scene, production, artifacts, digests);
  return (
    <div className="fy-draftcard" data-complete={complete ? "true" : undefined}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="fy-mono">{pad(ordinal)}</span>
        <button
          type="button"
          className="fy-linkbtn"
          style={{ font: "600 13px var(--font-sans)", textAlign: "left" }}
          onClick={onOpen}
        >
          {scene.title}
        </button>
      </div>
      <div className="fy-mono" style={{ marginTop: 8 }}>
        {scene.id} · {complete ? "done" : "in progress"}
      </div>
    </div>
  );
}
