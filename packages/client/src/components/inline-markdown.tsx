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

export function renderInlineMarkdown(text: string): ReactNode {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [, strong, star, underscore, code] = match;
    const key = out.length;
    if (strong !== undefined) out.push(<strong key={key}>{strong}</strong>);
    else if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else out.push(<em key={key}>{star ?? underscore}</em>);
    last = at + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length === 1 ? out[0] : <Fragment>{out}</Fragment>;
}
