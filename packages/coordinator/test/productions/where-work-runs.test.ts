import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProductionSchema } from "@arke-studio/contracts";
import { setProductionModel } from "../../src/productions/ops.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

/**
 * Where a production's work runs (SPEC-033 §1.12).
 *
 * The stored value is a **concrete model reference**, never the word `local` or `cloud`: with two
 * local video models installed, `local` does not say which seeds the dispatch, and migrating an
 * existing routing default under that spelling would throw away the model id it already had.
 *
 * It lives on the production and takes the path every production field takes. That is the whole
 * of D17: production ids are world-scoped rather than installation-global, so an app-settings
 * store keyed by production id collides across two copies of a world and loses the choice the
 * moment the world moves to another machine.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, bundle: store.getBundle() };
}

async function onDisk(dir: string, productionId: string) {
  const raw = await readFile(join(dir, "productions", productionId, "production.json"), "utf8");
  return ProductionSchema.parse(JSON.parse(raw));
}

describe("the choice is a model reference on the production's own record (R-74..R-76)", () => {
  it("is written through the ordinary commit, and cleared without leaving a shape behind", async () => {
    const { dir, store, bundle } = await open();
    const production = bundle.productions[0]!;
    assert.equal(production.meta.models, undefined, "the fixture predates the choice");

    await setProductionModel(store, production.meta.id, "video", "comfyui-draft-video");
    assert.deepEqual((await onDisk(dir, production.meta.id)).models, { video: "comfyui-draft-video" });

    // A second capability joins the first rather than replacing the record.
    await setProductionModel(store, production.meta.id, "image", "comfyui-draft-image");
    assert.deepEqual((await onDisk(dir, production.meta.id)).models, {
      video: "comfyui-draft-video",
      image: "comfyui-draft-image",
    });

    await setProductionModel(store, production.meta.id, "image", null);
    assert.deepEqual((await onDisk(dir, production.meta.id)).models, { video: "comfyui-draft-video" });

    // Clearing the last one removes the key. `{}` on disk reads as a choice that was made and
    // then emptied, which is a different thing from never having made one.
    await setProductionModel(store, production.meta.id, "video", null);
    assert.equal((await onDisk(dir, production.meta.id)).models, undefined);
  });

  it("appears in the change log, because production meta is unversioned", async () => {
    const { dir, store, bundle } = await open();
    const production = bundle.productions[0]!;
    await setProductionModel(store, production.meta.id, "llm", "gemma4-12b");
    const changes = (await readFile(join(dir, "changes.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { entity?: string; fieldsChanged?: string[] });
    assert.ok(
      changes.some(
        (line) =>
          line.entity === `productions/${production.meta.id}/production` && line.fieldsChanged?.includes("models"),
      ),
      "history is the change line",
    );
  });

  it("travels with the world, because nothing about it is installation-level (row 34)", async () => {
    // The whole of D17, checked rather than argued: the choice is bytes in the world folder, so
    // a copy of that folder carries it, and two copies cannot collide over one production id.
    const { dir, store, bundle } = await open();
    const production = bundle.productions[0]!;
    await setProductionModel(store, production.meta.id, "video", "comfyui-draft-video");
    await store.close();

    const elsewhere = join(await tempDir("arke-world-copy-"), "the-undersong");
    await cp(dir, elsewhere, { recursive: true });
    const moved = await WorldStore.open(elsewhere, { clock: CLOCK });
    closeOnCleanup(() => moved.close());
    assert.equal(
      moved.getBundle().productions.find((p) => p.meta.id === production.meta.id)?.meta.models?.video,
      "comfyui-draft-video",
    );
  });
});
