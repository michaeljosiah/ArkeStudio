import { useEffect, useMemo, useState } from "react";
import {
  CLONED_VOICE_MODEL,
  CLONED_VOICE_PROVIDER,
  readerName,
  readerPriceLabel,
  supportsVoiceUse,
  voiceTargetKey,
  type ManifestModel,
} from "@arke-studio/contracts";
import { requestVoiceCatalogue, useStore, type ReadingVoice } from "../lib/store.js";
import { cx } from "./ui.js";
import { Cloud, Monitor, User, Waveform, X } from "./icons.js";

/**
 * One row a voice (SPEC-046 R-30): a cloned voice is drawn once, with a chip per reader that
 * can speak it here, as the Voice page draws it — three rows named Harbour glass that differ
 * only in a vendor's name at the far end read as three voices. A voice that is its own reader
 * is a row of one.
 */
interface PickerRow {
  key: string;
  label: string;
  attributes: string[];
  usedBy: string[];
  /** The library voice this row is, when it is one. */
  clone: string | null;
  readers: ReadingVoice[];
}

/** The library voice a candidate reads, whether it says so or is the recipe's row for it. */
function cloneOf(voice: ReadingVoice): string | null {
  if (voice.readsClone !== undefined) return voice.readsClone;
  return voice.provider === CLONED_VOICE_PROVIDER && voice.model === CLONED_VOICE_MODEL ? voice.voiceId : null;
}

function pickerRows(voices: readonly ReadingVoice[]): PickerRow[] {
  const rows: PickerRow[] = [];
  const byClone = new Map<string, PickerRow>();
  for (const voice of voices) {
    const clone = cloneOf(voice);
    if (clone === null) {
      rows.push({ key: voiceTargetKey(voice), label: voice.label, attributes: voice.attributes, usedBy: voice.usedBy, clone: null, readers: [voice] });
      continue;
    }
    const existing = byClone.get(clone);
    if (existing) {
      existing.readers.push(voice);
      for (const who of voice.usedBy) if (!existing.usedBy.includes(who)) existing.usedBy.push(who);
      continue;
    }
    const row: PickerRow = { key: `clone:${clone}`, label: voice.label, attributes: voice.attributes, usedBy: [...voice.usedBy], clone, readers: [voice] };
    byClone.set(clone, row);
    rows.push(row);
  }
  return rows;
}

/** A reader as its chip names it (R-30): `IndexTTS · free`, `Voxtral · $0.016 per 1k`. */
function readerLabel(voice: ReadingVoice, models: readonly ManifestModel[]): string {
  const row = models.find((m) => m.provider === voice.provider && m.id === voice.model && m.capability === "voice-tts") ?? null;
  return [readerName(voice, row), readerPriceLabel(row) ?? (voice.local ? "free" : null)].filter(Boolean).join(" · ");
}

/**
 * Choosing a voice to read with (design 70).
 *
 * Deliberately not the character-voice picker. That one ranks the catalogue against a sheet's
 * written voice and ends in an assignment; this one ranks nothing and assigns nothing. A row
 * whose voice a character already uses says so — as data on the row, not as a warning — and
 * picking it still only reads, which is why the action is worded the way it is.
 *
 * The verb is the caller's (issue 1216). On the bench the press reads, and the button says so;
 * on Settings the same dialog only sets the narrator — no request, no job, no charge — while the
 * row beside it states a per-character price, so `Read with this voice` under that price read as
 * a spend that was not one. The default keeps the bench's word.
 */
