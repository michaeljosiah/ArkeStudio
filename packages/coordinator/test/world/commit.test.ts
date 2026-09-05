import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CommitPlanError, CommitStaleError, Committer } from "../../src/world/commit.js";
import { readChanges } from "../../src/world/change-writer.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { makeTempWorld } from "./helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function readWorld(dir: string) {
  return JSON.parse(await readFile(join(dir, "world.json"), "utf8")) as Record<string, number>;
}

describe("the commit primitive (R-13, R-15..R-21, R-27)", () => {
  it("replaces binary bytes with byte hashes and refuses stale binary bases", async () => {
    const dir = await makeTempWorld();
    const committer = new Committer(dir, CLOCK);
    const before = Buffer.from([0xff, 0x00, 0x80]);
    const after = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    await writeFile(join(dir, "world-art.png"), before);
    const input = { kind: "world-image-adopt", source: "test", files: [{
      path: "world-art.png", action: "replace" as const, content: after.toString("base64"), encoding: "base64" as const, baseHash: sha256(before),
    }] };
    await committer.commit(input);
    assert.deepEqual(await readFile(join(dir, "world-art.png")), after);
    const changes = await readChanges(join(dir, "changes.jsonl"));
    assert.equal(changes.at(-1)!["contentHashBefore"], sha256(before));
    assert.equal(changes.at(-1)!["contentHashAfter"], sha256(after));
    await assert.rejects(committer.commit(input), CommitStaleError);
    await assert.rejects(committer.commit({ ...input, files: [{ ...input.files[0]!, path: "characters/maren-kest.md" }] }), CommitPlanError);
  });

  it("bumps a sheet's own version and leaves canon untouched (R-17)", async () => {
    const dir = await makeTempWorld();
    const committer = new Committer(dir, CLOCK);
    const path = "characters/maren-kest.md";
    const live = await readFile(join(dir, path), "utf8");
    const doc = MarkdownFile.parse(live);
    doc.setBody(doc.body.replace("Salt-crusted braids", "Salt-white braids"));

    const result = await committer.commit({
      kind: "sheet-edit",
      source: "test",
      files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
    });

    assert.equal(result.versions[path], 6);
    const after = MarkdownFile.parse(await readFile(join(dir, path), "utf8"));
    assert.equal(after.data["version"], 6);
    assert.equal((await readWorld(dir))["canonRevision"], 104, "canon untouched by a sheet edit");

    // History: outgoing v5 and incoming v6 both snapshotted (R-18, R-19).
    const v5 = await readFile(join(dir, ".history/characters/maren-kest/v5.md"), "utf8");
    assert.equal(v5, live);
    const v6 = await readFile(join(dir, ".history/characters/maren-kest/v6.md"), "utf8");
    assert.ok(v6.includes("Salt-white braids"));

    const changes = await readChanges(join(dir, "changes.jsonl"));
    const line = changes[changes.length - 1]!;
    assert.equal(line["entity"], "characters/maren-kest");
    assert.equal(line["fromVersion"], 5);
    assert.equal(line["toVersion"], 6);
    assert.ok((line["fieldsChanged"] as string[]).includes("appearance"));
  });

  it("advances the canon revision once for a commit touching two entries (R-16)", async () => {
    const dir = await makeTempWorld();
    const committer = new Committer(dir, CLOCK);
    const files = [];
    for (const id of ["CANON-001", "CANON-007"]) {
      const path = `canon/${id}.md`;
      const live = await readFile(join(dir, path), "utf8");
      const doc = MarkdownFile.parse(live);
      doc.setBody(doc.body + "\nAmended.");
      files.push({ path, action: "replace" as const, content: doc.serialize(), baseHash: sha256(live) });
    }
    const result = await committer.commit({ kind: "canon-edit", source: "test", files });

    assert.equal(result.canonRevision, 105, "one increment, not two");
    assert.equal((await readWorld(dir))["canonRevision"], 105);
    for (const id of ["CANON-001", "CANON-007"]) {
      const doc = MarkdownFile.parse(await readFile(join(dir, `canon/${id}.md`), "utf8"));
      assert.equal(doc.data["amendedAt"], 105, `${id} stamped with the new revision`);
    }
  });

  it("stamps settledAt when a proposed entry settles, introducedAt on create", async () => {
    const dir = await makeTempWorld();
    const committer = new Committer(dir, CLOCK);
    const newEntry = "---\nid: CANON-072\ntype: lore\ntitle: The tithe\nstatus: settled\nintroducedAt: 0\nlinks: []\n---\n\nThe tithe is paid at slack water.\n";
    const result = await committer.commit({
      kind: "new-canon",
      source: "test",
      files: [{ path: "canon/CANON-072.md", action: "create", content: newEntry, baseHash: null }],
    });
    const doc = MarkdownFile.parse(await readFile(join(dir, "canon/CANON-072.md"), "utf8"));
    assert.equal(doc.data["introducedAt"], result.canonRevision);
  });

  it("a mixed commit moves both tracks atomically (D9)", async () => {
    const dir = await makeTempWorld();
    const committer = new Committer(dir, CLOCK);
    const sheetPath = "characters/maren-kest.md";
    const sheetLive = await readFile(join(dir, sheetPath), "utf8");
    const sheetDoc = MarkdownFile.parse(sheetLive);
    sheetDoc.setData({ canonRules: ["CANON-002", "CANON-073"] });
    const canonNew =
      "---\nid: CANON-073\ntype: rule\ntitle: The left ear\nstatus: settled\nintroducedAt: 0\nlinks: [maren-kest]\n---\n\nWhat the verse takes, it keeps.\n";

    const result = await committer.commit({
      kind: "canon-and-sheet",
      source: "test",
      files: [
        { path: "canon/CANON-073.md", action: "create", content: canonNew, baseHash: null },
        { path: sheetPath, action: "replace", content: sheetDoc.serialize(), baseHash: sha256(sheetLive) },
      ],
    });
    assert.equal(result.canonRevision, 105);
    assert.equal(result.versions[sheetPath], 6);
    const after = MarkdownFile.parse(await readFile(join(dir, sheetPath), "utf8"));
    assert.deepEqual(after.data["canonRules"], ["CANON-002", "CANON-073"]);
  });

  it("refuses a commit whose base moved — staleness detected, never merged (R-27)", async () => {
    const dir = await makeTempWorld();
    const committer = new Committer(dir, CLOCK);
    const path = "characters/maren-kest.md";
    const live = await readFile(join(dir, path), "utf8");

    // Someone else lands first.
    const first = MarkdownFile.parse(live);
    first.setBody(first.body + "\nFirst edit.");
    await committer.commit({
      kind: "sheet-edit",
      source: "first",
      files: [{ path, action: "replace", content: first.serialize(), baseHash: sha256(live) }],
    });

    // A second commit drafted against the old base must refuse.
    const second = MarkdownFile.parse(live);
    second.setBody(second.body + "\nSecond edit.");
    await assert.rejects(
      () =>
        committer.commit({
          kind: "sheet-edit",
          source: "second",
          files: [{ path, action: "replace", content: second.serialize(), baseHash: sha256(live) }],
        }),
      CommitStaleError,
    );
    const after = await readFile(join(dir, path), "utf8");
    assert.ok(after.includes("First edit."), "the newer content survived");
  });

  it("rechecks the physical base after staging and preserves a concurrent outside save", async () => {
    const dir = await makeTempWorld();
    const path = "characters/maren-kest.md";
    const live = await readFile(join(dir, path), "utf8");
    const proposed = MarkdownFile.parse(live);
    proposed.setBody(proposed.body.replace("Salt-crusted braids", "Salt-white braids"));
    const outside = live.replace("Salt-crusted braids", "Iron-grey braids");

    await assert.rejects(
      () =>
        new Committer(dir, CLOCK).commit(
          {
            kind: "sheet-edit",
            source: "test",
            files: [{ path, action: "replace", content: proposed.serialize(), baseHash: sha256(live) }],
          },
          {
            at: (point) => {
              if (point === "staged-written") writeFileSync(join(dir, path), outside, "utf8");
            },
          },
        ),
      CommitStaleError,
    );

    assert.equal(await readFile(join(dir, path), "utf8"), outside);
  });

  it("rechecks history destinations after staging and preserves a conflicting snapshot", async () => {
    const dir = await makeTempWorld();
    const path = "characters/maren-kest.md";
    const live = await readFile(join(dir, path), "utf8");
    const proposed = MarkdownFile.parse(live);
    proposed.setBody(proposed.body.replace("Salt-crusted braids", "Salt-white braids"));
    const conflictPath = join(dir, ".history/characters/maren-kest/v6.md");

    await assert.rejects(
      () =>
        new Committer(dir, CLOCK).commit(
          {
            kind: "sheet-edit",
            source: "test",
            files: [{ path, action: "replace", content: proposed.serialize(), baseHash: sha256(live) }],
          },
          {
            at: (point) => {
              if (point === "staged-written") {
                mkdirSync(join(conflictPath, ".."), { recursive: true });
                writeFileSync(conflictPath, "conflicting snapshot", "utf8");
              }
            },
          },
        ),
      CommitPlanError,
    );

    assert.equal(await readFile(conflictPath, "utf8"), "conflicting snapshot");
    assert.equal(await readFile(join(dir, path), "utf8"), live);
  });

  it("allocates canon ids monotonically inside the transaction (R-11)", async () => {
    const dir = await makeTempWorld();
    const committer = new Committer(dir, CLOCK);
    const result = await committer.commit({
      kind: "canon-id-allocation",
      source: "test",
      files: [],
      allocateCanonIds: 2,
    });
    assert.deepEqual(result.allocatedCanonIds, ["CANON-072", "CANON-073"]);
    assert.equal((await readWorld(dir))["nextCanonId"], 74);
    const changes = await readChanges(join(dir, "changes.jsonl"));
    const allocs = changes.filter((c) => c["allocation"]);
    assert.equal(allocs.length, 2);
  });

  it("leaves no journal or staging debris after a clean commit", async () => {
    const dir = await makeTempWorld();
    const committer = new Committer(dir, CLOCK);
    await committer.commit({ kind: "canon-id-allocation", source: "test", files: [], allocateCanonIds: 1 });
    const { readdir } = await import("node:fs/promises");
    const journals = (await readdir(join(dir, ".commit")).catch(() => [] as string[])).filter((f) =>
      f.endsWith(".json"),
    );
    assert.deepEqual(journals, []);
    const staged = await readdir(join(dir, ".commit", "staging")).catch(() => [] as string[]);
    assert.deepEqual(staged, [], "per-commit staging directories are removed");
    void stat;
  });
});
