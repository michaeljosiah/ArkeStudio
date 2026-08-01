import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AppIndex } from "../../src/index-db/app-index.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "../../../../fixtures");

describe("the app index (R-5, R-6, R-15, D2, D3)", () => {
  it("serves the picker from the registry without scanning any world (R-6)", async () => {
    const { root, worldDir } = await makeTempRoot();
    const provider = new FsWorldProvider(root);
    const first = await provider.listWorlds(); // seeds
    assert.equal(first.length, 1);
    assert.equal(first[0]!.counts.characters, 3);

    // Change the world's contents directly. A registry-served list must NOT see it — proof
    // that no world folder was scanned to produce the answer.
    await writeFile(
      join(worldDir, "characters", "extra.md"),
      '---\nid: extra\ntype: character\nname: Extra\nversion: 1\nstatus: sketch\ncanonRules: []\nlinks: []\ncreated: "2026-08-01"\nupdated: "2026-08-01"\n---\n\n## Essence\nX.\n',
      "utf8",
    );
    const second = await provider.listWorlds();
    assert.equal(second[0]!.counts.characters, 3, "served from the registry, not a scan");

    // Opening the world refreshes its registry row with real counts.
    await provider.loadWorld(second[0]!.worldId);
    const third = await provider.listWorlds();
    assert.equal(third[0]!.counts.characters, 4);
    await provider.close();
  });

  it("drops registry rows whose folder is gone — the registry follows the truth", async () => {
    const { root } = await makeTempRoot();
    const provider = new FsWorldProvider(root);
    await provider.listWorlds();
    const { rm } = await import("node:fs/promises");
    await rm(join(root, "worlds", "the-undersong"), { recursive: true, force: true });
    assert.deepEqual(await provider.listWorlds(), []);
    await provider.close();
  });

  it("rebuilds jobs and ledger from the append-only logs, and deleting it loses nothing (R-5)", async () => {
    const root = await mkdtemp(join(tmpdir(), "arke-appidx-"));
    const { cp, mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "queue"), { recursive: true });
    await cp(join(FIXTURES, "queue", "jobs.jsonl"), join(root, "queue", "jobs.jsonl"));
    await cp(join(FIXTURES, "ledger.jsonl"), join(root, "ledger.jsonl"));

    const index = AppIndex.open(root);
    await index.rebuildFromLogs(join(root, "queue", "jobs.jsonl"), join(root, "ledger.jsonl"));
    const byProvider = index.spendByProvider();
    const fal = byProvider.find((p) => p.provider === "fal")!;
    assert.equal(fal.microUsd, 38000 + 131000 + 128400 + 130000);
    assert.equal(byProvider.find((p) => p.provider === "elevenlabs")!.microUsd, 0);
    const weeks = index.spendByWeek();
    assert.equal(weeks.length, 1);
    index.close();

    // Delete and rebuild: identical aggregation, because the logs are the truth.
    const { rm } = await import("node:fs/promises");
    await rm(join(root, ".index"), { recursive: true, force: true });
    const again = AppIndex.open(root);
    await again.rebuildFromLogs(join(root, "queue", "jobs.jsonl"), join(root, "ledger.jsonl"));
    assert.deepEqual(again.spendByProvider(), byProvider);
    again.close();
  });

  it("discards a corrupt app database silently (R-4)", async () => {
    const root = await mkdtemp(join(tmpdir(), "arke-appidx-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, ".index"), { recursive: true });
    await writeFile(join(root, ".index", "app.db"), "not sqlite", "utf8");
    const index = AppIndex.open(root);
    assert.equal(index.seeded, false);
    index.close();
  });
});
