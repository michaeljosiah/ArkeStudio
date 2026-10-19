import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClientMessageSchema } from "@arke-studio/contracts";
import { MarkdownFile } from "../../src/world/text-files.js";
import { createChapter, createProduction, editChapterPlan, openChapter, readChapterVersion, reorderChapters, restoreChapter, saveChapter, setChapterRetired } from "../../src/productions/ops.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Chapter order end to end (issue 399): the schema, the writer, the scanner, and the summary
 * must agree on one order authority. These tests go through the scanned bundle rather than raw
 * frontmatter, because the raw files were fine all along — it was the read path that dropped
 * them.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store };
}

async function chaptersOf(dir: string, productionId: string) {
  const { bundle } = await scanWorld(dir);
  const production = bundle.productions.find((p) => p.meta.id === productionId);
  assert.ok(production, `production ${productionId} is in the bundle`);
  return production.chapters;
}

describe("chapter order through the scanned bundle (issue 399)", () => {
  it("a created chapter appears in the bundle and survives rescan", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    await createChapter(store, "inkbound", { title: "The neap ledger", order: 1 });
    await createChapter(store, "inkbound", { title: "What the water left", order: 2 });

    for (let pass = 0; pass < 2; pass++) {
      const chapters = await chaptersOf(dir, "inkbound");
      assert.equal(chapters.length, 2, `both chapters present on scan ${pass + 1}`);
      assert.deepEqual(
        chapters.map((c) => ({ id: c.id, file: c.file, order: c.order, status: c.status, version: c.version })),
        [
          { id: "the-neap-ledger", file: "the-neap-ledger", order: 1, status: "planned", version: 1 },
          { id: "what-the-water-left", file: "what-the-water-left", order: 2, status: "planned", version: 1 },
        ],
      );
    }
  });

  it("reordering changes bundle order only: no rename, no version cut, no history move", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    for (const [i, title] of ["First", "Second", "Third"].entries()) {
      await createChapter(store, "inkbound", { title, order: i + 1 });
    }
    const chapterDir = join(dir, "productions", "inkbound", "chapters");
    const namesBefore = (await readdir(chapterDir)).sort();

    await reorderChapters(store, "inkbound", ["third", "first", "second"]);

    assert.deepEqual((await readdir(chapterDir)).sort(), namesBefore, "no file renamed (R-4, D3)");
    const chapters = await chaptersOf(dir, "inkbound");
    assert.deepEqual(
      chapters.map((c) => ({ file: c.file, order: c.order, version: c.version })),
      [
        { file: "third", order: 1, version: 1 },
        { file: "first", order: 2, version: 1 },
        { file: "second", order: 3, version: 1 },
      ],
      "bundle order follows the explicit field, not the filename",
    );
  });

  it("legacy number-shaped chapters read, render, and reorder without vanishing", async () => {
    const { dir, store } = await open();
    const before = await chaptersOf(dir, "the-ledger-of-nights");
    assert.deepEqual(
      before.map((c) => ({ id: c.id, file: c.file, order: c.order })),
      [
        { id: "neap", file: "01-neap", order: 1 },
        { id: "the-same-ink", file: "02-the-same-ink", order: 2 },
        { id: "nothing-wrong-with-it", file: "03-nothing-wrong-with-it", order: 3 },
        { id: "her-own-hand", file: "04-her-own-hand", order: 4 },
      ],
      "the shipped `number` shape reads as order, and the summary carries the stem",
    );
    assert.equal(before[0]?.status, "drafted", "authored status survives");
    assert.equal(before[0]?.words, 291, "summary measures saved prose rather than the declared 3,120");

    // The regression this issue exists for: writing `order` into a shipped chapter must not
    // make it fail the read schema and disappear from the bundle.
    await reorderChapters(store, "the-ledger-of-nights", [
      "02-the-same-ink",
      "01-neap",
      "04-her-own-hand",
      "03-nothing-wrong-with-it",
    ]);
    const after = await chaptersOf(dir, "the-ledger-of-nights");
    assert.equal(after.length, 4, "all four chapters still present after reorder");
    assert.deepEqual(
      after.map((c) => ({ file: c.file, order: c.order })),
      [
        { file: "02-the-same-ink", order: 1 },
        { file: "01-neap", order: 2 },
        { file: "04-her-own-hand", order: 3 },
        { file: "03-nothing-wrong-with-it", order: 4 },
      ],
      "explicit order wins over both the legacy field and the filename",
    );
    const raw = await readFile(join(dir, "productions", "the-ledger-of-nights", "chapters", "01-neap.md"), "utf8");
    const data = MarkdownFile.parse(raw).data;
    assert.equal(data["number"], 1, "the legacy field is left where it was, not rewritten");
    assert.equal(data["order"], 2, "the authority field is written beside it");
    assert.equal(data["version"], 4, "reorder cuts no version");
    assert.equal(data["words"], 3120, "reading and reordering do not rewrite legacy metadata");
  });

  it("ties and invalid orders fall back to filename order, deterministically", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    const chapterDir = join(dir, "productions", "inkbound", "chapters");
    const author = (id: string, fields: string) =>
      writeFile(join(chapterDir, `${id}.md`), `---\nid: ${id}\n${fields}\ntitle: ${id}\nversion: 1\n---\n\nProse.\n`);
    await createChapter(store, "inkbound", { title: "Anchor", order: 1 });
    await author("tied-b", "order: 5");
    await author("tied-a", "order: 5");
    await author("zero", "order: 0");
    await author("bare", "status: planned");

    const chapters = await chaptersOf(dir, "inkbound");
    assert.deepEqual(
      chapters.map((c) => ({ file: c.file, order: c.order })),
      [
        { file: "anchor", order: 1 },
        { file: "tied-a", order: 2 },
        { file: "tied-b", order: 3 },
        { file: "bare", order: 4 },
        { file: "zero", order: 5 },
      ],
      "ties break by filename; unresolvable orders sort last by filename; the summary is dense",
    );
    assert.equal(chapters.find((c) => c.file === "bare")?.status, "planned", "absent status reads as planned");
  });

  it("the summary's stem addresses the file the commands need", async () => {
    const { dir, store } = await open();
    const [first] = await chaptersOf(dir, "the-ledger-of-nights");
    assert.ok(first, "the fixture production has a first chapter");
    await saveChapter(store, "the-ledger-of-nights", first.file, "Six columns since 1747.");
    const [after] = await chaptersOf(dir, "the-ledger-of-nights");
    assert.ok(after, "the chapter is still first after the save");
    assert.equal(after.words, 4, "a save addressed by the summary's stem lands in the same chapter");
    assert.equal(after.version, first.version, "a direct save cuts no version (R-5)");
  });
});

