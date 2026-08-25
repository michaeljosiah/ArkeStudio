import { useEffect, useMemo, useState } from "react";
import { supportsVoiceUse, voiceTargetKey } from "@arke-studio/contracts";
import { requestVoiceCatalogue, useStore, type ReadingVoice } from "../lib/store.js";
import { cx } from "./ui.js";
import { User, Waveform, X } from "./icons.js";

/**
 * Choosing a voice to read with (design 70).
 *
 * Deliberately not the character-voice picker. That one ranks the catalogue against a sheet's
 * written voice and ends in an assignment; this one ranks nothing and assigns nothing. A row
 * whose voice a character already uses says so — as data on the row, not as a warning — and
 * picking it still only reads, which is why the action is worded the way it is.
 */
export function VoicePickerDialog({
  open,
  worldId,
  chosenId,
  chosenProvider,
  chosenModel,
  use = "bench",
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
  onClose: () => void;
  onPick: (voice: ReadingVoice) => void;
}) {
  const catalogue = useStore().voiceCatalogue;
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

  const rows = useMemo(
    () =>
      (catalogue ?? [])
        .filter((v: ReadingVoice) => supportsVoiceUse(v, use))
        .filter((v: ReadingVoice) => (where === "all" ? true : where === "local" ? v.local : !v.local)),
    [catalogue, where, use],
  );
  const visibleCatalogue = useMemo(
    () => (catalogue ?? []).filter((v: ReadingVoice) => supportsVoiceUse(v, use)),
    [catalogue, use],
  );
  const counts = useMemo(
    () => ({
      all: visibleCatalogue.length,
      cloud: visibleCatalogue.filter((v: ReadingVoice) => !v.local).length,
      local: visibleCatalogue.filter((v: ReadingVoice) => v.local).length,
    }),
    [visibleCatalogue],
  );
  const chosen = rows.find((v: ReadingVoice) => voiceTargetKey(v) === pick);

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
          {rows.map((voice) => (
            <button
              key={voiceTargetKey(voice)}
              type="button"
              disabled={voice.unavailableReason !== undefined}
              title={voice.unavailableReason}
              className={cx(
                "fy-voices__row",
                pick === voiceTargetKey(voice) && "fy-voices__row--on",
              )}
              onClick={() => setPick(voiceTargetKey(voice))}
            >
              <Waveform size={12} />
              <span className="fy-voices__name">{voice.label}</span>
              <span className="fy-voices__attrs">{voice.attributes.join(" · ")}</span>
              {/* Whom the world already gives this voice to. Data, not a warning: picking it
                  here reads with it and changes nothing about them. */}
              {voice.usedBy.length > 0 && (
                <span className="fy-voices__usedby">
                  <User size={9} />
                  {voice.usedBy.join(", ")}
                </span>
              )}
              <span className="fy-voices__where">
                {voice.unavailableReason ?? (voice.local ? "on this machine" : voice.provider)}
              </span>
            </button>
          ))}
        </div>
        <div className="fy-voices__foot">
          <span className="fy-voices__picked">{chosen?.label ?? ""}</span>
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
            Read with this voice
          </button>
        </div>
      </div>
    </>
  );
}
