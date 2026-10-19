import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  DRAMA_DELIVERY_LABEL, DRAMA_NARRATOR, dramaLineHash, dramaRoleVoice, dramaSpeakerLabel, episodeReadiness, episodeScriptFile, estimateScriptSeconds, formatSeconds,
  type DramaDelivery, type DramaEdition, type EpisodeScriptBlock, type JobSummary, type ProductionBundle, type WorldBundle,
} from "@arke-studio/contracts";
import { EmptyState, Screen } from "../components/layout.js";
import { Portrait, characterPortraitPath } from "../components/portrait.js";
import { Button, IconButton, cx } from "../components/ui.js";
import { Chat, ChevronLeft, ChevronRight, Lock, Play } from "../components/icons.js";
import { HeldBar } from "../components/held-bar.js";
import { useDockHost } from "../components/player.js";
import { useMediaQuery } from "../lib/media-query.js";
import { EditorDialog } from "../components/editor-dialog.js";
import { NARRATOR_LABEL, pilotChapters } from "../components/audio-drama-plan-card.js";
import { useGlobalChat } from "../components/global-chat-context.js";
import { useProduction } from "../lib/selectors.js";
import { dramaCastRoles } from "../lib/audio-drama-cast.js";
import { loadPlaylist, playPlaylistLine } from "../lib/audio.js";
import { dramaEditionMediaUrl, mediaUrl } from "../lib/media.js";
import { listDramaEditions, publishDramaEdition, renderAudiobookMix, subscribeAudiobookMix, subscribeDramaEditions, useStore } from "../lib/store.js";

type Spoken = Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>;
const spoken = (block: EpisodeScriptBlock): block is Spoken => block.kind === "dialogue" || block.kind === "narration";

/**
 * What a Hear press is doing to this episode now (230p, issue 1882), as Activity reports it. A
 * press makes its lines one after another, each a voice job landing in the episode's staging
 * folder, so the press is the run of those jobs back from the one still going, each begun within
 * a minute of the one before it ending. Its lines made so far count before the world's snapshot
 * does, which refreshes only once the press is over. None while nothing is going.
 */
export function episodeActivity(jobs: readonly JobSummary[], worldId: string, productionId: string, episode: number): { live: Set<string>; made: Set<string> } | null {
  const dir = `.staging/drama/${productionId}/${episodeScriptFile(episode).replace(/\.json$/, "")}`;
  // This world's own (codex on PR 1945): another world may hold the same slug and episode.
  const mine = jobs.filter((job) => job.worldId === worldId && job.target.kind === "voice-preview" && job.landing?.dir === dir).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  // Only what is being made counts as going (codex on PR 1945): a job parked for reconciliation
  // waits on a person, and may wait indefinitely while nothing is performed.
  const going = (job: JobSummary) => job.status === "queued" || job.status === "submitting" || job.status === "running";
  const block = (job: JobSummary) => typeof job.params["block"] === "string" ? job.params["block"] : "";
  const newest = mine.findIndex(going);
  if (newest < 0) return null;
  const live = new Set(mine.filter(going).map(block)), made = new Set<string>();
  for (let at = newest + 1; at < mine.length; at++) {
    const job = mine[at]!, after = mine[at - 1]!;
    if (Date.parse(after.createdAt) - Date.parse(job.updatedAt) > 60_000) break;
    if (job.status === "succeeded") made.add(block(job));
  }
  return { live, made };
}

