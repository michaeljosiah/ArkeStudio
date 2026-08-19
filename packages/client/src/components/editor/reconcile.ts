import {
  applyPatches,
  cleanupEfficiency,
  cleanupSemantic,
  makeDiff,
  makePatches,
} from "@sanity/diff-match-patch";

/**
 * Source-preserving reconciliation — the reason the rich editor may own a hand-written document.
 *
 * A rich editor does not hold markdown; it holds a document tree, and serialising that tree back
 * produces *canonical* markdown. Canonical differs from what people type in ways that are invisible
 * on screen and loud on disk: `* item` becomes `- item`, `_word_` becomes `*word*`, a setext
 * heading becomes an ATX one, a lazily numbered list is renumbered. Serialising naively means the
 * first keystroke rewrites the whole file — every line of the bible's history diff changes, and
 * `.history/bible/vN.md` fills with versions whose only difference is punctuation the author never
 * touched.
 *
 * So the edit is carried into the original bytes rather than replacing them. Three texts are held:
 * the source as loaded, its canonical form at load, and its canonical form after the edit. The
 * difference between the two canonical forms *is* the user's edit expressed in canonical space;
 * patching that difference onto the original source lands the edit while every untouched region
 * keeps the bytes the author wrote.
 *
 * That patch is fuzzy — it is matched against a text it was not computed from — so what comes out
 * of here is a *candidate*, never an answer. `commit.ts` proves it before anything reaches disk.
 * Keeping the proof there rather than here leaves this module pure, and means one round trip
 * answers both questions worth asking: did the patch land where it was meant to, and does the
 * document survive being written down at all.
 */

/**
 * Above this, patching costs more than it is worth and the document is handed to the source editor
 * instead (see `RICH_MODE_MAX_CHARACTERS`).
 *
 * Measured, not guessed: parsing markdown into a ProseMirror document is superlinear in this
 * stack — 11k characters costs ~25ms, 23k ~45ms, 45k ~190ms, 90k ~1000ms — while serialising back
 * is linear and nearly free. That parse is what the commit's proof pays, so the cap is the size at
 * which it still disappears inside a keystroke debounce. It is a backstop, not the policy: the
 * rich-mode gate is what keeps documents this long away from the editor in the first place.
 */
export const RECONCILE_MAX_CHARACTERS = 48_000;

/**
 * diff-match-patch's own default is one second of search, which freezes the tab on
 * replacement-heavy edits. A coarse, timed-out diff is safe here because the commit's proof rejects
 * a bad placement outright — the diff only has to be good, never optimal.
 */
const DIFF_TIMEOUT_SECONDS = 0.01;

export interface ReconcileParams {
  /** The bible text as loaded, in whatever style the author (or a text editor) left it. */
  originalSource: string;
  /** Canonical serialisation of `originalSource` — what the editor emits before any edit. */
  baseCanonical: string;
  /** Canonical serialisation after the edit — what the editor emits now. */
  edited: string;
}

/**
 * Carry `edited` into `originalSource`'s style, and return the bytes to try.
 *
 * Every branch returns something that *should* render the document the editor is showing; none of
 * them returns something known to. Falling back to `edited` is this function saying "no style worth
 * preserving here", not "this is safe" — the caller decides that.
 */
