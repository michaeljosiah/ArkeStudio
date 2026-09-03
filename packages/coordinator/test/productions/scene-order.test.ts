import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  deriveCut,
  deriveSpineCut,
  insertShot,
  isGraphScene,
  SceneRecordSchema,
  SceneSchema,
  skillFor,
  type ProductionSpine,
} from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { draftSceneSkeleton, reorderScenes } from "../../src/productions/ops.js";
import { scanWorld } from "../../src/world/scan.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";
import { legacySceneView, orderedShots } from "@arke-studio/contracts";

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

  it("discarding a legacy staged scene releases its claimed identity", async () => {
    const { store, gate } = await open();
    const first = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The discarded bell.",
    });
    await gate.discard(first.proposalId);
    const replacement = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The discarded bell.",
    });
    assert.equal(replacement.path, first.path, "discard releases the staged stem rather than burning it");
  });

  it("a drafted scene is told where the production's shot ids start, and the gate refuses a clash", async () => {
    /*
     * Driven live 2026-08-22: two agent-drafted scenes each numbered their shots from sh_1, and
     * "Generate frame" on one scene's shot 1 opened the other scene's. Takes and selections key
     * by bare shot id, so the collision is not cosmetic.
     */
    const { dir, store, gate } = await open();
    const onDisk = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const highest = onDisk.scenes
      .flatMap((s) => orderedShots(s))
      .reduce((a, shot) => Math.max(a, Number(shot.id.replace(/^sh_0*/, "")) || 0), 0);

    const draft = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The lamps hold their line.",
    });
    assert.match(
      draft.instruction,
      new RegExp(`number this scene's shots sh_${highest + 1}\\b`),
      "the agent is told the first free id in the whole production",
    );
    assert.match(draft.instruction, /unique across the WHOLE production/);

    // An agent that numbers from one anyway is refused in words it can act on.
    const target = join(dir, ".proposals", draft.proposalId, ...draft.path.split("/"));
    const staged = SceneRecordSchema.parse(JSON.parse(await readFile(target, "utf8")));
    assert.ok(isGraphScene(staged));
    const taken = orderedShots(onDisk.scenes[0]!)[0]!.id;
    const colliding = insertShot(staged, {
      at: { atStart: true },
      shot: { id: taken, title: "Collides", description: "Something happens." },
    });
    await writeFile(
      target,
      JSON.stringify(colliding, null, 2),
      "utf8",
    );
    const problems = await gate.recordProblems(draft.proposalId);
    assert.equal(problems.length, 1, "the clash is a record problem, so the open session is asked to fix it");
    assert.match(problems[0]!.message, new RegExp(taken));
    assert.match(problems[0]!.message, /unique across the whole production/);
    const outcome = await gate.accept(draft.proposalId);
    assert.equal(outcome.status, "invalid", "and accept refuses rather than writing the collision");
  });


  it("a collision the scene already had does not block an unrelated edit to it (driven 2026-08-22)", async () => {
    /*
     * The check's own doing. Two scenes drafted before the mint went production-wide really do
     * share sh_1 and sh_2 on disk, and judging the whole shot list made every gated edit to
     * either one refuse for a collision it did not cause and could not fix — the scene became
     * permanently unwritable through the gate. Found by talking to a scene in the installed app
     * and watching Wrap up do nothing at all.
     */
    const { dir, store, gate } = await open();
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const first = legacySceneView(production.scenes[0]!);
    const second = legacySceneView(production.scenes[1]!);
    const shared = first.shots[0]!.id;

    // Put the overlap on disk, the way concurrent drafting once did.
    const stem = (id: string) => production.sceneFiles[id]!;
    const path = (id: string) => `productions/saltlight/scenes/${stem(id)}.json`;
    const rawSecond = await readFile(join(dir, ...path(second.id).split("/")), "utf8");
    await store.commit({
      kind: "scene-save",
      source: "editor",
      files: [
        {
          path: path(second.id),
          action: "replace",
          content:
            JSON.stringify(
              { ...second, shots: [{ ...second.shots[0]!, id: shared }, ...second.shots.slice(1)] },
              null,
              2,
            ) + "\n",
          baseHash: `sha256:${createHash("sha256").update(rawSecond, "utf8").digest("hex")}`,
        },
      ],
    });

    // Now edit that scene for a reason that has nothing to do with ids.
    const live = legacySceneView(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.id === second.id)!);
    const staged = await gate.stage({
      kind: "scene-edit",
      summary: "A synopsis, nothing to do with shot ids",
      source: "chat:studio",
      targets: [
        { path: path(second.id), content: JSON.stringify({ ...live, synopsis: "The lamps hold." }, null, 2) + "\n" },
      ],
    });
    assert.deepEqual(
      await gate.recordProblems(staged.id),
      [],
      "a pre-existing overlap is a fact about the world, not this edit's fault",
    );

    // A NEW collision is still refused.
    const other = legacySceneView(store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.id === first.id)!);
    const introduces = await gate.stage({
      kind: "scene-edit",
      summary: "This one takes an id it never had",
      source: "chat:studio",
      targets: [
        {
          path: path(second.id),
          content:
            JSON.stringify({ ...live, shots: [...live.shots, { ...other.shots[1]!, number: 99 }] }, null, 2) + "\n",
        },
      ],
    });
    const problems = await gate.recordProblems(introduces.id);
    assert.equal(problems.length, 1, "the id this edit adds is still a collision");
    assert.match(problems[0]!.message, /unique across the whole production/);
  });

  it("a staged draft has claimed its number too, not only its stem (round 3, 2026-08-22)", async () => {
    // Driven live: drafting two scenes back to back — the ordinary way to build an episode —
    // gave both the same number and the same order, because only what was on disk was counted.
    // Three scenes then called themselves Scene 1, in an order nothing had decided.
    const { dir, store, gate } = await open();
    const read = async (d: { proposalId: string; path: string }) =>
      JSON.parse(await readFile(join(dir, ".proposals", d.proposalId, ...d.path.split("/")), "utf8")) as {
        number: number;
        order: number;
      };
    const onDisk = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!.scenes;
    const highest = onDisk.reduce((a, s) => Math.max(a, s.number), 0);

    const first = await read(
      await draftSceneSkeleton(store, gate, { productionId: "saltlight", brief: "The first new one." }),
    );
    const second = await read(
      await draftSceneSkeleton(store, gate, { productionId: "saltlight", brief: "The second new one." }),
    );
    const third = await read(
      await draftSceneSkeleton(store, gate, { productionId: "saltlight", brief: "The third new one." }),
    );

    assert.equal(first.number, highest + 1);
    assert.equal(second.number, highest + 2, "the second draft sees the first one waiting");
    assert.equal(third.number, highest + 3);
    assert.deepEqual(
      [first.order, second.order, third.order],
      [highest + 1, highest + 2, highest + 3],
      "and order follows number, so nothing lands unplaced",
    );
  });

  it("a draft shaped by a registry skill stages a readable manifest, recording only the triple", async () => {
    // The desktop wires the contracts registry's skillFor straight into the coordinator, so at
    // runtime the "triple" arriving here is the full Skill — purpose and the whole guidance body
    // riding along under the narrow type. The strict manifest schema used to reject that AFTER
    // the target file was written: an invisible orphaned proposal, and Draft scene silently dead
    // in every packaged build whose routed video model has a shipped skill.
    const { store, gate } = await open();
    const registrySkill = skillFor("scene-drafting", "seedance");
    assert.ok(registrySkill, "the seedance drafting skill ships with the app");
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "One lantern answers another across the water.",
      skill: registrySkill,
    });
    const manifest = await gate.readManifest(draft.proposalId);
    assert.deepEqual(
      manifest.skill,
      { id: registrySkill.id, version: registrySkill.version, family: registrySkill.family },
      "the manifest records exactly the provenance triple, never the guidance body",
    );
  });

  it("an agent-mangled scene draft is refused at accept, never committed for the scanner to drop", async () => {
    // The drafting agent edits its staged target with raw file tools, so nothing checks the
    // shape between staging and accept. Live 0.5.29 wrote prose where a slug belongs and a
    // sentence where the audio object belongs; accept committed it, and the scanner — which
    // reads with the same SceneSchema — silently dropped the scene from the bundle. The gate
    // must refuse by name instead.
    const { dir, store, gate } = await open();
    const draft = await draftSceneSkeleton(store, gate, {
      productionId: "saltlight",
      brief: "The chalk circle waits for someone to step in.",
    });
    const target = join(dir, ".proposals", draft.proposalId, ...draft.path.split("/"));
    const staged = JSON.parse(await readFile(target, "utf8")) as Record<string, unknown>;
    staged["shots"] = [
      {
        id: "sh_1",
        number: 1,
        title: "Spotlight snaps on",
        description: "the spotlight snaps on over the chalk circle",
        audio: "light click and focus hum",
        durationSec: 3,
      },
    ];
    staged["inherits"] = { location: "rehearsal hall", timeOfDay: "dawn", tone: "playful" };
    await writeFile(target, JSON.stringify(staged, null, 2) + "\n");

    const outcome = await gate.accept(draft.proposalId);
    assert.equal(outcome.status, "invalid", "accept refuses rather than committing");
    assert.ok(outcome.status === "invalid" && /not a scene/.test(outcome.problems[0]!.message), "the refusal names the record");
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
      schemaVersion: 1,
      revision: 1,
      trackArtifactId: "art_track",
      markers: [],
      anchors: {
        sh_20: { startSec: 0, endSec: 8, clipAudio: { mode: "mute" } },
        sh_12: { startSec: 10, endSec: 18, clipAudio: { mode: "mute" } },
        sh_04: { startSec: 20, endSec: 28, clipAudio: { mode: "mute" } },
      },
      updatedAt: "2026-08-19T12:00:00.000Z",
    };
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
