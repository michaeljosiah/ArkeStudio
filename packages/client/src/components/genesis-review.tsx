import type { GenesisContent, GenesisContentReview, GenesisReviewCard } from "@arke-studio/contracts";
import { renderInlineMarkdown } from "./inline-markdown.js";
import { Button, Callout } from "./ui.js";

function Content({ content, review }: { content: GenesisContent; review: GenesisContentReview }) {
  if (content.kind === "remove") return <p>Remove this item from the approved founding content.</p>;
  if (content.kind === "thread") return <p>Open question: {content.value}</p>;
  if (content.kind === "canon") return <>
    <p>{content.value.type === "thread" ? "Open question" : `Established ${content.value.type}`}</p>
    <div style={{ whiteSpace: "pre-wrap" }}>{renderInlineMarkdown(content.value.statement)}</div>
  </>;
  if (content.kind === "world") return <>
    {Object.entries(content.value).filter(([key]) => key !== "keyArt").map(([key, value]) =>
      <section key={key}><h4>{key === "bible" ? "World bible" : key[0]!.toUpperCase() + key.slice(1)}</h4>
        <div style={{ whiteSpace: "pre-wrap" }}>{renderInlineMarkdown(String(value))}</div></section>)}
    {content.value.keyArt && <p>Key art: {content.value.keyArt.prompt ?? content.value.keyArt.subject}</p>}
  </>;
  const entity = content.value;
  return <>
    {("neverDepicted" in entity && entity.neverDepicted) && <p>Never depicted</p>}
    {(["role", "billing", "region"] as const).map(field => entity.sheet?.[field] ?
      <p key={field}>{field}: {entity.sheet[field]}</p> : null)}
    {Object.entries(entity.sheet?.sections ?? {}).map(([heading, text]) =>
      <section key={heading}><h4>{heading}</h4><div style={{ whiteSpace: "pre-wrap" }}>{renderInlineMarkdown(text)}</div></section>)}
    {!!entity.sheet?.links?.length && <p>Linked to: {entity.sheet.links.map(key => review.cards.find(card => card.key === key)?.title ?? key.split(":").at(-1)).join(", ")}</p>}
  </>;
}

export function GenesisContentCards({ review, busy, onDecide, onRevise }: {
  review: GenesisContentReview; busy: boolean;
  onDecide(cards: GenesisReviewCard[], decision: "approve" | "reject"): void;
  onRevise(title: string): void;
}) {
  const pending = review.cards.filter(card => card.status === "pending");
  return <section aria-label="Review world content" style={{ display: "grid", gap: 14 }}>
    <h2>Review world content</h2>
    <p>Founding saves approved content. Changed or rejected proposals do not replace an earlier approved version.</p>
    {review.problems.length > 0 && <Callout title="Before founding">{review.problems.map(problem => <p key={problem}>{problem}</p>)}</Callout>}
    {review.cards.map(card => <article className="fy-actioncard" key={card.key} aria-label={card.title} data-status={card.status}>
      <div className="fy-actioncard__head"><h3>{card.title}</h3><span>{card.status}</span></div>
      <Content content={card.content} review={review} />
      {card.previous && card.status !== "approved" && <details><summary>Previously approved content</summary><Content content={card.previous} review={review} /></details>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        {card.status !== "approved" && <Button disabled={busy} onClick={() => onDecide([card], "approve")}>Approve this version</Button>}
        {card.status === "pending" && <Button variant="ghost" disabled={busy} onClick={() => onDecide([card], "reject")}>Reject</Button>}
        <Button variant="ghost" disabled={busy} onClick={() => onRevise(card.title)}>Request changes</Button>
      </div>
    </article>)}
    {pending.length > 1 && <Button disabled={busy} onClick={() => onDecide(pending, "approve")}>Approve all {pending.length} pending items shown above</Button>}
  </section>;
}
