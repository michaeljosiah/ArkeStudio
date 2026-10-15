import { useState } from "react";
import { audioSamples, type AudioArrangementCommand, type AudioStudioSnapshot } from "@arke-studio/contracts";
import { Button, Input } from "../components/ui.js";
import { Speaker } from "../components/icons.js";
import { ARTIFACT_DRAG_TYPE, LANE_DRAG_SOUND } from "./editor-audio.js";

export function AudioStudioLibrary({ snapshot, selected, disabled, replacing, onAdd, onImport, onEdit, onCancelReplace }: {
  snapshot: AudioStudioSnapshot; selected: string | null; disabled: boolean; replacing: boolean;
  onAdd: (file: string, asSpeech: boolean) => void; onImport: () => void; onCancelReplace: () => void;
  onEdit: (label: string, commands: AudioArrangementCommand[]) => void;
}) {
  const [tab, setTab] = useState("Media"), [search, setSearch] = useState("");
  const clip = snapshot.state.clips.find(entry => entry.id === selected);
  const effect = (label: string, changes: Extract<AudioArrangementCommand, { kind: "set-clip" }>["changes"]) => { if (clip) onEdit(label, [{ kind: "set-clip", id: clip.id, changes }]); };
  return <div className="fy-audio-library"><header className="fy-artpanel__head"><b>Library</b><Button size="sm" disabled={disabled} onClick={onImport}>Import</Button></header>
    <div className="fy-audio-library__tabs" role="tablist" aria-label="Library content">{["Media", "Effects", "Transitions"].map(value => <button type="button" key={value} role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>{value}</button>)}</div>
    {tab === "Media" && <><label className="fy-audio-library__search"><Input aria-label="Search audio library" placeholder="Find a take or sound…" value={search} onChange={event => setSearch(event.target.value)} /></label>
      {replacing && <div className="fy-audio-studio__propose"><b>Replace {clip?.label}</b><p>Choose a source to compare Current and Suggested.</p><Button size="sm" onClick={onCancelReplace}>Cancel replacement</Button></div>}
      <div className="fy-audio-library__items">{snapshot.library.filter(entry => entry.label.toLowerCase().includes(search.toLowerCase())).map(entry => <div className="fy-audio-library__asset" key={entry.artifactId} draggable={!disabled} onDragStart={event => { event.dataTransfer.setData(ARTIFACT_DRAG_TYPE, entry.artifactId); event.dataTransfer.setData(LANE_DRAG_SOUND, "true"); }}>
        <Speaker size={16} /><div><b>{entry.label}</b><small>{snapshot.state.clips.some(clip => clip.source?.file === entry.file) ? "In arrangement" : entry.block ? "Available take" : "Audio asset"}</small><div className="fy-audio-inspector__actions"><Button size="sm" disabled={disabled} onClick={() => onAdd(entry.file, false)}>{replacing ? "Review replacement" : "Add at playhead"}</Button>{!replacing && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onAdd(entry.file, true)}>Use for passage</Button>}</div></div>
      </div>)}{!snapshot.library.length && <p>Import audio, or generate performances in Audiobook.</p>}</div></>}
    {tab !== "Media" && <div className="fy-audio-library__items"><p>{clip ? `Apply to ${clip.label}` : "Select a clip to apply an effect."}</p>
      <fieldset disabled={disabled || !clip || clip.protected} className="fy-audio-library__presets">
        {tab === "Effects" ? <><Button onClick={() => effect("Duck under speech", { duckDb: 12 })}>Duck under speech · −12 dB</Button><Button onClick={() => effect("Remove speech ducking", { duckDb: 0 })}>Remove ducking</Button><Button onClick={() => effect("Centre audio", { pan: 0 })}>Centre pan</Button><Button onClick={() => effect("Loop source", { loop: true, loopFade: Math.min(audioSamples(.02), Math.floor((clip!.sourceOut - clip!.sourceIn) / 2)) })}>Loop with smooth seam</Button></>
          : <><Button onClick={() => effect("Fade in", { fadeIn: Math.min(audioSamples(.5), clip!.sourceOut - clip!.sourceIn - clip!.fadeOut) })}>Fade in · 0.5 s</Button><Button onClick={() => effect("Fade out", { fadeOut: Math.min(audioSamples(.5), clip!.sourceOut - clip!.sourceIn - clip!.fadeIn) })}>Fade out · 0.5 s</Button><Button onClick={() => effect("Remove fades", { fadeIn: 0, fadeOut: 0 })}>Remove fades</Button></>}
      </fieldset><p>Adjust exact values in the Inspector. Changes can be undone.</p></div>}
  </div>;
}
