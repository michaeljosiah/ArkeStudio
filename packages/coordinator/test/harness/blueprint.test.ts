import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { blueprintCoverage } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { foldBlueprint, sameBlueprint } from "../../src/harness/blueprint.js";

async function writeEntity(dir: string, kind: string, slug: string, body: unknown): Promise<string> {
  const kindDir = join(dir, "draft", kind);
  await mkdir(kindDir, { recursive: true });
  const file = join(kindDir, `${slug}.json`);
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

describe("the blueprint fold (SPEC-031 R-2)", () => {
  it("folds draft.json and the entity directory into one aggregate", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeFile(
      join(dir, "draft.json"),
      JSON.stringify({
        name: "The Undersong",
        logline: "A drowned god still sings beneath the harbour.",
        look: "salt-bleached watercolour",
        threads: ["Who hears the song first?"],
        keyArt: { subject: "Maren at the tideline", characters: ["Maren Kest"] },
      }),
    );
    await writeEntity(dir, "characters", "maren-kest", {
      name: "Maren Kest",
      line: "Tide-caller, the last one",
      description: "She keeps the drowned bell and pretends not to hear it answer.",
      brief: { apparentAge: "around forty", wardrobe: "her brother's coat" },
    });
    await writeEntity(dir, "locations", "the-vigil", {
      name: "The Vigil",
      line: "A lighthouse that faces the wrong way.",
      brief: { establishingView: "the lamp room from the causeway at low tide", hour: "dusk" },
    });

    const blueprint = await foldBlueprint(dir);
    assert.equal(blueprint.name, "The Undersong");
    assert.equal(blueprint.look, "salt-bleached watercolour");
    assert.equal(blueprint.characters.length, 1);
    assert.equal(blueprint.characters[0]!.slug, "maren-kest");
    assert.equal(blueprint.characters[0]!.brief?.wardrobe, "her brother's coat");
    assert.equal(blueprint.locations[0]!.brief?.establishingView, "the lamp room from the causeway at low tide");
    assert.equal(blueprint.keyArt?.characters[0], "Maren Kest");
    assert.deepEqual(blueprint.dropped, []);
  });

  it("drops a corrupt entity file from the fold and names it, rather than failing", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeEntity(dir, "characters", "maren-kest", { name: "Maren Kest" });
    await writeEntity(dir, "characters", "broken", "{not json");

    const blueprint = await foldBlueprint(dir);
    assert.equal(blueprint.characters.length, 1, "the rest still folds");
    assert.deepEqual(blueprint.dropped, ["draft/characters/broken.json"]);
  });

  it("a corrupt draft.json is named too, and the entities still fold", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeFile(join(dir, "draft.json"), "{torn");
    await writeEntity(dir, "characters", "maren-kest", { name: "Maren Kest" });

    const blueprint = await foldBlueprint(dir);
    assert.equal(blueprint.characters.length, 1);
    assert.deepEqual(blueprint.dropped, ["draft.json"]);
  });

  it("a withdrawn entity is removed from the fold and never seen again (R-2)", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeEntity(dir, "characters", "maren-kest", { name: "Maren Kest" });
    await writeEntity(dir, "characters", "old-tom", { name: "Old Tom", withdrawn: true });

    const blueprint = await foldBlueprint(dir);
    assert.deepEqual(
      blueprint.characters.map((c) => c.slug),
      ["maren-kest"],
    );
    assert.deepEqual(blueprint.dropped, [], "withdrawal is intentional, not a parse failure");

    // Deleting the file is the other spelling of the same decision.
    await rm(join(dir, "draft", "characters", "maren-kest.json"));
    assert.equal((await foldBlueprint(dir)).characters.length, 0);
  });

  it("renaming an entity keeps its identity — the filename, not the display name", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeEntity(dir, "characters", "maren-kest", { name: "Maren Kest" });
    const before = await foldBlueprint(dir);

    await writeEntity(dir, "characters", "maren-kest", { name: "Maren Vael" });
    const after = await foldBlueprint(dir);
    assert.equal(after.characters.length, 1, "a rename does not create a second entity");
    assert.equal(after.characters[0]!.slug, before.characters[0]!.slug);
    assert.equal(after.characters[0]!.name, "Maren Vael");
  });

  it("folds a pre-blueprint draft's entity arrays, behind the directory", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeFile(
      join(dir, "draft.json"),
      JSON.stringify({
        name: "The Undersong",
        characters: [
          { name: "Maren Kest", line: "the stale one-liner" },
          { name: "Brother Ellum", line: "keeps the ledger of the drowned" },
        ],
      }),
    );
    await writeEntity(dir, "characters", "maren-kest", {
      name: "Maren Kest",
      line: "Tide-caller, the last one",
    });

    const blueprint = await foldBlueprint(dir);
    assert.equal(blueprint.characters.length, 2);
    const maren = blueprint.characters.find((c) => c.slug === "maren-kest");
    assert.equal(maren?.line, "Tide-caller, the last one", "the directory file wins over the legacy line");
    assert.ok(blueprint.characters.some((c) => c.name === "Brother Ellum"), "a legacy-only entity is not dropped");
  });

  it("a withdrawn entity is not resurrected by a legacy draft.json array (R-2)", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeFile(
      join(dir, "draft.json"),
      JSON.stringify({ characters: [{ name: "Old Tom", line: "keeps turning up" }] }),
    );
    await writeEntity(dir, "characters", "old-tom", { name: "Old Tom", withdrawn: true });

    const blueprint = await foldBlueprint(dir);
    assert.equal(blueprint.characters.length, 0, "the array must not bring him back");
  });

  it("a file whose name the aggregate would refuse is dropped, never a throw (R-2)", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeEntity(dir, "characters", "", { name: "Nameless" });
    await writeEntity(dir, "characters", "maren-kest", { name: "Maren Kest" });

    const blueprint = await foldBlueprint(dir);
    assert.equal(blueprint.characters.length, 1);
    assert.deepEqual(blueprint.dropped, ["draft/characters/.json"]);
  });

  it("a kind directory that cannot be read is named, not read as empty", async () => {
    const dir = await tempDir("arke-blueprint-");
    await mkdir(join(dir, "draft"), { recursive: true });
    // The agent wrote the directory as a file — a whole kind is gone, and the fold says so.
    await writeFile(join(dir, "draft", "characters"), "not a directory");

    const blueprint = await foldBlueprint(dir);
    assert.equal(blueprint.characters.length, 0);
    assert.deepEqual(blueprint.dropped, ["draft/characters"]);
  });

  it("a legacy entry whose name matches a directory file does not double the entity", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeFile(
      join(dir, "draft.json"),
      JSON.stringify({ characters: [{ name: "Maren Kest", line: "the stale line" }] }),
    );
    // The model picked a shorter slug than slugify(name) would.
    await writeEntity(dir, "characters", "maren", { name: "Maren Kest", line: "Tide-caller" });

    const blueprint = await foldBlueprint(dir);
    assert.equal(blueprint.characters.length, 1, "one person, one entity");
    assert.equal(blueprint.characters[0]!.slug, "maren");
  });

  it("an empty sandbox folds to an empty plan, and equality holds across folds", async () => {
    const dir = await tempDir("arke-blueprint-");
    const a = await foldBlueprint(dir);
    const b = await foldBlueprint(dir);
    assert.ok(sameBlueprint(a, b));
    assert.equal(a.characters.length, 0);
    assert.deepEqual(a.dropped, []);
  });

  it("coverage reads what is covered and what is open, as the rail shows it (R-7)", async () => {
    const dir = await tempDir("arke-blueprint-");
    await writeFile(
      join(dir, "draft.json"),
      JSON.stringify({
        logline: "A drowned god still sings.",
        bible: "The argument underneath it.",
        keyArt: { characters: ["Maren Kest"] },
      }),
    );
    await writeEntity(dir, "characters", "maren-kest", { name: "Maren Kest" });

    const coverage = blueprintCoverage(await foldBlueprint(dir));
    assert.equal(coverage.premise, true);
    assert.equal(coverage.cast, 1);
    assert.equal(coverage.places, 0);
    assert.equal(coverage.throughLine, true);
    assert.equal(coverage.look, false, "the look has never been discussed, and the rail says so");
    assert.equal(coverage.keyArt, false, "a brief that names no subject or moment settles nothing");
  });
});
