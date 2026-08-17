import { useEffect, useMemo, useState } from "react";
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
  onClose,
  onPick,
}: {
  open: boolean;
  worldId: string;
  chosenId: string | undefined;
  onClose: () => void;
  onPick: (voice: ReadingVoice) => void;
}) {
  const catalogue = useStore().voiceCatalogue;
  const [where, setWhere] = useState<"all" | "cloud" | "local">("all");
  const [pick, setPick] = useState<string | undefined>(chosenId);

  useEffect(() => {
    if (open) requestVoiceCatalogue(worldId);
  }, [open, worldId]);
  useEffect(() => {
    if (open) setPick(chosenId);
  }, [open, chosenId]);

  const rows = useMemo(
    () =>
      (catalogue ?? []).filter((v: ReadingVoice) => (where === "all" ? true : where === "local" ? v.local : !v.local)),
    [catalogue, where],
  );
  const counts = useMemo(
    () => ({
      all: catalogue?.length ?? 0,
      cloud: (catalogue ?? []).filter((v: ReadingVoice) => !v.local).length,
      local: (catalogue ?? []).filter((v: ReadingVoice) => v.local).length,
    }),
    [catalogue],
  );
  const chosen = rows.find((v: ReadingVoice) => v.voiceId === pick);

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
              key={`${voice.provider}:${voice.voiceId}`}
              type="button"
              className={cx("fy-voices__row", pick === voice.voiceId && "fy-voices__row--on")}
              onClick={() => setPick(voice.voiceId)}
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
              <span className="fy-voices__where">{voice.local ? "on this machine" : voice.provider}</span>
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
            disabled={chosen === undefined}
            onClick={() => {
              if (chosen) onPick(chosen);
            }}
          >
            Read with this voice
          </button>
        </div>
      </div>
    </>
  );
}
