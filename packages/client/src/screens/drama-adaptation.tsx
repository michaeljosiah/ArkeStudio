import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import {
  DRAMA_VERDICT_LABEL, DramaVerdictSchema, affectedBlocks, dramaSpeakerLabel, chapterParagraphs, changedParagraphs, productionShape, remapParagraphs,
  type DramaChapterDecision, type DramaVerdict, type EpisodeScriptBlock, type ProductionBundle, type WorldBundle,
} from "@arke-studio/contracts";
import { useProduction } from "../lib/selectors.js";
import { CUT, adaptationMap, layoutMap, pairChangedParagraphs, wordChanges, type MapChapter, type MapScene, type MarkedWords } from "../lib/adaptation.js";
import { blockLine } from "../lib/episode-script.js";
import {
  openChapter, readChapterVersion, readDramaSource, saveEpisodeScript, setDramaVerdict, subscribeChapterOpenResults, subscribeEpisodeScriptSaveResults,
} from "../lib/store.js";
import { useGlobalChat } from "../components/global-chat-context.js";
import { EmptyState, Screen } from "../components/layout.js";
import { Button, IconButton, cx } from "../components/ui.js";
import { X } from "../components/icons.js";

type Filter = DramaVerdict | "all" | "unplanned";
const MAP = { width: 760, left: 236, right: 520, block: 12 };

/**
 * Adaptation (design turn 230m/n, SPEC-057 R-61..R-66): what became of each chapter. The map is read
 * from the scripts' source pins and the author's verdicts; Compare shows a changed chapter against
 * the version its scene was made from, and the author keeps the script or asks Arke to revise it.
 */
export function DramaAdaptationScreen() {
  const { worldId, prodId } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  if (!world || !production) return <Screen id="drama-adaptation"><EmptyState title="Opening the adaptation…" /></Screen>;
  if (!productionShape(production.meta).isAudioDrama) return <Screen id="drama-adaptation"><EmptyState title="Adaptation is an audio drama's." /></Screen>;
  if (!production.audioDrama?.source) return <Screen id="drama-adaptation"><EmptyState title="This drama adapts no story." /></Screen>;
  // The story may since have gone (codex on PR 1878): said, rather than an empty map.
  if (!world.productions.some((candidate) => candidate.meta.id === production.audioDrama!.source!.productionId)) {
    return <Screen id="drama-adaptation"><EmptyState title="The story this drama adapts is no longer here." /></Screen>;
  }
  return <Adaptation world={world} production={production} />;
}

