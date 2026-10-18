import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import {
  estimateScriptSeconds, pickableSheets,
  type EpisodeScriptBlock, type ProductionBundle, type ScriptChannel, type ScriptHeading, type WorldBundle,
} from "@arke-studio/contracts";
import { useProduction } from "../lib/selectors.js";
import {
  openChapter, readChapterVersion, saveEpisodeScript, subscribeChapterOpenResults, subscribeEpisodeScriptSaveResults,
} from "../lib/store.js";
import {
  bedMarks, chapterParagraphs, heardAsLabel, joinBlock, mendRelations, newBlock, paragraphLabel, parseParagraphs,
  scenesOf, scriptAsText, speakerTones, splitBlock,
} from "../lib/episode-script.js";
import { BookOpen, ChevronLeft, ChevronRight, More, X } from "../components/icons.js";
import { Button, IconButton, cx } from "../components/ui.js";
import { EmptyState, Screen } from "../components/layout.js";

/** Minutes and seconds, as the listening ring reads (3:05). */
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}`;

const CUE_LABEL = { sound: "Sound", ambience: "Ambience", music: "Music" } as const;
const INSERTS: Array<[EpisodeScriptBlock["kind"], string]> = [
  ["dialogue", "Line"], ["narration", "Narration"], ["sound", "Sound"], ["ambience", "Ambience"],
  ["music", "Music"], ["silence", "Silence"], ["note", "Note"], ["heading", "Scene"],
];

/**
 * An audio drama's episode, as its script (design turn 230d–f, SPEC-057 R-11..R-24). The script is
 * the score: who speaks, the words — the only thing set large — and the beds that run under them,
 * drawn down their lanes. It reads like a page and edits like one; it is saved whole, against the
 * file it was read from, as a chapter is.
 */
export function EpisodeScriptScreen() {
  const { worldId, prodId, episode: episodeParam } = useParams();
  const { world, production } = useProduction(worldId, prodId);
  const episode = Number(episodeParam);
  if (!world || !production) return <Screen id="episode-script"><EmptyState title="Opening the script…" /></Screen>;
  if (!Number.isInteger(episode) || episode < 1) return <p role="alert">This episode address is invalid.</p>;
  return <EpisodeScript key={`${production.meta.id}:${episode}`} world={world} production={production} episode={episode} />;
}

function EpisodeScript({ world, production, episode }: { world: WorldBundle; production: ProductionBundle; episode: number }) {
  const navigate = useNavigate();
  const base = `/w/${world.meta.worldId}/p/${production.meta.id}`;
  const stored = production.episodeScripts?.find((entry) => entry.script.episode === episode) ?? null;
  const plan = production.audioDrama?.plan;
  const episodes = Math.max(plan?.episodes ?? 1, episode);

  // The editor's copy, and the file it was read from: every save is fenced on that hash.
  const [blocks, setBlocks] = useState<EpisodeScriptBlock[]>(() => stored?.script.blocks ?? []);
  const [title, setTitle] = useState(() => stored?.script.title ?? "");
  const [baseHash, setBaseHash] = useState<string | null>(stored?.hash ?? null);
  const [version, setVersion] = useState<number | null>(stored?.script.version ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const focusNext = useRef<{ id: string; at: number } | null>(null);

  // Another window's save, or Arke's accepted proposal, arrives in the bundle: adopted while this
  // copy holds nothing unsaved, never over the author's own typing.
  useEffect(() => {
    if (dirty || saving || !stored || stored.hash === baseHash) return;
    setBlocks(stored.script.blocks); setTitle(stored.script.title); setBaseHash(stored.hash); setVersion(stored.script.version);
  }, [stored?.hash]);

  const edit = (next: EpisodeScriptBlock[]) => { setBlocks(mendRelations(next)); setDirty(true); setFailure(null); };
  const change = (id: string, patch: Partial<EpisodeScriptBlock>) =>
    edit(blocks.map((block) => block.id === id ? ({ ...block, ...patch } as EpisodeScriptBlock) : block));

  // Saved whole, one save in flight; edits made meanwhile wait for its answer and go next.
  useEffect(() => {
    if (!dirty || saving) return;
    const timer = setTimeout(() => {
      const requestId = saveEpisodeScript(world.meta.worldId, production.meta.id, episode, title, blocks, baseHash);
      if (requestId === null) { setFailure("The studio is disconnected. Your edits are kept here."); return; }
      setSaving(requestId); setDirty(false);
    }, 700);
    return () => clearTimeout(timer);
  }, [dirty, saving, blocks, title, baseHash]);
  useEffect(() => subscribeEpisodeScriptSaveResults((result) => {
    if (result.requestId !== saving) return;
    setSaving(null);
    if (result.disposition === "saved" && result.hash) { setBaseHash(result.hash); setVersion(result.version ?? version); }
    else { setFailure(result.reason ?? "Not saved."); setDirty(false); }
  }), [saving, version]);

  useEffect(() => {
    const target = focusNext.current;
    if (!target) return;
    focusNext.current = null;
    const field = document.querySelector<HTMLTextAreaElement>(`[data-words="${target.id}"]`);
    field?.focus(); field?.setSelectionRange(target.at, target.at);
  });

  const cast = useMemo(() => pickableSheets(world.sheets, production.meta.id).filter((sheet) => sheet.type === "character"), [world.sheets, production.meta.id]);
  const name = (slug: string) => cast.find((sheet) => sheet.id === slug)?.name ?? slug;
  const scenes = scenesOf(blocks);
  const beds = bedMarks(blocks);
  const tones = speakerTones(blocks);
  const estimate = estimateScriptSeconds(blocks);
  const headings = blocks.filter((block): block is ScriptHeading => block.kind === "heading");
  const selectedIndex = blocks.findIndex((block) => block.id === selected);
  const selectedScene = selectedIndex >= 0 ? scenes[selectedIndex] : headings[0] ?? null;
  const source = production.audioDrama?.source ? world.productions.find((p) => p.meta.id === production.audioDrama!.source!.productionId) ?? null : null;
  const newLines = blocks.filter((block, i) => (block.kind === "dialogue" || block.kind === "narration") && scenes[i]?.source && !block.paragraphs?.length).length;

  const insertAfter = (kind: EpisodeScriptBlock["kind"]) => {
    const at = selectedIndex >= 0 ? selectedIndex + 1 : blocks.length;
    const previousSpeaker = blocks.slice(0, at).reverse().find((block) => block.kind === "dialogue");
    const block = newBlock(kind, previousSpeaker?.kind === "dialogue" ? previousSpeaker.speaker : cast[0]?.id);
    edit([...blocks.slice(0, at), block, ...blocks.slice(at)]);
    setSelected(block.id);
    if (block.kind === "dialogue" || block.kind === "narration") focusNext.current = { id: block.id, at: 0 };
  };
  const remove = (id: string) => { edit(blocks.filter((block) => block.id !== id)); setSelected(null); };

  const onWordsKey = (event: KeyboardEvent<HTMLTextAreaElement>, block: EpisodeScriptBlock) => {
    const field = event.currentTarget;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const next = splitBlock(blocks, block.id, field.selectionStart);
      const added = next[next.findIndex((candidate) => candidate.id === block.id) + 1]!;
      edit(next); setSelected(added.id); focusNext.current = { id: added.id, at: 0 };
    } else if (event.key === "Backspace" && field.selectionStart === 0 && field.selectionEnd === 0) {
      const index = blocks.findIndex((candidate) => candidate.id === block.id);
      const upper = blocks[index - 1];
      const joined = joinBlock(blocks, block.id);
      if (!joined || !upper || (upper.kind !== "dialogue" && upper.kind !== "narration")) return;
      event.preventDefault();
      const at = upper.words.length + (upper.words && "words" in block && block.words ? 1 : 0);
      edit(joined); setSelected(upper.id); focusNext.current = { id: upper.id, at };
    }
  };

  const download = () => {
    const text = scriptAsText(title, episode, blocks, name);
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
    link.download = `${production.meta.id}-episode-${episode}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  };

  return (
    <div className="fy-ad-ep" data-screen="episode-script">
      <header className="fy-ad-ep__bar">
        <IconButton label="Previous episode" disabled={episode <= 1} onClick={() => navigate(`${base}/script/${episode - 1}`)}><ChevronLeft size={16} /></IconButton>
        <IconButton label="Next episode" disabled={episode >= episodes} onClick={() => navigate(`${base}/script/${episode + 1}`)}><ChevronRight size={16} /></IconButton>
        <nav className="fy-ad-ep__views" aria-label="Episode views">
          <button type="button" onClick={() => navigate(base)}>Episodes</button>
          <button type="button" aria-current="page">Script</button>
        </nav>
        <label className="fy-ad-ep__title">
          <span>Episode {episode}</span>
          <input aria-label="Episode title" value={title} placeholder="Title" maxLength={160}
            onChange={(event) => { setTitle(event.target.value); setDirty(true); }} />
        </label>
        {headings.length > 0 && (
          <select aria-label="Scene" className="fy-ad-ep__scene" value={selectedScene?.id ?? ""} onChange={(event) => {
            setSelected(event.target.value);
            document.querySelector(`[data-block="${event.target.value}"]`)?.scrollIntoView({ block: "start" });
          }}>
            {headings.map((heading, i) => <option key={heading.id} value={heading.id}>{i + 1} · {heading.place}</option>)}
          </select>
        )}
        <span className="gap" />
        {/* The listening ring (230d): what the script will run, against the plan's target. */}
        <span className="fy-ad-ep__ring" title="Estimated listening time">
          <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8" /><circle cx="10" cy="10" r="8"
            style={{ strokeDasharray: `${Math.min(1, estimate / Math.max(1, (plan?.minutes ?? 25) * 60)) * 50.3} 50.3` }} /></svg>
          <b>{clock(estimate)}</b><span>/ {plan?.minutes ?? 25}:00</span>
        </span>
        <button type="button" className={cx("fy-ad-ep__toggle", sourceOpen && "fy-ad-ep__toggle--on")} aria-pressed={sourceOpen} onClick={() => setSourceOpen(!sourceOpen)}>
          <BookOpen size={14} />Source
        </button>
        <span className="fy-ad-ep__more">
          <IconButton label="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><More size={16} /></IconButton>
          {menuOpen && (
            <div role="menu" className="fy-ad-ep__menu" onClick={() => setMenuOpen(false)}>
              <button type="button" role="menuitem" onClick={download}>Download script</button>
              <button type="button" role="menuitem" onClick={() => window.print()}>Print</button>
            </div>
          )}
        </span>
      </header>
      <div className={cx("fy-ad-ep__body", sourceOpen && "fy-ad-ep__body--source")}>
        <div className="fy-ad-score" role="list" aria-label={`Episode ${episode} script`}>
          {blocks.length === 0 && (
            <div className="fy-ad-score__empty">
              <p>No script yet.</p>
              <Button variant="primary" onClick={() => insertAfter("heading")}>Start the script</Button>
            </div>
          )}
          {blocks.map((block, i) => {
            const scene = scenes[i] ?? null;
            const on = selected === block.id;
            const lanes = beds[i]!;
            const lane = (which: "ambience" | "music") => {
              const mark = lanes.find((candidate) => candidate.lane === which);
              return <span className={cx("fy-ad-score__lane", mark && `fy-ad-score__lane--${mark.at}`, mark?.stops && mark.at === "end" && "fy-ad-score__lane--foot")} data-lane={which} />;
            };
            const isNew = (block.kind === "dialogue" || block.kind === "narration") && !!scene?.source && !block.paragraphs?.length;
            return (
              <div key={block.id} role="listitem" data-block={block.id} aria-selected={on}
                className={cx("fy-ad-score__row", `fy-ad-score__row--${block.kind}`, on && "fy-ad-score__row--on",
                  block.kind === "dialogue" && `fy-voice--${tones.get(block.speaker) ?? 1}`,
                  block.kind === "dialogue" && block.overlapsPrevious && "fy-ad-score__row--breaks-in")}
                onClick={() => setSelected(block.id)}>
                {lane("ambience")}{lane("music")}
                {block.kind === "heading" ? (
                  <HeadingRow block={block} n={headings.indexOf(block) + 1} on={on} production={production} world={world}
                    source={source} onChange={(patch) => change(block.id, patch)} onSource={() => { setSelected(block.id); setSourceOpen(true); }} />
                ) : (
                  <>
                    <div className="fy-ad-score__who">
                      {block.kind === "dialogue" && (on
                        ? <select aria-label="Speaker" value={block.speaker} onChange={(event) => change(block.id, { speaker: event.target.value })}>
                            {!cast.some((sheet) => sheet.id === block.speaker) && <option value={block.speaker}>{block.speaker}</option>}
                            {cast.map((sheet) => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}
                          </select>
                        : <b className="fy-ad-score__speaker">{name(block.speaker)}</b>)}
                      {block.kind === "dialogue" && block.channel && !on && <small>{block.channel}</small>}
                      {block.kind === "narration" && <b className="fy-ad-score__speaker">Narrator</b>}
                      {(block.kind === "sound" || block.kind === "ambience" || block.kind === "music") && <span className="fy-ad-score__cuekind">{CUE_LABEL[block.kind]}</span>}
                      {block.kind === "silence" && <span className="fy-ad-score__cuekind">Silence</span>}
                      {block.kind === "note" && <span className="fy-ad-score__cuekind">Note</span>}
                    </div>
                    <div className="fy-ad-score__words">
                      {(block.kind === "dialogue" || block.kind === "narration") && (
                        <>
                          {(on || block.direction) && (
                            // How, in parentheses above the words, never part of them (R-13).
                            <span className="fy-ad-score__dirwrap">(<input className="fy-ad-score__direction" aria-label="Direction" placeholder="direction" value={block.direction ?? ""} maxLength={240}
                              onChange={(event) => change(block.id, { direction: event.target.value || undefined } as Partial<EpisodeScriptBlock>)} />)</span>
                          )}
                          <span className="fy-ad-score__line">
                            <textarea data-words={block.id} aria-label={block.kind === "dialogue" ? `${name(block.speaker)}'s line` : "Narration"}
                              rows={1} value={block.words} placeholder="…" onFocus={() => setSelected(block.id)}
                              onKeyDown={(event) => onWordsKey(event, block)}
                              onChange={(event) => change(block.id, { words: event.target.value.replace(/\n/g, " ") })} />
                            {block.kind === "dialogue" && block.cut && <span className="fy-ad-score__cut" aria-label="broken off">—</span>}
                            {isNew && <span className="fy-ad-score__new">new</span>}
                          </span>
                        </>
                      )}
                      {(block.kind === "sound" || block.kind === "ambience" || block.kind === "music") && (
                        <div className={cx("fy-ad-score__cue", block.required && !block.soundArtifact && "fy-ad-score__cue--missing")}>
                          <textarea aria-label="What is heard" rows={1} value={block.heard} maxLength={600}
                            onChange={(event) => change(block.id, { heard: event.target.value.replace(/\n/g, " ") })} />
                          {(block.purpose || on) && <input aria-label="Why" placeholder="why it is heard" value={block.purpose ?? ""} maxLength={240}
                            onChange={(event) => change(block.id, { purpose: event.target.value || undefined } as Partial<EpisodeScriptBlock>)} />}
                          {block.required && !block.soundArtifact && <small className="fy-ad-score__warn">No sound yet</small>}
                        </div>
                      )}
                      {block.kind === "silence" && (
                        <div className="fy-ad-score__silence">
                          <span className="fy-ad-score__gap" style={{ width: `${Math.min(10, block.seconds) * 18}px` }} />
                          <input aria-label="Seconds" type="number" min={0.1} max={120} step={0.5} value={block.seconds}
                            onChange={(event) => { const seconds = Number(event.target.value); if (seconds >= 0.1 && seconds <= 120) change(block.id, { seconds }); }} />
                          <span>s</span>
                          {(block.note || on) && <input aria-label="Silence note" placeholder="what fills it" value={block.note ?? ""} maxLength={240}
                            onChange={(event) => change(block.id, { note: event.target.value || undefined } as Partial<EpisodeScriptBlock>)} />}
                        </div>
                      )}
                      {block.kind === "note" && (
                        <textarea className="fy-ad-score__note" aria-label="Note" rows={1} value={block.text} maxLength={2_000}
                          onChange={(event) => change(block.id, { text: event.target.value })} />
                      )}
                    </div>
                    {/* The take (S-3): a spoken line's place for its performance. */}
                    <span className="fy-ad-score__take" aria-hidden="true">{block.kind === "dialogue" || block.kind === "narration" ? "○" : ""}</span>
                  </>
                )}
                {on && (
                  <RowTools block={block} index={i} blocks={blocks} scene={scene} onChange={(patch) => change(block.id, patch)}
                    onBreak={(broken) => {
                      const next = blocks[i + 1];
                      if (next?.kind !== "dialogue") return;
                      edit(blocks.map((candidate, at) => at === i ? { ...candidate, cut: broken || undefined } as EpisodeScriptBlock
                        : at === i + 1 ? { ...candidate, overlapsPrevious: broken || undefined } as EpisodeScriptBlock : candidate));
                    }}
                    onInsert={insertAfter} onRemove={() => remove(block.id)} />
                )}
              </div>
            );
          })}
          {blocks.length > 0 && selectedIndex < 0 && (
            <div className="fy-ad-score__add">
              {INSERTS.map(([kind, label]) => <button key={kind} type="button" onClick={() => insertAfter(kind)}>+ {label}</button>)}
            </div>
          )}
        </div>
        {sourceOpen && (
          <SourceColumn world={world} story={selectedScene?.source ? world.productions.find((p) => p.meta.id === selectedScene.source!.story) ?? null : source}
            heading={selectedScene ?? null} block={selectedIndex >= 0 ? blocks[selectedIndex]! : null} onClose={() => setSourceOpen(false)} />
        )}
      </div>
      <footer className="fy-ad-ep__foot">
        <span role="status">
          {failure ? <>Not saved · {failure} <button type="button" className="fy-linkbtn" onClick={() => {
            setFailure(null); setDirty(false);
            if (stored) { setBlocks(stored.script.blocks); setTitle(stored.script.title); setBaseHash(stored.hash); setVersion(stored.script.version); }
          }}>Take the saved script</button></>
            : saving || dirty ? "Saving…" : version !== null ? `Saved · script v${version}` : "Not started"}
        </span>
        <span className="gap" />
        {newLines > 0 && <span>{newLines} new line{newLines === 1 ? "" : "s"}</span>}
      </footer>
    </div>
  );
}

