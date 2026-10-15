import { useEffect, useState } from "react";
import { audioSamples, audioSeconds, type AudioArrangementCommand, type AudioClip, type AudioPlacement, type AudioStudioSnapshot } from "@arke-studio/contracts";
import { Button, Input, Select } from "../components/ui.js";

function NumberField({ label, value, onChange, min, max, step = 0.001 }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number }) {
  return <label className="fy-audio-inspector__field"><span>{label}</span><Input aria-label={label} type="number" value={Number(value.toFixed(6))} min={min} max={max} step={step} onChange={event => { if (Number.isFinite(event.target.valueAsNumber)) onChange(event.target.valueAsNumber); }} /></label>;
}
export function AudioStudioInspector({ snapshot, selected, trackId, disabled, onEdit, onReplace }: {
  snapshot: AudioStudioSnapshot; selected: string | null; trackId: string | null; disabled: boolean;
  onEdit: (label: string, commands: AudioArrangementCommand[], base?: string) => void; onReplace: () => void;
}) {
  const clip = snapshot.state.clips.find(entry => entry.id === selected);
  const track = snapshot.state.tracks.find(entry => entry.id === (trackId ?? clip?.trackId));
  if (clip) return <ClipInspector key={clip.id} clip={clip} snapshot={snapshot} disabled={disabled} onEdit={onEdit} onReplace={onReplace} />;
  return <div className="fy-audio-inspector">
    <header><b>{track?.name ?? "Chapter mix"}</b></header>
    {track && <form key={`${track.id}/${snapshot.base}`} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); onEdit("Update track", [{ kind: "set-track", id: track.id, changes: { name: String(data.get("name")), gainDb: Number(data.get("gain")) } }]); }}>
      <fieldset disabled={disabled}><label className="fy-audio-inspector__field"><span>Track name</span><Input name="name" defaultValue={track.name} maxLength={120} required /></label><label className="fy-audio-inspector__field"><span>Track level (dB)</span><Input name="gain" type="number" min={-96} max={24} step={0.1} defaultValue={track.gainDb} /></label><Button type="submit">Apply track</Button><Button type="button" variant="ghost" disabled={snapshot.state.clips.some(entry => entry.trackId === track.id)} onClick={() => onEdit("Remove track", [{ kind: "remove-track", id: track.id }])}>Remove empty track</Button></fieldset>
    </form>}
    <form key={`master/${snapshot.base}`} onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); onEdit("Set chapter master", [{ kind: "set-master", master: { targetLufs: Number(data.get("lufs")), ceilingDb: Number(data.get("ceiling")) } }]); }}>
      <fieldset disabled={disabled}><legend>Chapter master</legend><p>Applied once to the complete stereo mix.</p><label className="fy-audio-inspector__field"><span>Target loudness (LUFS)</span><Input name="lufs" type="number" min={-30} max={-10} step={0.1} defaultValue={snapshot.state.master.targetLufs} /></label><label className="fy-audio-inspector__field"><span>Sample ceiling (dBFS)</span><Input name="ceiling" type="number" min={-6} max={-0.1} step={0.1} defaultValue={snapshot.state.master.ceilingDb} /></label><Button type="submit">Apply master</Button></fieldset>
    </form>
  </div>;
}
function ClipInspector({ clip, snapshot, disabled, onEdit, onReplace }: { clip: AudioClip; snapshot: AudioStudioSnapshot; disabled: boolean; onEdit: (label: string, commands: AudioArrangementCommand[], base?: string) => void; onReplace: () => void }) {
  const [draft, setDraft] = useState(clip), [base, setBase] = useState(snapshot.base), [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) { setDraft(clip); setBase(snapshot.base); } }, [clip, snapshot.base, dirty]);
  const change = <K extends keyof AudioClip>(key: K, value: AudioClip[K]) => { setDirty(true); setDraft(held => ({ ...held, [key]: value })); };
  const placement = (value: AudioPlacement) => change("placement", value);
  const passages = snapshot.state.passages.map(passage => ({ ...passage, label: snapshot.passages.find(entry => entry.key === passage.key)?.text.slice(0, 70) ?? `${passage.key} · needs repair` }));
  const passageSelect = (label: string, value: string, set: (id: string) => void) => <label className="fy-audio-inspector__field"><span>{label}</span><Select label={label} value={value} onChange={event => set(event.target.value)}>{passages.map(passage => <option key={passage.id} value={passage.id}>{passage.label}</option>)}</Select></label>;
  const seconds = (label: string, value: number, set: (samples: number) => void, min?: number) => <NumberField label={label} value={audioSeconds(value)} min={min} onChange={value => set(audioSamples(value))} />;
  const mode = draft.placement;
  const reset = () => { setDraft(clip); setBase(snapshot.base); setDirty(false); };
  return <div className="fy-audio-inspector"><header><b>Clip</b><span>{clip.role}</span></header>
    <p className="fy-audio-inspector__source">{clip.source?.label ?? "Source unavailable"}<small>{clip.source ? `${clip.source.channels === 2 ? "Stereo" : "Mono"} · ${clip.source.rate / 1000} kHz · exact source` : "Choose a replacement from Library"}</small></p>
    <div className="fy-audio-inspector__actions"><Button disabled={disabled || clip.protected} onClick={onReplace}>Replace source…</Button><Button disabled={disabled} variant="ghost" onClick={() => onEdit(clip.protected ? "Release clip protection" : "Protect clip", [{ kind: "protect-clip", id: clip.id, protected: !clip.protected }])}>{clip.protected ? "Release protection" : "Protect clip"}</Button></div>
    <form onSubmit={event => { event.preventDefault(); const { id: _id, source: _source, protected: _protected, repeated: _repeated, ...changes } = draft; onEdit("Update clip", [{ kind: "set-clip", id: clip.id, changes }], base); setDirty(false); }}>
      <fieldset disabled={disabled || clip.protected}>
        <label className="fy-audio-inspector__field"><span>Name</span><Input aria-label="Clip name" value={draft.label} maxLength={200} required onChange={event => change("label", event.target.value)} /></label>
        <label className="fy-audio-inspector__field"><span>Role</span><Select label="Audio role" value={draft.role} onChange={event => change("role", event.target.value as AudioClip["role"])}>{["speech", "music", "ambience", "sfx"].map(role => <option key={role} value={role}>{role === "sfx" ? "Sound effect" : role}</option>)}</Select></label>
        <label className="fy-audio-inspector__field"><span>Track</span><Select label="Clip track" value={draft.trackId} onChange={event => change("trackId", event.target.value)}>{snapshot.state.tracks.map(track => <option key={track.id} value={track.id}>{track.name}</option>)}</Select></label>
        <h3>Placement</h3>
        <Select label="Placement mode" value={mode.kind} onChange={event => {
          const id = draft.passageId ?? passages[0]?.id;
          if (event.target.value === "fixed") placement({ kind: "fixed", at: 0 });
          else if (event.target.value === "sequence") placement({ kind: "sequence", offset: 0 });
          else if (id && event.target.value === "passage") placement({ kind: "passage", anchor: { passageId: id, edge: "start", offset: 0 } });
          else if (id) placement({ kind: "range", from: { passageId: id, edge: "start", offset: 0 }, to: { passageId: id, edge: "end", offset: 0 } });
        }}><option value="fixed">Fixed time</option><option value="sequence" disabled={draft.role !== "speech" || !draft.passageId}>Follow reading sequence</option><option value="passage" disabled={!passages.length}>Linked to passage</option><option value="range" disabled={!passages.length}>Passage range</option></Select>
        {mode.kind === "fixed" && seconds("Start (s)", mode.at, at => placement({ ...mode, at }), 0)}
        {mode.kind === "sequence" && seconds("Gap / overlap (s)", mode.offset, offset => placement({ ...mode, offset }))}
        {mode.kind === "passage" && <>{passageSelect("Linked passage", mode.anchor.passageId, passageId => placement({ ...mode, anchor: { ...mode.anchor, passageId } }))}<Select label="Passage edge" value={mode.anchor.edge} onChange={event => placement({ ...mode, anchor: { ...mode.anchor, edge: event.target.value as "start" | "end" } })}><option value="start">Start</option><option value="end">End</option></Select>{seconds("Offset (s)", mode.anchor.offset, offset => placement({ ...mode, anchor: { ...mode.anchor, offset } }))}</>}
        {mode.kind === "range" && (["from", "to"] as const).map(edge => <div key={edge}>{passageSelect(edge === "from" ? "Range from" : "Range to", mode[edge].passageId, passageId => placement({ ...mode, [edge]: { ...mode[edge], passageId } }))}<Select label={`${edge} passage edge`} value={mode[edge].edge} onChange={event => placement({ ...mode, [edge]: { ...mode[edge], edge: event.target.value } })}><option value="start">Start</option><option value="end">End</option></Select>{seconds(`${edge} offset (s)`, mode[edge].offset, offset => placement({ ...mode, [edge]: { ...mode[edge], offset } }))}</div>)}
        <h3>Source window</h3>{seconds("Source in (s)", draft.sourceIn, value => change("sourceIn", value), 0)}{seconds("Source out (s)", draft.sourceOut, value => change("sourceOut", value), 0)}
        <h3>Mix</h3><NumberField label="Clip level (dB)" value={draft.gainDb} min={-96} max={24} step={0.1} onChange={value => change("gainDb", value)} /><NumberField label="Pan (−1 left, +1 right)" value={draft.pan} min={-1} max={1} step={0.05} onChange={value => change("pan", value)} />
        {seconds("Fade in (s)", draft.fadeIn, value => change("fadeIn", value), 0)}{seconds("Fade out (s)", draft.fadeOut, value => change("fadeOut", value), 0)}
        <label className="fy-audio-inspector__check"><input type="checkbox" checked={draft.loop} onChange={event => change("loop", event.target.checked)} />Loop source window</label>
        {draft.loop && seconds("Loop crossfade (s)", draft.loopFade, value => change("loopFade", value), 0)}
        <NumberField label="Duck under speech (dB)" value={draft.duckDb} min={0} max={30} step={0.5} onChange={value => change("duckDb", value)} />
        {dirty && base !== snapshot.base && <p role="status">The arrangement changed while you edited. Reset these fields before applying.</p>}
        <div className="fy-audio-inspector__actions"><Button type="submit" variant="primary" disabled={!dirty || base !== snapshot.base}>Apply changes</Button><Button type="button" variant="ghost" disabled={!dirty} onClick={reset}>Reset fields</Button></div>
      </fieldset>
    </form>
  </div>;
}
