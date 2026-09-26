import { useState } from "react";
import type { GenesisImportCard, GenesisImports, GenesisImportResolve } from "@arke-studio/contracts";
import { Button, Callout } from "./ui.js";

function ImportCard({ card, busy, onResolve }: { card: GenesisImportCard; busy: boolean; onResolve(input: GenesisImportResolve): void }) {
  const [name, setName] = useState(card.proposal.name), [body, setBody] = useState(card.proposal.body);
  const [target, setTarget] = useState(card.matches[0]?.key ?? "");
  const [mode, setMode] = useState<"" | "distinct" | "append" | "replace">(card.matches.length ? "append" : "");
  const decide = (decision: GenesisImportResolve["decision"]) => onResolve({
    id: card.id, digest: card.digest, decision, name, body, ...(mode ? { mode } : {}), ...(mode !== "distinct" && target ? { target } : {}),
  });
  return <article className="fy-actioncard" aria-label={card.proposal.name}>
    <h3>{card.proposal.name} · {card.proposal.kind}</h3>
    <p>{card.status === "prepared" ? "Prepared for content approval" : card.status}</p>
    <p>Source: {card.source.name}, line {card.source.line}</p>
    <details><summary>Source identity</summary><code>{card.source.hash}</code></details>
    <blockquote style={{ whiteSpace: "pre-wrap" }}>{card.source.quote}</blockquote>
    <p>The quote is verified. The wording below is an interpretation for you to review.</p>
    <label>Name<input aria-label="Imported name" value={name} disabled={busy || card.status === "prepared" || card.status === "rejected"} onChange={e => setName(e.target.value)} /></label>
    <label>Proposed interpretation<textarea aria-label="Imported interpretation" value={body} disabled={busy || card.status === "prepared" || card.status === "rejected"} onChange={e => setBody(e.target.value)} /></label>
    {!!card.proposal.links?.length && <p>Suggested relationships, requiring approval: {card.proposal.links.join(", ")}</p>}
    {!!card.related.length && <Callout title="Other imports with the same name">
      <p>Compare these interpretations before preparing content. After preparing one, you can merge the others into its draft record or leave them undecided.</p>
      {card.related.map((other, index) => <p key={index}>{other.source}: {other.text}</p>)}
    </Callout>}
    {!!card.matches.length && <Callout title="Possible duplicate or conflicting statement">
      <p>These names match. Compare their words; matching names alone do not establish that they are the same entity.</p>
      {card.matches.map(match => <section key={match.key}><h4>{match.name}</h4><p style={{ whiteSpace: "pre-wrap" }}>{match.text}</p></section>)}
    </Callout>}
      <label>Resolution<select aria-label="Import resolution" value={mode} onChange={e => setMode(e.target.value as typeof mode)}>
        <option value="">Create if the name is available</option>
        {!!card.matches.length && <><option value="append">Append to the existing record</option><option value="replace">Replace this section</option></>}
        <option value="distinct">Keep as a distinct record</option>
      </select></label>
      {(mode === "append" || mode === "replace") && <label>Existing record<select aria-label="Import merge target" value={target} onChange={e => setTarget(e.target.value)}>
        {card.matches.map(match => <option key={match.key} value={match.key}>{match.name} ({match.key})</option>)}
      </select></label>}
    {(card.status === "pending" || card.status === "deferred") && <div style={{ display: "flex", gap: 8 }}>
      <Button disabled={busy || !name.trim() || !body.trim()} onClick={() => decide("prepare")}>Prepare for approval</Button>
      <Button variant="ghost" disabled={busy} onClick={() => decide("reject")}>Reject extraction</Button>
      <Button variant="ghost" disabled={busy} onClick={() => decide("defer")}>Leave undecided</Button>
    </div>}
  </article>;
}
export function GenesisImportCards({ imports, busy, onResolve, onExtract, onRefresh }: {
  imports: GenesisImports; busy: boolean; onResolve(input: GenesisImportResolve): void; onExtract(name: string): void; onRefresh(): void;
}) {
  if (!imports.documents.length && !imports.cards.length && !imports.problems.length) return null;
  return <section aria-label="Review document imports" style={{ display: "grid", gap: 12 }}>
    <h2>Review document imports</h2>
    <p>Source files are retained as artifacts. Only approved content becomes part of the world.</p>
    {imports.documents.map(document => <div key={document.name}><strong>{document.name}</strong><p>{document.detail}</p>
      {document.supported && <Button disabled={busy} onClick={() => onExtract(document.name)}>Extract proposals in chat</Button>}</div>)}
    <Button variant="ghost" disabled={busy} onClick={onRefresh}>Refresh import review</Button>
    {imports.problems.length > 0 && <Callout title="Import material needs attention">{imports.problems.map(problem => <p key={problem}>{problem}</p>)}</Callout>}
    {imports.cards.map(card => <ImportCard key={card.id + card.digest} card={card} busy={busy} onResolve={onResolve} />)}
  </section>;
}
