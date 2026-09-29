import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Prop } from "@arke-studio/contracts";
import { acceptPropStateReference, createProp } from "../../src/references/props.js";
import { WorldStore } from "../../src/world/store.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { createSheetFromSentence } from "../../src/sheets/authoring.js";
import { planIdentities } from "../../src/world-chat/materialise.js";
import type { WorldChangeCandidate } from "@arke-studio/contracts";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { MarkdownFile } from "../../src/world/text-files.js";

/** The prop-state accept path (design turn 105, `referenceOwner: accepted-state-record`; issue 535). */
describe("prop-state references", () => {
  it("accepts a candidate through an immutable take, asks before replacing, and keeps the replaced take", async () => {
    const dir = await makeTempWorld();
    const propId = newId("prop");
    const stateId = newId("pst");
    const base = join(dir, "references", propId);
    await mkdir(join(base, "candidates"), { recursive: true });
    await writeFile(
      join(base, "prop.json"),
      `${JSON.stringify({ id: propId, name: "Polaroid", states: [{ id: stateId, name: "on-fridge" }] }, null, 2)}\n`,
    );
    await writeFile(join(base, "candidates", "first.png"), Buffer.from("png-1"));
    await writeFile(join(base, "candidates", "second.png"), Buffer.from("png-2"));
    const store = await WorldStore.open(dir, { clock: () => "2026-09-05T10:00:00.000Z" });
    closeOnCleanup(() => store.close());
    assert.equal(store.getBundle().props[0]?.name, "Polaroid", "the scan carries the prop record");
    assert.deepEqual(store.getBundle().referenceCandidates[propId], [
      `references/${propId}/candidates/first.png`,
      `references/${propId}/candidates/second.png`,
    ]);

    const first = await acceptPropStateReference(store, { propId, stateId, selection: { source: "candidate", file: "first.png" } });
    assert.equal(first.status, "accepted", JSON.stringify(first));
    const firstTake = first.status === "accepted" ? first.takeId : "";
    const record = JSON.parse(await readFile(join(base, "prop.json"), "utf8")) as Prop;
    assert.equal(record.states[0]?.reference?.file, `takes/${firstTake}/first.png`);
    assert.ok((await stat(join(base, "takes", firstTake, "take.json"))).isFile(), "the take is immutable history on disk");
    assert.equal(store.getBundle().referenceReviews.find((review) => review.takeId === firstTake)?.decision, "accept");
    assert.equal(store.getBundle().referenceTakes.find((take) => take.id === firstTake)?.prop?.stateId, stateId);

    const refused = await acceptPropStateReference(store, { propId, stateId, selection: { source: "candidate", file: "second.png" } });
    assert.equal(refused.status, "refused", "a state that already has its reference asks first");

    const replaced = await acceptPropStateReference(store, {
      propId,
      stateId,
      selection: { source: "candidate", file: "second.png" },
      replace: true,
    });
    assert.equal(replaced.status, "accepted", JSON.stringify(replaced));
    const after = JSON.parse(await readFile(join(base, "prop.json"), "utf8")) as Prop;
    assert.notEqual(after.states[0]?.reference?.sourceTakeId, firstTake, "the replacement took over the state");
    assert.ok((await stat(join(base, "takes", firstTake, "take.json"))).isFile(), "the superseded reference keeps its take");
  });

  it("creation keeps one mention to one thing: a slug another prop or a sheet holds is refused, and the scan names a collision already on disk (issue 1116)", async () => {
    const dir = await makeTempWorld();
    // Two props written by hand that answer to the same mention, and one named after a sheet.
    const hidden = newId("prop");
    const twin = newId("prop");
    const namesake = newId("prop");
    for (const [id, name] of [[hidden, "Tea cup"], [twin, "Tea-cup"], [namesake, "Maren Kest"]] as const) {
      // The namesake's file sits under a directory that is not its id, as a hand-moved record can:
      // the report has to name the file as read, not the id the file claims.
      const folder = id === namesake ? "moved-by-hand" : id;
      await mkdir(join(dir, "references", folder), { recursive: true });
      await writeFile(join(dir, "references", folder, "prop.json"), `${JSON.stringify({ id, name, states: [] }, null, 2)}\n`);
    }
    const store = await WorldStore.open(dir, { clock: () => "2026-09-12T14:00:00.000Z" });
    closeOnCleanup(() => store.close());
    const bundle = store.getBundle();
    assert.equal(bundle.props.length, 3, "both records stay loaded: either may be cited by a shot's own control");
    const reported = bundle.problems.filter((problem) => problem.path.startsWith("references/") && problem.path.endsWith("prop.json"));
    // The scan walks the reference directories in its own order, so whichever of the two twins
    // it meets second is the one reported — naming the first.
    const twins = reported.filter((problem) => problem.path.includes(hidden) || problem.path.includes(twin));
    assert.equal(twins.length, 1, JSON.stringify(reported));
    assert.match(twins[0]!.message, /answers to @tea-cup, as does "Tea[ -]cup" \(references\/prop_[0-9A-Z]+\/prop\.json\) — rename one/);
    const moved = reported.find((problem) => problem.message.includes("Maren Kest"));
    assert.equal(moved?.path, "references/moved-by-hand/prop.json", "the path a person can open, not the id the file claims");
    assert.match(moved?.message ?? "", /@maren-kest, the sheet Maren Kest's id/);
    assert.equal(reported.length, 2);
    assert.match(twins[0]!.message, /\(references\/prop_[0-9A-Z]+\/prop\.json\)/, "the twin's holder is named by the path it was read from");

    assert.equal(await createProp(store, "Tea Cup"), null, "the slug is another prop's");
    assert.equal(await createProp(store, "The Vigil"), null, "the slug is a sheet's id");
    assert.equal(await createProp(store, "?!"), null, "nothing to cite it by");
    const ledger = await createProp(store, "Ledger");
    assert.equal(ledger?.name, "Ledger");
    assert.ok((await stat(join(dir, "references", ledger!.id, "prop.json"))).isFile());
    assert.equal(await createProp(store, "ledger"), null, "and the word is taken from then on");
    // Two equivalent requests in flight at once: the check is the commit's precondition, inside
    // the serialised write, so the second sees the first land and returns nothing.
    const [one, two] = await Promise.all([createProp(store, "Lantern"), createProp(store, "Lantern")]);
    assert.equal([one, two].filter((prop) => prop !== null).length, 1, "one Lantern, not two");
    assert.equal(store.getBundle().props.filter((prop) => prop.name === "Lantern").length, 1);
    for (const problem of store.getBundle().problems.filter((entry) => entry.path.endsWith("prop.json"))) {
      assert.equal(problem.kind, "conflict", "a loaded record in conflict is not a file that could not be read");
    }
  });

  it("two files claiming one prop id are both named, each by its own path (codex round 4)", async () => {
    const dir = await makeTempWorld();
    const id = newId("prop");
    for (const [folder, name] of [["first-copy", "Lantern"], ["second-copy", "Lantern"]] as const) {
      await mkdir(join(dir, "references", folder), { recursive: true });
      await writeFile(join(dir, "references", folder, "prop.json"), `${JSON.stringify({ id, name, states: [] }, null, 2)}` + "\n");
    }
    const store = await WorldStore.open(dir, { clock: () => "2026-09-12T14:00:00.000Z" });
    closeOnCleanup(() => store.close());
    const reported = store.getBundle().problems.filter((problem) => problem.kind === "conflict");
    const paths = reported.map((problem) => problem.path).sort();
    assert.deepEqual([...new Set(paths)], ["references/second-copy/prop.json"], "the later file is the one reported, and never a path it does not have");
    assert.ok(reported.some((problem) => /carries the id prop_[0-9A-Z]+, as does "Lantern" \(references\/first-copy\/prop\.json\)/.test(problem.message)), JSON.stringify(reported));
    assert.ok(reported.some((problem) => /answers to @lantern, as does "Lantern" \(references\/first-copy\/prop\.json\)/.test(problem.message)), JSON.stringify(reported));
  });

  it("a sheet minted after a prop of the same name steps past the prop's slug (issue 1116)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: () => "2026-09-12T14:00:00.000Z" });
    closeOnCleanup(() => store.close());
    const gate = new ProposalManager(store);
    assert.equal((await createProp(store, "Ledger"))?.name, "Ledger");
    const draft = await createSheetFromSentence(store, gate, {
      sheetType: "location",
      name: "Ledger",
      sentence: "The counting room where the ledger is kept.",
    });
    assert.equal(draft.slug, "ledger-2", "the prop holds @ledger; the sheet is cited by its own word");
    // The wrap-up's allocator walks the same set.
    const candidate = { id: "cand_1", classification: "sheet.create", draft: { type: "location", name: "Ledger" } } as unknown as WorldChangeCandidate;
    assert.equal(planIdentities([candidate], [], store.getBundle()).slugBy.get("cand_1"), "ledger-2");
  });

  it("a sheet staged before the prop is refused at the press, under the lock (issue 1116)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: () => "2026-09-12T14:00:00.000Z" });
    closeOnCleanup(() => store.close());
    const gate = new ProposalManager(store);
    const draft = await createSheetFromSentence(store, gate, { sheetType: "location", name: "Lantern", sentence: "A lamp by the stair." });
    assert.equal(draft.slug, "lantern", "minted while the word was free");
    assert.equal((await createProp(store, "Lantern"))?.name, "Lantern", "the prop lands first: no live sheet holds the word yet");
    const outcome = await gate.accept(draft.proposal.id);
    assert.equal(outcome.status, "invalid", JSON.stringify(outcome));
    assert.match(outcome.status === "invalid" ? outcome.problems[0]!.message : "", /@lantern already cites the prop "Lantern"/);
    assert.equal(store.getBundle().sheets.some((sheet) => sheet.id === "lantern"), false, "the sheet did not land as the prop's twin");
  });

  it("a new sheet whose front matter names another id than its file is refused at the press (issue 1116)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: () => "2026-09-12T14:00:00.000Z" });
    closeOnCleanup(() => store.close());
    const gate = new ProposalManager(store);
    assert.equal((await createProp(store, "Bar"))?.name, "Bar");
    const draft = await createSheetFromSentence(store, gate, { sheetType: "location", name: "Foo", sentence: "A bar by the water." });
    // A session edits the staged sheet so its id is the prop's word while the file keeps its own.
    const path = join(dir, ".proposals", draft.proposal.id, "locations", "foo.md");
    const staged = await readFile(path, "utf8");
    await writeFile(path, staged.replace(/^id: foo$/m, "id: bar"));
    const outcome = await gate.accept(draft.proposal.id);
    assert.equal(outcome.status, "invalid", JSON.stringify(outcome));
    assert.match(outcome.status === "invalid" ? outcome.problems[0]!.message : "", /id is "bar" but the file is foo\.md/);
  });

  it("an amended sheet cannot take a prop's word either, while a word it already holds is not its to lose (codex round 5)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: () => "2026-09-12T14:00:00.000Z" });
    closeOnCleanup(() => store.close());
    const gate = new ProposalManager(store);
    assert.equal((await createProp(store, "Bar"))?.name, "Bar");
    const live = await readFile(join(dir, "characters", "bray-half-hitch.md"), "utf8");
    const turned = MarkdownFile.parse(live);
    turned.setData({ id: "bar" });
    const staged = await gate.stage({ kind: "sheet-edit", summary: "Bray takes the prop's word", source: "form", targets: [{ path: "characters/bray-half-hitch.md", content: turned.serialize() }] });
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "invalid", JSON.stringify(outcome));
    assert.match(outcome.status === "invalid" ? outcome.problems[0]!.message : "", /id is "bar" but the file is bray-half-hitch\.md/);
    // The same sheet amended in a field, its id untouched, still lands.
    const kept = MarkdownFile.parse(live);
    kept.setData({ role: "Rigger who sings" });
    const plain = await gate.stage({ kind: "sheet-edit", summary: "Bray sings", source: "form", targets: [{ path: "characters/bray-half-hitch.md", content: kept.serialize() }] });
    assert.equal((await gate.accept(plain.id)).status, "accepted");
  });
});
