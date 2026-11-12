import { useEffect, useState } from "react";
import { type ClientMessage, type ProductionBundle, type SceneBeat, type SceneRecord, type WorldBundle } from "@arke-studio/contracts";
import { Button } from "../../components/ui.js";
import { BeatLines } from "./beats.js";
import type { LineVoice } from "./table-read.js";

type Command = Extract<ClientMessage, { kind: "scene-command" }>["command"];
type Draft = { blockId?: string; text: string; speaker: string; version: number };

/** A draft stays here until the scene writer acknowledges it; refusals never erase the line. */
export function BeatLineEditor({ world, production, scene, shotId, beats, voices, locked, refusalVersion, onCommand }: {
  world: WorldBundle; production: ProductionBundle; scene: SceneRecord; shotId: string;
  beats: readonly SceneBeat[]; voices: ReadonlyMap<string, LineVoice>; locked: boolean;
  refusalVersion: number; onCommand: (command: Command) => boolean;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const lines = beats.filter(beat => beat.kind !== "picture");
  const begin = (beat?: SceneBeat) => {
    setNotice("");
    setDraft({ ...(beat?.blockId ? { blockId: beat.blockId } : {}), text: beat?.text ?? "", speaker: beat?.speaker ?? "", version: scene.version });
  };
  useEffect(() => {
    if (!pending || !draft || scene.version === draft.version) return;
    const saved = beats.some(beat => (!draft.blockId || beat.blockId === draft.blockId) && beat.text === draft.text.trim() && (beat.speaker ?? "") === draft.speaker);
    setPending(false);
    if (saved) { setDraft(null); setNotice("Line saved"); }
    else setNotice("The scene changed. Your line has not been saved.");
  }, [scene.version, beats]);
  useEffect(() => {
    if (pending) { setPending(false); setNotice("The line was not saved. Your draft is still here."); }
  }, [refusalVersion]);
  const stale = draft !== null && draft.version !== scene.version;
  return <div className="fy-beat-editor">
    {lines.length ? lines.map((beat, index) => <div key={beat.blockId ?? beat.lineId}>
      <BeatLines beats={[beat]} sheets={world.sheets} voices={voices} story={{ worldId: world.meta.worldId, production, scene }} />
      {!draft && <Button size="sm" variant="ghost" disabled={locked} onClick={() => begin(beat)}>Edit{lines.length > 1 ? ` line ${index + 1}` : " line"}</Button>}
    </div>) : !draft && <p className="fy-swbeat__none">No line · the picture alone</p>}
    {!draft && lines.every(beat => beat.blockId) && <Button size="sm" variant="ghost" disabled={locked} onClick={() => begin()}>Add line</Button>}
    {draft && <form onSubmit={event => {
      event.preventDefault();
      if (locked || pending || stale || !draft.text.trim()) return;
      if (onCommand({ kind: "set-beat-line", shotId, ...(draft.blockId ? { blockId: draft.blockId } : {}),
        text: draft.text.trim(), ...(draft.speaker ? { speaker: draft.speaker } : {}) })) setPending(true);
      else setNotice("The line could not be sent. Your draft is still here.");
    }}>
      <label>Who speaks<select aria-label="Who speaks" value={draft.speaker} disabled={pending} onChange={event => setDraft({ ...draft, speaker: event.target.value })}>
        <option value="">Narrator</option>
        {world.sheets.filter(sheet => sheet.type === "character" && (!sheet.retired || sheet.id === draft.speaker)).map(sheet => <option key={sheet.id} value={sheet.id}>{sheet.name}</option>)}
      </select></label>
      <label>Line<textarea aria-label="Line" value={draft.text} maxLength={16_000} disabled={pending} onChange={event => setDraft({ ...draft, text: event.target.value })} /></label>
      {stale && <p role="status">The scene changed. Reload the line before saving.</p>}
      <div className="fy-beat-editor__actions">
        <Button type="button" variant="ghost" disabled={pending} onClick={() => { setDraft(null); setNotice(""); }}>Cancel</Button>
        {stale ? <Button type="button" disabled={pending} onClick={() => begin(beats.find(beat => draft.blockId ? beat.blockId === draft.blockId : beat.kind !== "picture"))}>Reload line</Button>
          : <Button type="submit" variant="primary" disabled={locked || pending || !draft.text.trim()}>{pending ? "Saving…" : "Save line"}</Button>}
      </div>
    </form>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
