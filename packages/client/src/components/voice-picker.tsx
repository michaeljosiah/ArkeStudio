import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cloudSpeechPreference, readerName, filterVoices, formatMicroUsd, supportsVoiceUse, voiceTargetKey, voiceFacet, VOICE_FACETS,
  UNSPECIFIED_VOICE_FACET, type VoiceFilters } from "@arke-studio/contracts";
import { requestVoiceCatalogue, requestCataloguePreview, stopCataloguePreview, useStore, type ReadingVoice } from "../lib/store.js";
import { dismissPlayback, playbackSnapshot, playClip, usePlayback } from "../lib/audio.js";
import { voicePreviewMediaUrl } from "../lib/media.js";
import { cx } from "./ui.js";
import { X } from "./icons.js";

/**
 * Where a row's voice is read: this machine, a Gemini row's reader, or the provider. A library
 * voice is listed once per hosted reader that can speak it (SPEC-046 R-37), so its rows share a
 * name and differ only here — they say the reader, `Voxtral` or `Breeze`, rather than a vendor id.
 */
function whereLabel(voice: ReadingVoice, use: "bench" | "narration"): string {
  if (voice.local) return "On this machine";
  if (voice.readsClone !== undefined) return readerName(voice);
  if (voice.provider === "google") return `${readerName(voice)}${cloudSpeechPreference(voice, use === "narration" ? "routine" : "creative") === 0 ? " · Recommended" : ""}`;
  return voice.provider;
}

