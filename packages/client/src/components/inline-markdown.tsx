import { Fragment, type ReactNode } from "react";

/**
 * The little markdown a model puts in a chat reply, rendered rather than printed (issue 911).
 *
 * Arke's first reply on the world door showed up literally as `**The name itself**` and
 * `*Ozioma Nweke*` — the first prose a new user reads, and it looked broken. The model is
 * asked for Markdown in the bible and carries the habit into its replies; forbidding it in the
 * brief would not have held, so the bubble renders it instead.
 *
 * Only the inline forms: bold, italic, code. Block structure (headings, lists) survives as the
 * plain lines it already was under `white-space: pre-wrap`. The bible itself goes through the
 * rich editor and never comes here.
 */
const INLINE = /\*\*([^\n]+?)\*\*|(?<![\w*])\*(?!\s)([^\n*]+?)(?<!\s)\*(?![\w*])|(?<!\w)_(?!\s)([^\n_]+?)(?<!\s)_(?!\w)|`([^`\n]+)`/g;

export function renderInlineMarkdown(text: string, range?: { start: number; end: number }): ReactNode {
  const out: ReactNode[] = [];
  const start = range?.start ?? 0, end = range?.end ?? text.length;
  let last = 0;
  const plain = (from: number, to: number) => {
    const value = text.slice(Math.max(start, from), Math.min(end, to));
    if (Math.max(start, from) < Math.min(end, to)) out.push(value);
  };
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) plain(last, at);
    if (at >= end) { last = end; break; }
    const [, strong, star, underscore, code] = match;
    const content = (strong ?? star ?? underscore ?? code)!;
    // Parse the complete span, then clip its contents. A display part may cross even an
    // unusually long span without exposing markers or changing the saved reply.
    const contentStart = at + (match[0].length - content.length) / 2;
    const visible = content.slice(Math.max(0, start - contentStart), Math.max(0, end - contentStart));
    const key = out.length;
    if (visible) {
      if (strong !== undefined) out.push(<strong key={key}>{visible}</strong>);
      else if (code !== undefined) out.push(<code key={key}>{visible}</code>);
      else out.push(<em key={key}>{visible}</em>);
    }
    last = at + match[0].length;
    if (last >= end) break;
  }
  if (last < end) plain(last, end);
  return out.length === 1 ? out[0] : <Fragment>{out}</Fragment>;
}
