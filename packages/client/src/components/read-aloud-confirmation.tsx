import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readerName, formatMicroUsd, type DomainEvent } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button } from "./ui.js";

type ReadResult = Extract<DomainEvent, { type: "voice.audio" }>;

/** The destination and price belong to the coordinator's quote, not the current voice picker. */
export function ReadAloudConfirmation({ title, result, onConfirm, onCancel }: {
  title: string;
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
  const reader = readerName(result, row);
  const local = result.provider === "kokoro" && result.model === "kokoro-82m";
  // A read over the reader's cap goes as several requests and arrives in as many pieces (issue
  // 1208): said with the price, since each seam is audible and each piece is a call.
  const pieces = result.parts !== undefined && result.parts > 1 ? ` · ${result.parts} parts` : "";
  if (result.status !== "confirmation-required" || settled === quote) return null;
  const cancel = () => { setSettled(quote); onCancel(); };
  return createPortal(
    <EditorDialog open title="Read aloud" subtitle={`${title} · ${reader}${pieces}`} labelledBy={heading} onClose={cancel}>
      <div className="fy-exsheet">
        {/* What leaves the machine, said before it does: the words, and for a cloned narrator the
            recording with them (issue 1215), as the audiobook's door says it. */}
        <p>{local ? `Read locally with ${reader}.` : result.voiceReference === true ? `This text and the voice recording will be sent to ${reader}.` : `This text will be sent to ${reader}.`} Text is retained in Activity.</p>
        {(result.notices ?? []).map((notice) => <p key={notice} className="fy-mono" data-testid="read-aloud-notice">{notice}</p>)}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
          <Button variant="primary" disabled={!result.confirmationToken} onClick={() => {
            if (!result.confirmationToken || submitted.current === quote) return;
            submitted.current = quote;
            setSettled(quote);
            onConfirm(result.confirmationToken);
          }}>Confirm {result.characterCount} characters · {formatMicroUsd(result.estimatedMicroUsd)}</Button>
        </div>
      </div>
    </EditorDialog>, document.body,
  );
}