function Adaptation({ world, production }: { world: WorldBundle; production: ProductionBundle }) {
  const map = useMemo(() => adaptationMap(world, production), [world, production]);
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<{ chapter?: string; scene?: string } | null>(null);
  const [comparing, setComparing] = useState<MapScene | null>(null);
  const chat = useGlobalChat();
  const surface = chat?.forPage() ?? null;
  const ask = (text: string) => { if (!chat || !surface) return; chat.setValue(surface.key, "draft", text); chat.open(surface); };
  const totalHeight = Math.max(420, map.chapters.length * 34);
  const layout = useMemo(() => layoutMap(map, { height: totalHeight, left: MAP.left + MAP.block, right: MAP.right }), [map, totalHeight]);
  const words = map.chapters.reduce((sum, chapter) => sum + chapter.words, 0);
  const counts = new Map<Filter, number>([["all", map.chapters.length], ["unplanned", map.counts.notPlanned]]);
  for (const verdict of DramaVerdictSchema.options) counts.set(verdict, map.chapters.filter((chapter) => chapter.verdict === verdict).length);
  const shown = (chapter: MapChapter) => filter === "all" || (filter === "unplanned" ? chapter.verdict === null : chapter.verdict === filter);
  const lit = (chapter: string, to: string) => !selected || selected.chapter === chapter || selected.scene === to;
  const chapter = selected?.chapter ? map.chapters.find((candidate) => candidate.id === selected.chapter) : undefined;
  const scene = selected?.scene ? map.episodes.flatMap((episode) => episode.scenes).find((candidate) => candidate.key === selected.scene) : undefined;
  const changed = map.episodes.flatMap((episode) => episode.scenes).filter((candidate) => candidate.changed);
  const base = `/w/${world.meta.worldId}/p/${production.meta.id}`;

  if (comparing) return <Screen id="drama-adaptation"><Compare world={world} production={production} map={map} scene={comparing} ask={surface ? ask : null} onClose={() => setComparing(null)} /></Screen>;
  return (
    <Screen id="drama-adaptation">
      <div className="fy-ad-map">
        <header className="fy-ad-map__head">
          <div>
            <h1>Adaptation</h1>
            <p>{map.story?.meta.title} · {map.chapters.length} chapters · {words.toLocaleString()} words → {map.episodes.length} episodes</p>
          </div>
          <span className="gap" />
          <span className="fy-ad-map__chip">Read {map.counts.read} of {map.chapters.length}</span>
          <span className="fy-ad-map__chip">Planned {map.counts.planned}</span>
          <span className="fy-ad-map__chip">Not planned {map.counts.notPlanned}</span>
          {map.counts.changed > 0 && <span className="fy-ad-map__chip fy-ad-map__chip--warn">{map.counts.changed} changed</span>}
          {(map.counts.notPlanned > 0 || map.episodes.some((episode) => !episode.planned)) && surface && (
            <Button size="sm" variant="primary" onClick={() => ask(`Plan the unplanned episodes of this audio drama from the chapters not yet planned, and draft each episode's script.`)}>Plan with Arke</Button>
          )}
        </header>
        <nav className="fy-ad-map__filters" aria-label="Verdicts">
          {(["all", ...DramaVerdictSchema.options, "unplanned"] as Filter[]).filter((value) => value === "all" || (counts.get(value) ?? 0) > 0).map((value) => (
            <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
              {value === "all" ? "All" : value === "unplanned" ? "Not planned" : DRAMA_VERDICT_LABEL[value]} {counts.get(value)}
            </button>
          ))}
        </nav>
        <div className="fy-ad-map__body">
          <svg className="fy-ad-map__svg" viewBox={`0 0 ${MAP.width} ${layout.height + 8}`} role="img" aria-label="Chapters to episodes">
            {layout.ribbons.map((ribbon) => (
              <path key={`${ribbon.chapter}>${ribbon.to}`} d={ribbon.d} data-ribbon={`${ribbon.chapter}>${ribbon.to}`}
                className={cx("fy-ad-map__ribbon", ribbon.to === CUT && "fy-ad-map__ribbon--cut",
                  !lit(ribbon.chapter, ribbon.to) && "fy-ad-map__ribbon--dim", selected && lit(ribbon.chapter, ribbon.to) && "fy-ad-map__ribbon--lit")} />
            ))}
            {map.chapters.map((entry) => {
              const at = layout.chapters.get(entry.id)!;
              return (
                <g key={entry.id} className={cx("fy-ad-map__chapter", !shown(entry) && "fy-ad-map__chapter--dim")} data-chapter={entry.id}
                  onClick={() => setSelected({ chapter: entry.id })} role="button" tabIndex={0}
                  onKeyDown={(event) => { if (event.key === "Enter") setSelected({ chapter: entry.id }); }}>
                  <text x={MAP.left - 8} y={at.y + Math.min(at.h, 22) / 2 + 4} textAnchor="end">
                    <tspan className="fy-ad-map__n">{entry.order} </tspan>{entry.title}
                    <tspan className="fy-ad-map__verdict" dx="6">{entry.verdict ? DRAMA_VERDICT_LABEL[entry.verdict] : ""}{entry.moved ? " · moved" : ""}</tspan>
                  </text>
                  {entry.changed && <circle cx={MAP.left - 2} cy={at.y + 4} r="3" className="fy-ad-map__dot" />}
                  <rect x={MAP.left} y={at.y} width={MAP.block} height={at.h} rx="2" className={cx("fy-ad-map__block", entry.verdict === null && "fy-ad-map__block--open", selected?.chapter === entry.id && "fy-ad-map__block--on")} />
                </g>
              );
            })}
            {map.episodes.map((episode) => {
              const at = layout.episodes.get(episode.episode)!;
              return (
                <g key={episode.episode} className="fy-ad-map__episode">
                  {episode.planned ? (
                    <text x={MAP.right + MAP.block + 8} y={at.y + 14}><tspan className="fy-ad-map__ep">Episode {episode.episode}{episode.title ? ` · ${episode.title}` : ""}</tspan>
                      <tspan x={MAP.right + MAP.block + 8} dy="13" className="fy-ad-map__meta">{Math.round(episode.seconds / 60)} min · {episode.scenes.length} scene{episode.scenes.length === 1 ? "" : "s"}</tspan></text>
                  ) : (
                    <>
                      <rect x={MAP.right} y={at.y} width={MAP.block} height={at.h} rx="2" className="fy-ad-map__block fy-ad-map__block--open" />
                      <text x={MAP.right + MAP.block + 8} y={at.y + at.h / 2 + 4}>Episode {episode.episode} <tspan className="fy-ad-map__meta">not planned</tspan></text>
                    </>
                  )}
                  {episode.scenes.map((entry) => {
                    const box = layout.scenes.get(entry.key)!;
                    return <rect key={entry.key} x={MAP.right} y={box.y} width={MAP.block} height={box.h} rx="2" data-scene={entry.key} role="button" tabIndex={0}
                      className={cx("fy-ad-map__block", entry.changed && "fy-ad-map__block--changed", selected?.scene === entry.key && "fy-ad-map__block--on")}
                      onClick={() => setSelected({ scene: entry.key })} onKeyDown={(event) => { if (event.key === "Enter") setSelected({ scene: entry.key }); }} />;
                  })}
                </g>
              );
            })}
            {map.cutWords > 0 && (
              <g>
                <rect x={MAP.right} y={layout.cut.y} width={MAP.block} height={layout.cut.h} rx="2" className="fy-ad-map__block fy-ad-map__block--open" />
                <text x={MAP.right + MAP.block + 8} y={layout.cut.y + 14}><tspan className="fy-ad-map__ep">Cut</tspan> <tspan className="fy-ad-map__meta">{map.cutWords.toLocaleString()} words</tspan></text>
              </g>
            )}
          </svg>
          <aside className="fy-ad-map__side" aria-label="Decision">
            {chapter ? (
              <ChapterPanel world={world} production={production} chapter={chapter} map={map} ask={surface ? ask : null}
                onCompare={(key) => setComparing(map.episodes.flatMap((episode) => episode.scenes).find((candidate) => candidate.key === key) ?? null)} />
            ) : scene ? (
              <section className="fy-ad-map__panel">
                <h2>Episode {scene.episode} · Scene {scene.n}</h2>
                <p>{scene.heading.place}{scene.heading.time ? ` — ${scene.heading.time}` : ""}</p>
                {scene.chapter && <p className="fy-ad-map__meta">From chapter {map.chapters.find((entry) => entry.id === scene.chapter)?.order} · v{scene.heading.source?.version}</p>}
                <div className="fy-ad-map__acts">
                  <Link className="ui-btn ui-btn--secondary ui-btn--sm" to={`${base}/script/${scene.episode}`}>Open script</Link>
                  {scene.changed && <Button size="sm" variant="primary" onClick={() => setComparing(scene)}>Compare</Button>}
                </div>
              </section>
            ) : (
              <p className="fy-ad-map__meta">Select a chapter or a scene.</p>
            )}
            {!chapter && changed.length > 0 && changed.map((entry) => {
              const from = map.chapters.find((candidate) => candidate.id === entry.chapter);
              return (
                <section key={entry.key} className="fy-ad-map__changed">
                  <h3>Chapter {from?.order} changed <small>v{entry.heading.source?.version} → v{from?.version}</small></h3>
                  <p>Episode {entry.episode}, scene {entry.n} was adapted from v{entry.heading.source?.version}.</p>
                  <Button size="sm" variant="primary" onClick={() => setComparing(entry)}>Compare</Button>
                </section>
              );
            })}
          </aside>
        </div>
      </div>
    </Screen>
  );
}

