import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { WorldBundle } from "@arke-studio/contracts";
import { TURN_RESULT_BOUNDS } from "@arke-studio/contracts";
import { MAX_PROPOSALS } from "../../src/world-chat/wrapup.js";
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

  /**
   * A season longer than a turn can carry says so before the model tries (2026-08-23).
   *
   * The door promises up to a hundred episodes; a turn stages at most twelve candidates. A model
   * that reads "eighty episodes" and writes eighty has the whole turn refused for breaking the
   * bound, after doing all the work — the failure the numbers in this file exist to prevent.
   */
  it("tells a long season to come in runs, and names the run size", async () => {
    const text = await shaped(
      { medium: "video", kind: "microdrama" },
      { episodeCount: 80, episodeSecondsMin: 60, episodeSecondsMax: 90, hookWindowSec: 3 },
    );
    assert.match(text, /season of 80 episodes/);
    // Room for the companions the same briefing permits: a run plus the overview, the season
    // direction and a world fact all have to fit inside one turn's operation cap.
    const run = Number(/runs of at most (\d+) episodes/.exec(text)?.[1]);
    assert.ok(run > 0, "a run size is named");
    assert.ok(
      run + 3 <= TURN_RESULT_BOUNDS.candidateOperations,
      `run of ${run} leaves room for an overview, a season change and a world fact`,
    );
    assert.match(text, /not all 80 at once/);
    // The half that makes the loop terminate rather than pile up against the wrap-up's own cap.
    assert.match(text, new RegExp(`at most ${MAX_PROPOSALS} changes`));
    assert.match(text, /Wrap up each run before starting the next/);
  });

  /**
   * It stops asking once the season is written (codex, 2026-08-23).
   *
   * Gated on the declared count alone, a finished sixty-episode production went on demanding runs
   * of more episodes every turn — including in a conversation opened to change one line of the
   * overview.
   */
  it("says nothing about runs once every promised episode exists", async () => {
    const { bundle } = await scanWorld(FIXTURE_WORLD);
    const production = bundle.productions[0]!;
    const patched: WorldBundle = {
      ...bundle,
      productions: [
        {
          ...production,
          meta: { ...production.meta, medium: "video", kind: "microdrama" },
          season: {
            ...(production.season ?? { version: 1 }),
            defaults: { episodeCount: production.episodes.length, episodeSecondsMin: 60, episodeSecondsMax: 90 },
          },
        } as (typeof bundle.productions)[number],
        ...bundle.productions.slice(1),
      ],
    };
    const text = describeEntryContext({ kind: "production", productionId: production.meta.id }, patched);
    assert.ok(!/runs of at most/.test(text), "a season with nothing left to write asks for nothing");
  });

  /**
   * Only the thread that writes the season hears it (codex, 2026-08-23).
   *
   * `describeShape` briefs the episode and scene threads too, and telling a scene thread to write
   * ten episodes invites proposals nobody asked for while somebody is looking at one scene.
   */
  it("never tells an episode or scene thread to write a run of episodes", async () => {
    const { bundle } = await scanWorld(FIXTURE_WORLD);
    const production = bundle.productions[0]!;
    const patched: WorldBundle = {
      ...bundle,
      productions: [
        {
          ...production,
          meta: { ...production.meta, medium: "video", kind: "microdrama" },
          season: {
            ...(production.season ?? { version: 1 }),
            defaults: { episodeCount: 80, episodeSecondsMin: 60, episodeSecondsMax: 90, hookWindowSec: 3 },
          },
        } as (typeof bundle.productions)[number],
        ...bundle.productions.slice(1),
      ],
    };
    const episodeId = production.episodes[0]?.id;
    if (episodeId) {
      const text = describeEntryContext(
        { kind: "episode", productionId: production.meta.id, episodeId },
        patched,
      );
      assert.match(text, /season of 80 episodes/, "it still hears the shape");
      assert.ok(!/runs of at most/.test(text), "but is not asked to write a run of them");
    }
    const sceneId = production.scenes[0]?.id;
    if (sceneId) {
      const text = describeEntryContext({ kind: "scene", productionId: production.meta.id, sceneId }, patched);
      assert.ok(!/runs of at most/.test(text), "and neither is a scene thread");
    }
  });

  it("says nothing about runs when the whole season fits in one turn", async () => {
    const text = await shaped(
      { medium: "video", kind: "microdrama" },
      { episodeCount: 8, episodeSecondsMin: 60, episodeSecondsMax: 90 },
    );
    assert.ok(!/runs of at most/.test(text), "a short sample is written in one go");
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