export function reconcileMarkdown({
  originalSource,
  baseCanonical,
  edited,
}: ReconcileParams): string {
  // Nothing changed in the document, only possibly in the tree. Hand back the original bytes
  // untouched, so opening the bible, clicking into it and leaving writes nothing at all.
  if (edited === baseCanonical) return originalSource;

  // The file on disk is already canonical, so there is no style to preserve and no fuzzy matching
  // to do. Every bible the app or the Studio wrote arrives here.
  if (originalSource === baseCanonical) return edited;

  // The source is canonical except for how it ends. Markdown serialisation drops the trailing
  // newline a text editor insists on, and that difference alone must not force the patch path.
  const trailing = /\n+$/.exec(originalSource)?.[0] ?? "";
  if (
    trailing.length <= 1 &&
    !edited.endsWith("\n") &&
    stripTrailingNewlines(originalSource) === stripTrailingNewlines(baseCanonical)
  ) {
    return edited + trailing;
  }

  // Beyond the cap the proof costs more than the debounce allows. Canonical output is correct,
  // just not style-preserving, and the rich-mode gate keeps documents this long out of here.
  if (Math.max(originalSource.length, baseCanonical.length, edited.length) > RECONCILE_MAX_CHARACTERS) {
    return edited;
  }

  // diff-match-patch's half-match accelerator ignores the deadline above and can run for hundreds
  // of milliseconds when both texts repeat a long seed. Detect that shape and skip the patch path.
  if (hasRepeatedHalfMatchSeed(baseCanonical, edited)) return edited;

  let diffs = makeDiff(baseCanonical, edited, { checkLines: true, timeout: DIFF_TIMEOUT_SECONDS });
  // makePatches would run its own cleanup with the library's one-second timeout; do it here so the
  // bounded diff above is the one that survives.
  if (diffs.length > 2) {
    diffs = cleanupSemantic(diffs);
    diffs = cleanupEfficiency(diffs);
  }
  const patches = makePatches(baseCanonical, diffs);

  /*
   * makePatches writes `start1`/`start2` as UTF-16 code-unit indices, but applyPatches runs them
   * through `adjustIndiciesToUcs2`, which reads them as UTF-8 *byte* offsets. On pure ASCII the two
   * agree and the disagreement is invisible; one em dash or curly quote above a hunk — which is to
   * say, most prose anyone writes — and every hunk after it seeks to the wrong place.
   *
   * Rewriting each start as the byte offset of that same code-unit index in the text being patched
   * makes the library's conversion an identity, so the search seed is the index makePatches meant.
   */
  /*
   * Patch the body without the file's trailing newline, and put it back afterwards. An edit made at
   * the very end of the document seeks to the very end of the source, where a trailing newline is
   * the last thing the matcher sees — and it lands the insertion on the far side of it, opening a
   * new line for text that belonged to the end of the last one. The newline is not content, so it
   * should not be in the text being patched.
   */
  const body = originalSource.slice(0, originalSource.length - trailing.length);
  const byteOffsets = utf8OffsetsAtCodeUnitIndices(
    body,
    patches.flatMap((patch) => [patch.start1, patch.start2]),
  );
  for (const patch of patches) {
    patch.start1 = byteOffsets.get(patch.start1) ?? 0;
    patch.start2 = byteOffsets.get(patch.start2) ?? 0;
  }

  const [patched, applied] = applyPatches(patches, body);
  const reconciled = patched + trailing;

  // A hunk that could not be located means the fuzzy match gave up rather than guessed. Whatever it
  // did with the rest is not worth trusting.
  if (applied.some((ok) => !ok)) return edited;

  return reconciled;
}

function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, "");
}

/**
 * Byte offset of each requested code-unit index, walked once in ascending order.
 *
 * `adjustIndiciesToUcs2` walks the text forward and throws if it cannot land on a target exactly,
 * so offsets are clamped to the text length and de-duplicated here — the same index asked for twice
 * (start1 and start2 of an unchanged-length hunk) must not advance the walk twice.
 */
function utf8OffsetsAtCodeUnitIndices(text: string, indices: number[]): Map<number, number> {
  const targets = [...new Set(indices)].sort((a, b) => a - b);
  const offsets = new Map<number, number>();
  let codeUnit = 0;
  let bytes = 0;
  for (const target of targets) {
    const bounded = Math.max(0, Math.min(target, text.length));
    while (codeUnit < bounded) {
      const codePoint = text.codePointAt(codeUnit) ?? 0;
      bytes += utf8Length(codePoint);
      codeUnit += codePoint > 0xffff ? 2 : 1;
    }
    offsets.set(target, bytes);
  }
  return offsets;
}

function utf8Length(codePoint: number): 1 | 2 | 3 | 4 {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/**
 * Whether diff-match-patch's half-match accelerator would spin on these two texts.
 *
 * It looks for a quarter-length seed from the longer text repeated in the shorter one, and that
 * search ignores the diff deadline. Mirroring the library's own prefix/suffix trimming first keeps
 * a small edit inside a repetitive document from being mistaken for a repetitive edit.
 */
function hasRepeatedHalfMatchSeed(textA: string, textB: string): boolean {
  const shortest = Math.min(textA.length, textB.length);
  let prefix = 0;
  while (prefix < shortest && textA.charCodeAt(prefix) === textB.charCodeAt(prefix)) prefix += 1;
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    textA.charCodeAt(textA.length - suffix - 1) === textB.charCodeAt(textB.length - suffix - 1)
  ) {
    suffix += 1;
  }

  const middleA = textA.slice(prefix, textA.length - suffix);
  const middleB = textB.slice(prefix, textB.length - suffix);
  const long = middleA.length > middleB.length ? middleA : middleB;
  const short = middleA.length > middleB.length ? middleB : middleA;
  if (long.length < 4 || short.length * 2 < long.length) return false;

  const seedLength = Math.floor(long.length / 4);
  for (const start of [Math.ceil(long.length / 4), Math.ceil(long.length / 2)]) {
    const seed = long.slice(start, start + seedLength);
    const first = short.indexOf(seed);
    if (first !== -1 && short.includes(seed, first + 1)) return true;
  }
  return false;
}