/** A chapter's decision (230m): its verdict, why, where it went and what it leaves out. */
function ChapterPanel({ world, production, chapter, map, ask, onCompare }: {
  world: WorldBundle; production: ProductionBundle; chapter: MapChapter; map: ReturnType<typeof adaptationMap>;
  ask: ((text: string) => void) | null; onCompare: (scene: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [verdict, setVerdict] = useState<DramaVerdict>(chapter.verdict ?? "keep");
  const [reason, setReason] = useState(chapter.decision?.reason ?? "");
  const [leavesOut, setLeavesOut] = useState(chapter.decision?.leavesOut ?? "");
  // Follows the stored decision too (codex on PR 1878): a cleared one is not saved back from a stale draft.
  useEffect(() => { setEditing(false); setVerdict(chapter.verdict ?? "keep"); setReason(chapter.decision?.reason ?? ""); setLeavesOut(chapter.decision?.leavesOut ?? ""); }, [chapter.id, JSON.stringify(chapter.decision ?? null)]);
  const scenes = map.episodes.flatMap((episode) => episode.scenes).filter((scene) => scene.chapter === chapter.id);
  const save = () => {
    const value: DramaChapterDecision = { verdict, ...(reason.trim() ? { reason: reason.trim() } : {}), ...(leavesOut.trim() ? { leavesOut: leavesOut.trim() } : {}) };
    setDramaVerdict(world.meta.worldId, production.meta.id, chapter.id, value);
    setEditing(false);
  };
  return (
    <section className="fy-ad-map__panel" data-panel={chapter.id}>
      <h2>Chapter {chapter.order} · {chapter.title}</h2>
      <dl>
        <dt>Words</dt><dd>{chapter.words.toLocaleString()}</dd>
        <dt>Verdict</dt><dd><span className={cx("fy-ad-map__vchip", chapter.verdict === "cut" && "fy-ad-map__vchip--cut")}>{chapter.verdict ? DRAMA_VERDICT_LABEL[chapter.verdict] : "Not planned"}</span></dd>
      </dl>
      {chapter.decision?.reason && <p>{chapter.decision.reason}</p>}
      {scenes.length > 0 && <>
        <h3>Goes to</h3>
        {scenes.map((scene) => <p key={scene.key} className="fy-ad-map__goes">Episode {scene.episode} · Scene {scene.n} · {scene.heading.place}</p>)}
      </>}
      {chapter.decision?.leavesOut && <><h3>Leaves out</h3><p>{chapter.decision.leavesOut}</p></>}
      {editing ? (
        <div className="fy-ad-map__edit">
          <select aria-label="Verdict" value={verdict} onChange={(event) => setVerdict(event.target.value as DramaVerdict)}>
            {DramaVerdictSchema.options.map((value) => <option key={value} value={value}>{DRAMA_VERDICT_LABEL[value]}</option>)}
          </select>
          <input aria-label="Why" placeholder="Why" maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
          <input aria-label="Leaves out" placeholder="Leaves out" maxLength={300} value={leavesOut} onChange={(event) => setLeavesOut(event.target.value)} />
          <div className="fy-ad-map__acts">
            {chapter.decision && <Button size="sm" variant="ghost" onClick={() => { setDramaVerdict(world.meta.worldId, production.meta.id, chapter.id, null); setEditing(false); }}>Clear</Button>}
            <Button size="sm" variant="primary" onClick={save}>Save</Button>
          </div>
        </div>
      ) : (
        <div className="fy-ad-map__acts">
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Change</Button>
          {ask && <Button size="sm" variant="secondary" onClick={() => ask(`About chapter ${chapter.order}, “${chapter.title}”, in this audio drama: what should become of it? Propose the script changes.`)}>Ask Arke</Button>}
          {map.story && <Link className="fy-linkbtn" to={`/w/${world.meta.worldId}/p/${map.story.meta.id}/story/chapters/${encodeURIComponent(chapter.id)}`}>Open in {map.story.meta.title}</Link>}
        </div>
      )}
      {scenes.filter((scene) => scene.changed).map((scene) => (
        <section key={scene.key} className="fy-ad-map__changed">
          <h3>Chapter {chapter.order} changed <small>v{scene.heading.source?.version} → v{chapter.version}</small></h3>
          <p>Episode {scene.episode}, scene {scene.n} was adapted from v{scene.heading.source?.version}.</p>
          <Button size="sm" variant="primary" onClick={() => onCompare(scene.key)}>Compare</Button>
        </section>
      ))}
    </section>
  );
}

/** A chapter's text: as adapted (its kept text by hash, else its version), or as it is now, with the hash read. */
function useChapterText(world: WorldBundle, production: ProductionBundle, story: ProductionBundle | null, chapter: MapChapter | undefined, version: number | "now", hash?: string, onHash?: (hash: string | null) => void): string[] | null | string {
  const [text, setText] = useState<string[] | string | null>(null);
  useEffect(() => {
    if (!story || !chapter) return;
    let live = true;
    const done = (body: string) => { if (live) setText(chapterParagraphs(body)); };
    const fail = (reason: string) => { if (live) setText(reason); };
    const now = () => {
      const requestId = openChapter(world.meta.worldId, story.meta.id, chapter.id);
      if (!requestId) { fail("Not connected."); return () => {}; }
      return subscribeChapterOpenResults((result) => {
        if (result.requestId !== requestId) return;
        if (result.disposition === "opened") { onHash?.(result.hash ?? null); done(result.body ?? ""); } else fail("The chapter could not be read.");
      });
    };
    let stop = () => {};
    const byVersion = () => readChapterVersion(world.meta.worldId, story.meta.id, chapter.file, version as number).then(done, (error: Error) => fail(error.message));
    if (version === "now") stop = now();
    // The exact text pinned (codex on PR 1878): an edit in place keeps the version number.
    else if (hash) readDramaSource(world.meta.worldId, production.meta.id, hash).then(done, byVersion);
    else void byVersion();
    return () => { live = false; stop(); };
  }, [story?.meta.id, chapter?.id, chapter?.hash, version, hash]);
  return text;
}

/**
 * Compare (230n, R-65): the chapter as adapted, the chapter now, and the scene with the lines resting
 * on changed paragraphs marked. Keep the script records the version considered and a reason; Ask Arke
 * to revise puts it to Arke, whose change arrives in the script as a draft. No take is touched (R-66).
 */
function Compare({ world, production, map, scene, ask, onClose }: {
  world: WorldBundle; production: ProductionBundle; map: ReturnType<typeof adaptationMap>; scene: MapScene;
  ask: ((text: string) => void) | null; onClose: () => void;
}) {
  const chapter = map.chapters.find((candidate) => candidate.id === scene.chapter);
  const pin = scene.heading.source!;
  const adapted = useChapterText(world, production, map.story, chapter, pin.version, pin.hash);
  // The chapter's hash as read (codex on PR 1878): Keep waits until the text shown is the chapter's now.
  const [readHash, setReadHash] = useState<string | null>(null);
  const now = useChapterText(world, production, map.story, chapter, "now", undefined, setReadHash);
  // The script as Compare opened it (codex on PR 1878): Keep refuses if it moved meanwhile.
  const [openedHash] = useState(() => production.episodeScripts?.find((entry) => entry.script.episode === scene.episode)?.hash ?? null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const changed = Array.isArray(adapted) && Array.isArray(now) ? changedParagraphs(adapted, now) : [];
  // A changed paragraph beside the one that took its place, its words marked (issue 1882).
  const pairs = Array.isArray(adapted) && Array.isArray(now) ? pairChangedParagraphs(adapted, now, changed, remapParagraphs(adapted, now)) : new Map<number, number>();
  const partnerOf = new Map([...pairs].map(([from, to]) => [to, from]));
  const adaptedSet = new Set((Array.isArray(adapted) ? adapted : []).map((paragraph) => paragraph.replace(/\s+/g, " ").trim()));
  const affected = new Set(affectedBlocks(scene.blocks, pin.paragraphs, changed));
  const stored = production.episodeScripts?.find((entry) => entry.script.episode === scene.episode);
  const takes = production.episodeTakes?.find((entry) => entry.episode === scene.episode);
  const keptTakes = scene.blocks.filter((block) => takes?.lines[block.id]?.kept).length;
  const name = (slug: string) => world.sheets.find((sheet) => sheet.id === slug)?.name ?? dramaSpeakerLabel(slug);
  useEffect(() => subscribeEpisodeScriptSaveResults((result) => {
    if (result.requestId !== saving) return;
    setSaving(null);
    if (result.disposition === "saved") onClose(); else setFailure(result.reason ?? "Not kept.");
  }), [saving]);
  const keep = () => {
    if (!stored || !chapter || !Array.isArray(adapted) || !Array.isArray(now)) return;
    if (stored.hash !== openedHash) { setFailure("The script changed while you were comparing. Compare again."); return; }
    if (chapter.hash !== undefined && readHash !== chapter.hash) { setFailure("The chapter changed while you were comparing. Compare again."); return; }
    // Only the scene's pin moves (R-65): the version considered, and why — and its paragraph
    // numbers, renumbered for the text now, a changed paragraph let go (codex on PR 1878). The lines'
    // words are untouched, so their takes are too (R-66).
    const places = remapParagraphs(adapted, now);
    const renumber = (pins: readonly number[] | undefined) => (pins ?? []).flatMap((n) => places.has(n) ? [places.get(n)!] : []);
    const inScene = new Set([scene.heading.id, ...scene.blocks.map((block) => block.id)]);
    const blocks = stored.script.blocks.map((block): EpisodeScriptBlock => {
      if (!inScene.has(block.id)) return block;
      if (block.kind === "heading" && block.id === scene.heading.id) {
        const { keptReason: _was, paragraphs, ...source } = block.source!;
        const moved = renumber(paragraphs);
        return { ...block, source: { ...source, version: chapter.version, ...(chapter.hash ? { hash: chapter.hash } : {}),
          ...(moved.length > 0 ? { paragraphs: moved } : {}), ...(reason.trim() ? { keptReason: reason.trim() } : {}) } };
      }
      if ("paragraphs" in block && block.paragraphs?.length) {
        const { paragraphs, ...rest } = block;
        const moved = renumber(paragraphs);
        return (moved.length > 0 ? { ...rest, paragraphs: moved } : rest) as EpisodeScriptBlock;
      }
      return block;
    });
    const requestId = saveEpisodeScript(world.meta.worldId, production.meta.id, scene.episode, stored.script.title, blocks, stored.hash);
    if (requestId === null) setFailure("The studio is disconnected."); else setSaving(requestId);
  };
  const column = (title: string, sub: string, text: string[] | string | null, mark: (paragraph: string, n: number) => boolean,
    words?: (n: number) => MarkedWords | null) => (
    <section className="fy-ad-cmp__col">
      <h2>{title} <small>{sub}</small></h2>
      {text === null ? <p className="fy-ad-map__meta">Reading…</p> : typeof text === "string" ? <p className="fy-ad-map__meta">{text}</p>
        : text.map((paragraph, i) => {
          const marked = words?.(i + 1) ?? null;
          return <p key={i} className={cx(mark(paragraph, i + 1) && "fy-ad-cmp__mark")}><small>¶{i + 1}</small>{" "}
            {marked ? marked.map((word, at) => <span key={at}>{at > 0 ? " " : ""}{word.changed ? <mark className="fy-ad-cmp__word">{word.text}</mark> : word.text}</span>) : paragraph}</p>;
        })}
    </section>
  );
  const pairedWords = (from: number, side: "before" | "after") => {
    const to = pairs.get(from);
    return to === undefined || !Array.isArray(adapted) || !Array.isArray(now) ? null : wordChanges(adapted[from - 1]!, now[to - 1]!)[side];
  };
  return (
    <div className="fy-ad-cmp" aria-label="Compare">
      <header className="fy-ad-cmp__bar">
        <b>Chapter {chapter?.order} · v{pin.version} → v{chapter?.version}</b>
        <span>episode {scene.episode}, scene {scene.n} · {affected.size} line{affected.size === 1 ? "" : "s"} · {keptTakes} kept take{keptTakes === 1 ? "" : "s"}</span>
        <span className="gap" />
        <IconButton label="Close compare" onClick={onClose}><X size={14} /></IconButton>
      </header>
      <div className="fy-ad-cmp__cols">
        {column(`Chapter ${chapter?.order} · v${pin.version}`, "adapted", adapted, (_, n) => changed.includes(n), (n) => pairedWords(n, "before"))}
        {column(`Chapter ${chapter?.order} · v${chapter?.version}`, "now", now, (paragraph) => !adaptedSet.has(paragraph.replace(/\s+/g, " ").trim()),
          (n) => partnerOf.has(n) ? pairedWords(partnerOf.get(n)!, "after") : null)}
        <section className="fy-ad-cmp__col">
          <h2>Episode {scene.episode} · Scene {scene.n} <small>script v{stored?.script.version} · from v{pin.version}</small></h2>
          {scene.blocks.map((block) => {
            const { who, text } = blockLine(block, name);
            return <p key={block.id} data-affected={affected.has(block.id) || undefined} className={cx("fy-ad-cmp__line", affected.has(block.id) && "fy-ad-cmp__mark")}><small>{who}</small> {text}</p>;
          })}
          <label className="fy-ad-cmp__reason">Reason · optional
            <textarea rows={3} maxLength={300} value={reason} placeholder={`Why the script stays with v${pin.version}`} onChange={(event) => setReason(event.target.value)} />
          </label>
          {failure && <p className="fy-ad-cmp__fail" role="alert">{failure}</p>}
          <div className="fy-ad-map__acts">
            <Button size="sm" variant="secondary" disabled={saving !== null || !stored} onClick={keep}>{saving ? "Keeping…" : "Keep the script"}</Button>
            {ask && <Button size="sm" variant="primary" onClick={() => ask(`Revise episode ${scene.episode}, scene ${scene.n} (“${scene.heading.place}”) for chapter ${chapter?.order} v${pin.version} → v${chapter?.version}: paragraphs ${changed.join(", ") || "none"} changed. Propose the change to the script, keeping every line that has not changed.`)}>Ask Arke to revise</Button>}
          </div>
        </section>
      </div>
    </div>
  );
}
