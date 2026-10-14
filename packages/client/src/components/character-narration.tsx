import { chapterNarrator } from "../lib/audiobook-narrator.js";
import { useRef, useState } from "react";
import { PERFORMANCE_NOTE_MAX, characterPerformanceDirection, legacyVoiceModel, sheetNarrations, speakerNoteFor } from "@arke-studio/contracts";
import { setAudiobookNote, setSheetNarration, useStore } from "../lib/store.js";

/** Character defaults and intentional book differences are separate edits. Never turn an
 * inherited value into a book override merely because the author edited it from a book. */
export function CharacterNarration({ worldId, productionId, speakerKey, name, disabled = false, showCharacter = true }: {
  worldId: string; productionId: string; speakerKey: string; name: string; disabled?: boolean; showCharacter?: boolean;
}) {
  const store = useStore();
  const overrideToggle = useRef<HTMLButtonElement>(null);
  const [characterDraft, setCharacterDraft] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState<string | null>(null);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const world = store.state?.world?.meta.worldId === worldId ? store.state.world : undefined;
  const book = world?.productions.find(p => p.meta.id === productionId);
  const sheet = world?.sheets.find(s => s.id === speakerKey && s.type === "character" && !s.retired);
  const inherited = sheet?.narration?.trim() || undefined;
  const override = book?.audiobook?.notes?.[speakerKey];
  const note = speakerNoteFor(book?.audiobook?.notes, { speaker: speakerKey, ...(sheet ? { sheet: sheet.id } : {}) }, sheetNarrations(world?.sheets ?? []));
  const narrator = chapterNarrator({ bookNarrator: book?.audiobook?.narrator, stored: store.state?.app.narrator ?? null, worldId, catalogue: store.voiceCatalogueHeld });
  const modelId = narrator.model ?? legacyVoiceModel(narrator.provider, narrator.voiceId, world?.clonedVoices ?? []);
  const model = store.state?.app.manifest?.models.find(m => m.provider === narrator.provider && m.id === modelId && m.capability === "voice-tts");
  const direction = model ? characterPerformanceDirection(note, model) : null;
  const active = Object.entries(store.audiobook).some(([key, run]) => key.startsWith(`${worldId}/`) && run.state === "reading") || Object.values(store.audiobookBook).some(run => run.state === "reading");
  const held = disabled || store.connection !== "open" || active || !book;
  const commitCharacter = () => {
    if (characterDraft === null || !sheet || held) return;
    const next = characterDraft.trim();
    setCharacterDraft(null);
    if (next === (inherited ?? "")) return;
    if (!setSheetNarration(worldId, `characters/${sheet.id}.md`, next || null)) setRefusal("The studio is disconnected — narration was not saved.");
  };
  const commitOverride = () => {
    if (overrideDraft === null || held) return;
    const next = overrideDraft.trim();
    setOverrideDraft(null);
    setOverrideOpen(false);
    if (next === (override ?? "")) return;
    if (!setAudiobookNote(worldId, productionId, speakerKey, next || null)) setRefusal("The studio is disconnected — the override was not saved.");
  };
  const performed = book?.audiobook?.reading === "performed";
  const source = override !== undefined ? "book override" : inherited !== undefined ? "character" : "narrator baseline";
  const effective = !performed ? "Not sent in this reading mode" : note === undefined || (model && direction === null) ? "No character cue — narrator's baseline" : !model ? "Reader unavailable — cannot preview" : direction?.mode === "unsupported" ? `Not sent — ${direction.reason}` : direction?.mode === "tag" ? direction.tag : direction?.audible;
  return <div className="fy-character-narration" data-testid="character-narration" data-source={override !== undefined ? "book" : inherited !== undefined ? "character" : "none"}>
    {sheet && showCharacter && <label>
      <span>Character narration</span>
      <textarea className="fy-ab__note-input" aria-label={`Narration · ${name}`} maxLength={PERFORMANCE_NOTE_MAX} rows={2} disabled={held}
        value={characterDraft ?? inherited ?? ""} onChange={e => setCharacterDraft(e.target.value)} onBlur={commitCharacter}
        onKeyDown={e => { if (e.key === "Escape") setCharacterDraft(null); }} />
      <small>Default across books · {(characterDraft ?? inherited ?? "").length} / {PERFORMANCE_NOTE_MAX}</small>
    </label>}
    <div className="fy-character-narration__book"><b>{book?.meta.title ?? "This book"}</b>
      {override !== undefined || overrideOpen || !sheet ? <label>
        <span>Book override{!sheet ? " · speaker has no character sheet" : ""}</span>
        <textarea className="fy-ab__note-input" aria-label={`Book override · ${name}`} maxLength={PERFORMANCE_NOTE_MAX} rows={2} disabled={held}
          value={overrideDraft ?? override ?? ""} onChange={e => setOverrideDraft(e.target.value)} onBlur={event => { if (!overrideToggle.current || event.relatedTarget !== overrideToggle.current) commitOverride(); }}
          onKeyDown={e => { if (e.key === "Escape") { setOverrideDraft(null); setOverrideOpen(false); } }} />
        {sheet && override !== undefined && <small>Overrides Character narration for this book.</small>}
      </label> : <span className="fy-mono">Uses Character narration</span>}
      {sheet && <button type="button" className="fy-ch__derive" disabled={held} data-testid="narration-override-toggle" ref={overrideToggle}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { setRefusal(null); setOverrideDraft(null); if (override !== undefined) { setOverrideOpen(false); if (!setAudiobookNote(worldId, productionId, speakerKey, null)) setRefusal("The studio is disconnected — the override was not removed."); } else setOverrideOpen(!overrideOpen); }}>
        {override !== undefined ? "Use character narration" : overrideOpen ? "Cancel override" : "Override for this book"}
      </button>}
    </div>
    <div className="fy-character-narration__effective" data-testid="narration-effective"><span>Effective character direction · {source}</span><code>{effective}</code><small>{narrator.label ?? narrator.voiceId} · {model?.displayName ?? modelId} · saved direction</small></div>
    {refusal && <p role="alert">{refusal}</p>}
  </div>;
}
