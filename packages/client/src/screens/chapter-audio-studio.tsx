import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatTimingSeconds, type ChapterTiming } from "@arke-studio/contracts";
import { Button } from "../components/ui.js";
import { ChevronLeft, Download, Play, Speaker } from "../components/icons.js";
import { EditorPanelTabs } from "./editor-panel-tabs.js";
import { EditorSheetSlot, useCutLayout } from "./editor-responsive.js";
import type { TimingRowLike } from "./chapter-timing.js";

/**
 * Turn 226's first slice composes the Cut shell around the existing chapter clock and writes.
 * There is deliberately no local arrangement copy: the supplied timeline and Inspector use
 * the acknowledged chapter record, and Play goes through the same mixer as Listen/export.
 */
export function ChapterAudioStudio({ book, title, rows, timing, selected, onSelect, playhead, onPlayhead,
  timeline, inspector, conversation, proposal, propose, reviewing, playing, pending, canPlay,
  onPlay, onStop, onBack, onExport, exportDisabled, problem,
}: {
  book: string; title: string; rows: readonly TimingRowLike[]; timing: ChapterTiming;
  selected: string | null; onSelect: (key: string) => void; playhead: number; onPlayhead: (seconds: number) => void;
  timeline: ReactNode; inspector: ReactNode; conversation: ReactNode; proposal: ReactNode; propose: ReactNode;
  reviewing: boolean; playing: boolean; pending: boolean; canPlay: boolean;
  onPlay: (seconds: number) => void; onStop: () => void; onBack: () => void; onExport: () => void;
  exportDisabled: boolean; problem: string | null;
}) {
  const { phone, compact } = useCutLayout();
  const [panel, setPanel] = useState<"inspector" | "arke">("inspector");
  const [detailsOpen, setDetailsOpen] = useState(false), [arkeOpen, setArkeOpen] = useState(false), [libraryOpen, setLibraryOpen] = useState(false);
  const [search, setSearch] = useState(""), [follow, setFollow] = useState(true);
  const script = useRef<HTMLDivElement>(null);
  const sounding = playing ? timing.bars.find(bar => bar.kind === "block" && bar.made && bar.at <= playhead && playhead < bar.at + bar.seconds)?.key : null;
  useEffect(() => {
    if (!follow || !sounding) return;
    const row = [...(script.current?.querySelectorAll<HTMLElement>("[data-passage]") ?? [])].find(node => node.dataset.passage === sounding);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [follow, sounding]);
  const inspect = () => { setPanel("inspector"); setDetailsOpen(true); setLibraryOpen(false); setArkeOpen(false); };
  const select = (key: string) => { onSelect(key); setPanel("inspector"); };
  const arke = () => { setPanel("arke"); setArkeOpen(true); setLibraryOpen(false); setDetailsOpen(false); };
  const library = <div className="fy-audio-library">
    <header className="fy-artpanel__head"><b>Library</b></header>
    <div className="fy-audio-library__tabs"><b>Media</b></div>
    <label className="fy-audio-library__search"><span className="fy-sr-only">Search chapter audio</span><input aria-label="Search chapter audio" placeholder="Find a take or sound…" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <div className="fy-audio-library__items">
      {rows.filter(row => timing.bars.some(bar => bar.key === row.block.key && bar.made) && `${row.mark} ${row.block.text}`.toLowerCase().includes(search.toLowerCase())).map(row => <button type="button" key={row.block.key} aria-pressed={selected === row.block.key} onClick={() => { select(row.block.key); setLibraryOpen(false); }}><Speaker size={18} /><span><b>{row.mark}</b><small>{row.block.text}</small></span></button>)}
      {timing.beds.filter(bed => bed.source.label.toLowerCase().includes(search.toLowerCase())).map(bed => <button type="button" key={`bed:${bed.id}`} onClick={() => { const row = rows[bed.fromIndex]; if (row) select(row.block.key); setLibraryOpen(false); }}><Speaker size={18} /><span><b>{bed.source.label}</b><small>Bed · {formatTimingSeconds(bed.seconds)}</small></span></button>)}
      {timing.sounds.filter(sound => sound.source.label.toLowerCase().includes(search.toLowerCase())).map(sound => <button type="button" key={`sound:${sound.id}`} onClick={() => { const row = rows[sound.index]; if (row) select(row.block.key); setLibraryOpen(false); }}><Speaker size={18} /><span><b>{sound.source.label}</b><small>Sound effect</small></span></button>)}
      {!timing.bars.some(bar => bar.made) && timing.beds.length === 0 && timing.sounds.length === 0 && <p>Choose performances in Audiobook. Add beds and sounds in the Inspector.</p>}
    </div>
    <footer><Button variant="ghost" onClick={onBack}>Open Audiobook</Button></footer>
  </div>;
  const play = <Button size="sm" aria-label={playing || pending ? "Stop" : "Play"} disabled={(reviewing || !canPlay) && !playing && !pending} onClick={() => playing || pending ? onStop() : onPlay(playhead)}>{!(playing || pending) && <Play size={14} />}{pending ? "Mixing…" : playing ? "Stop" : "Play"}</Button>;
  return <div className="fy-cutcols fy-audio-studio" data-testid="audio-studio" data-phone={phone || undefined} data-compact={compact || undefined} data-reviewing={reviewing || undefined}>
    <aside className="fy-artpanel fy-audio-studio__library" aria-label="Library">
      <EditorSheetSlot sheet={compact} open={libraryOpen} title="Library" onClose={() => setLibraryOpen(false)}>{library}</EditorSheetSlot>
    </aside>
    <main className="fy-cutmain">
      {phone && <header className="fy-cut-back"><button type="button" aria-label="Back to Audiobook" onClick={onBack}><ChevronLeft size={20} /></button><div><span>{book}</span><b>Audio Studio · {title}</b></div><Button onClick={onExport} disabled={exportDisabled || reviewing}><Download size={16} />Export</Button></header>}
      <header className="fy-cuthead">
        <Button size="sm" variant="ghost" onClick={onBack}><ChevronLeft size={12} />Audiobook</Button>
        <div className="fy-cuthead__title"><h1>Audio Studio</h1><span className="fy-cuthead__meta">{title} · {formatTimingSeconds(timing.seconds)}</span></div>
        <span className="fy-h1row__push" />
        <Button size="sm" disabled={!canPlay || pending || reviewing} onClick={() => onPlay(0)}><Play size={12} />Listen from top</Button>
        <Button size="sm" variant="primary" disabled={exportDisabled || reviewing} onClick={onExport}><Download size={12} />Export…</Button>
      </header>
      {proposal}
      {problem && <p role="status" className="fy-cuttimeline-error">{problem}</p>}
      <div className="fy-cutpreview-wrap">
        <section className="fy-audio-script" aria-label="Chapter script">
          <header><b>Script</b><span>{title}</span><Button size="sm" variant="ghost" aria-pressed={follow} onClick={() => setFollow(value => !value)}>Follow playhead</Button></header>
          <div className="fy-audio-script__passages" ref={script}>
            {rows.map(row => <button type="button" key={row.block.key} data-passage={row.block.key} aria-pressed={selected === row.block.key} data-sounding={sounding === row.block.key || undefined} onClick={() => { select(row.block.key); if (!playing && !pending) onPlayhead(timing.bars.find(bar => bar.key === row.block.key)?.at ?? 0); }}><span>{row.mark}</span><span>{row.block.text}{!timing.bars.find(bar => bar.key === row.block.key)?.made && <small>Not read</small>}</span></button>)}
            {!rows.length && <p>No script passages yet.</p>}
          </div>
          {!compact && <footer>{play}<span className="fy-mono">{formatTimingSeconds(playhead)} / {formatTimingSeconds(timing.seconds)}</span></footer>}
        </section>
      </div>
      {compact && <div className="fy-cut-clock">{play}<span className="fy-mono">{formatTimingSeconds(playhead)} / {formatTimingSeconds(timing.seconds)}</span></div>}
      <div className="fy-audio-studio__timeline">{timeline}</div>
    </main>
    <aside className="fy-cutside" aria-label="Editor details">
      <div className="fy-cutside__head"><EditorPanelTabs value={panel} onChange={setPanel} /></div>
      <EditorSheetSlot sheet={phone} open={detailsOpen} title="Details" onClose={() => setDetailsOpen(false)} className="fy-cut-trim-sheet" footer={<><span>Chapter audio · seconds</span><Button variant="primary" onClick={() => setDetailsOpen(false)}>Done</Button></>}>
        <div className="fy-cutside__panel fy-cutside__panel--inspect" id="cut-inspector-panel" role={compact ? undefined : "tabpanel"} aria-labelledby={compact ? undefined : "cut-inspector-tab"} hidden={!compact && panel !== "inspector"}>{reviewing && <p className="fy-audio-studio__propose">Current timing · review the proposed changes above.</p>}{selected === null ? <p className="fy-audio-studio__propose">Select a passage or clip to inspect its timing and sounds.</p> : inspector}</div>
      </EditorSheetSlot>
      <EditorSheetSlot sheet={compact} open={arkeOpen} title="Arke" onClose={() => setArkeOpen(false)}>
        <div className="fy-cutside__panel fy-cutside__panel--arke" id="cut-arke-panel" role={compact ? undefined : "tabpanel"} aria-labelledby={compact ? undefined : "cut-arke-tab"} hidden={!compact && panel !== "arke"}>{propose}{conversation}</div>
      </EditorSheetSlot>
    </aside>
    {compact && !phone && <button type="button" className="fy-cut-arke-rail" onClick={arke}><span>Arke</span></button>}
    {compact && <nav className="fy-cut-tools" aria-label="Audio Studio panels"><Button onClick={() => { setLibraryOpen(true); setDetailsOpen(false); setArkeOpen(false); }}>Library</Button><Button onClick={inspect}>Inspect</Button><Button onClick={arke}>Arke</Button></nav>}
  </div>;
}