/** A scene's heading (230f): number, place and time, then Heard as, its chapter and its length. */
function HeadingRow({ block, n, on, production, world, source, onChange, onSource }: {
  block: ScriptHeading; n: number; on: boolean; production: ProductionBundle; world: WorldBundle;
  source: ProductionBundle | null; onChange: (patch: Partial<ScriptHeading>) => void; onSource: () => void;
}) {
  const story = block.source ? world.productions.find((p) => p.meta.id === block.source!.story) ?? null : source;
  const chapter = block.source ? story?.chapters.find((c) => c.id === block.source!.chapter) : undefined;
  const current = chapter?.version ?? null;
  const changed = block.source && current !== null && current > block.source.version;
  const heardAs = block.heardAs ?? (production.audioDrama?.plan.narrator === "narrated" ? "narrated" : production.audioDrama?.plan.narrator === "in-the-room" ? "in-the-room" : undefined);
  return (
    <div className="fy-ad-score__heading">
      <span className="fy-ad-score__n">{n}</span>
      <div>
        <div className="fy-ad-score__place">
          <input aria-label="Place" value={block.place} maxLength={160} onChange={(event) => onChange({ place: event.target.value })} />
          <input aria-label="Time" placeholder="time" value={block.time ?? ""} maxLength={80} onChange={(event) => onChange({ time: event.target.value || undefined })} />
        </div>
        <div className="fy-ad-score__chips">
          {on ? (
            <select aria-label="Heard as" value={block.heardAs ?? ""} onChange={(event) => onChange({ heardAs: (event.target.value || undefined) as ScriptHeading["heardAs"] })}>
              <option value="">{heardAs ? `${heardAsLabel(heardAs)} (plan)` : "Heard as…"}</option>
              <option value="narrated">Narrated</option><option value="in-the-room">In the room</option><option value="recording">A recording</option>
            </select>
          ) : heardAs && <span className="fy-ad-chip">{heardAsLabel(heardAs)}</span>}
          {on && story && (
            <select aria-label="Adapts chapter" value={block.source?.chapter ?? ""} onChange={(event) => {
              const picked = story.chapters.find((c) => c.id === event.target.value);
              onChange({ source: picked ? { story: story.meta.id, chapter: picked.id, version: picked.version ?? 1 } : undefined });
            }}>
              <option value="">No chapter</option>
              {story.chapters.filter((c) => !c.retired).map((c) => <option key={c.id} value={c.id}>Chapter {c.order} · {c.title}</option>)}
            </select>
          )}
          {on && block.source && (
            <input aria-label="Source paragraphs" className="fy-ad-score__paras" placeholder="¶ e.g. 14-17" defaultValue={(block.source.paragraphs ?? []).join(", ")}
              onBlur={(event) => onChange({ source: { ...block.source!, paragraphs: parseParagraphs(event.target.value) } })} />
          )}
          {!on && block.source && chapter && (
            <button type="button" className={cx("fy-ad-chip", changed && "fy-ad-chip--warn")} onClick={(event) => { event.stopPropagation(); onSource(); }}>
              Chapter {chapter.order}{changed ? ` · changed v${current}` : ""}
            </button>
          )}
          {block.estimateSec !== undefined && <span className="fy-ad-chip">≈{Math.floor(block.estimateSec / 60)}:{String(block.estimateSec % 60).padStart(2, "0")}</span>}
        </div>
      </div>
    </div>
  );
}

