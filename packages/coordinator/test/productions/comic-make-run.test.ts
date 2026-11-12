import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comicCardRedraws, comicMakeSpent, runComicMake, type ComicMakeOps } from "../../src/productions/comic-make-run.js";

/** A book of plain pages: each panel at $1, and the first `faultsFor` takes of a panel at fault. */
function book(pages: Record<string, string[]>, faultsFor: (panel: string) => number = () => 0) {
  const takes = new Map<string, number>();
  const accepted = new Set<string>();
  const log: string[] = [];
  const settle = (panel: string) => {
    takes.set(panel, (takes.get(panel) ?? 0) + 1);
    if (takes.get(panel)! > faultsFor(panel)) accepted.add(panel);
  };
  const ops: ComicMakeOps = {
    unmade: (page) => pages[page]!.filter((panel) => !takes.has(panel)),
    faulted: (page) => pages[page]!.filter((panel) => takes.has(panel) && !accepted.has(panel)),
    allAccepted: (page) => pages[page]!.every((panel) => accepted.has(panel)),
    price: (_page, panels) => panels.length,
    spent: () => [...takes.values()].reduce((sum, count) => sum + count, 0),
    make: async (page, confirmed, panel) => {
      log.push(`make ${panel ?? page} under ${confirmed}`);
      for (const one of panel ? [panel] : pages[page]!.filter((entry) => !takes.has(entry))) settle(one);
    },
    reviewed: async () => { log.push("reviewed"); },
    place: async (page) => { log.push(`place ${page}`); },
  };
  return { ops, log, takes, accepted };
}
const go = (control = new AbortController()) => ({ signal: control.signal });

describe("what an approved Make card does (turn 270)", () => {
  it("draws every page's panels and places the words of each page all in", async () => {
    const { ops, log } = book({ a: ["a1", "a2"], b: ["b1"] });
    assert.equal(await runComicMake({ pages: ["a", "b"], redraws: 2, ceilingMicroUsd: 5, ...go() }, ops), "finished");
    assert.deepEqual(log.filter((line) => line.startsWith("place")), ["place a", "place b"]);
  });

  it("redraws a fault, and places once it clears", async () => {
    const { ops, log, takes } = book({ a: ["a1"] }, () => 1);
    await runComicMake({ pages: ["a"], redraws: 2, ceilingMicroUsd: 5, ...go() }, ops);
    assert.equal(takes.get("a1"), 2);
    assert.ok(log.includes("place a"));
  });

  it("gives one panel two redraws at most, so a stubborn one cannot take the card's limit", async () => {
    const { ops, takes, log } = book({ a: ["a1", "a2"] }, (panel) => panel === "a1" ? 9 : 1);
    await runComicMake({ pages: ["a"], redraws: 6, ceilingMicroUsd: 50, ...go() }, ops);
    assert.equal(takes.get("a1"), 3);
    assert.equal(takes.get("a2"), 2);
    assert.ok(!log.includes("place a"), "a panel still at fault is the author's; no words are placed");
  });

  it("stops at the card's redraw limit", async () => {
    const { ops, takes } = book({ a: ["a1", "a2"] }, () => 9);
    await runComicMake({ pages: ["a"], redraws: 1, ceilingMicroUsd: 50, ...go() }, ops);
    assert.equal(takes.get("a1"), 2);
    assert.equal(takes.get("a2"), 1);
  });

  it("never spends past the price approved, and says so", async () => {
    const { ops, takes } = book({ a: ["a1", "a2"], b: ["b1"] });
    assert.equal(await runComicMake({ pages: ["a", "b"], redraws: 0, ceilingMicroUsd: 2, ...go() }, ops), "limit");
    assert.equal(takes.has("b1"), false);
  });

  it("gives each draw only what is left of the price", async () => {
    const { ops, log } = book({ a: ["a1"], b: ["b1"] });
    await runComicMake({ pages: ["a", "b"], redraws: 0, ceilingMicroUsd: 3, ...go() }, ops);
    assert.deepEqual(log.filter((line) => line.startsWith("make")), ["make a under 3", "make b under 2"]);
  });

  it("starts nothing new once stopped", async () => {
    const control = new AbortController();
    const { ops, takes } = book({ a: ["a1"], b: ["b1"] });
    const make = ops.make;
    ops.make = async (...args) => { await make(...args); control.abort(); };
    assert.equal(await runComicMake({ pages: ["a", "b"], redraws: 2, ceilingMicroUsd: 5, signal: control.signal }, ops), "stopped");
    assert.equal(takes.has("b1"), false);
  });

  it("draws one panel again once, with no redraw and no placing", async () => {
    const { ops, log, takes } = book({ a: ["a1", "a2"] }, () => 9);
    assert.equal(await runComicMake({ pages: ["a"], panel: "a1", redraws: 0, ceilingMicroUsd: 1, ...go() }, ops), "finished");
    assert.equal(takes.get("a1"), 1);
    assert.equal(takes.has("a2"), false);
    assert.ok(!log.some((line) => line.startsWith("place")));
  });

  it("counts a picture still out against the price until it lands", () => {
    assert.equal(comicMakeSpent(300, 100, 2, 50), 300);
    assert.equal(comicMakeSpent(100, 100, 0, 50), 0);
  });

  it("limits redraws to about every second panel and six at most", () => {
    assert.equal(comicCardRedraws(3), 2);
    assert.equal(comicCardRedraws(13), 6);
    assert.equal(comicCardRedraws(40), 6);
  });
});
