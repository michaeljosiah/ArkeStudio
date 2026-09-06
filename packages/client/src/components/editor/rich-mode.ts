import { serializeMarkdown } from "./round-trip.js";

/**
 * Whether a bible may be opened in the rich editor, and what to say when it may not.
 *
 * The editor is a lens over markdown, and a lens that quietly drops what it cannot focus on is
 * worse than no lens. Every refusal here is a shape that *loses content* on the way in — measured
 * against this exact extension set, not assumed — so the document opens in the plain source editor
 * instead, where the bytes are the bytes.
 *
 * Formatting the editor merely rewrites (`* item` for `- item`, setext headings, lazy numbering) is
 * not a refusal. That is what `reconcile.ts` exists to carry, and refusing on it would push most
 * hand-written documents out of the rich editor for no gain.
 */

/**
 * Above this, the rich editor is not offered.
 *
 * Parsing markdown into a ProseMirror document is superlinear here — 23k characters cost ~45ms,
 * 45k ~190ms, 90k ~1000ms — and that parse is paid on open and again on every reconciliation proof.
 * 48k is roughly eight thousand words: the size at which both still disappear into a debounce.
 * Beyond it the source editor is not a degraded experience, it is the faster one.
 */
export const RICH_MODE_MAX_CHARACTERS = 48_000;

export type RichModeRefusal =
  | "too-long"
  | "html"
  | "footnotes"
  | "reference-links"
  | "will-not-round-trip";

export interface RichModeVerdict {
  reason: RichModeRefusal;
  /** Shown on the screen, in the screen's voice: what is true, not what to do about it. */
  message: string;
}

interface LossyShape {
  reason: RichModeRefusal;
  message: string;
  pattern: RegExp;
}

/*
 * The `{0,3}` on the two definition patterns is not decoration: CommonMark lets a definition be
 * indented by up to three spaces before it stops being one, and a definition indented by two used
 * to read as ordinary prose here — so the gate allowed the document and the editor inlined every
 * link in it.
 *
 * Each of these was confirmed to lose content through this extension set, not inferred:
 *   "text with <br> break"          → "text with &lt;br&gt; break"
 *   "text[^1]\n\n[^1]: note"        → "text[^1](note)"
 *   "see [d][x]\n\n[x]: https://…"  → "see [d](https://…)", definition gone
 * The first two are corruption. The third is arguably the same document, but the definition list is
 * an authoring style someone chose, and silently inlining every link is not this editor's call.
 */
const LOSSY_SHAPES: LossyShape[] = [
  {
    reason: "html",
    // "This text", not "this bible": the gate guards a chapter now as well (turn 126).
    message: "This text contains HTML, which the rich editor would rewrite. Editing as source.",
    pattern: /<\/?[A-Za-z][\w.:-]*(?:\s[^<>]*)?\/?>|<!--[\s\S]*?-->/,
  },
  {
    reason: "footnotes",
    message: "This bible uses footnotes, which the rich editor cannot hold. Editing as source.",
    pattern: /^ {0,3}\[\^[^\]]+\]:\s+/m,
  },
  {
    reason: "reference-links",
    message:
      "This bible uses reference-style links, which the rich editor would inline. Editing as source.",
    pattern: /^ {0,3}\[[^\]^]+\]:\s+\S+/m,
  },
];

/**
 * Null when the rich editor may own this text.
 *
 * `serialize` is injected so tests can drive the round-trip branch without standing up an editor,
 * and so a caller that already has a canonical form is not made to compute it twice.
 */
export function describeRichModeRefusal(
  text: string,
  serialize: (markdown: string) => string | null = serializeMarkdown,
): RichModeVerdict | null {
  if (text.length > RICH_MODE_MAX_CHARACTERS) {
    return {
      reason: "too-long",
      message: "This bible is long enough that the rich editor would lag. Editing as source.",
    };
  }

  // Code is quoted, not interpreted: `<div>` inside a fence is a string that round-trips fine, and
  // refusing a bible because it quotes a tag would be the app failing to read what it is looking at.
  const prose = stripCode(text);
  for (const shape of LOSSY_SHAPES) {
    if (shape.pattern.test(prose)) return { reason: shape.reason, message: shape.message };
  }

  // Last word to the pipeline itself. A construct nobody predicted throws on the way in rather than
  // arriving wrong, and this is where that becomes a refusal instead of a blank editor.
  if (serialize(text) === null) {
    return {
      reason: "will-not-round-trip",
      message: "The rich editor could not read this bible. Editing as source.",
    };
  }

  return null;
}

export interface RichModeGate {
  /** The text this verdict was reached about. */
  text: string;
  verdict: RichModeVerdict | null;
}

/**
 * Decide the gate for a document that has just arrived, reusing the last verdict where it is safe.
 *
 * Evaluating costs a full markdown parse, and a screen that re-evaluated on every save echo would
 * pay it once a keystroke-pause — so a document the *rich editor* wrote is deliberately not
 * re-examined. That is sound in both directions: rich output is a serialisation of a document that
 * already passed, and it escapes anything that would look like markup, so re-reading it could only
 * produce a spurious refusal over an author's literal `\<br\>`.
 *
 * `richWrite` is what the rich editor last wrote, or null when the last write came from the source
 * editor. That distinction is the whole point. The source editor is a text area: somebody can type
 * HTML, a footnote, a link definition — the exact shapes this gate exists to refuse — and if their
 * own text were waved through as "not a new document", toggling back to rich would hand the editor
 * a document it is known to damage.
 */
export function updateRichModeGate(
  previous: RichModeGate | null,
  live: string,
  richWrite: string | null,
  evaluate: (text: string) => RichModeVerdict | null = describeRichModeRefusal,
): RichModeGate {
  if (previous === null) return { text: live, verdict: evaluate(live) };
  if (live === previous.text) return previous;
  if (live === richWrite) return { text: live, verdict: previous.verdict };
  return { text: live, verdict: evaluate(live) };
}

/**
 * Blank out fenced blocks and inline code spans, leaving line structure intact so the anchored
 * patterns above still see real line starts.
 */
function stripCode(text: string): string {
  const out: string[] = [];
  let fence: "`" | "~" | null = null;
  let fenceLength = 0;

  for (const line of text.split("\n")) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);
    if (match) {
      const marker = match[1]![0] as "`" | "~";
      const length = match[1]!.length;
      if (fence === null) {
        fence = marker;
        fenceLength = length;
      } else if (fence === marker && length >= fenceLength) {
        fence = null;
        fenceLength = 0;
      }
      out.push("");
      continue;
    }
    out.push(fence ? "" : line.replace(/`+[^`\n]*`+/g, ""));
  }

  return out.join("\n");
}