/** One episode's state at a glance (230p): its script, its cast, what is performed, whether it can be mixed. */
type MixProblems = Array<{ episode: number; issues: string[]; lanes?: number }>;
function episodeState(world: WorldBundle, production: ProductionBundle, episode: number, mixes: MixProblems, jobs: readonly JobSummary[] = []) {
  const entry = production.episodeScripts?.find((candidate) => candidate.script.episode === episode);
  const blocks = entry?.script.blocks ?? [];
  const takes = production.episodeTakes?.find((candidate) => candidate.episode === episode);
  const lines = blocks.filter(spoken);
  const cast = production.audioDrama?.cast ?? {};
  const voiceless = new Set(lines.flatMap((line) => line.kind === "dialogue" && !cast[line.speaker]?.voice && !world.sheets.find((sheet) => sheet.id === line.speaker)?.voice ? [line.speaker] : []));
  const current = (line: Spoken) => { const kept = takes?.lines[line.id]?.kept; return kept !== undefined && kept.textHash === dramaLineHash(line); };
  const activity = episodeActivity(jobs, world.meta.worldId, production.meta.id, episode);
  // While a press runs, its lines made so far count as performed; the snapshot catches up after.
  const performed = lines.filter((line) => current(line) || activity?.made.has(line.id) === true).length;
  const path = `productions/${production.meta.id}/scripts/${episodeScriptFile(episode)}`;
  const draft = world.proposals.some((staged) => staged.proposal.targets.some((target) => target.path === path));
  const name = (slug: string) => world.sheets.find((sheet) => sheet.id === slug)?.name ?? dramaSpeakerLabel(slug);
  const scenes: Array<{ seconds: number; done: boolean; working: boolean }> = [];
  let scene: EpisodeScriptBlock[] = [];
  const close = () => {
    if (scene.length === 0) return;
    const sceneLines = scene.filter(spoken);
    scenes.push({ seconds: Math.max(1, estimateScriptSeconds(scene)), done: sceneLines.length > 0 && sceneLines.every((line) => takes?.lines[line.id]?.kept?.textHash === dramaLineHash(line)),
      working: sceneLines.some((line) => activity?.live.has(line.id) === true) });
  };
  for (const block of blocks) { if (block.kind === "heading") { close(); scene = []; } else scene.push(block); }
  close();
  const readiness = episodeReadiness(blocks, takes, name, (line) => dramaRoleVoice(production.audioDrama?.cast, world.sheets, line));
  // What the listener is left with (issue 1882): the last line said, by who says it.
  const last = lines.at(-1);
  const endsOn = last ? { who: last.kind === "dialogue" ? name(last.speaker) : "Narrator", words: last.words.length > 70 ? `${last.words.slice(0, 69).trimEnd()}…` : last.words } : null;
  // A saved arrangement's own problems hold the episode back too (issue 1882), as Publish's render would.
  const mix = mixes.find((candidate) => candidate.episode === episode);
  const mixIssues = mix?.issues ?? [];
  // The lanes its stems would be (issue 1882): the saved arrangement's own, else the lanes the
  // studio derives — one per voice, and one each for placed sounds, ambience and music.
  const lanes = mix?.lanes ?? new Set(blocks.flatMap((block) => block.kind === "dialogue" ? [block.speaker] : block.kind === "narration" ? ["@narrator"]
    : (block.kind === "sound" || block.kind === "ambience" || block.kind === "music") && block.soundArtifact ? [`@${block.kind}`] : [])).size;
  return {
    entry, planned: blocks.length > 0, title: entry?.script.title ?? "", seconds: estimateScriptSeconds(blocks), lines: lines.length, performed,
    voiceless: voiceless.size, draft, scenes, mixIssues, endsOn, lanes, performing: activity !== null,
    readiness: readiness.ready && mixIssues.length > 0
      ? { ...readiness, ready: false, reasons: [`the saved mix has ${mixIssues.length} problem${mixIssues.length === 1 ? "" : "s"} to fix in Audio Studio`] }
      : readiness,
  };
}

/**
 * An audio drama's home (design turn 230p, SPEC-057 R-71): a show page — the next episode to play,
 * the cast, each episode with its scenes and where it stands, and the episodes not yet planned as
 * one row for Arke to plan. Publish… makes an edition of the ready ones (230q).
 */
export function DramaEpisodesScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  if (!world || !production) return <Screen id="production-dashboard"><EmptyState title="Opening production…" /></Screen>;
  return <DramaEpisodes world={world} production={production} />;
}

