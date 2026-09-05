import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId, type Prop } from "@arke-studio/contracts";
import { acceptPropStateReference } from "../../src/references/props.js";
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
});
