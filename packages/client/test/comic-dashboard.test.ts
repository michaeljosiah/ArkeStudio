import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ProductionBundle } from "@arke-studio/contracts";
import { chapterStages, nextStep } from "../src/screens/comic-dashboard.js";

/** A graphic novel's home (design turn 256e): each chapter's stage in a word, and the one next step. */
const page = (id: string) => ({ id, layout: "splash", status: "draft" as const, panels: [{ id: `${id}p`, description: "x", characters: [], lettering: [] }] });
const PLAN = { passages: [{ where: "¶ 1", what: "x", verdict: "keep" as const, why: "y" }], pages: [{ change: "a", turn: "b" }, { change: "c", turn: "d" }], knows: [], leans: [], mysteries: [] };
const production = {
  meta: { id: "drawn" },
  chapters: [{ id: "c1", order: 1, title: "The tide" }, { id: "c2", order: 2, title: "Salt" }, { id: "c3", order: 3, title: "The bell" }, { id: "c4", order: 4, title: "Low water" }],
  comic: undefined,
  comicScripts: [
    { chapter: "c1", hash: "h1", script: { version: 1, pages: [page("01J00000000000000000000P01")] } },
    { chapter: "c3", hash: "h3", script: { version: 1, pages: [], plan: PLAN } },
  ],
  comicPages: [{ page: "01J00000000000000000000P01", record: { version: 1, takes: [{ id: "01J00000000000000000000T01", artifact: "ar_x", hash: "x", mode: "baked", model: "m", language: "en", at: "2026-11-01T00:00:00.000Z" }], accepted: { en: "01J00000000000000000000T01" }, lettering: {}, acknowledged: {}, making: [] } }],
} as unknown as ProductionBundle;
const world = { proposals: [{ proposal: { id: "pr_1" }, comicScripts: { "productions/drawn/comic/c2.json": { version: 1, pages: [page("01J00000000000000000000P02")] } } }] } as never;

describe("a graphic novel's home (turn 256e)", () => {
  it("says each chapter's stage in a word", () => {
    assert.deepEqual(chapterStages(world, production).map((chapter) => [chapter.title, chapter.stage, chapter.pages]),
      [["The tide", "made", 1], ["Salt", "draft", 1], ["The bell", "kept", 2], ["Low water", "none", 0]]);
  });

  it("puts a waiting decision first, then the first chapter not done", () => {
    assert.match(nextStep(chapterStages(world, production))!.says, /keep or discard Arke’s draft of 2 · Salt/);
    const none = chapterStages({ proposals: [] } as never, production);
    assert.match(nextStep(none)!.says, /plan 2 · Salt with Arke/);
  });
});