/**
 * The chapter, opened (design turn 126, issue 874): fetched off disk by id, saved against the
 * base it read, made unique by a press, and put back from history after an accepted draft.
 */
const LEDGER = "the-ledger-of-nights";
const NEAP_PATH = join("productions", LEDGER, "chapters", "01-neap.md");

describe("the chapter workspace's own commands (turn 126)", () => {
  it("opens by id or by file stem and answers body, version and the hash of the bytes read", async () => {
    const { dir, store } = await open();
    const byId = await openChapter(store, LEDGER, "neap");
    const byFile = await openChapter(store, LEDGER, "01-neap");
    assert.equal(byId.file, "01-neap", "the fixture's id and stem differ, and both open it");
    assert.equal(byId.version, 4);
    assert.match(byId.body, /The ledger of the Vigil/);
    assert.match(byId.hash, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(byFile, byId);
    await assert.rejects(() => openChapter(store, LEDGER, "no-such-chapter"), /no longer in this production/);
    await assert.rejects(() => openChapter(store, "no-such-production", "neap"), /no longer in this world/);
    const live = await readFile(join(dir, NEAP_PATH), "utf8");
    assert.match(live, /^id: neap$/m, "opening reads; it writes nothing");
  });

  it("a save names the base it read, and a save against a moved base is refused with nothing written", async () => {
    const { dir, store } = await open();
    const opened = await openChapter(store, LEDGER, "neap");
    const saved = await saveChapter(store, LEDGER, "01-neap", "One paragraph.\n\nTwo.", { baseHash: opened.hash });
    assert.equal(saved.version, 4, "a direct save keeps the version (SPEC-012 R-5)");
    assert.notEqual(saved.hash, opened.hash, "the bytes moved, so the base did");
    assert.equal((await chaptersOf(dir, LEDGER)).find((c) => c.id === "neap")?.words, 3, "the summary's count follows the prose");

    // An editor that read v4 before that save still holds the old base.
    await assert.rejects(() => saveChapter(store, LEDGER, "01-neap", "Overwritten.", { baseHash: opened.hash }));
    const again = await openChapter(store, LEDGER, "neap");
    assert.equal(again.body.trim(), "One paragraph.\n\nTwo.", "the refused save wrote nothing");
    assert.equal(again.hash, saved.hash, "the save's answer is the base the next save must name");
    const next = await saveChapter(store, LEDGER, "01-neap", "One paragraph.\n\nTwo.\n\nThree.", { baseHash: saved.hash });
    assert.equal(next.version, 4);
  });

  it("two Untitled presses make two chapters rather than one refusal", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    const first = await createChapter(store, "inkbound", { title: "Untitled", order: 1 });
    const second = await createChapter(store, "inkbound", { title: "Untitled", order: 2 });
    assert.equal(first, "untitled");
    assert.equal(second, "untitled-2");
    // The frontmatter id is reserved as well as the stem: the fixture's `01-neap.md` is `neap`,
    // and a new `neap.md` would answer to two chapters by id (codex, PR 879).
    assert.equal(await createChapter(store, LEDGER, { title: "Neap", order: 9 }), "neap-2");
    // A stem a staged draft has claimed is taken too, or accepting that draft would find its
    // create refused as stale (codex, PR 879).
    const gate = new ProposalManager(store);
    await gate.stage({
      kind: "chapter-draft",
      summary: "New chapter: Untitled",
      source: "test",
      targets: [{
        path: `productions/${LEDGER}/chapters/untitled.md`,
        content: MarkdownFile.create({ id: "untitled", title: "Untitled", order: 10, status: "planned", version: 1 }, "").serialize(),
      }],
    });
    assert.equal(await createChapter(store, LEDGER, { title: "Untitled", order: 10 }), "untitled-2");
    assert.deepEqual(
      (await chaptersOf(dir, "inkbound")).map((c) => ({ id: c.id, order: c.order })),
      [
        { id: "untitled", order: 1 },
        { id: "untitled-2", order: 2 },
      ],
    );
  });

  it("replaces an outline through a fenced manuscript save without leaving its count at zero", async () => {
    const { dir, store } = await open();
    const file = "04-her-own-hand";
    const before = await openChapter(store, LEDGER, file);
    const unchanged = await saveChapter(store, LEDGER, file, before.body, { baseHash: before.hash });
    let chapter = (await chaptersOf(dir, LEDGER)).find(c => c.file === file)!;
    assert.equal(chapter.status, "outlined");
    assert.equal(chapter.words, 0, "saving the same outline does not call it drafted");
    await assert.rejects(saveChapter(store, LEDGER, file, "A refused draft.", { baseHash: "sha256:" + "0".repeat(64) }));
    const cleared = await saveChapter(store, LEDGER, file, "", { baseHash: unchanged.hash });
    chapter = (await chaptersOf(dir, LEDGER)).find(c => c.file === file)!;
    assert.equal(chapter.status, "outlined", "clearing notes is not a draft");
    await saveChapter(store, LEDGER, file, "Maren closed the ledger.", { baseHash: cleared.hash });
    await store.close();
    const reopened = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => reopened.close());
    chapter = reopened.getBundle().productions.find(p => p.meta.id === LEDGER)!.chapters.find(c => c.file === file)!;
    assert.equal(chapter.status, "drafted");
    assert.equal(chapter.words, 4);
    assert.equal(chapter.version, before.version, "the ordinary save still keeps its version");
    assert.equal((await openChapter(reopened, LEDGER, file)).body.trim(), "Maren closed the ledger.");
  });

  it("the plan saves in place, clears by null, rides on the summary, and keeps the version (turn 127)", async () => {
    const { dir, store } = await open();
    const before = await openChapter(store, LEDGER, "neap");
    await editChapterPlan(store, LEDGER, "01-neap", {
      title: "Neap, corrected",
      synopsis: "The ledger is opened; a correction two centuries old is the same stroke Maren made on Tuesday.",
      pov: "maren-kest",
      when: "Neap · first night",
      implies: [{ kind: "canon", what: "The bells can ring uncalled when the drowned city has a debt to collect." }],
    });
    const planned = (await chaptersOf(dir, LEDGER)).find((c) => c.id === "neap")!;
    assert.equal(planned.title, "Neap, corrected");
    assert.match(planned.synopsis ?? "", /same stroke/);
    assert.equal(planned.pov, "maren-kest");
    assert.equal(planned.when, "Neap · first night");
    assert.equal(planned.implies?.length, 1);
    assert.match(planned.implies?.[0]?.id ?? "", /^if_[0-9a-f]{10}$/, "an implied fact is given an id at the write");
    assert.equal(planned.implies?.[0]?.state, "open");
    assert.equal(planned.version, before.version, "a plan edit cuts no version (SPEC-012 R-5)");
    // Propose writes the state; the id and the words are kept through the edit.
    await editChapterPlan(store, LEDGER, "01-neap", { implies: [{ ...planned.implies![0]!, state: "proposed" }] });
    const proposedFact = (await chaptersOf(dir, LEDGER)).find((c) => c.id === "neap")!.implies![0]!;
    assert.equal(proposedFact.state, "proposed");
    assert.equal(proposedFact.id, planned.implies![0]!.id);
    const after = await openChapter(store, LEDGER, "neap");
    assert.equal(after.body, before.body, "the prose is untouched");

    await editChapterPlan(store, LEDGER, "01-neap", { when: null, implies: null, synopsis: "   " });
    const cleared = (await chaptersOf(dir, LEDGER)).find((c) => c.id === "neap")!;
    assert.equal(cleared.when, undefined);
    assert.equal(cleared.implies, undefined);
    assert.equal(cleared.synopsis, undefined, "a blank clears rather than storing a blank");
    assert.equal(cleared.pov, "maren-kest", "untouched fields stay");

    await assert.rejects(() => editChapterPlan(store, LEDGER, "01-neap", { pov: "the-vigil" }), /not a character/);
  });

  it("a new chapter takes the point of view of the chapter before it (SPEC-056 D-3)", async () => {
    const { dir, store } = await open();
    await editChapterPlan(store, LEDGER, "01-neap", { pov: "maren-kest" });
    const chapters = await chaptersOf(dir, LEDGER);
    const last = [...chapters].filter((c) => !c.retired).sort((a, b) => b.order - a.order)[0]!;
    if (last.id !== "neap") await editChapterPlan(store, LEDGER, last.file, { pov: "maren-kest" });
    const made = await createChapter(store, LEDGER, { title: "Untitled", order: 99 });
    assert.equal((await chaptersOf(dir, LEDGER)).find((c) => c.id === made)!.pov, "maren-kest");
    // A point of view the world no longer holds as a character is not carried.
    await editChapterPlan(store, LEDGER, made + "", { pov: null });
    const again = await createChapter(store, LEDGER, { title: "Untitled", order: 100 });
    assert.equal((await chaptersOf(dir, LEDGER)).find((c) => c.id === again)!.pov, undefined, "nothing before it to carry");
  });

  it("the chapter before a new one is found by the ranks on disk, past a legacy chapter with none (codex on PR 1799)", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await createProduction(first, { title: "Inkbound", format: "story" });
    const anchor = await createChapter(first, "inkbound", { title: "Anchor", order: 10 });
    await editChapterPlan(first, "inkbound", anchor, { pov: "maren-kest" });
    await first.close();
    // No rank: the summaries number it after Anchor, but a new chapter's rank (11) sorts before it.
    await writeFile(join(dir, "productions", "inkbound", "chapters", "bare.md"), "---\nid: bare\ntitle: bare\npov: perrin-tallow\nstatus: planned\nversion: 1\n---\n\nProse.\n");
    const store = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => store.close());
    await store.reconcileExternalEdit("productions/inkbound/chapters/bare.md");
    assert.deepEqual((await chaptersOf(dir, "inkbound")).map((c) => c.file), ["anchor", "bare"]);
    const made = await createChapter(store, "inkbound", { title: "Untitled", order: 3 });
    assert.equal((await chaptersOf(dir, "inkbound")).find((c) => c.id === made)!.pov, "maren-kest", "Anchor's, the ranked chapter it follows");
  });

  it("a chapter's goal and picture save with the plan, ride on the summary and keep the version (SPEC-056 R-49/R-50)", async () => {
    const { dir, store } = await open();
    const before = await openChapter(store, LEDGER, "neap");
    await editChapterPlan(store, LEDGER, "01-neap", { goal: 4500, picture: "world-art.png" });
    const set = (await chaptersOf(dir, LEDGER)).find((c) => c.id === "neap")!;
    assert.equal(set.goal, 4500);
    assert.equal(set.picture, "world-art.png");
    assert.equal(set.version, before.version, "a goal or a picture cuts no version");

    // A picture must be an image the world holds now, never a path out of it.
    await assert.rejects(() => editChapterPlan(store, LEDGER, "01-neap", { picture: "missing.png" }), /not in this world/);
    await assert.rejects(() => editChapterPlan(store, LEDGER, "01-neap", { picture: "../outside.png" }), /not a picture/);
    await assert.rejects(() => editChapterPlan(store, LEDGER, "01-neap", { picture: "changes.jsonl" }), /not a picture/);
    // Only what the world's media route serves: an AVIF would be saved and never load (codex on PR 1795).
    await assert.rejects(() => editChapterPlan(store, LEDGER, "01-neap", { picture: "world-art.avif" }), /not a picture/);
    assert.equal((await chaptersOf(dir, LEDGER)).find((c) => c.id === "neap")!.picture, "world-art.png", "a refused picture writes nothing");

    await editChapterPlan(store, LEDGER, "01-neap", { goal: null, picture: null });
    const cleared = (await chaptersOf(dir, LEDGER)).find((c) => c.id === "neap")!;
    assert.equal(cleared.goal, undefined);
    assert.equal(cleared.picture, undefined);
  });

  it("a pressed chapter lands after the highest persisted rank, not after the dense count (codex, PR 879)", async () => {
    const { dir, store } = await open();
    await createProduction(store, { title: "Inkbound", format: "story" });
    // Legacy-ranked chapters, written through the committer: a file written by hand under an
    // open store is an outside edit the world refuses to write over until it is reconciled.
    for (const [file, number] of [["ten", 10], ["twenty", 20]] as const) {
      const doc = MarkdownFile.create({ id: file, number, title: file, status: "drafted", version: 1 }, "Words.");
      await store.commit({
        kind: "chapter-create",
        source: "test",
        files: [{ path: `productions/inkbound/chapters/${file}.md`, action: "create", content: doc.serialize(), baseHash: null }],
      });
    }
    // The dense count says 3; the files say 20.
    await createChapter(store, "inkbound", { title: "Untitled", order: 3 });
    const chapters = await chaptersOf(dir, "inkbound");
    assert.deepEqual(chapters.map((c) => c.id), ["ten", "twenty", "untitled"], "the new chapter is last");
    const raw = await readFile(join(dir, "productions", "inkbound", "chapters", "untitled.md"), "utf8");
    assert.match(raw, /^order: 21$/m);
  });

  it("an accepted draft cuts a version, and Earlier versions puts the one before it back as a new one", async () => {
    const { dir, store } = await open();
    const gate = new ProposalManager(store);
    const before = await openChapter(store, LEDGER, "neap");
    assert.deepEqual(before.versions, [], "an imported v4 with no history offers nothing to put back");
    const doc = MarkdownFile.parse(await readFile(join(dir, NEAP_PATH), "utf8"));
    doc.setBody("Drafted anew, from the seventh bell.");
    const proposal = await gate.stage({
      kind: "chapter-draft",
      summary: "Draft the rest",
      source: "test",
      targets: [{ path: NEAP_PATH.split("\\").join("/"), content: doc.serialize() }],
    });
    const outcome = await gate.accept(proposal.id);
    assert.notEqual(outcome.status, "invalid");
    const drafted = await openChapter(store, LEDGER, "neap");
    assert.equal(drafted.version, 5, "an accepted draft cuts a version (SPEC-012 R-5)");
    assert.match(drafted.body, /Drafted anew/);
    assert.deepEqual(drafted.versions, [4], "the version the accept moved off is the one that can come back");

    const restored = await restoreChapter(store, LEDGER, "01-neap", 4);
    assert.equal(restored, 6, "restoring makes a new version; nothing between is lost");
    const back = await openChapter(store, LEDGER, "neap");
    assert.equal(back.version, 6);
    assert.equal(back.body.trim(), before.body.trim());
    assert.deepEqual(back.versions, [4, 5], "nothing between is lost");

    // Compare reads a kept version's prose without the front matter (SPEC-056 R-13).
    assert.equal((await readChapterVersion(store, LEDGER, "01-neap", 4)).trim(), before.body.trim());
    assert.match(await readChapterVersion(store, LEDGER, "01-neap", 5), /Drafted anew/);
    await assert.rejects(() => readChapterVersion(store, LEDGER, "01-neap", 99), /not kept/, "a version never written");
    await assert.rejects(() => readChapterVersion(store, LEDGER, "../01-neap", 4), /no longer in this production/, "only the production's own chapters");
  });
});


