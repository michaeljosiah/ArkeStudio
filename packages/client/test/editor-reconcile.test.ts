import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RECONCILE_MAX_CHARACTERS, reconcileMarkdown } from "../src/components/editor/reconcile.js";
import { serializeMarkdown } from "../src/components/editor/round-trip.js";

/**
 * Carrying an edit into the author's own bytes.
 *
 * `baseCanonical` comes from the real serialiser — a headless Tiptap editor needs no DOM — so these
 * run against the canonical forms the mounted editor actually produces rather than a guess at them.
 * `edited` is derived from `baseCanonical` by string surgery, which is exactly what the editor
 * emits for the same edit: everything the author did not touch serialises identically either way.
 *
 * What is *proved* is not tested here, because this function proves nothing — see `commit.ts`.
 */

const canonical = (markdown: string): string => {
  const out = serializeMarkdown(markdown);
  assert.ok(out !== null, "the fixture must survive a round trip");
  return out;
};

const reconcile = (originalSource: string, edit: (canonical: string) => string): string =>
  reconcileMarkdown({
    originalSource,
    baseCanonical: canonical(originalSource),
    edited: edit(canonical(originalSource)),
  });

/** A bible written by hand: star bullets, underscore emphasis, a setext heading, a trailing line. */
const HAND_WRITTEN = `The tides
=========

The tide is the world's clock and its _accountant_.

* salt in the rigging
* verse under the hull
`;

describe("markdown reconciliation", () => {
  it("returns the original bytes untouched when the document did not change", () => {
    const result = reconcile(HAND_WRITTEN, (base) => base);
    assert.equal(result, HAND_WRITTEN, "opening a bible and closing it must write nothing");
  });

  it("keeps the author's formatting in the regions they did not edit", () => {
    const result = reconcile(HAND_WRITTEN, (base) => base.replace("accountant", "auditor"));

    assert.match(result, /auditor/, "the edit landed");
    assert.match(result, /^\* salt in the rigging$/m, "star bullets survived");
    assert.match(result, /_auditor_/, "underscore emphasis survived");
    assert.match(result, /^=========$/m, "the setext heading survived");
  });

  it("carries an edit that sits below a lot of non-ASCII prose", () => {
    /*
     * The regression this exists for: diff-match-patch writes hunk offsets as UTF-16 indices and
     * reads them back as UTF-8 byte offsets. Every em dash, curly quote or accent above a hunk pulls
     * the two counts apart by a byte or two, and once the gap exceeds the fuzzy matcher's search
     * radius the hunk stops resolving — the whole file is rewritten in canonical form instead. Pure
     * ASCII cannot catch it, and neither can a handful of dashes; this fixture carries several
     * hundred, which is one long section of ordinary prose.
     */
    const paragraphs = Array.from(
      { length: 60 },
      (_, index) => `Ledger ${index} — the tide — the verse — the harbour — read again — and again.`,
    ).join("\n\n");
    const source = `${paragraphs}\n\n* salt in the rigging\n* verse under the hull\n\nThe harbourmaster keeps a ledger nobody reads.\n`;

    const result = reconcile(source, (base) => base.replace("nobody reads", "nobody has ever read"));

    assert.match(result, /a ledger nobody has ever read/, "the edit landed");
    assert.match(
      result,
      /^\* salt in the rigging$/m,
      "and the author's bullets survived, which is only true if the patch resolved",
    );
    assert.equal(
      serializeMarkdown(result),
      canonical(source).replace("nobody reads", "nobody has ever read"),
      "and the bytes still render the document the editor is showing",
    );
  });

  it("hands back canonical output when the source is already canonical", () => {
    const source = canonical(HAND_WRITTEN);
    const edited = source.replace("accountant", "auditor");
    assert.equal(reconcileMarkdown({ originalSource: source, baseCanonical: source, edited }), edited);
  });

  it("keeps the file's trailing newline", () => {
    const source = `${canonical(HAND_WRITTEN)}\n`;
    const result = reconcileMarkdown({
      originalSource: source,
      baseCanonical: canonical(source),
      edited: canonical(source).replace("accountant", "auditor"),
    });
    assert.ok(result.endsWith("\n"), "a file that ended with a newline still does");
    assert.ok(!result.endsWith("\n\n"), "and did not grow another one");
  });

  it("puts an edit at the end of the document before the trailing newline, not after it", () => {
    // The matcher seeks to the end of the source, where the file's last newline is the last thing it
    // sees, and used to land the insertion on the far side of it — opening a new line for text that
    // belonged to the end of the previous one.
    const source = "The tide is the world's clock,\nand its accountant.\n";
    const result = reconcile(source, (base) => `${base} It keeps two ledgers.`);
    assert.match(result, /and its accountant\. It keeps two ledgers\./);
  });

  it("gives up on formatting rather than spend more than it can afford", () => {
    // Only the lengths matter to the guard, so this stays away from the real serialiser — running it
    // over 48k characters would cost more than the rest of the suite put together.
    const source = `* ${"salt in the rigging ".repeat(RECONCILE_MAX_CHARACTERS / 20)}`;
    assert.ok(source.length > RECONCILE_MAX_CHARACTERS);

    const baseCanonical = source.replace("* ", "- ");
    const edited = `${baseCanonical}\n\nAnd a new line.`;
    assert.equal(reconcileMarkdown({ originalSource: source, baseCanonical, edited }), edited);
  });
});
