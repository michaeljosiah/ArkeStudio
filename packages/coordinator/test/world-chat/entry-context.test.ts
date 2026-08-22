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

/**
 * The shape travels as numbers, never as craft (review 2026-08-22): a microdrama thread whose
 * briefing does not carry the episode count, the seconds and the hook window leaves the model
 * pitching episodes for a shape it cannot see — and the numbers are the shape.
 */
describe("a production thread is briefed on its shape", () => {
  async function shaped(meta: Record<string, unknown>, defaults?: Record<string, unknown>) {
    bundle ??= (await scanWorld(FIXTURE_WORLD)).bundle;
    const production = bundle.productions[0]!;
    const patched = {
      ...bundle,
      productions: [
        {
          ...production,
          meta: { ...production.meta, ...meta } as typeof production.meta,
          season: {
            version: production.season?.version ?? 1,
            ...(defaults !== undefined ? { defaults } : {}),
          } as typeof production.season,
        },
        ...bundle.productions.slice(1),
      ],
    };
    return describeEntryContext({ kind: "production", productionId: production.meta.id }, patched);
  }

  it("a microdrama's numbers reach the model: count, seconds, hook window", async () => {
    const text = await shaped(
      { medium: "video", kind: "microdrama" },
      { episodeCount: 12, episodeSecondsMin: 45, episodeSecondsMax: 90, hookWindowSec: 3 },
    );
    assert.match(text, /microdrama/i);
    assert.match(text, /season of 12 episodes/);
    assert.match(text, /45–90 seconds/);
    assert.match(text, /first 3 seconds are the hook/);
  });

  it("an episodic production without stored defaults still says it is one", async () => {
    const text = await shaped({ medium: "video", kind: "series" });
    assert.match(text, /a season of several episodes/);
    assert.ok(!text.includes("undefined"), "absent numbers are absent, not printed");
  });

  it("only a picture has a frame: a story thread never hears about aspect", async () => {
    const text = await shaped({ format: "story", medium: "story", kind: "book" });
    assert.ok(!/delivers in/.test(text), "prose does not deliver in 16:9");
    assert.match(text, /one continuous piece/);
  });
});