describe("chapter retirement (issue 888)", () => {
  it("keeps prose, version and history, projects retirement, restores, and refuses foreign files", async () => {
    const { dir, store } = await open();
    const productionId = "the-ledger-of-nights";
    const file = "01-neap";
    const before = await openChapter(store, productionId, "neap");
    await setChapterRetired(store, productionId, file, true);
    assert.equal((await chaptersOf(dir, productionId))[0]?.retired, true);
    const after = await openChapter(store, productionId, "neap");
    assert.equal(after.body, before.body);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.versions, before.versions);
    assert.equal(store.getBundle().meta.schemaVersion, 15);
    await assert.rejects(setChapterRetired(store, productionId, "../story", true), /no longer/);
    await assert.rejects(reorderChapters(store, productionId, [file, file]), /list changed/);
    await setChapterRetired(store, productionId, file, false);
    assert.equal((await chaptersOf(dir, productionId))[0]?.retired, undefined);
    assert.equal((await openChapter(store, productionId, "neap")).body, before.body);
  });
});


it("commits daily progress with successful saves, without counting refused or unchanged saves (issue 891)", async () => {
  const { dir, store } = await open();
  await createProduction(store, { title: "Inkbound", format: "story" });
  await createChapter(store, "inkbound", { title: "First", order: 1 });
  await createChapter(store, "inkbound", { title: "Second", order: 2 });
  const before = await openChapter(store, "inkbound", "first");
  await Promise.all([
    saveChapter(store, "inkbound", "first", "One two three four", { baseHash: before.hash }),
    saveChapter(store, "inkbound", "second", "Five six seven"),
  ]);
  const path = join(dir, "productions", "inkbound", "progress.json");
  const progress = await readFile(path, "utf8");
  assert.equal(Object.values(JSON.parse(progress).days)[0], 7);
  await assert.rejects(saveChapter(store, "inkbound", "first", "One two three four five six", { baseHash: before.hash }));
  assert.equal(await readFile(path, "utf8"), progress, "a stale save cannot increase progress");
  await saveChapter(store, "inkbound", "first", "One two three four");
  await saveChapter(store, "inkbound", "second", "Five");
  assert.equal(await readFile(path, "utf8"), progress, "unchanged saves and deletions add nothing");
  const scanned = (await scanWorld(dir)).bundle.productions.find((p) => p.meta.id === "inkbound")!;
  assert.deepEqual(scanned.progress, JSON.parse(progress), "the dashboard reads the persisted record");
  await writeFile(path, "damaged", "utf8");
  await assert.rejects(saveChapter(store, "inkbound", "first", "One two three four five"));
  assert.equal((await openChapter(store, "inkbound", "first")).body.trim(), "One two three four");
});


