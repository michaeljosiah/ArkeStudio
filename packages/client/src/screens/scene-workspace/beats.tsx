import { formatMicroUsd, type SceneBeat, type Sheet, type TableReadPlan } from "@arke-studio/contracts";
import type { LineVoice } from "./table-read.js";

/**
 * A visual novel's scene page reads its shots as beats (turn 172): the line each one carries,
 * whose it is, whether it is voiced, and how it moves on. Nothing here is a store of its own —
 * the line is the covered script block, the voice is the table read's, the rest is `shot.beat`.
 */

const VOICE_WORD: Record<LineVoice, string> = { voiced: "voiced", voicing: "voicing", unvoiced: "not voiced" };

/** Who a beat's line belongs to, as the page and the player say it. */
export function beatSpeakerName(beat: Pick<SceneBeat, "kind" | "speaker">, sheets: readonly Pick<Sheet, "id" | "name">[]): string | null {
  if (beat.kind === "narration") return "Narrator";
  if (beat.kind === "dialogue" && beat.speaker) return sheets.find((sheet) => sheet.id === beat.speaker)?.name ?? beat.speaker;
  return null;
}

/** The lines a row carries, each under its speaker, with whether it is voiced. */
export function BeatLines({
  beats,
  sheets,
  voices,
}: {
  beats: readonly SceneBeat[];
  sheets: readonly Pick<Sheet, "id" | "name">[];
  voices: ReadonlyMap<string, LineVoice>;
}) {
  const spoken = beats.filter((beat) => beat.kind !== "picture");
  if (spoken.length === 0) return <p className="fy-swbeat__none">No line · the picture alone</p>;
  return (
    <ul className="fy-swbeat" data-testid="beat-lines">
      {spoken.map((beat) => {
        const voice = beat.lineId === undefined ? "unvoiced" : voices.get(beat.lineId) ?? "unvoiced";
        return (
          <li key={beat.lineId ?? beat.shot.id} className="fy-swbeat__line" data-kind={beat.kind}>
            <span className="fy-swbeat__who">{beatSpeakerName(beat, sheets)}</span>
            <span className="fy-swbeat__text">{beat.text}</span>
            <span className="fy-swbeat__voice" data-voice={voice}>
              <i aria-hidden="true" />
              {VOICE_WORD[voice]}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * "Voice lines" (172b): prepare every line the plan has no read for, at the price it quoted. A
 * visual novel plays an unvoiced line as text, so this is an offer, never a block — and when
 * every line has a read it says so rather than offering nothing.
 */
export function VoiceLinesControl({
  plan,
  preparing,
  notice,
  onPrepare,
}: {
  plan: TableReadPlan | null;
  preparing: boolean;
  notice: string;
  onPrepare: () => void;
}) {
  if (plan === null || plan.items.length === 0) return null;
  const missing = plan.items.filter((item) => item.route === "local" || item.route === "cloud");
  const voicing = plan.items.filter((item) => item.route === "generating").length;
  const voiced = plan.items.filter((item) => item.file !== undefined).length;
  return (
    <span className="fy-swvoice">
      <span className="fy-swvoice__count">{voiced} of {plan.items.length} voiced{voicing > 0 ? ` · ${voicing} voicing` : ""}</span>
      {missing.length > 0 ? (
        <button type="button" className="fy-swvoice__go" disabled={preparing} onClick={onPrepare}>
          {preparing ? "Voicing…" : `Voice ${missing.length} line${missing.length === 1 ? "" : "s"}`}
          {plan.totalEstimatedMicroUsd > 0 ? ` · ${formatMicroUsd(plan.totalEstimatedMicroUsd)}` : ""}
        </button>
      ) : null}
      {notice === "" ? null : <span role="status" className="fy-swvoice__notice">{notice}</span>}
    </span>
  );
}

/** How a beat moves on, as the row's chip says it. */
export function advanceWord(advance: "voice" | "tap" | "hold", holdSec: number): string {
  return advance === "voice" ? "after the voice" : advance === "tap" ? "on tap" : `hold ${holdSec}s`;
}
