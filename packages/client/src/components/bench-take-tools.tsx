import { useEffect, useRef, useState, type ReactNode } from "react";
import { benchDeleteRefusal, type BenchTake } from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { ImageDownload } from "./image-actions.js";
import { Lines, RefreshCw, Trash, X } from "./icons.js";
import { Button, cx } from "./ui.js";
import {
  sendBenchDelete,
  sendBenchDiscard,
  sendBenchTakeFiles,
  subscribeBenchTakeDeleted,
  subscribeBenchTakeFiles,
} from "../lib/store.js";

/**
 * A generated take's tools (design turn 180; SPEC-021 R-36, R-37): Run it again · Upscale · Download, then What was
 * sent, then Not this · Delete — each a glyph whose hint names it and nothing beneath it. A tool
 * that does not apply is absent rather than disabled, so the row only ever offers what it can do.
 *
 * Delete is the one tool that cannot be taken back, so it asks once, naming every file it removes
 * with its size, and the coordinator — not this row — decides: the confirm's list and the refusal
 * both come from it, because the folder holds files the take does not record (a video's poster)
 * and a filed take's refusal is a rule, not a screen state.
 */

/** Which tools a take carries, in order — pure so the rule can be asserted without a screen. */
export function benchTakeTools(take: BenchTake, extra: { upscale?: boolean; rerun?: boolean; sent?: boolean } = {}): string[] {
  const tools: string[] = [];
  if (extra.rerun !== false) tools.push("rerun");
  if (extra.upscale === true) tools.push("upscale");
  if (take.media !== undefined) tools.push("download");
  if (extra.sent !== false) tools.push("sent");
  if (take.disposition === "open" && take.media !== undefined) tools.push("not-this");
  if (benchDeleteRefusal(take)?.absent !== true) tools.push("delete");
  return tools;
}