it("raises the retirement boundary when an external chapter edit is adopted", async () => {
  for (const retired of [true, false]) {
    const { dir, store } = await open();
    const path = "productions/the-ledger-of-nights/chapters/01-neap.md";
    assert.ok(store.getBundle().meta.schemaVersion < 15);
    await store.close();
    const doc = MarkdownFile.parse(await readFile(join(dir, path), "utf8"));
    doc.setData({ retired });
    await writeFile(join(dir, path), doc.serialize(), "utf8");
    const reopened = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => reopened.close());
    await reopened.reconcileExternalEdit(path);
    assert.equal(reopened.getBundle().meta.schemaVersion, 15);
    assert.equal(JSON.parse(await readFile(join(dir, "world.json"), "utf8")).schemaVersion, 15);
    assert.equal((await chaptersOf(dir, "the-ledger-of-nights"))[0]!.retired, retired);
  }
});

it("retires and restores a scanned non-slug filename through the chapter wire contract", async () => {
  const dir = await makeTempWorld();
  const productionId = "the-ledger-of-nights";
  const chapterFile = "My Chapter_One";
  const doc = MarkdownFile.parse(await readFile(join(dir, "productions", productionId, "chapters", "01-neap.md"), "utf8"));
  doc.setData({ id: "portable-one", title: "Portable one" });
  await writeFile(join(dir, "productions", productionId, "chapters", `${chapterFile}.md`), doc.serialize(), "utf8");
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  for (const kind of ["retire-chapter", "restore-chapter-retired"] as const) {
    const message = ClientMessageSchema.parse({ kind, worldId: store.worldId, productionId, chapterFile });
    assert.ok(message.kind === "retire-chapter" || message.kind === "restore-chapter-retired");
    await setChapterRetired(store, message.productionId, message.chapterFile, message.kind === "retire-chapter");
    const chapter = (await chaptersOf(dir, productionId)).find((c) => c.file === chapterFile)!;
    assert.ok(chapter);
    assert.equal(chapter.retired === true, kind === "retire-chapter");
    assert.equal((await openChapter(store, productionId, chapterFile)).body, doc.body);
  }
  const foreign = ClientMessageSchema.parse({ kind: "retire-chapter", worldId: store.worldId, productionId, chapterFile: "../story" });
  assert.ok(foreign.kind === "retire-chapter");
  await assert.rejects(setChapterRetired(store, foreign.productionId, foreign.chapterFile, true), /no longer/);
});
