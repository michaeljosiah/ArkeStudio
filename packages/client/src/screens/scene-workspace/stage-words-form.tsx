import type { ReactNode } from "react";
import { STAGE_FRAME_ANGLE_LABELS, STAGE_FRAME_SIDE_LABELS, STAGE_FRAME_SIZE_LABELS, type StageFrameWords } from "@arke-studio/contracts";
import { Link, Row, Stepper, Value } from "./stage-inspector.js";

/**
 * The camera in words (issue 1820, design turn 228a): subject, size, angle, side and lens, then one
 * mono line with where they put the camera, and Edit as numbers for the form underneath. Choosing
 * any word writes all of them, solved through the real lens; a hand edit to the numbers drops them.
 */
export function CameraWords({ words, cast, defaultSubject, shotLensMm, at, numbers, disabled, onWords, onNumbers, move }: {
  words: StageFrameWords | undefined;
  cast: ReadonlyArray<{ sheetId: string; name: string }>;
  defaultSubject: string | undefined;
  shotLensMm: string | undefined;
  /** Where the words put the camera, already formatted. */
  at: string;
  numbers: boolean;
  disabled: boolean;
  onWords: (next: StageFrameWords) => void;
  onNumbers: () => void;
  /** The move row, drawn under the lens as 228a orders the form. */
  move?: ReactNode;
}) {
  const subject = words?.subject ?? defaultSubject ?? cast[0]?.sheetId;
  const base: StageFrameWords | null = subject === undefined ? null : words ?? { subject, size: "medium", angle: "eye", side: "front" };
  const choose = (change: Partial<StageFrameWords>) => {
    if (base === null) return;
    const next = { ...base, ...change };
    if (next.side !== "over") delete next.over;
    else if (next.over === undefined || next.over === next.subject) {
      const other = cast.find((figure) => figure.sheetId !== next.subject);
      if (other === undefined) return;
      next.over = other.sheetId;
    }
    onWords(next);
  };
  return (
    <div data-testid="stage-camera-words">
      <Row label="subject">
        <select className="fy-swstage__select" aria-label="Camera subject" value={words?.subject ?? ""} disabled={disabled || cast.length === 0}
          onChange={(event) => { if (event.target.value) choose({ subject: event.target.value }); }}>
          {words === undefined ? <option value="">—</option> : null}
          {cast.map((figure) => <option key={figure.sheetId} value={figure.sheetId}>{figure.name}</option>)}
        </select>
      </Row>
      <Row label="size">
        <span className="fy-swstage__chips" role="radiogroup" aria-label="Shot size">
          {STAGE_FRAME_SIZE_LABELS.map(([size, label]) => (
            <button key={size} type="button" role="radio" aria-checked={words?.size === size} data-on={words?.size === size ? "true" : undefined} disabled={disabled || base === null}
              onClick={() => choose({ size })}>{label}</button>
          ))}
        </span>
      </Row>
      <Row label="angle">
        <span className="fy-swstage__chips" role="radiogroup" aria-label="Camera angle">
          {STAGE_FRAME_ANGLE_LABELS.map(([angle, label]) => (
            <button key={angle} type="button" role="radio" aria-checked={words?.angle === angle} data-on={words?.angle === angle ? "true" : undefined} disabled={disabled || base === null}
              onClick={() => choose({ angle })}>{label}</button>
          ))}
        </span>
      </Row>
      <Row label="side">
        <select className="fy-swstage__select" aria-label="Camera side" value={words?.side ?? ""} disabled={disabled || base === null}
          onChange={(event) => { if (event.target.value) choose({ side: event.target.value as StageFrameWords["side"] }); }}>
          {words === undefined ? <option value="">—</option> : null}
          {STAGE_FRAME_SIDE_LABELS.filter(([side]) => side !== "over" || cast.length > 1).map(([side, label]) => <option key={side} value={side}>{label}</option>)}
        </select>
      </Row>
      {words?.side === "over" ? (
        <Row label="over">
          <select className="fy-swstage__select" aria-label="Over whose shoulder" value={words.over ?? ""} disabled={disabled}
            onChange={(event) => choose({ over: event.target.value })}>
            {cast.filter((figure) => figure.sheetId !== words.subject).map((figure) => <option key={figure.sheetId} value={figure.sheetId}>{figure.name}</option>)}
          </select>
        </Row>
      ) : null}
      <Row label="lens">
        <Stepper label="lens" value={words?.focalMm} unit="mm" step={1} min={8} max={400} decimals={0} placeholder={shotLensMm} disabled={disabled || base === null} clearable
          onCommit={(focalMm) => { if (base === null) return; const { focalMm: _focal, ...rest } = base; onWords(focalMm === undefined ? rest : { ...rest, focalMm }); }} />
      </Row>
      {move}
      <Row label="at"><Value muted><span className="fy-swstage__quietmono">{at}</span></Value></Row>
      <Row label=""><Link disabled={disabled} onClick={onNumbers}>{numbers ? "Hide numbers" : "Edit as numbers"}</Link></Row>
    </div>
  );
}
