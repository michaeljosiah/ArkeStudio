import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Prop } from "@arke-studio/contracts";
import { acceptPropStateReference, createProp } from "../../src/references/props.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

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
      await mkdir(join(dir, "references", id), { recursive: true });
      await writeFile(join(dir, "references", id, "prop.json"), `${JSON.stringify({ id, name, states: [] }, null, 2)}\n`);
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
    assert.match(reported.find((problem) => problem.path.includes(namesake))?.message ?? "", /@maren-kest, the sheet Maren Kest's id/);
    assert.equal(reported.length, 2);

    assert.equal(await createProp(store, "Tea Cup"), null, "the slug is another prop's");
    assert.equal(await createProp(store, "The Vigil"), null, "the slug is a sheet's id");
    assert.equal(await createProp(store, "?!"), null, "nothing to cite it by");
    const ledger = await createProp(store, "Ledger");
    assert.equal(ledger?.name, "Ledger");
    assert.ok((await stat(join(dir, "references", ledger!.id, "prop.json"))).isFile());
    assert.equal(await createProp(store, "ledger"), null, "and the word is taken from then on");
  });
});