/** Design 176: browsing and hearing are independent of the pending narrator choice. */
export function VoicePickerDialog({ open, worldId, chosenId, chosenProvider, chosenModel, use = "bench", onClose, onPick }: {
  open: boolean; worldId?: string; chosenId: string | undefined; chosenProvider?: string; chosenModel?: string;
  use?: "bench" | "narration"; onClose: () => void; onPick: (voice: ReadingVoice) => void;
}) {
  const { voiceCatalogue: catalogue, voiceCatalogueErrors: errors, cataloguePreview: result, state } = useStore();
  const [where, setWhere] = useState<"all" | "cloud" | "local">("all");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<VoiceFilters>({});
  const currentVoice = (catalogue ?? []).find(v => v.voiceId === chosenId &&
    (!chosenProvider || v.provider === chosenProvider) && (!chosenModel || v.model === chosenModel));
  const chosenKey = currentVoice ? voiceTargetKey(currentVoice) : undefined;
  const [pick, setPick] = useState<string | undefined>(chosenKey);
  const selectionInitialized = useRef(false);
  const [active, setActive] = useState<{ requestId: string; voice: ReadingVoice } | null>(null);
  const activeRef = useRef(active);
  const [heard, setHeard] = useState<Set<string>>(() => new Set());
  const dialog = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const playback = usePlayback();
  const stop = useCallback(() => {
    const pending = activeRef.current;
    if (pending) {
      stopCataloguePreview(pending.requestId);
      if (playbackSnapshot().clip?.id === pending.requestId) dismissPlayback();
    }
    activeRef.current = null;
    setActive(null);
  }, []);
  useEffect(() => {
    if (!open) return;
    requestVoiceCatalogue(worldId);
    setQuery(""); setFilters({}); setWhere("all");
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => { selectionInitialized.current = false; stop(); previous?.focus?.(); };
  }, [open, worldId, stop]);
  useEffect(() => {
    if (open && catalogue !== null && !selectionInitialized.current) {
      setPick(chosenKey); selectionInitialized.current = true;
    }
  }, [open, chosenKey, catalogue]);
  useEffect(() => {
    if (!open || !active || result?.requestId !== active.requestId || result.status !== "ready" || !result.file) return;
    setHeard(previous => new Set(previous).add(voiceTargetKey(active.voice)));
    void playClip({ id: active.requestId, url: voicePreviewMediaUrl(result.file), title: active.voice.label,
      sub: active.voice.preview?.kind === "sample" ? "Provider sample" : "Voice preview" });
  }, [open, active, result]);
  const disabledModels = state?.app.models.disabled;
  const available = useMemo(() => (catalogue ?? []).filter(v => supportsVoiceUse(v, use) && !disabledModels?.includes(v.model)), [catalogue, use, disabledModels]);
  const scoped = useMemo(() => available.filter(v => where === "all" || (where === "local" ? v.local : !v.local)), [available, where]);
  const rows = useMemo(() => filterVoices(scoped, query, filters), [scoped, query, filters]);
  const selected = available.find(v => voiceTargetKey(v) === pick);
  const outside = selected && !rows.some(v => voiceTargetKey(v) === pick);
  const previewResult = active && result?.requestId === active.requestId ? result : null;
  const sounding = active && playback.clip?.id === active.requestId ? playback : null;
  const previewError = previewResult?.status === "failed" ? previewResult.error : sounding?.status === "error" || sounding?.status === "blocked" ? sounding.error ?? "Playback could not start. Try again." : null;
  const listen = (voice: ReadingVoice) => {
    stop();
    const next = { requestId: requestCataloguePreview(voice), voice };
    activeRef.current = next;
    setActive(next);
  };
  const change = (action: () => void) => { stop(); action(); };
  if (!open) return null;
  return <>
    <div className="fy-bench__scrim" onClick={onClose} />
    <div ref={dialog} className="fy-voices fy-voice-browser" role="dialog" aria-modal="true" aria-label={use === "narration" ? "Choose narrator voice" : "Choose a voice"} data-testid="voice-picker"
      onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, [tabindex="0"]') ?? [])];
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }}>
      <div className="fy-voices__head"><div><strong className="fy-voices__title">{use === "narration" ? "Choose narrator voice" : "Choose a voice"}</strong>
        {use === "narration" && <p>The voice used to read your writing aloud.</p>}</div>
        <button type="button" className="fy-bench__footicon" aria-label="Close" onClick={onClose}><X size={16} /></button></div>
      <div className="fy-voices__tabs">{(["all", "cloud", "local"] as const).map(tab => <button key={tab} type="button" aria-pressed={where === tab}
        className={cx("fy-voices__tab", where === tab && "fy-voices__tab--on")} onClick={() => change(() => setWhere(tab))}>
        {tab === "all" ? "All" : tab === "cloud" ? "Cloud" : "On this machine"} {catalogue === null ? "" : available.filter(v => tab === "all" || (tab === "local" ? v.local : !v.local)).length}
      </button>)}</div>
      <div className="fy-voice-browser__tools">
        <input ref={search} type="search" aria-label="Search voices by name or description" placeholder="Search voices by name or description" value={query} onChange={e => change(() => setQuery(e.target.value))} />
        <div className="fy-voice-browser__filters">{VOICE_FACETS.map(facet => {
          const other = { ...filters }; delete other[facet];
          const narrowed = filterVoices(scoped, query, other);
          const counts = new Map<string, number>();
          for (const voice of narrowed) {
            const value = voiceFacet(voice, facet);
            counts.set(value, (counts.get(value) ?? 0) + 1);
          }
          // Keep an active filter removable even if a search or source change leaves no matches.
          const selected = filters[facet];
          if (selected && !counts.has(selected)) counts.set(selected, 0);
          const values = [...counts.keys()].sort();
          if (values.every(v => v === UNSPECIFIED_VOICE_FACET) && !selected) return null;
          const title = facet[0]!.toUpperCase() + facet.slice(1);
          return <label key={facet}>{title}<select aria-label={title} value={filters[facet] ?? ""} onChange={e => change(() => setFilters({ ...filters, [facet]: e.target.value }))}>
            <option value="">Any {facet.toLowerCase()}</option>{values.map(value => <option key={value} value={value}>
              {value === UNSPECIFIED_VOICE_FACET ? "Not specified" : value} ({counts.get(value)})
            </option>)}</select></label>;
        })}</div>
        <div className="fy-voice-browser__summary"><span role="status" aria-live="polite">{catalogue === null ? "Loading voices…" : `${rows.length} matches of ${scoped.length} voices${errors.length ? " · incomplete catalogue" : ""}`}</span><span>Name A–Z</span>
          <button type="button" onClick={() => change(() => setFilters({}))}>Clear filters</button></div>
      </div>
      {errors.length > 0 && <div className="fy-voice-browser__error" role="alert">{errors.join(" ")} <button type="button" onClick={() => { stop(); requestVoiceCatalogue(worldId); }}>Retry catalogue</button></div>}
      {chosenId && catalogue !== null && !currentVoice && <p className="fy-voices__none">The saved voice is unavailable. Choose another voice.</p>}
      <div className="fy-voices__rows">
        {catalogue !== null && rows.length === 0 && <div className="fy-voice-browser__empty"><strong>{scoped.length ? "No voices match these filters" : "No voices here"}</strong>
          <p>{scoped.length ? "Try another name or remove a filter." : "Add a provider key or enable local voice in Settings."}</p>
          {query && <button type="button" onClick={() => change(() => setQuery(""))}>Clear search</button>}</div>}
        {rows.map(voice => {
          const key = voiceTargetKey(voice);
          const isActive = active && voiceTargetKey(active.voice) === key;
          const busy = isActive && !previewError && sounding?.status !== "ended";
          const usable = voice.preview && voice.preview.kind !== "unavailable";
          const label = voice.preview?.kind === "sample" ? "Provider sample · no generation charge" : heard.has(key) ? "Cached preview" : voice.preview?.kind === "generate" ? `Generate preview · ${voice.local ? "Free · on this machine" : formatMicroUsd(voice.preview.microUsd ?? 0)}` : voice.preview?.reason ?? "No preview available";
          return <div key={key} className={cx("fy-voices__row", key === pick && "fy-voices__row--on")}>
            <button type="button" className="fy-voice-browser__play" disabled={!usable} aria-label={`${busy ? "Stop" : "Play"} ${voice.label} sample`} title={label} onClick={() => busy ? stop() : listen(voice)}>{busy ? "■" : "▶"}</button>
            <div className="fy-voice-browser__identity"><span className="fy-voices__name">{voice.label}</span>{key === chosenKey && <small>Current</small>}<p>{voice.description || voice.attributes.join(" · ") || "No description"}</p>
              <span className="fy-voice-browser__preview-label">{label}</span></div>
            <span className="fy-voice-browser__metadata">{[voice.facets?.language, voice.facets?.accent, voice.facets?.gender].filter(Boolean).join(" · ")}</span>
            <span className="fy-voices__where">{voice.unavailableReason ?? whereLabel(voice, use)}{voice.usedBy.length > 0 && <small>{voice.usedBy.join(", ")}</small>}</span>
            <button type="button" className="fy-voice-browser__select" aria-pressed={pick === key} aria-label={`Select ${voice.label}`} disabled={!!voice.unavailableReason} onClick={() => setPick(key)}>{pick === key ? "Selected" : "Select"}</button>
          </div>;
        })}
      </div>
      {active && <div className="fy-voice-browser__player" role="status"><strong>{active.voice.label}</strong>
        <span>{previewError ?? (sounding?.status === "playing" ? "Playing sample" : sounding?.status === "ended" ? "Sample finished" : "Loading sample…")}</span>
        {sounding && <span>{Math.floor(sounding.currentTime)}s / {Math.floor(sounding.duration)}s</span>}
        {previewError ? <button type="button" onClick={() => listen(active.voice)}>Retry preview</button> : <button type="button" onClick={stop}>Stop</button>}</div>}
      <div className="fy-voices__foot"><div><span className="fy-voices__picked">{selected?.label ?? "Choose a voice"}</span>{selected && <small> · {selected.readsClone !== undefined ? readerName(selected) : selected.provider}{outside ? " · Outside these results" : ""}</small>}</div><span style={{ flex: 1 }} />
        <button type="button" className="fy-bench__chip" onClick={onClose}>Cancel</button>
        <button type="button" className="fy-voices__use" data-testid="voice-use" disabled={!selected || !!selected.unavailableReason} onClick={() => { if (selected && !selected.unavailableReason) onPick(selected); }}>
          {use === "narration" ? selected ? `Use ${selected.label}` : "Use voice" : "Read with this voice"}</button></div>
    </div>
  </>;
}
