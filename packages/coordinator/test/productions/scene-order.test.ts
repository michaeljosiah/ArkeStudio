import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deriveCut, deriveSpineCut, SceneSchema, type ProductionSpine } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { draftSceneSkeleton, reorderScenes } from "../../src/productions/ops.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Scene identity, order, and path become separate authorities (issue #387): identity is stable
 * at creation, explicit order governs displays and the ordinary cut, the stem captured at scan
 * is the address, and the spine never notices any of it.
 */

const CLOCK = () => "2026-08-19T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, gate: new ProposalManager(store) };
}

describe("scene identity and explicit order (issue 387)", () => {
  it("a drafted scene's id and stem come from the slug, not the position, and deduplicate", async () => {
    const { dir, store, gate } = await open();
    const first = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The bell answers itself.",
    });
    assert.equal(first.path, "productions/saltlight/scenes/the-bell-answers-itself.json", "no ordering prefix");
    const staged = JSON.parse(
      await readFile(join(dir, ".proposals", first.proposalId, ...first.path.split("/")), "utf8"),
    ) as { id: string; number: number; order: number };
    assert.equal(staged.id, "sc_the-bell-answers-itself", "identity from the slug");
    assert.equal(staged.order, staged.number, "explicit order from birth");

    const second = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The bell answers itself.",
    });
    assert.equal(
      second.path,
      "productions/saltlight/scenes/the-bell-answers-itself-2.json",
      "a second identical brief takes the next stem, never the same one",
    );
  });

  it("reorder rewrites order fields only: no rename, no version cut, and the cut follows", async () => {
    const { dir, store } = await open();
    const sceneDir = join(dir, "productions", "saltlight", "scenes");
    const namesBefore = (await readdir(sceneDir)).sort();
    const before = await scanWorld(dir);
    const saltlight = before.bundle.productions.find((p) => p.meta.id === "saltlight")!;
    assert.deepEqual(
      saltlight.scenes.map((s) => s.id),
      ["sc_02", "sc_04", "sc_06"],
      "legacy scenes order by their birth numbers",
    );

    await reorderScenes(store, "saltlight", ["sc_06", "sc_02", "sc_04"]);

    assert.deepEqual((await readdir(sceneDir)).sort(), namesBefore, "no file renamed");
    const after = await scanWorld(dir);
    const reordered = after.bundle.productions.find((p) => p.meta.id === "saltlight")!;
    assert.deepEqual(reordered.scenes.map((s) => s.id), ["sc_06", "sc_02", "sc_04"], "the bundle follows order");
    for (const scene of reordered.scenes) {
      assert.equal(
        scene.version,
        saltlight.scenes.find((s) => s.id === scene.id)!.version,
        `reorder cuts no version (${scene.id})`,
      );
    }
    const cut = deriveCut(reordered);
    assert.equal(cut.entries[0]!.sceneNumber, 6, "the ordinary cut follows explicit order");
    const raw = JSON.parse(await readFile(join(sceneDir, "06-slack-water.json"), "utf8")) as { order: number };
    assert.equal(raw.order, 1, "order landed in the file");
  });

  it("scene reorder does not change the spine cut", async () => {
    const { dir, store } = await open();
    const before = await scanWorld(dir);
    const saltlight = before.bundle.productions.find((p) => p.meta.id === "saltlight")!;
    const spine: ProductionSpine = {
      version: 1,
      track: { artifactId: "art_track", durationSec: 30 },
      anchors: {
        sh_20: { startSec: 0 },
        sh_12: { startSec: 10 },
        sh_04: { startSec: 20 },
      },
    } as ProductionSpine;
    const cutBefore = deriveSpineCut(saltlight, spine, 30);

    await reorderScenes(store, "saltlight", ["sc_06", "sc_02", "sc_04"]);
    const after = await scanWorld(dir);
    const reordered = after.bundle.productions.find((p) => p.meta.id === "saltlight")!;
    const cutAfter = deriveSpineCut(reordered, spine, 30);
    assert.deepEqual(cutAfter.segments, cutBefore.segments, "spine playback is anchor-ordered, blind to scene order");
    assert.equal(cutAfter.clipSec, cutBefore.clipSec);
    assert.deepEqual(
      [...cutAfter.unanchoredShotIds].sort(),
      [...cutBefore.unanchoredShotIds].sort(),
      "the same shots are unanchored either way — only the advisory listing order may follow the scenes",
    );
  });

  it("the bundle carries real stems, and an off-pattern filename stays reachable", async () => {
    const { dir } = await open();
    const scene = {
      id: "sc_the-answer",
      number: 9,
      slug: "the-answer",
      title: "The answer",
      status: "draft",
      version: 1,
      shots: [],
    };
    SceneSchema.parse(scene);
    await writeFile(
      join(dir, "productions", "saltlight", "scenes", "the-answer.json"),
      JSON.stringify(scene, null, 2) + "\n",
      "utf8",
    );
    const { bundle, problems } = await scanWorld(dir);
    const saltlight = bundle.productions.find((p) => p.meta.id === "saltlight")!;
    assert.deepEqual(problems, []);
    assert.equal(saltlight.sceneFiles["sc_the-answer"], "the-answer", "the actual stem is the address");
    assert.equal(saltlight.sceneFiles["sc_04"], "04-the-verse-rises", "legacy stems captured verbatim");
    assert.ok(saltlight.scenes.some((s) => s.id === "sc_the-answer"), "the scene is in the bundle");
  });

  it("a duplicate scene id is a named problem, not a silent overwrite", async () => {
    const { dir } = await open();
    const original = JSON.parse(
      await readFile(join(dir, "productions", "saltlight", "scenes", "04-the-verse-rises.json"), "utf8"),
    ) as { id: string };
    await writeFile(
      join(dir, "productions", "saltlight", "scenes", "99-duplicate.json"),
      JSON.stringify({ ...original, slug: "duplicate", number: 99 }, null, 2) + "\n",
      "utf8",
    );
    const { bundle, problems } = await scanWorld(dir);
    const saltlight = bundle.productions.find((p) => p.meta.id === "saltlight")!;
    assert.equal(saltlight.sceneFiles["sc_04"], "04-the-verse-rises", "the first file keeps the id");
    assert.ok(
      problems.some((p) => p.message.includes("duplicate scene id sc_04")),
      "the collision is named",
    );
  });
});
