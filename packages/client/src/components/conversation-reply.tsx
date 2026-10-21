import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { chatReplyParts } from "../lib/chat-reply.js";
import { renderInlineMarkdown } from "./inline-markdown.js";
import { Button } from "./ui.js";

/** The journal, Copy and Listen keep the whole reply; paging changes only what is being read. */
export function ConversationReply({ text }: { text: string }) {
  const parts = useMemo(() => chatReplyParts(text), [text]);
  const [part, setPart] = useState(0);
  const current = Math.min(part, parts.length - 1);
  const content = useRef<HTMLDivElement>(null);
  const moving = useRef(false);
  const id = useId();
  useLayoutEffect(() => {
    if (!moving.current) return;
    moving.current = false;
    content.current?.focus({ preventScroll: true });
    content.current?.scrollIntoView({ block: "start" });
  }, [current]);
  if (parts.length === 1) return renderInlineMarkdown(text);
  const start = parts.slice(0, current).reduce((length, value) => length + value.length, 0);
  const move = (next: number) => { moving.current = true; setPart(next); };
  return <>
    <div ref={content} id={id} className="fy-chat__reply-part" tabIndex={-1} aria-label={`Reply, part ${current + 1} of ${parts.length}`}>
      {renderInlineMarkdown(text, { start, end: start + parts[current]!.length })}
    </div>
    <nav className="fy-chat__reply-pages" aria-label="Reply parts">
      <Button variant="ghost" size="sm" disabled={current === 0} aria-controls={id} onClick={() => move(current - 1)}>Previous</Button>
      <span aria-live="polite">Part {current + 1} of {parts.length}</span>
      <Button variant="ghost" size="sm" disabled={current === parts.length - 1} aria-controls={id} onClick={() => move(current + 1)}>Next</Button>
    </nav>
  </>;
}
