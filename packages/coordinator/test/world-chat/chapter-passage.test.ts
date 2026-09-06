import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { newId, type ConversationId } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { overviewSteer, proseStyleSteer } from "../../src/productions/ops.js";
import { foldedOccurrences, replacePassage, stageWorldChatProductionAuthoredAction } from "../../src/world-chat/production-authoring.js";
import { storyFence } from "../../src/world-chat/target-reads.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * The craft loop (design turn 128, issue 896): a revision is a passage, never a chapter, and the
 * style the book is written in is a record of its own that every draft and revision reads.
 */

const PRODUCTION = "the-ledger-of-nights";
const CHAPTER = "productions/the-ledger-of-nights/chapters/01-neap.md";
const NOW = () => "2026-09-06T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: NOW });
  closeOnCleanup(() => store.close());
  return { dir, store, gate: new ProposalManager(store), intent: { actionId: newId("act"), conversationId: newId("cv") as ConversationId } };
}

function passageAction(find: string, replacement: string) {
  return {
    kind: "world-chat-production-chapter" as const,
    worldId: "",
    action: {
      kind: "production-chapter" as const,
      productionId: PRODUCTION,
      change: { operation: "edit" as const, chapterId: "neap", changes: { passage: { find, with: replacement } } },
      checkReceiptIds: [],
    },
  };
}