/** The selected row's own controls: channel, a line broken off, its source paragraphs, insert, delete. */
function RowTools({ block, index, blocks, scene, onChange, onBreak, onInsert, onRemove }: {
  block: EpisodeScriptBlock; index: number; blocks: EpisodeScriptBlock[]; scene: ScriptHeading | null;
  onChange: (patch: Partial<EpisodeScriptBlock>) => void; onBreak: (broken: boolean) => void;
  onInsert: (kind: EpisodeScriptBlock["kind"]) => void; onRemove: () => void;
}) {
  const next = blocks[index + 1];
  const sceneEnd = (() => { let end = index + 1; while (end < blocks.length && blocks[end]!.kind !== "heading") end++; return end; })();
  return (
    <div className="fy-ad-score__tools" onClick={(event) => event.stopPropagation()}>
      {block.kind === "dialogue" && (
        <>
          <select aria-label="Channel" value={block.channel ?? ""} onChange={(event) => onChange({ channel: (event.target.value || undefined) as ScriptChannel | undefined })}>
            <option value="">In the room</option><option value="off-mic">Off-mic</option><option value="radio">Radio</option><option value="recording">A recording</option>
          </select>
          <label><input type="checkbox" checked={!!block.cut} disabled={next?.kind !== "dialogue"} onChange={(event) => onBreak(event.target.checked)} /> Broken off by the next line</label>
        </>
      )}
      {(block.kind === "ambience" || block.kind === "music") && (
        <select aria-label="Runs until" value={block.until ?? ""} onChange={(event) => onChange({ until: event.target.value || undefined } as Partial<EpisodeScriptBlock>)}>
          <option value="">Runs to the end of the scene</option>
          {blocks.slice(index + 1, sceneEnd + 1).filter(Boolean).map((candidate, offset) => (
            <option key={candidate.id} value={candidate.id}>Stops before row {index + offset + 2}{candidate.kind === "heading" ? ` · scene ${candidate.place}` : ""}</option>
          ))}
        </select>
      )}
      {(block.kind === "sound" || block.kind === "ambience" || block.kind === "music") && (
        <label><input type="checkbox" checked={!!block.required} onChange={(event) => onChange({ required: event.target.checked || undefined } as Partial<EpisodeScriptBlock>)} /> Required</label>
      )}
      {(block.kind === "dialogue" || block.kind === "narration" || block.kind === "sound" || block.kind === "ambience" || block.kind === "music") && scene?.source && (
        <input aria-label="From source paragraphs" className="fy-ad-score__paras" placeholder="¶ from the chapter" defaultValue={(block.paragraphs ?? []).join(", ")}
          onBlur={(event) => { const paragraphs = parseParagraphs(event.target.value); onChange({ paragraphs: paragraphs.length ? paragraphs : undefined } as Partial<EpisodeScriptBlock>); }} />
      )}
      <span className="gap" />
      <select aria-label="Insert below" value="" onChange={(event) => { if (event.target.value) onInsert(event.target.value as EpisodeScriptBlock["kind"]); }}>
        <option value="">Insert below…</option>
        {INSERTS.map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}
      </select>
      <Button variant="ghost" size="sm" onClick={onRemove}>Delete</Button>
    </div>
  );
}