export function VoicePickerDialog({
  open,
  worldId,
  chosenId,
  chosenProvider,
  chosenModel,
  use = "bench",
  confirmLabel = "Read with this voice",
  onClose,
  onPick,
}: {
  open: boolean;
  /** Absent in Settings, where no world need be open — only `usedBy` depends on one. */
  worldId?: string;
  chosenId: string | undefined;
  chosenProvider?: string;
  chosenModel?: string;
  use?: "bench" | "narration";
  /** What the primary button says the press does — a read on the bench, a setting elsewhere. */
  confirmLabel?: string;
  onClose: () => void;
  onPick: (voice: ReadingVoice) => void;
}) {
  const { state, voiceCatalogue: catalogue } = useStore();
  const models = state?.app.manifest?.models ?? [];
  const [where, setWhere] = useState<"all" | "cloud" | "local">("all");
  const fallbackChosen = chosenId === undefined
    ? undefined
    : (catalogue ?? []).find(
        (voice) =>
          voice.voiceId === chosenId &&
          (chosenProvider === undefined || voice.provider === chosenProvider) &&
          (chosenModel === undefined || voice.model === chosenModel),
      );
  const chosenKey =
    chosenId === undefined
      ? undefined
      : chosenProvider !== undefined && chosenModel !== undefined
        ? voiceTargetKey({ provider: chosenProvider, model: chosenModel, voiceId: chosenId })
        : fallbackChosen
          ? voiceTargetKey(fallbackChosen)
          : undefined;
  const [pick, setPick] = useState<string | undefined>(chosenKey);

  useEffect(() => {
    if (open) requestVoiceCatalogue(worldId);
  }, [open, worldId]);
  useEffect(() => {
    if (open) setPick(chosenKey);
  }, [open, chosenKey]);

  const visibleCatalogue = useMemo(
    () => (catalogue ?? []).filter((v: ReadingVoice) => supportsVoiceUse(v, use)),
    [catalogue, use],
  );
  const rows = useMemo(
    () => pickerRows(visibleCatalogue.filter((v: ReadingVoice) => (where === "all" ? true : where === "local" ? v.local : !v.local))),
    [visibleCatalogue, where],
  );
  // The tabs count voices as the rows draw them: a cloned voice with three readers is one.
  const counts = useMemo(
    () => ({
      all: pickerRows(visibleCatalogue).length,
      cloud: pickerRows(visibleCatalogue.filter((v: ReadingVoice) => !v.local)).length,
      local: pickerRows(visibleCatalogue.filter((v: ReadingVoice) => v.local)).length,
    }),
    [visibleCatalogue],
  );
  const chosen = rows.flatMap((row) => row.readers).find((v: ReadingVoice) => voiceTargetKey(v) === pick);

  if (!open) return null;
  return (
    <>
      <div className="fy-bench__scrim" onClick={onClose} />
      <div className="fy-voices" role="dialog" aria-label="Choose a voice" data-testid="voice-picker">
        <div className="fy-voices__head">
          <strong className="fy-voices__title">Choose a voice</strong>
          <span style={{ flex: 1 }} />
          <button type="button" className="fy-bench__footicon" aria-label="Close" onClick={onClose}>
            <X size={12} />
          </button>
        </div>
        <div className="fy-voices__tabs">
          {(["all", "cloud", "local"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              className={cx("fy-voices__tab", where === tab && "fy-voices__tab--on")}
              onClick={() => setWhere(tab)}
            >
              {`${tab === "all" ? "All" : tab === "cloud" ? "Cloud" : "On this machine"} ${counts[tab]}`}
            </button>
          ))}
        </div>
        <div className="fy-voices__rows">
          {catalogue === null && <p className="fy-voices__none">Reading the catalogue…</p>}
          {catalogue !== null && rows.length === 0 && (
            <p className="fy-voices__none">No voices here — add a key in Providers, or install a local runtime.</p>
          )}
          {rows.map((row) => {
            const on = row.readers.some((reader) => voiceTargetKey(reader) === pick);
            const usedBy = row.usedBy.length > 0 && (
              // Whom the world already gives this voice to. Data, not a warning: picking it
              // here reads with it and changes nothing about them.
              <span className="fy-voices__usedby">
                <User size={9} />
                {row.usedBy.join(", ")}
              </span>
            );
            if (row.clone === null) {
              const voice = row.readers[0]!;
              return (
                <button
                  key={row.key}
                  type="button"
                  disabled={voice.unavailableReason !== undefined}
                  title={voice.unavailableReason}
                  className={cx("fy-voices__row", on && "fy-voices__row--on")}
                  onClick={() => setPick(voiceTargetKey(voice))}
                >
                  <Waveform size={12} />
                  <span className="fy-voices__name">{voice.label}</span>
                  <span className="fy-voices__attrs">{voice.attributes.join(" · ")}</span>
                  {usedBy}
                  <span className="fy-voices__where">
                    {voice.unavailableReason ?? (voice.local ? "on this machine" : voice.provider)}
                  </span>
                </button>
              );
            }
            // A cloned voice: the row is a div because its chips are the buttons, and pressing
            // the row picks the first reader that can speak now, as the chips pick one each.
            const first = row.readers.find((reader) => reader.unavailableReason === undefined);
            return (
              <div
                key={row.key}
                role="button"
                aria-pressed={on}
                data-testid="voice-clone-row"
                className={cx("fy-voices__row", "fy-voices__row--clone", on && "fy-voices__row--on", first === undefined && "fy-voices__row--off")}
                onClick={() => {
                  if (!on && first !== undefined) setPick(voiceTargetKey(first));
                }}
              >
                <Waveform size={12} />
                <span className="fy-voices__name">{row.label}</span>
                <span className="fy-voices__attrs">{row.attributes.join(" · ")}</span>
                {usedBy}
                <span className="fy-readerchips" role="group" aria-label="Reader">
                  {row.readers.map((reader) => {
                    const readerKey = voiceTargetKey(reader);
                    return (
                      <button
                        key={readerKey}
                        type="button"
                        className="fy-readerchip"
                        aria-pressed={readerKey === pick}
                        disabled={reader.unavailableReason !== undefined}
                        title={reader.unavailableReason}
                        data-testid={`voice-reader-${reader.provider}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setPick(readerKey);
                        }}
                      >
                        {reader.local ? <Monitor size={10} /> : <Cloud size={10} />}
                        {readerLabel(reader, models)}
                      </button>
                    );
                  })}
                </span>
              </div>
            );
          })}
        </div>
        <div className="fy-voices__foot">
          <span className="fy-voices__picked">{chosen === undefined ? "" : cloneOf(chosen) === null ? chosen.label : `${chosen.label} · ${readerName(chosen, models.find((m) => m.provider === chosen.provider && m.id === chosen.model) ?? null)}`}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="fy-bench__chip" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="fy-voices__use"
            data-testid="voice-use"
            disabled={chosen === undefined || chosen.unavailableReason !== undefined}
            onClick={() => {
              if (chosen !== undefined && chosen.unavailableReason === undefined) onPick(chosen);
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
