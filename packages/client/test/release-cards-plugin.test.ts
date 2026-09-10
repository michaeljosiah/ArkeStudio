import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_CARDS, newestCards, releaseCardsModule, releaseCardsPlugin } from "../release-cards-plugin.js";

/**
 * The cards a build carries are chosen before the bundler sees them (SPEC-016 R-19; codex on PR
 * 1087): the plugin reads `docs/releases`, keeps the newest eight and generates the module with
 * exactly their pictures imported — never a glob that emits the whole history.
 */

async function docs(cards: Array<{ tag: string; date?: string; picture?: string | null; withFile?: boolean; title?: string }>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arke-release-cards-"));
  for (const card of cards) {
    await mkdir(join(dir, card.tag), { recursive: true });
    const picture = card.picture === undefined ? "picture.jpg" : card.picture;
    const front = [`title: ${card.title ?? card.tag}`, `date: ${card.date ?? "2026-09-01"}`, ...(picture ? [`picture: ${picture}`] : [])];
    await writeFile(join(dir, card.tag, "notes.md"), `---\n${front.join("\n")}\n---\nSome words.\n`, "utf8");
    if (picture && card.withFile !== false) await writeFile(join(dir, card.tag, picture), "jpg", "utf8");
  }
  return dir;
}

describe("the release cards a build carries", () => {
  it("keeps the newest cards by version, with the picture each names, and no more than the limit", async () => {
    const dir = await docs([
      { tag: "v0.5.9" },
      { tag: "v0.5.47" },
      { tag: "v0.5.10", picture: "hero.png" },
      { tag: "v0.5.41", picture: "missing.jpg", withFile: false },
    ]);
    try {
      const all = newestCards(dir);
      assert.deepEqual(all.map((card) => card.tag), ["v0.5.47", "v0.5.41", "v0.5.10", "v0.5.9"], "newest first, by number");
      assert.equal(all[0]!.picture, resolve(dir, "v0.5.47", "picture.jpg"));
      assert.equal(all[2]!.picture, resolve(dir, "v0.5.10", "hero.png"), "the picture the front matter names");
      assert.equal(all[1]!.picture, null, "a name the folder lacks is no picture");
      assert.ok(all[0]!.notes.startsWith("---\n"), "the card file rides whole");
      assert.deepEqual(newestCards(dir, 2).map((card) => card.tag), ["v0.5.47", "v0.5.41"], "the limit is applied here, not after bundling");
      assert.equal(BUNDLED_CARDS, 8);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("skips a folder without a readable card, and a folder that is not a release", async () => {
    const dir = await docs([{ tag: "v0.5.47" }, { tag: "v0.5.48", date: "not a date" }]);
    try {
      await mkdir(join(dir, "v0.5.49"), { recursive: true });
      await writeFile(join(dir, "README.md"), "not a card", "utf8");
      assert.deepEqual(newestCards(dir).map((card) => card.tag), ["v0.5.47"]);
      assert.deepEqual(newestCards(join(dir, "nowhere")), [], "no folder, no cards");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("generates one url import per picture and a row per card", () => {
    const from = resolve("C:/repo/packages/client/src/lib");
    const code = releaseCardsModule(
      [
        { tag: "v0.5.47", notes: "---\ntitle: T\n---\nwords", picture: resolve("C:/repo/docs/releases/v0.5.47/picture.jpg") },
        { tag: "v0.5.41", notes: "---\ntitle: U\n---\nmore", picture: null },
      ],
      from,
    );
    assert.match(code, /^import picture0 from "\.\.\/\.\.\/\.\.\/\.\.\/docs\/releases\/v0\.5\.47\/picture\.jpg\?url";/m);
    assert.equal((code.match(/^import /gm) ?? []).length, 1, "a card without a picture imports nothing");
    assert.match(code, /\{ tag: "v0\.5\.47", notes: "---\\ntitle: T\\n---\\nwords", picture: picture0 \}/);
    assert.match(code, /\{ tag: "v0\.5\.41", notes: "---\\ntitle: U\\n---\\nmore", picture: null \}/);
    assert.match(code, /^export const RELEASE_CARDS = \[/m);
  });

  it("answers for the stub module alone", async () => {
    const dir = await docs([{ tag: "v0.5.47" }]);
    try {
      const plugin = releaseCardsPlugin({ docs: dir });
      const stub = resolve(fileURLToPath(new URL("../src/lib/release-cards.ts", import.meta.url)));
      const load = plugin.load as (id: string) => string | null;
      assert.equal(load.call(plugin, resolve(fileURLToPath(new URL("../src/lib/releases.ts", import.meta.url)))), null);
      const code = load.call(plugin, stub.replace(/\\/g, "/"))!;
      assert.match(code, /export const RELEASE_CARDS = \[\n  \{ tag: "v0\.5\.47"/);
      assert.match(code, /picture0/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
