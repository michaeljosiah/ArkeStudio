import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readerName, formatMicroUsd, freePlanAskCopy, type DomainEvent } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";

type ReadResult = Extract<DomainEvent, { type: "voice.audio" }>;

/** The destination and price belong to the coordinator's quote, not the current voice picker. */
export function ReadAloudConfirmation({ title, result, onConfirm, onCancel, inline = false }: {
  title: string;
  /** A contents sheet keeps its quote in the same native modal layer. */
  inline?: boolean;
  result: ReadResult;
  onConfirm: (confirmationToken: string) => void;
  onCancel: () => void;
}) {
  const { state } = useStore();
  const heading = useId();
  const [settled, setSettled] = useState<string | null>(null);
  const submitted = useRef<string | null>(null);
  const quote = `${result.requestId}:${result.confirmationToken ?? ""}`;
  const row = state?.app.manifest?.models.find(model => model.provider === result.provider && model.id === result.model);
  const ceiling = row?.pricing.kind === "perToken" || result.voices?.some(voice => state?.app.manifest?.models.some(model => model.provider === voice.provider && model.pricing.kind === "perToken"));
  const reader = readerName(result, row);
  const local = result.provider === "kokoro" && result.model === "kokoro-82m";
  // A read over the reader's cap goes as several requests and arrives in as many pieces (issue
  // 1208): said with the price, since each seam is audible and each piece is a call.
  const pieces = result.parts !== undefined && result.parts > 1 ? ` · ${result.parts} parts` : "";
  // A read Google's free day cannot cover asks in its own words when it costs nothing; a priced
  // voice in it keeps the price on the button, with the day's line above (codex on PR 1475).
  const free = result.freePlan !== undefined ? freePlanAskCopy(result.freePlan) : null;
  if (result.status !== "confirmation-required" || settled === quote) return null;
  const cancel = () => { setSettled(quote); onCancel(); };
  const content = <div className="fy-exsheet">
    {inline && <div id={heading}>{title} · {reader}{pieces}</div>}
    {/* What leaves the machine, said before it does: the words, and for a cloned narrator the
        recording with them (SPEC-046 R-40), as the audiobook's door says it. */}
    <p>{local ? `Read locally with ${reader}.` : result.voiceReference === true ? `This text and the voice recording will be sent to ${reader}.` : `This text will be sent to ${reader}.`} Text is retained in Activity.</p>
    {(result.notices ?? []).map((notice) => <p key={notice} className="fy-mono" data-testid="read-aloud-notice">{notice}</p>)}
    {free !== null && <p className="fy-mono" data-testid="read-aloud-free-plan">{free.line}</p>}
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
      <Button variant="ghost" onClick={cancel}>Cancel</Button>
      <Button variant="primary" disabled={!result.confirmationToken} onClick={() => {
        if (!result.confirmationToken || submitted.current === quote) return;
        submitted.current = quote;
        setSettled(quote);
        onConfirm(result.confirmationToken);
      }}>{free !== null && result.estimatedMicroUsd === 0 ? free.confirm : `Confirm ${result.characterCount} characters · ${ceiling ? "up to " : ""}${formatMicroUsd(result.estimatedMicroUsd)}`}</Button>
    </div>
  </div>;
  if (inline) return <section className="fy-read-confirmation" aria-labelledby={heading}>{content}</section>;
  return createPortal(
    <EditorDialog open title="Read aloud" subtitle={`${title} · ${reader}${pieces}`} labelledBy={heading} onClose={cancel}>
      {content}
    </EditorDialog>, document.body,
  );
}
