import { useEffect, useRef, useState } from "react";
import { audiobookWording, audiobookWordsCounts, type AudiobookWordsRow, type AudiobookWordsState } from "@arke-studio/contracts";
import { requestAudiobookWords, subscribeAudiobookWords, useStore } from "../lib/store.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";

export function wordsCheckLabel(row: AudiobookWordsRow): string {
  if (row.comparison?.status === "compared") {
    const review = audiobookWording(row.text, row.comparison.observedText);
    return review === "match" ? "match" : review === "formatting" ? "same words, different formatting" : "review wording";
  }
  return row.reason ?? (row.comparison?.status === "unavailable" ? "local transcription unavailable" : "unchecked");
}

/** Reuse the recorded-take checks and Voice panel. Differences are review findings, never
 * a Make again action or a failed-take flag. */
export function AudiobookWordsControl({ worldId, productionId, chapterId, block, freshness }: {
  worldId: string; productionId: string; chapterId: string; block: string; freshness: string;
}) {
  const [open, setOpen] = useState(false);
  return <div className="fy-abp__kv" data-testid="audiobook-words-control">
    <span className="fy-abp__k">Words</span>
    <Button variant="ghost" onClick={() => setOpen(true)}>Check words</Button>
    {open && <AudiobookWordsDialog worldId={worldId} productionId={productionId} chapterId={chapterId} block={block} freshness={freshness} onClose={() => setOpen(false)} />}
  </div>;
}

export function AudiobookWordsDialog({ worldId, productionId, chapterId, block, freshness, onClose }: {
  worldId: string; productionId: string; chapterId: string; block: string; freshness: string; onClose: () => void;
}) {
  const connection = useStore().connection;
  const [scope, setScope] = useState<"block" | "chapter" | "book">("block");
  const [state, setState] = useState<AudiobookWordsState | null>(null);
  const request = useRef<string | null>(null);
  const owner = useRef<string | null>(null);
  const selectedScope = () => scope === "book" ? {} : scope === "chapter" ? { chapters: [chapterId] } : { blocks: [{ chapterId, key: block }] };
  const ask = (action: "read" | "check" | "stop") => {
    if (action === "check") setState(previous => previous ? { ...previous, running: true } : previous);
    request.current = requestAudiobookWords(worldId, productionId, action, selectedScope());
  };
  useEffect(() => subscribeAudiobookWords(answer => {
    if (answer.worldId !== worldId || answer.productionId !== productionId ||
      (answer.requestId !== request.current && answer.requestId !== owner.current)) return;
    owner.current = answer.state.runningRequestId ?? null;
    setState(answer.state);
  }), [worldId, productionId]);
  useEffect(() => {
    setState(null); owner.current = null;
    if (connection === "open") ask("read");
  }, [worldId, productionId, chapterId, block, freshness, scope, connection]);
  const counts = state === null ? null : audiobookWordsCounts(state.rows);
  const running = state?.running === true;
  return <EditorDialog open title="Check words" subtitle="Current saved readings · on this machine" width={680} onClose={onClose}>
    <div className="fy-rectake fy-abwords" data-testid="audiobook-words-dialog">
      <div className="fy-rectake__sect">
        <span className="fy-rectake__sect-title">Scope</span>
        {running ? <span className="fy-mono">{state.chapters.length} chapter{state.chapters.length === 1 ? "" : "s"} · {state.total} readings</span> : <span className="fy-seg" role="group" aria-label="Words check scope">
          {([['block', 'This block'], ['chapter', 'Chapter'], ['book', 'Book']] as const).map(([value, label]) =>
            <button key={value} type="button" className={`fy-seg__item${scope === value ? " fy-seg__item--active" : ""}`}
              aria-pressed={scope === value} disabled={running} onClick={() => setScope(value)}>{label}</button>)}
        </span>}
      </div>
      <p className="fy-mono" role="status">{counts === null ? "Loading checks…" :
        `${counts.match} match · ${counts.differ} to review · ${counts.unchecked} unchecked · ${counts.unavailable} unavailable${running ? ` · ${state!.done} / ${state!.total} checked` : ""}`}</p>
      {state?.reason && <p className="fy-rectake__refused" role="status">{state.reason}</p>}
      <p className="fy-mono">Formatting differences are separated from wording to review. Spelling, numbers, abbreviations and names may be recognition errors. Listen before changing a recording; no reading is changed. This does not check pronunciation or word timing.</p>
      <div className="fy-rectake__table">
        {state?.rows.map(row => {
          const compared = row.comparison?.status === "compared" ? row.comparison : null;
          const review = compared ? audiobookWording(row.text, compared.observedText) : null;
          const tone = compared ? review !== "review" ? "pass" : "warning" : "unavailable";
          return <details key={`${row.chapterId}/${row.key}`} className="fy-abp__disc">
            <summary className={`fy-rectake__check fy-rectake__check--${tone}`}>
              <span className="fy-rectake__check-label">{scope === "book" ? `${row.chapterTitle} · ` : ""}{row.label}</span>
              <span className="fy-mono fy-rectake__check-value">{wordsCheckLabel(row)}</span>
            </summary>
            <div className="fy-ab__splitpanel"><div className="fy-ab__reads">
              <div className="fy-ab__read"><b>Words</b><span>{row.text || "—"}</span></div>
              <div className="fy-ab__read"><b>Heard</b><span>{compared?.observedText ?? "unchecked"}</span></div>
            </div></div>
            {compared?.result === "mismatch" && <p className="fy-mono">{review === "formatting" ? "Formatting differences · raw transcript kept" : `${compared.differences.length} difference${compared.differences.length === 1 ? "" : "s"} · the transcript may be wrong; review the recording`}</p>}
          </details>;
        })}
      </div>
      <div className="fy-rectake__foot">
        <span className="fy-mono fy-rectake__tech">{running ? "Completed checks are kept" : "Local · no synthesis"}</span>
        <span className="fy-rectake__push" />
        <Button variant="ghost" onClick={onClose}>Done</Button>
        {running ? <Button variant="primary" disabled={connection !== "open"} onClick={() => ask("stop")}>Stop</Button> :
          <Button variant="primary" disabled={connection !== "open" || state?.available !== true || !state.rows.some(row => row.artifactId !== undefined && row.comparison?.status !== "compared")}
            onClick={() => ask("check")}>Check words</Button>}
      </div>
    </div>
  </EditorDialog>;
}