describe("a revision is a passage, never a chapter (turn 128)", () => {
  it("replaces the one span it names and leaves the rest of the chapter as it was", async () => {
    const { dir, store, gate, intent } = await open();
    const live = MarkdownFile.parse(await readFile(join(dir, ...CHAPTER.split("/")), "utf8"));
    // Quoted as the file holds it: the fixture wraps its lines, so a passage is quoted within one.
    const find = "kept in a hand that changes every generation";
    assert.ok(live.body.includes(find), "the fixture holds the passage");
    const proposal = await stageWorldChatProductionAuthoredAction(store, gate, intent, {
      ...passageAction(find, "kept in a hand that changes each generation"),
      worldId: store.worldId,
    });
    assert.equal(proposal.kind, "chapter-draft");
    assert.match(proposal.summary, /^Revise a passage/);
    const staged = MarkdownFile.parse(await readFile(join(dir, ".proposals", proposal.id, ...CHAPTER.split("/")), "utf8"));
    assert.equal(staged.body, live.body.replace(find, "kept in a hand that changes each generation"), "one span changed, nothing else");
    assert.equal(staged.data["words"], staged.body.trim().split(/\s+/).length, "the words are restamped");
    assert.equal(staged.data["draftedAgainst"], live.data["draftedAgainst"], "a revision is not a draft: the overview stamp is untouched");
    // The review draws the span from before and proposed, so both are there for the screen.
    const review = (await scanWorld(dir)).bundle.proposals.find((item) => item.proposal.id === proposal.id)?.review;
    const prose = review?.targets[0]?.fields.find((field) => field.field === "Prose");
    assert.ok(prose?.before?.includes(find));
    assert.ok(prose?.proposed?.includes("changes each generation"));
  });

  it("refuses by name a passage that is not there, and one that is there twice", async () => {
    const { store, gate, intent } = await open();
    await assert.rejects(
      () => stageWorldChatProductionAuthoredAction(store, gate, intent, { ...passageAction("Nobody wrote this sentence.", "x"), worldId: store.worldId }),
      /that passage is not in chapter 01 as it stands/,
    );
    await assert.rejects(
      () => stageWorldChatProductionAuthoredAction(store, gate, intent, { ...passageAction("Maren", "Ines"), worldId: store.worldId }),
      /that passage occurs 2 times in chapter 01 · quote more of it/,
    );
    assert.equal(replacePassage("a b c", { find: "b", with: "B" }, "chapter 01"), "a B c");
    assert.equal(replacePassage("a b c", { find: "b", with: "" }, "chapter 01"), "a  c", "an empty replacement removes the passage");
  });

  it("an ask that named its paragraph is looked for there and only there (codex on turn 128)", async () => {
    const { store, gate, intent } = await open();
    // "Maren" is in two paragraphs of the fixture; the paragraph decides which one, and current
    // uniqueness never does.
    const anchored = (paragraph: number) => stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-chapter",
      worldId: store.worldId,
      action: {
        kind: "production-chapter",
        productionId: PRODUCTION,
        change: { operation: "edit", chapterId: "neap", changes: { passage: { find: "Maren", with: "Ines", paragraph } } },
        checkReceiptIds: [],
      },
    });
    const body = "The ledger of the Vigil is kept in a hand.\n\nMaren has the 1820 volume open.\n\nMaren is not reading it.";
    assert.equal(replacePassage(body, { find: "Maren", with: "Ines", paragraph: 3 }, "chapter 01"), body.replace("Maren is not", "Ines is not"), "the third paragraph's occurrence, not the second's");
    assert.throws(() => replacePassage(body, { find: "Maren", with: "Ines", paragraph: 1 }, "chapter 01"), /that passage is not in paragraph 1 of chapter 01 as it stands/);
    assert.throws(() => replacePassage(body, { find: "Maren", with: "Ines", paragraph: 9 }, "chapter 01"), /not in paragraph 9 of chapter 01/, "a paragraph the chapter no longer has");
    // Still exactly once inside the paragraph (codex, round two): a twin is never the one selected.
    const twins = "Maren looked at Maren in the glass.\n\nThe tide came.";
    assert.throws(() => replacePassage(twins, { find: "Maren", with: "Ines", paragraph: 1 }, "chapter 01"), /occurs more than once in paragraph 1 of chapter 01 · quote more of it/);
    assert.equal(replacePassage(twins, { find: "at Maren", with: "at Ines", paragraph: 1 }, "chapter 01"), "Maren looked at Ines in the glass.\n\nThe tide came.");
    const proposal = await anchored(2);
    assert.match(proposal.summary, /^Revise a passage/);
    assert.equal(proposal.origin?.gesture, "passage-revision", "the origin says a passage was revised, so the screen draws one only then");
    await assert.rejects(() => anchored(1), /not in paragraph 1 of chapter 01 as it stands · read the chapter again/);
  });

  it("finds a quote across a wrapped line, with whitespace folded (codex, round three)", () => {
    const body = "The ledger of the Vigil is kept in a hand that changes every\ngeneration and a form that never has.\n\nMaren checks it.";
    assert.deepEqual(foldedOccurrences(body, "changes every generation"), [{ start: 47, end: 71 }]);
    assert.equal(
      replacePassage(body, { find: "changes every generation", with: "changes each generation", paragraph: 1 }, "chapter 01"),
      "The ledger of the Vigil is kept in a hand that changes each generation and a form that never has.\n\nMaren checks it.",
      "the file's own wrap is inside the span replaced",
    );
    assert.deepEqual(foldedOccurrences("a  b a b", "a b"), [{ start: 0, end: 4 }, { start: 5, end: 8 }], "each occurrence, in file offsets");
    assert.deepEqual(foldedOccurrences("a b", "   "), [], "nothing is not a passage");
    // Emphasis markers fold too when the words do not match otherwise (codex, round four): the
    // editor showed `bold`, or wrote `**bold**` where the file holds `__bold__`.
    assert.deepEqual(foldedOccurrences("She was __not__ wrong.", "not wrong"), [{ start: 8, end: 21 }], "the file's own markers are inside the span");
    assert.deepEqual(foldedOccurrences("She was __not__ wrong.", "**not** wrong"), [{ start: 8, end: 21 }]);
    assert.deepEqual(foldedOccurrences("She was not wrong.", "not wrong"), [{ start: 8, end: 17 }], "plain words match plainly first");
    // An underscore inside a word is the word's, not a marker (codex on PR 903, round three): a
    // quote of the word never matches prose the author has since joined up.
    assert.deepEqual(foldedOccurrences("call foo_bar now", "foobar"), [], "foo_bar is one word");
    assert.deepEqual(foldedOccurrences("call foo_bar now", "foo_bar"), [{ start: 5, end: 12 }]);
    assert.deepEqual(foldedOccurrences("She was _not_ wrong.", "not wrong"), [{ start: 8, end: 19 }], "a single underscore at a word's edge is emphasis");
    // Plain and emphasised copies are two occurrences whichever way the quote was spelled (codex
    // on PR 903, round four): uniqueness sees both, so a revision never lands on the wrong copy.
    assert.deepEqual(foldedOccurrences("not wrong, then __not__ wrong", "not wrong"), [{ start: 0, end: 9 }, { start: 16, end: 29 }]);
    assert.deepEqual(foldedOccurrences("not wrong, then __not__ wrong", "**not** wrong"), [{ start: 0, end: 9 }, { start: 16, end: 29 }]);
  });

  it("a style written by hand into a world below its boundary is adopted and the boundary raised on open (codex, round five)", async () => {
    const dir = await makeTempWorld();
    const path = join(dir, "productions", PRODUCTION, "prose-style.json");
    await writeFile(path, `${JSON.stringify({ version: 1, pov: "close third", voice: "Short declaratives." }, null, 2)}\n`, "utf8");
    const store = await WorldStore.open(dir, { clock: NOW });
    closeOnCleanup(() => store.close());
    const bundle = store.getBundle();
    assert.equal(bundle.meta.schemaVersion, 10, "opened, the world is fenced at the style's boundary");
    const production = bundle.productions.find((p) => p.meta.id === PRODUCTION)!;
    assert.equal(production.proseStyle?.pov, "close third", "and the record is the author's, adopted");
    assert.ok((production.proseStyle?.version ?? 0) >= 1);
  });

  it("a style in a world that opened with an edit waiting is adopted the moment the edit clears, even by being put back (codex on PR 903, round three)", async () => {
    const dir = await makeTempWorld();
    const sheet = join(dir, "characters", "bray-half-hitch.md");
    const committed = await readFile(sheet, "utf8");
    // A world a build between the style and its boundary left behind: the scan state knows the
    // style's bytes, and world.json still says 9. Made by adopting the style once, then putting
    // the version back by hand and telling the scan state so, so the only edit waiting is the
    // sheet's.
    await writeFile(join(dir, "productions", PRODUCTION, "prose-style.json"), `${JSON.stringify({ version: 1, pov: "close third" }, null, 2)}\n`, "utf8");
    const first = await WorldStore.open(dir, { clock: NOW });
    assert.equal(first.getBundle().meta.schemaVersion, 10);
    await first.close();
    const worldPath = join(dir, "world.json");
    const world = JSON.parse(await readFile(worldPath, "utf8")) as Record<string, unknown>;
    const belowRaw = `${JSON.stringify({ ...world, schemaVersion: 9 }, null, 2)}\n`;
    await writeFile(worldPath, belowRaw, "utf8");
    const statePath = join(dir, ".index", "scan-state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as { manifest: Record<string, string> };
    state.manifest["world.json"] = sha256(belowRaw);
    await writeFile(statePath, JSON.stringify(state), "utf8");
    await writeFile(sheet, `${committed}\nEdited outside.\n`, "utf8");

    const store = await WorldStore.open(dir, { clock: NOW });
    closeOnCleanup(() => store.close());
    assert.deepEqual(store.getBundle().externalEdits.map((edit) => edit.path), ["characters/bray-half-hitch.md"], "the sheet's edit waits");
    assert.equal(store.getBundle().meta.schemaVersion, 9, "and adoption waited with it");
    // Put back, not committed: the branch that clears the edit without a commit.
    await writeFile(sheet, committed, "utf8");
    await store.reconcileExternalEdit("characters/bray-half-hitch.md");
    assert.equal(store.getBundle().externalEdits.length, 0);
    assert.equal(store.getBundle().meta.schemaVersion, 10, "cleared is cleared, however it cleared, and cleared is adopted");
  });

  it("a world is fenced at a boundary on request, once, and only upward (codex on PR 903, round three)", async () => {
    const { store } = await open();
    const before = store.getBundle().meta.schemaVersion;
    assert.ok(before < 10, "the fixture is below the style's boundary");
    await store.raiseSchemaBoundary(10, "world-chat-constraints");
    assert.equal(store.getBundle().meta.schemaVersion, 10);
    const change = store.getBundle().changes.findLast((line) => line.entity === "world");
    assert.deepEqual(change?.fieldsChanged, ["schemaVersion"], "the crossing is in the audit trail");
    await store.raiseSchemaBoundary(9, "world-chat-constraints");
    assert.equal(store.getBundle().meta.schemaVersion, 10, "a lower request is left alone");
  });
});