function DramaEpisodes({ world, production }: { world: WorldBundle; production: ProductionBundle }) {
  const navigate = useNavigate();
  const base = `/w/${world.meta.worldId}/p/${production.meta.id}`;
  const plan = production.audioDrama?.plan ?? null;
  const source = production.audioDrama?.source ? world.productions.find((p) => p.meta.id === production.audioDrama!.source!.productionId) ?? null : null;
  const count = Math.max(plan?.episodes ?? 0, ...(production.episodeScripts ?? []).map((entry) => entry.script.episode));
  // Checked by the coordinator as Publish checks it, sources read live, so asked for with the editions.
  const [mixes, setMixes] = useState<MixProblems>([]);
  const jobs = useStore().state?.app.jobs ?? [];
  const states = Array.from({ length: count }, (_, i) => ({ n: i + 1, ...episodeState(world, production, i + 1, mixes, jobs) }));
  const planned = states.filter((state) => state.planned);
  const unplanned = states.filter((state) => !state.planned);
  const next = planned.find((state) => state.readiness.ready) ?? null;
  const roles = dramaCastRoles(world, production);
  const [publishing, setPublishing] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [editions, setEditions] = useState<DramaEdition[]>([]);
  const listing = useRef<string | null>(null);
  const chat = useGlobalChat();
  const surface = chat?.forPage() ?? null;
  // The player sits at the page's foot (issue 1883), never over the last row.
  const dock = useRef<HTMLDivElement>(null);
  useDockHost(dock, null);
  // On a phone the next episode is under the thumb, with Chat beside it (230u, R-80).
  const phone = useMediaQuery("(max-width: 599px)");
  useEffect(() => subscribeDramaEditions((answer) => {
    if (answer.requestId !== listing.current) return;
    setEditions(answer.editions);
    if (answer.mixes) setMixes(answer.mixes);
  }), []);
  // Asked again when what a mix is checked against changes here: a script, a take, a voice, a file.
  const mixKey = JSON.stringify([production.episodeScripts?.map((entry) => entry.hash), production.episodeTakes, production.audioDrama?.cast, world.artifacts.length]);
  useEffect(() => { listing.current = listDramaEditions(world.meta.worldId, production.meta.id); }, [world.meta.worldId, production.meta.id, publishing, mixKey]);
  // The episode heard as its studio arrangement mixes it (R-67).
  useEffect(() => subscribeAudiobookMix((answer) => {
    if (answer.requestId !== playing) return;
    setPlaying(null);
    if (!answer.mix) { setProblem(answer.refused ?? "Not mixed."); return; }
    loadPlaylist([{ id: answer.requestId, url: mediaUrl(world.meta.slug, answer.mix.file), title: production.meta.title, lineId: answer.chapterId, speakerSheetId: "mix" }]);
    void playPlaylistLine(0);
  }), [playing]);
  const play = (episode: number) => {
    setProblem(null);
    const requestId = renderAudiobookMix(world.meta.worldId, production.meta.id, episodeScriptFile(episode).replace(/\.json$/, ""));
    if (requestId === null) setProblem("The studio is disconnected."); else setPlaying(requestId);
  };
  // Runs kept apart (codex on PR 1880): with 1 and 3 written, the rest are Episodes 2, 4–6.
  const range = (list: typeof states) => {
    const runs: Array<[number, number]> = [];
    for (const { n } of list) { const run = runs.at(-1); if (run && run[1] === n - 1) run[1] = n; else runs.push([n, n]); }
    return `${list.length === 1 ? "Episode" : "Episodes"} ${runs.map(([from, to]) => from === to ? `${from}` : `${from}–${to}`).join(", ")}`;
  };
  return (
    <div className="fy-prodmain fy-ad-show" data-screen="production-dashboard">
      <header className="fy-ad-show__hero">
        {/* On a phone the hero is the page's top (230u): back to the world's productions, and the drama's pages. */}
        {phone && (
          <nav className="fy-ad-show__ptop" aria-label="Production pages">
            <IconButton label="Back" onClick={() => navigate(`/w/${world.meta.worldId}/productions`)}><ChevronLeft size={20} /></IconButton>
            <span className="gap" />
            <button type="button" onClick={() => navigate(`${base}/cast`)}>Cast</button>
            {production.audioDrama?.source && <button type="button" onClick={() => navigate(`${base}/adaptation`)}>Adaptation</button>}
            <button type="button" onClick={() => navigate(`${base}/artifacts`)}>Artifacts</button>
          </nav>
        )}
        <h1>{production.meta.title}</h1>
        {/* The count once, in the plan line, where a plan says it (issue 1883). */}
        <p>Audio drama{plan ? "" : ` · ${count} episode${count === 1 ? "" : "s"}`}{source ? ` · from ${source.meta.title}` : ""}</p>
        <p className="fy-ad-show__plan">
          {plan ? `${plan.episodes} episode${plan.episodes === 1 ? "" : "s"} · about ${plan.minutes} minutes each${plan.narrator ? ` · ${NARRATOR_LABEL[plan.narrator].toLowerCase()}` : ""}` : "no plan"}
        </p>
        {production.audioDrama?.source && (
          <p className="fy-ad-show__plan">
            Adapts{" "}
            {source ? <button type="button" className="fy-linkbtn" onClick={() => navigate(`/w/${world.meta.worldId}/p/${source.meta.id}`)}>{source.meta.title}</button>
              : `${production.audioDrama.source.productionId} · no longer here`}
          </p>
        )}
        <div className="fy-ad-show__acts">
          {next && <Button variant="primary" disabled={playing !== null} onClick={() => play(next.n)}><Play size={14} /> Episode {next.n} {formatSeconds(next.seconds)}</Button>}
          {/* A new drama's way in (issue 1883, R-9): nothing is planned, so the pilot is the next thing to write. */}
          {!next && planned.length === 0 && count > 0 && (
            <Button variant="primary" onClick={() => navigate(`${base}/script/1`)}>{plan?.pilot ? "Start the pilot" : "Write episode 1"}</Button>
          )}
          <Button variant="secondary" disabled={planned.length === 0} onClick={() => setPublishing(true)}>Publish…</Button>
        </div>
        {problem && <p className="fy-ad-show__problem" role="alert">{problem}</p>}
      </header>
      {roles.length > 0 && (
        <section className="fy-ad-show__cast" aria-label="Cast">
          <h2>Cast</h2>
          <div className="fy-ad-show__faces">
            {roles.map((role) => (
              <button key={role.key} type="button" className="fy-ad-show__face" onClick={() => navigate(`${base}/cast`)}>
                <span className="fy-ad-show__portrait">
                  {role.sheet ? <Portrait worldSlug={world.meta.slug} path={characterPortraitPath(world, role.sheet.id)} label={role.name} radius={10} loading="lazy" /> : <span aria-hidden>≋</span>}
                  {role.role?.publicLabel && <span className="fy-ad-show__lock"><Lock size={11} /></span>}
                </span>
                <b>{role.role?.publicLabel ?? role.name}</b>
                <small className={cx(!role.voice && role.key !== DRAMA_NARRATOR && "fy-ad-show__warn")}>
                  {role.voice ? role.voice.label ?? role.voice.voiceId : role.key === DRAMA_NARRATOR ? "app narrator" : "no voice"}
                </small>
              </button>
            ))}
          </div>
        </section>
      )}
      {/* The pilot is a scene, not an episode: shown on its own (codex on PR 1866). */}
      {plan?.pilot && (
        <div>
          <div className="fy-listhead">Pilot</div>
          <button type="button" className="fy-ad-home__pilot fy-linkbtn" onClick={() => navigate(`${base}/script/1`)}>
            {[plan.pilot.title, pilotChapters(plan.pilot.chapters)].filter(Boolean).join(" · ")}
          </button>
        </div>
      )}
      <section aria-label="Episodes">
        <div className="fy-ad-show__listhead"><h2>Episodes</h2><small>Script · Cast · Performed · Mixed</small></div>
        <ol className="fy-ad-show__episodes">
          {planned.map((state) => (
            <li key={state.n} className="fy-ad-show__row" data-episode={state.n}>
              {state.readiness.ready
                ? <button type="button" className="fy-ad-show__play" aria-label={`Play episode ${state.n}`} disabled={playing !== null} onClick={() => play(state.n)}><Play size={16} /></button>
                : <span className="fy-ad-show__num">{state.n}</span>}
              <button type="button" className="fy-ad-show__open" onClick={() => navigate(`${base}/script/${state.n}`)}>
                <b>Episode {state.n}{state.title ? ` · ${state.title}` : ""} <small>≈ {Math.max(1, Math.round(state.seconds / 60))} min</small></b>
                {/* Work in the background shows on its own row, as Activity reports it (230p): under the
                    title where Ends on is, the scenes beneath both. */}
                {state.performing
                  ? <small className="fy-ad-show__activity" role="status"><i aria-hidden />Performing {state.performed} of {state.lines} lines</small>
                  : state.endsOn && <small className="fy-ad-show__ends">Ends on {state.endsOn.who}: “{state.endsOn.words}”</small>}
                <span className="fy-ad-show__scenes" aria-hidden>
                  {state.scenes.map((scene, i) => <i key={i} className={cx(scene.done && "fy-ad-show__scene--done", !scene.done && scene.working && "fy-ad-show__scene--work")} style={{ flexGrow: scene.seconds }} />)}
                </span>
              </button>
              <span className="fy-ad-show__status">
                <span className={cx(state.draft ? "fy-ad-show__warn" : "fy-ad-show__ok")}>{state.draft ? "● Script draft" : "✓ Script"}</span>
                <span className={cx(state.voiceless > 0 ? "fy-ad-show__warn" : "fy-ad-show__ok")}>{state.voiceless > 0 ? `● Cast ${state.voiceless} missing` : "✓ Cast"}</span>
                <span className={cx(state.performed < state.lines ? "fy-ad-show__warn" : "fy-ad-show__ok")}>{state.performed < state.lines ? `● Performed ${state.performed} of ${state.lines}` : "✓ Performed"}</span>
                <span className={cx(state.readiness.ready ? "fy-ad-show__ok" : state.mixIssues.length > 0 ? "fy-ad-show__warn" : "fy-ad-show__off")}
                  title={state.mixIssues.length > 0 ? state.mixIssues.join("\n") : undefined}>
                  {state.readiness.ready ? "✓ Mixed" : state.mixIssues.length > 0 ? `● Mix ${state.mixIssues.length} to fix` : "○ Mixed"}
                </span>
                <ChevronRight size={14} aria-hidden />
              </span>
            </li>
          ))}
          {unplanned.length > 0 && (
            <li className="fy-ad-show__row fy-ad-show__row--open">
              <span className="fy-ad-show__num">…</span>
              {/* Each unplanned episode is a page to write (issue 1883): the first opens from here. */}
              <button type="button" className="fy-ad-show__open" onClick={() => navigate(`${base}/script/${unplanned[0]!.n}`)}>
                <b>{range(unplanned)} · not planned</b>
              </button>
              {surface && <Button size="sm" variant="secondary" onClick={() => {
                chat!.setValue(surface.key, "draft", `Plan ${range(unplanned).toLowerCase()} of this audio drama, and draft each episode's script.`);
                chat!.open(surface);
              }}>Plan with Arke</Button>}
            </li>
          )}
        </ol>
      </section>
      {plan && plan.keptFromListener.length > 0 && (
        <div>
          <div className="fy-listhead">Kept from the listener</div>
          <ul className="fy-ad-home__kept">
            {plan.keptFromListener.map((kept, i) => (
              <li key={`${i}:${kept.fact}`}><Lock size={13} /><span>{kept.fact}</span><small>until ep {kept.revealEpisode}</small></li>
            ))}
          </ul>
        </div>
      )}
      {editions.length > 0 && (
        <section className="fy-ad-show__editions" aria-label="Editions">
          <h2>Editions</h2>
          {editions.map((edition) => (
            <div key={edition.id} className="fy-ad-show__edition">
              <b>{edition.name}</b> <small>{DRAMA_DELIVERY_LABEL[edition.delivery]} · {edition.episodes.length} episode{edition.episodes.length === 1 ? "" : "s"}</small>
              <span>{edition.files.filter((file) => !stemNames(edition).has(file.name)).map((file) => <a key={file.name} className="fy-linkbtn" href={dramaEditionMediaUrl(edition.id, file.name)} download={`${edition.name} - ${file.name}`}>{file.name}</a>)}</span>
              {/* A season's stems are many files: kept under one line, each by its lane (issue 1882). */}
              {stemNames(edition).size > 0 && (
                <details className="fy-ad-show__stems">
                  <summary>Stems · {stemNames(edition).size}</summary>
                  {[...stemNames(edition)].map(([file, label]) => <a key={file} className="fy-linkbtn" href={dramaEditionMediaUrl(edition.id, file)} download={`${edition.name} - ${file}`}>{label}</a>)}
                </details>
              )}
            </div>
          ))}
        </section>
      )}
      {phone && (
        <HeldBar className="fy-ad-show__thumb">
          {/* The next episode to hear, or with none ready the next to work on. */}
          {next ? <Button variant="primary" disabled={playing !== null} onClick={() => play(next.n)}><Play size={14} /> Episode {next.n} · {formatSeconds(next.seconds)}</Button>
            : planned[0] ? <Button variant="primary" onClick={() => navigate(`${base}/script/${planned[0]!.n}`)}>Episode {planned[0].n} script</Button> : null}
          <span className="gap" />
          <IconButton label="Chat" disabled={!surface} onClick={() => surface && chat!.open(surface)}><Chat size={18} /></IconButton>
        </HeldBar>
      )}
      <div ref={dock} className="fy-ad-show__dock" />
      {publishing && <PublishDialog world={world} production={production} states={planned} onClose={() => setPublishing(false)} />}
    </div>
  );
}

