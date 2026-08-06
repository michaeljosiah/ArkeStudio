import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldBundle } from "@arke-studio/contracts";
import { describeEntryContext } from "../../src/world-chat/entry-context.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD } from "../world/helpers.js";

/**
 * Handing over what the conversation was opened about (#70 phase 6).
 *
 * The entry points exist to spare somebody describing what they were just looking at. If this
 * text never reached the model, they would have to anyway, and the buttons would be decoration.
 */

let bundle: WorldBundle;

describe("what a conversation was opened about", () => {
  it("says nothing for one opened from the world itself", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    assert.equal(describeEntryContext({ kind: "world" }, bundle), "");
  });

  it("carries a refusal's question and what the search had found", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const text = describeEntryContext(
      { kind: "canon-question", question: "Who may ring the bells?", candidateEntryIds: ["CANON-002"] },
      bundle,
    );
    assert.match(text, /Who may ring the bells\?/);
    assert.match(text, /CANON-002/, "the closest entries travel too");
    assert.match(text, /none of them answered it/, "and that they did not answer it");
  });

  it("says plainly when nothing came close", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const text = describeEntryContext(
      { kind: "canon-question", question: "Anything at all?", candidateEntryIds: [] },
      bundle,
    );
    assert.match(text, /Nothing in canon came close/);
  });

  it("names a sheet by the name a person would use", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const text = describeEntryContext(
      { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
      bundle,
    );
    assert.match(text, /Maren Kest/, "the name, not only the slug");
    assert.match(text, /maren-kest/, "and the slug, so the model can read it");
    assert.match(text, /Read it before proposing a change/);
  });

  it("names a canon entry by its title", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const text = describeEntryContext({ kind: "canon-entry", entryId: "CANON-002" }, bundle);
    assert.match(text, /CANON-002/);
    assert.match(text, /Tide-calling/, "the title, so the model knows what it is before reading");
  });

  it("degrades to the id when the thing has since gone", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const text = describeEntryContext({ kind: "canon-entry", entryId: "CANON-999" }, bundle);
    assert.match(text, /CANON-999/, "still says what it was about rather than nothing");
  });

  it("does not paste the entity's contents into the prompt", async () => {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const maren = bundle.sheets.find((s) => s.id === "maren-kest")!;
    const text = describeEntryContext(
      { kind: "sheet", sheetKind: "character", sheetId: "maren-kest" },
      bundle,
    );
    // Names and ids cross; the model reads the entity through its tools, at whatever version is
    // current when it asks, rather than from a snapshot that may already be stale.
    assert.ok(!text.includes(maren.sections[0]!.body), "prose stays behind the tools");
  });
});