/**
 * The scene's source (230e, R-21): the exact chapter version it was adapted from, read-only and
 * numbered by paragraph, with the selected line's passage marked. A newer version is said, not
 * shown in its place: what the script answers to is the version it pinned.
 */
function SourceColumn({ world, story, heading, block, onClose }: {
  world: WorldBundle; story: ProductionBundle | null; heading: ScriptHeading | null; block: EpisodeScriptBlock | null; onClose: () => void;
}) {
  const pin = heading?.source;
  const chapter = pin && story ? story.chapters.find((c) => c.id === pin.chapter) : undefined;
  const [text, setText] = useState<{ key: string; paragraphs: string[] } | { key: string; failure: string } | null>(null);
  const key = pin && chapter ? `${story!.meta.id}:${chapter.id}:${pin.version}` : null;
  useEffect(() => {
    if (!key || !pin || !chapter || !story) return;
    let live = true;
    const done = (body: string) => { if (live) setText({ key, paragraphs: chapterParagraphs(body) }); };
    const fail = (failure: string) => { if (live) setText({ key, failure }); };
    readChapterVersion(world.meta.worldId, story.meta.id, chapter.file, pin.version).then(done, (error: Error) => {
      // A chapter that never went through a kept save has no snapshot of its current version.
      if ((chapter.version ?? 1) !== pin.version) { fail(error.message); return; }
      const requestId = openChapter(world.meta.worldId, story.meta.id, chapter.id);
      if (!requestId) { fail("Not connected."); return; }
      const stop = subscribeChapterOpenResults((result) => {
        if (result.requestId !== requestId) return;
        stop();
        if (result.disposition === "opened") done(result.body ?? ""); else fail("The chapter could not be read.");
      });
    });
    return () => { live = false; };
  }, [key]);
  const marked = new Set([...(block && "paragraphs" in block ? block.paragraphs ?? [] : []), ...(!block || block.kind === "heading" ? pin?.paragraphs ?? [] : [])]);
  const shown = text && text.key === key ? text : null;
  return (
    <aside className="fy-ad-source" aria-label="Source">
      <header><h2>Source</h2>{story && pin && <small>{story.meta.title} v{pin.version}</small>}<span className="gap" /><IconButton label="Close source" onClick={onClose}><X size={14} /></IconButton></header>
      {!pin || !chapter ? <p className="fy-ad-source__none">{heading ? "This scene adapts no chapter yet. Choose one in its heading." : "Select a scene."}</p> : (
        <>
          <h3><BookOpen size={14} />Chapter {chapter.order} · {chapter.title}</h3>
          {(chapter.version ?? 1) > pin.version && <p className="fy-ad-source__changed">The chapter is now v{chapter.version}. This scene was written from v{pin.version}.</p>}
          {block && "paragraphs" in block && block.paragraphs?.length ? <p className="fy-ad-source__from">{paragraphLabel(block.paragraphs)}</p> : null}
          {!shown ? <p className="fy-ad-source__none">Reading…</p> : "failure" in shown ? <p role="alert">{shown.failure}</p> : (
            <ol className="fy-ad-source__paras">
              {shown.paragraphs.map((paragraph, i) => (
                <li key={i} value={i + 1} className={cx(marked.has(i + 1) && "fy-ad-source__para--on")} data-paragraph={i + 1}>{paragraph}</li>
              ))}
            </ol>
          )}
          <Link className="fy-linkbtn" to={`/w/${world.meta.worldId}/p/${story!.meta.id}/story/chapters/${encodeURIComponent(chapter.id)}`}>Open in {story!.meta.title}</Link>
        </>
      )}
    </aside>
  );
}