describe("the style the book is written in (turn 128)", () => {
  it("is staged in its own file, versioned by the committer, and restorable", async () => {
    const { dir, store, gate, intent } = await open();
    const stage = (changes: Record<string, unknown>) => stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-prose-style",
      worldId: store.worldId,
      action: { kind: "production-prose-style", productionId: PRODUCTION, changes, checkReceiptIds: [] },
    });
    const first = await stage({ pov: "close third", tense: "past", voice: "Short declaratives." });
    assert.equal(first.kind, "prose-style");
    assert.equal((await gate.accept(first.id)).status, "accepted");
    let production = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!;
    assert.deepEqual(production.proseStyle, { version: 1, pov: "close third", tense: "past", voice: "Short declaratives." });
    assert.equal(production.story?.version, 6, "the overview's version does not move with the style");
    assert.equal(store.getBundle().meta.schemaVersion, 10, "the style is its own schema boundary, so a build older than it refuses the world by name");

    const second = await stage({ samples: ["Six, and the tide not yet called."], tense: null });
    assert.equal((await gate.accept(second.id)).status, "accepted");
    production = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!;
    assert.deepEqual(production.proseStyle, { version: 2, pov: "close third", voice: "Short declaratives.", samples: ["Six, and the tide not yet called."] });
    const history = await readFile(join(dir, ".history", "productions", PRODUCTION, "prose-style", "v1.json"), "utf8");
    assert.equal(JSON.parse(history).tense, "past", "the earlier version is kept beside the overview's history");

    // The review says each piece a change would settle.
    const third = await stage({ voice: "Weather and stone before feeling." });
    const review = (await scanWorld(dir)).bundle.proposals.find((item) => item.proposal.id === third.id)?.review;
    assert.equal(review?.targets[0]?.kind, "prose style");
    assert.deepEqual(review?.targets[0]?.fields.map((field) => field.field), ["Voice"]);
  });

  it("moves the story read's fence when it is settled, and steers every draft", async () => {
    const { store, gate, intent } = await open();
    const before = storyFence(store.getBundle().productions.find((p) => p.meta.id === PRODUCTION));
    assert.match(before, /^v6\+absent:/, "the fence names the overview's version and the style's absence");
    const proposal = await stageWorldChatProductionAuthoredAction(store, gate, intent, {
      kind: "world-chat-production-prose-style",
      worldId: store.worldId,
      action: { kind: "production-prose-style", productionId: PRODUCTION, changes: { pov: "close third", voice: "Short declaratives." }, checkReceiptIds: [] },
    });
    assert.equal((await gate.accept(proposal.id)).status, "accepted");
    const production = store.getBundle().productions.find((p) => p.meta.id === PRODUCTION)!;
    const after = storyFence(production);
    assert.match(after, /^v6\+v1:/);
    assert.notEqual(after, before, "a draft asked for against an older read reads again");

    const steer = overviewSteer(production.story, production.proseStyle);
    assert.match(steer, /The accepted story overview \(v6\) steers this draft/);
    assert.match(steer, /The prose style \(v1\) is how this book is written/);
    assert.match(steer, /- point of view: close third\n- voice: Short declaratives\./);
    assert.equal(proseStyleSteer(null), "");
    assert.equal(overviewSteer(null, null), "");
  });
});