/** "2.3 MB", or kilobytes where a megabyte figure would read as nothing at all. */
export function fileSizeCopy(bytes: number): string {
  if (bytes < 100_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** The one confirm (design 180b): the take, each file and its size, Cancel and Delete. */
export function BenchDeleteConfirm({
  takeNumber,
  files,
  busy = false,
  reason,
  onCancel,
  onDelete,
}: {
  takeNumber: number;
  files: ReadonlyArray<{ name: string; bytes: number }>;
  busy?: boolean;
  reason?: string | null;
  onCancel: () => void;
  onDelete: () => void;
}) {
  return (
    <EditorDialog open title={`Delete Take ${takeNumber}?`} onClose={onCancel} width={360} panelClassName="fy-bench__delete">
      <ul className="fy-bench__deletefiles" data-testid="bench-delete-files">
        {files.length === 0 ? <li>No files</li> : files.map((file) => <li key={file.name}>{`${file.name} · ${fileSizeCopy(file.bytes)}`}</li>)}
      </ul>
      {reason ? (
        <p role="alert" className="fy-bench__refusal">
          {reason}
        </p>
      ) : null}
      <div className="fy-bench__deletefoot">
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="destructive" disabled={busy} onClick={onDelete} data-testid="bench-delete-confirm">
          Delete
        </Button>
      </div>
    </EditorDialog>
  );
}

type DeleteFlow =
  | { step: "idle" }
  | { step: "asking"; requestId: string }
  | { step: "confirm"; files: Array<{ name: string; bytes: number }>; reason: string | null }
  | { step: "deleting"; requestId: string; files: Array<{ name: string; bytes: number }> };

export function BenchTakeTools({
  worldId,
  worldSlug,
  sessionId,
  take,
  rerunNeedsPrice,
  onRerun,
  onSent,
  sentExpanded,
  discardHeld,
  upscale,
}: {
  worldId: string;
  worldSlug: string | undefined;
  sessionId: string;
  take: BenchTake;
  rerunNeedsPrice: boolean;
  /** Null where the take cannot be made again — an upscale whose source is gone. */
  onRerun: (() => void) | null;
  /** Null where there is no request to restore — an upscale was sent a take, not a brief. */
  onSent: (() => void) | null;
  /** Present only where What was sent opens a box rather than restoring the composer. */
  sentExpanded?: boolean | undefined;
  /** Not this waits while an Accept for the same take is out. */
  discardHeld: boolean;
  /** The Upscale tool, where it applies (design turn 178); absent otherwise. */
  upscale?: ReactNode;
}) {
  const [flow, setFlow] = useState<DeleteFlow>({ step: "idle" });
  const [refusal, setRefusal] = useState<string | null>(null);
  const flowRef = useRef(flow);
  flowRef.current = flow;
  // A different take selected is a different question: whatever was open for the last one closes.
  useEffect(() => {
    setFlow({ step: "idle" });
    setRefusal(null);
  }, [take.id]);
  useEffect(
    () =>
      subscribeBenchTakeFiles((answer) => {
        const current = flowRef.current;
        if (current.step !== "asking" || answer.requestId !== current.requestId) return;
        if (answer.reason !== undefined) {
          setFlow({ step: "idle" });
          setRefusal(answer.reason);
          return;
        }
        setFlow({ step: "confirm", files: answer.files, reason: null });
      }),
    [],
  );
  useEffect(
    () =>
      subscribeBenchTakeDeleted((answer) => {
        const current = flowRef.current;
        if (current.step !== "deleting" || answer.requestId !== current.requestId) return;
        if (answer.deleted) setFlow({ step: "idle" });
        else setFlow({ step: "confirm", files: current.files, reason: answer.reason ?? "That take could not be deleted" });
      }),
    [],
  );

  const tools = benchTakeTools(take, { upscale: upscale !== undefined && upscale !== null, rerun: onRerun !== null, sent: onSent !== null });
  const press = () => {
    setRefusal(null);
    const why = benchDeleteRefusal(take);
    if (why !== null) {
      setRefusal(why.reason);
      return;
    }
    const requestId = sendBenchTakeFiles(worldId, sessionId, take.id);
    if (requestId !== null) setFlow({ step: "asking", requestId });
  };
  const mark = (label: string, onClick: () => void, glyph: ReactNode, extra: { end?: boolean; disabled?: boolean; expanded?: boolean } = {}) => (
    <button
      type="button"
      className={cx("fy-bench__rowicon", "fy-tip", extra.end === true && "fy-tip--end")}
      data-tip={label}
      aria-label={label}
      disabled={extra.disabled}
      {...(extra.expanded !== undefined ? { "aria-expanded": extra.expanded } : {})}
      onClick={onClick}
    >
      {glyph}
    </button>
  );
  const files = flow.step === "confirm" || flow.step === "deleting" ? flow.files : null;
  return (
    <>
      <span className="fy-bench__tools" role="toolbar" aria-label="Take tools">
        {tools.includes("rerun") && onRerun !== null &&
          mark(rerunNeedsPrice ? "Review price to run again" : "Run it again", onRerun, <RefreshCw size={14} />)}
        {tools.includes("upscale") && upscale}
        {tools.includes("download") && take.media !== undefined && (
          <ImageDownload
            worldSlug={worldSlug}
            path={`.sessions/${sessionId}/media/${take.id}/${take.media.file}`}
            name={`Take ${take.n}`}
            className="fy-bench__rowicon fy-bench__rowicon--bar"
          />
        )}
        <span className="fy-bench__toolsep" aria-hidden="true" />
        {tools.includes("sent") && onSent !== null && (
          <>
            {mark("What was sent", onSent, <Lines size={14} />, sentExpanded !== undefined ? { expanded: sentExpanded } : {})}
            <span className="fy-bench__toolsep" aria-hidden="true" />
          </>
        )}
        {tools.includes("not-this") &&
          mark("Not this", () => sendBenchDiscard(worldId, sessionId, take.id), <X size={14} />, { disabled: discardHeld })}
        {tools.includes("delete") &&
          mark("Delete", press, <Trash size={14} />, { end: true, disabled: flow.step === "asking" || flow.step === "deleting" })}
      </span>
      {refusal !== null && (
        <span role="alert" className="fy-bench__toolrefusal" data-testid="bench-delete-refusal">
          {refusal}
        </span>
      )}
      {files !== null && (
        <BenchDeleteConfirm
          takeNumber={take.n}
          files={files}
          busy={flow.step === "deleting"}
          reason={flow.step === "confirm" ? flow.reason : null}
          onCancel={() => setFlow({ step: "idle" })}
          onDelete={() => {
            const requestId = sendBenchDelete(worldId, sessionId, take.id);
            if (requestId !== null) setFlow({ step: "deleting", requestId, files });
          }}
        />
      )}
    </>
  );
}