/** An edition's stem files, each labelled by its episode and lane. */
const stemNames = (edition: DramaEdition) => new Map(edition.episodes.flatMap((episode) => (episode.stems ?? []).map((stem) => [stem.file, `Episode ${episode.episode} · ${stem.track}`] as const)));

/**
 * Publish an edition (230q, R-71..R-76): which episodes, ready or with the reason they are held
 * back; how it is delivered; what goes in it; what it freezes.
 */
function PublishDialog({ world, production, states, onClose }: {
  world: WorldBundle; production: ProductionBundle; states: Array<ReturnType<typeof episodeState> & { n: number }>; onClose: () => void;
}) {
  const ready = states.filter((state) => state.readiness.ready);
  const [name, setName] = useState(ready.length === 1 ? "Pilot" : "Season 1");
  const [delivery, setDelivery] = useState<DramaDelivery>("podcast");
  const [chosen, setChosen] = useState<number[]>(ready.map((state) => state.n));
  // Off unless asked for (230q): a stem is a whole episode's worth of WAV per lane.
  const [stems, setStems] = useState(false);
  const stemCount = states.filter((state) => chosen.includes(state.n) && state.lanes > 1).reduce((sum, state) => sum + state.lanes, 0);
  const [pressed, setPressed] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  // A dropped connection loses the answer (codex on PR 1880): the dialog is let go and says where to look.
  const { connection } = useStore();
  useEffect(() => {
    if (pressed === null || connection === "open") return;
    setPressed(null);
    setFailure("The studio disconnected. Check Editions before publishing again.");
  }, [connection]);
  useEffect(() => subscribeDramaEditions((answer) => {
    if (answer.requestId !== pressed) return;
    setPressed(null);
    if (answer.refused) setFailure(answer.refused); else onClose();
  }), [pressed]);
  const seconds = states.filter((state) => chosen.includes(state.n)).reduce((sum, state) => sum + state.seconds, 0);
  // The voices the chosen episodes' kept takes are in, by engine: "Wren, Bram · elevenlabs eleven_v3".
  // The takes', never the roles' (codex on PR 1945): a stand-in kept is published in its own voice.
  const voices = (() => {
    const engines = new Map<string, Set<string>>();
    for (const state of states.filter((candidate) => chosen.includes(candidate.n))) {
      const takes = production.episodeTakes?.find((candidate) => candidate.episode === state.n);
      for (const block of state.entry?.script.blocks ?? []) {
        if (block.kind !== "dialogue" && block.kind !== "narration") continue;
        const voice = takes?.lines[block.id]?.kept?.voice;
        if (!voice) continue;
        const engine = `${voice.provider}${voice.model ? ` ${voice.model}` : ""}`;
        engines.set(engine, (engines.get(engine) ?? new Set()).add((voice as { label?: string }).label ?? voice.voiceId));
      }
    }
    return [...engines].map(([engine, labels]) => `${[...labels].join(", ")} · ${engine}`).join("; ");
  })();
  const source = production.audioDrama?.source ? world.productions.find((p) => p.meta.id === production.audioDrama!.source!.productionId) : undefined;
  const publish = () => {
    setFailure(null);
    const requestId = publishDramaEdition(world.meta.worldId, production.meta.id, { name: name.trim() || "Edition", delivery, episodes: chosen, ...(stems && stemCount > 0 ? { stems: true } : {}) });
    if (requestId === null) setFailure("The studio is disconnected."); else setPressed(requestId);
  };
  return (
    // Never closed mid-publish (codex on PR 1880): Cancel would not stop it, and its answer would be lost.
    <EditorDialog open title="Publish an edition" subtitle={production.meta.title} onClose={() => { if (pressed === null) onClose(); }} width={680}>
      <div className="fy-ad-pub">
        <div className="fy-ad-pub__row">
          <label>Edition<input value={name} maxLength={120} onChange={(event) => setName(event.target.value)} /></label>
          <div className="fy-ad-pub__field"><span id="fy-ad-pub-delivery">Delivery</span>
            <div role="radiogroup" aria-labelledby="fy-ad-pub-delivery" className="fy-ad-pub__delivery">
              {(["podcast", "archive"] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={delivery === value} onClick={() => setDelivery(value)}>{DRAMA_DELIVERY_LABEL[value]}</button>
              ))}
            </div>
          </div>
        </div>
        <ul className="fy-ad-pub__episodes">
          {states.map((state) => (
            <li key={state.n} className={cx(!state.readiness.ready && "fy-ad-pub__held")}>
              <label>
                <input type="checkbox" disabled={!state.readiness.ready} checked={chosen.includes(state.n)}
                  onChange={(event) => setChosen(event.target.checked ? [...chosen, state.n].sort((a, b) => a - b) : chosen.filter((n) => n !== state.n))} />
                <b>Episode {state.n}{state.title ? ` · ${state.title}` : ""}</b>
                {state.readiness.ready && <small>{formatSeconds(state.seconds)}</small>}
              </label>
              <small>{state.readiness.ready ? ["ready", ...state.readiness.notes].join(" · ") : state.readiness.reasons.join(" · ")}</small>
            </li>
          ))}
        </ul>
        <p className="fy-ad-pub__outputs">
          {[`Episode audio · ${delivery === "podcast" ? "MP3" : "WAV"}`, "Listener transcript", "Credits", "Production script · PDF"].map((output) => <span key={output}>✓ {output}</span>)}
          <button type="button" className="fy-ad-pub__stems" aria-pressed={stems && stemCount > 0} disabled={stemCount === 0} onClick={() => setStems(!stems)}
            title={stemCount === 0 ? "Stems need two or more lanes" : undefined}>{stems && stemCount > 0 ? "✓ " : ""}Stems · {stemCount}</button>
        </p>
        <dl className="fy-ad-pub__frozen">
          {source && <><dt>Novel</dt><dd>{source.meta.title}{source.story?.version ? ` v${source.story.version}` : ""}</dd></>}
          <dt>Scripts</dt><dd>{states.filter((state) => chosen.includes(state.n)).map((state) => `Episode ${state.n} v${state.entry?.script.version ?? 1}`).join(", ") || "—"}</dd>
          {/* What it freezes besides (230q): the voices its lines are in, and the mix's format. */}
          {voices && <><dt>Voices</dt><dd>{voices}</dd></>}
          <dt>Mix</dt><dd>48 kHz stereo</dd>
        </dl>
        {failure && <p className="fy-ad-pub__fail" role="alert">{failure}</p>}
        <footer className="fy-ad-pub__foot">
          <span>{chosen.length} episode{chosen.length === 1 ? "" : "s"} · {formatSeconds(seconds)}</span>
          <span className="gap" />
          <Button variant="ghost" disabled={pressed !== null} onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={chosen.length === 0 || pressed !== null} onClick={publish}>{pressed ? "Publishing…" : "Publish edition"}</Button>
        </footer>
      </div>
    </EditorDialog>
  );
}
