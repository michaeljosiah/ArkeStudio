import { useState } from "react";
import { ChapterVoicePinSchema, type VoicePin } from "@arke-studio/contracts";
import type { SpeakerChoices, SpeakerPick } from "../screens/chapter-audiobook.js";
import { Button } from "./ui.js";

type Quote = Pick<VoicePin, "paragraph" | "occurrence" | "quote">;

function QuoteRow({ quote, index, choices, onPick }: { quote: Quote; index: number; choices: SpeakerChoices | null; onPick: (quote: Quote, pick: SpeakerPick) => void }) {
  const [selected, setSelected] = useState("");
  const options = [...(choices?.chapter ?? []).map(who => ({ key: who.sheet ? `sheet:${who.sheet}` : `speaker:${who.key}`, label: who.label, pick: { speaker: who.label, ...(who.sheet ? { sheet: who.sheet } : {}) } })),
    ...(choices?.cast ?? []).map(who => ({ key: `sheet:${who.sheet}`, label: who.label, pick: { speaker: who.label, sheet: who.sheet } }))];
  const selectedOption = options.find(option => option.key === selected);
  const fits = ChapterVoicePinSchema.safeParse({ ...quote, narration: true }).success;
  return <li data-testid="quote-review-row" style={{ padding: "16px 0", borderBottom: "1px solid var(--line)" }}>
    <p className="fy-mono">Paragraph {quote.paragraph + 1}</p>
    <blockquote style={{ margin: "8px 0 16px", overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}>{quote.quote}</blockquote>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <select className="ui-input" aria-label={`Speaker for quote ${index + 1}`} value={selected} disabled={!choices || !fits}
        style={{ flex: "1 1 200px", minWidth: 0, maxWidth: "100%" }} onChange={event => setSelected(event.target.value)}>
        <option value="">Choose a speaker</option>{options.map(option => <option key={option.key} value={option.key}>{option.label}</option>)}
      </select>
      <Button disabled={!choices || !fits || !selectedOption} onClick={() => selectedOption && onPick(quote, selectedOption.pick)}>Apply</Button>
      <Button variant="ghost" disabled={!choices || !fits} onClick={() => onPick(quote, { narration: true })}>Keep as narration</Button>
    </div>
    {!fits && <p className="fy-actioncard__notice">For this longer quotation, select a shorter passage in the chapter to assign its voice.</p>}
  </li>;
}

export function QuoteReview({ quotes, choices, onPick }: { quotes: readonly Quote[]; choices: SpeakerChoices | null; onPick: (quote: Quote, pick: SpeakerPick) => void }) {
  return <div style={{ padding: "8px 20px 24px" }}>
    <p>These quotations have no assigned voice. They may be dialogue or quoted text. Choose a speaker or keep narration.</p>
    <p className="fy-actioncard__notice">Saved, cast paragraphs only. This review aid does not prove dialogue coverage.</p>
    {!choices && <p role="status">Save any edits and finish casting before assigning voices. The world must be connected.</p>}
    <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>{quotes.map((quote, index) => <QuoteRow key={`${quote.paragraph}:${quote.occurrence}:${quote.quote}`} quote={quote} index={index} choices={choices} onPick={onPick} />)}</ol>
    {!quotes.length && <p>Nothing left in this review list.</p>}
  </div>;
}
