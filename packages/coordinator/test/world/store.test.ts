import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tempDir } from "../tmp.js";
import { WorldLockedError } from "../../src/world/lock.js";
import { CrashSignal, Committer } from "../../src/world/commit.js";
import { initialBible } from "../../src/world/bible.js";
import { WorldOpenError, readWorldMeta } from "../../src/world/scan.js";
import { deleteScanState, WorldStore } from "../../src/world/store.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { FIXTURE_WORLD, makeTempWorld } from "./helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("WorldStore (R-3, R-20, R-23, R-26, R-28)", () => {
  it("resolves a missing art-direction file as a visible, non-blank derived v1", async () => {
    const dir = await makeTempWorld();
    await rm(join(dir, "art-direction"), { recursive: true, force: true });
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const direction = store.getBundle().artDirection;
    assert.equal(direction.version, 1);
    assert.equal(direction.derived, true);
    assert.match(direction.description, /quiet dread/);
    assert.equal(direction.masterLook, undefined);
    await store.close();
  });

  it("surfaces uploaded main-photo candidates without accepting them", async () => {
    const dir = await makeTempWorld();
    const candidates = join(dir, "references", "maren-kest", "candidates");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(candidates, { recursive: true });
    await writeFile(join(candidates, "upload-test.png"), "candidate-bytes");
    const store = await WorldStore.open(dir, { clock: CLOCK });
    assert.deepEqual(store.getBundle().referenceCandidates["maren-kest"], [
      "references/maren-kest/candidates/upload-test.png",
    ]);
    assert.notEqual(
      store.getBundle().referenceKits.find((kit) => kit.sheetId === "maren-kest")?.mainPhoto?.file,
      "candidates/upload-test.png",
      "finding the upload does not accept it",
    );
    await store.close();
  });

  it("suppresses a generated source candidate when its immutable take exists", async () => {
    const dir = await makeTempWorld();
    const candidateDir = join(dir, "references", "maren-kest", "candidates");
    const takeDir = join(dir, "references", "maren-kest", "takes", "tk_01J8A0000000000000000000R1");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(candidateDir, { recursive: true });
    await mkdir(takeDir, { recursive: true });
    await writeFile(join(candidateDir, "generated.png"), "duplicate");
    await writeFile(join(takeDir, "generated.png"), "immutable");
    await writeFile(
      join(takeDir, "take.json"),
      JSON.stringify({
        id: "tk_01J8A0000000000000000000R1",
        jobId: "jb_01J8E0000000000000000000J1",
        coversShots: [],
        kind: "main-photo",
        reference: { sheetId: "maren-kest" },
        provider: "fal",
        model: "flux",
        provenance: { canonRevision: 42, sheets: { "maren-kest": 4 } },
        references: [],
        params: { sourceCandidate: "references/maren-kest/candidates/generated.png" },
        cost: { estimatedMicroUsd: 40000, actualMicroUsd: null },
        dispatchedAt: CLOCK(),
        completedAt: CLOCK(),
        media: "generated.png",
      }),
    );
    const store = await WorldStore.open(dir, { clock: CLOCK });
    assert.deepEqual(store.getBundle().referenceCandidates["maren-kest"], undefined);
    assert.equal(store.getBundle().referenceTakes.length, 1);
    await store.close();
  });

  it("enforces single-process ownership and reclaims stale locks (R-3)", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await assert.rejects(() => WorldStore.open(dir, { clock: CLOCK }), WorldLockedError);
    await first.close();

    // A lock naming a dead pid is stale and reclaimed.
    await writeFile(join(dir, "world.lock"), JSON.stringify({ pid: 999999901, startedAt: CLOCK() }), "utf8");
    const second = await WorldStore.open(dir, { clock: CLOCK });
    assert.equal(second.worldId, "01J8F3K2QW9VZX4N7M0RTYB6HC");
    await second.close();
  });

  it("does not release the world lock while an owned write is in flight", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    let finishWrite!: () => void;
    const held = new Promise<void>((resolve) => {
      finishWrite = resolve;
    });
    const write = store.ownedWrite(() => held);
    let closed = false;
    const close = store.close().then(() => {
      closed = true;
    });

    await delay(20);
    assert.equal(closed, false);
    await assert.rejects(() => WorldStore.open(dir, { clock: CLOCK }), WorldLockedError);

    finishWrite();
    await write;
    await close;
    const reopened = await WorldStore.open(dir, { clock: CLOCK });
    await reopened.close();
  });

  it("refuses commit and owned writes after close without running their callbacks", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    await store.close();
    let called = false;

    await assert.rejects(() => store.commit({ kind: "closed-test", source: "test", files: [] }), /closed/);
    await assert.rejects(
      () => store.commitUnserialised({ kind: "closed-test", source: "test", files: [] }),
      /closed/,
    );
    await assert.rejects(() => store.reload(), /closed/);
    await assert.rejects(() => store.reconcileExternalEdit("characters/maren-kest.md"), /closed/);
    await assert.rejects(
      () =>
        store.ownedWrite(async () => {
          called = true;
        }),
      /closed/,
    );
    assert.equal(called, false, "a rejected owned write never reaches the filesystem callback");
    await store.close();
  });

  it("does not expose mutation seams on a read-only store", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { readOnly: true, clock: CLOCK });
    let called = false;
    await assert.rejects(
      () => store.commit({ kind: "read-only-test", source: "test", files: [] }),
      /read-only/,
    );
    await assert.rejects(
      () =>
        store.ownedWrite(async () => {
          called = true;
        }),
      /read-only/,
    );
    await assert.rejects(() => store.reload(), /read-only/);
    assert.equal(called, false);
    await store.close();
  });

  it("opens a world with one malformed sheet, listing the failure (R-2)", async () => {
    const dir = await makeTempWorld();
    await writeFile(join(dir, "characters", "broken.md"), "no frontmatter at all", "utf8");
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const bundle = store.getBundle();
    assert.equal(bundle.problems.length, 1);
    assert.equal(bundle.problems[0]!.path, "characters/broken.md");
    assert.equal(bundle.sheets.length, 12, "the valid entities are usable");
    await store.close();
  });

  it("retires an entity in place — still on disk, still resolvable (R-26)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    await store.retire("characters/the-chorister.md", "test");
    const bundle = store.getBundle();
    const sheet = bundle.sheets.find((s) => s.id === "the-chorister");
    assert.ok(sheet, "retired entity still resolves");
    assert.equal(sheet.retired, true);
    assert.equal(sheet.version, 6, "retirement is a versioned change");
    await store.close();
  });

  it("restores a historical version as a new version (R-20)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    const path = "characters/maren-kest.md";

    // Make v6 so v5 is historical.
    const live = await readFile(join(dir, path), "utf8");
    const doc = MarkdownFile.parse(live);
    doc.setBody(doc.body.replace("Salt-crusted braids", "Iron-grey braids"));
    await store.commit({
      kind: "sheet-edit",
      source: "test",
      files: [{ path, action: "replace", content: doc.serialize(), baseHash: sha256(live) }],
    });

    await store.restoreVersion(path, 5, "test");
    const after = MarkdownFile.parse(await readFile(join(dir, path), "utf8"));
    assert.equal(after.data["version"], 7, "restore produced v7, not a rewrite of v5");
    assert.ok(after.body.includes("Salt-crusted braids"), "content is v5's");
    const v6 = await readFile(join(dir, ".history/characters/maren-kest/v6.md"), "utf8");
    assert.ok(v6.includes("Iron-grey braids"), "v6 remains in history (R-20)");
    await store.close();
  });

  it("reports closed-world edits and adopts them explicitly (R-28, D16)", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();

    // Hand-edit while closed.
    const path = join(dir, "characters", "bray-half-hitch.md");
    const raw = await readFile(path, "utf8");
    await writeFile(path, raw.replace("three belts", "four belts"), "utf8");

    const second = await WorldStore.open(dir, { clock: CLOCK });
    const edits = second.getBundle().externalEdits;
    assert.deepEqual(
      edits.map((e) => e.path),
      ["characters/bray-half-hitch.md"],
    );
    await assert.rejects(
      () => second.commit({ kind: "blocked", source: "test", files: [] }),
      /external edits awaiting reconciliation/,
      "ordinary writes cannot bypass a pending reconciliation",
    );
    await second.close();

    const third = await WorldStore.open(dir, { clock: CLOCK });
    assert.deepEqual(
      third.getBundle().externalEdits.map((e) => e.path),
      ["characters/bray-half-hitch.md"],
      "an unaccepted edit remains pending across close and reopen",
    );

    await third.reconcileExternalEdit("characters/bray-half-hitch.md");
    const bundle = third.getBundle();
    assert.equal(bundle.externalEdits.length, 0);
    const sheet = bundle.sheets.find((s) => s.id === "bray-half-hitch");
    assert.equal(sheet?.version, 7, "adoption bumped the version");
    assert.equal(
      await readFile(join(dir, ".history", "characters", "bray-half-hitch", "v6.md"), "utf8"),
      raw,
      "the outgoing snapshot is the last committed version, not the outside edit",
    );
    assert.match(
      await readFile(join(dir, ".history", "characters", "bray-half-hitch", "v7.md"), "utf8"),
      /four belts/,
      "the adopted edit is filed as the incoming version",
    );
    const changeLine = bundle.changes.findLast((c) => c.entity === "characters/bray-half-hitch");
    assert.equal(changeLine?.source, "external-edit");
    await third.close();
  });

  it("snapshots and journals a sheet deleted outside the app (R-28)", async () => {
    const dir = await makeTempWorld();
    const path = "characters/bray-half-hitch.md";
    const raw = await readFile(join(dir, path), "utf8");
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    await rm(join(dir, path));

    const second = await WorldStore.open(dir, { clock: CLOCK });
    await second.reconcileExternalEdit(path);

    assert.equal(await readFile(join(dir, path), "utf8").catch(() => null), null);
    assert.equal(await readFile(join(dir, ".history/characters/bray-half-hitch/v6.md"), "utf8"), raw);
    const change = second.getBundle().changes.findLast((candidate) => candidate.entity === path.slice(0, -3));
    assert.equal(change?.fromVersion, 6);
    assert.equal(change?.["deleted"], true);
    assert.equal(typeof change?.["commitId"], "string", "deletion used the journalled committer");
    await second.close();
  });

  it("snapshots the committed JSON base when adopting a scene edit", async () => {
    const dir = await makeTempWorld();
    const path = "productions/saltlight/scenes/02-the-tables-say-neap.json";
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    const committed = await readFile(join(dir, path), "utf8");
    const outside = JSON.parse(committed) as Record<string, unknown>;
    outside["title"] = "The tables still say neap";
    await writeFile(join(dir, path), `${JSON.stringify(outside, null, 2)}\n`, "utf8");

    const second = await WorldStore.open(dir, { clock: CLOCK });
    await second.reconcileExternalEdit(path);

    assert.equal(
      await readFile(join(dir, ".history/productions/saltlight/scenes/02-the-tables-say-neap/v3.json"), "utf8"),
      committed,
    );
    const adopted = JSON.parse(await readFile(join(dir, path), "utf8")) as Record<string, unknown>;
    assert.equal(adopted["version"], 4);
    assert.equal(adopted["title"], "The tables still say neap");
    await second.close();
  });

  it("reconstructs a deleted scan state from canonical history", async () => {
    const dir = await makeTempWorld();
    const path = join(dir, "characters", "bray-half-hitch.md");
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    await deleteScanState(dir);
    const committed = await readFile(path, "utf8");
    await writeFile(path, committed.replace("three belts", "four belts"), "utf8");

    const second = await WorldStore.open(dir, { clock: CLOCK });
    assert.deepEqual(second.getBundle().externalEdits.map((edit) => edit.path), [
      "characters/bray-half-hitch.md",
    ]);
    await second.close();
  });

  it("advances an unversioned adoption after point-of-no-return recovery", async () => {
    const dir = await makeTempWorld();
    const path = "productions/saltlight/production.json";
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    const committed = await readFile(join(dir, path), "utf8");
    const outside = committed.replace('"title": "Saltlight"', '"title": "Saltlight revised"');
    await writeFile(join(dir, path), outside, "utf8");

    await assert.rejects(
      () =>
        new Committer(dir, CLOCK).commit(
          {
            kind: "external-edit",
            source: "external-edit",
            files: [
              {
                path,
                action: "replace",
                content: outside,
                baseHash: sha256(outside),
                committedBaseHash: sha256(committed),
              },
            ],
          },
          {
            at: (point) => {
              if (point === "committing-marked") throw new CrashSignal("kill");
            },
          },
        ),
      CrashSignal,
    );

    const recovered = await WorldStore.open(dir, { clock: CLOCK });
    assert.deepEqual(recovered.getBundle().externalEdits, []);
    assert.equal(recovered.getBundle().productions.find((production) => production.meta.id === "saltlight")?.meta.title, "Saltlight revised");
    await recovered.close();
  });

  it("journals a hand-edited bible as the next version on open", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    const original = initialBible("Original author notes.", CLOCK());
    await first.commit({
      kind: "bible-create",
      source: "test",
      files: [{ path: "bible.md", action: "create", content: original, baseHash: null }],
    });
    await first.close();
    await writeFile(join(dir, "bible.md"), original.replace("Original", "Revised"), "utf8");

    const second = await WorldStore.open(dir, { clock: CLOCK });
    assert.equal(second.getBundle().bible.version, 2);
    assert.match(second.getBundle().bible.text, /Revised author notes/);
    assert.equal(await readFile(join(dir, ".history/bible/v1.md"), "utf8"), original);
    await second.close();
  });

  it("does not re-offer an adopted edit recovered after the point of no return", async () => {
    const dir = await makeTempWorld();
    const path = "characters/bray-half-hitch.md";
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    const committed = await readFile(join(dir, path), "utf8");
    const outside = committed.replace("three belts", "four belts");
    await writeFile(join(dir, path), outside, "utf8");

    await assert.rejects(
      () =>
        new Committer(dir, CLOCK).commit(
          {
            kind: "external-edit",
            source: "external-edit",
            files: [
              {
                path,
                action: "replace",
                content: outside,
                baseHash: sha256(outside),
                committedBase: committed,
              },
            ],
          },
          {
            at: (point) => {
              if (point === "committing-marked") throw new CrashSignal("kill");
            },
          },
        ),
      CrashSignal,
    );

    const recovered = await WorldStore.open(dir, { clock: CLOCK });
    assert.deepEqual(recovered.getBundle().externalEdits, []);
    assert.equal(recovered.getBundle().sheets.find((sheet) => sheet.id === "bray-half-hitch")?.version, 7);
    assert.equal(
      recovered.getBundle().changes.filter((change) => change.entity === "characters/bray-half-hitch").at(-1)
        ?.source,
      "external-edit",
    );
    await recovered.close();
  });

  it("clears a waiting edit restored to the committed bytes without cutting a version", async () => {
    const dir = await makeTempWorld();
    const path = join(dir, "characters", "bray-half-hitch.md");
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    const committed = await readFile(path, "utf8");
    await writeFile(path, committed.replace("three belts", "four belts"), "utf8");

    const second = await WorldStore.open(dir, { clock: CLOCK });
    await writeFile(path, committed, "utf8");
    await second.reconcileExternalEdit("characters/bray-half-hitch.md");

    assert.deepEqual(second.getBundle().externalEdits, []);
    assert.equal(second.getBundle().sheets.find((sheet) => sheet.id === "bray-half-hitch")?.version, 6);
    await second.close();
  });

  it("introduces a canon file created outside the app at the next revision", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    const path = "canon/CANON-999.md";
    await writeFile(
      join(dir, path),
      "---\nid: CANON-999\ntype: rule\ntitle: Outside rule\nstatus: settled\nintroducedAt: 0\nlinks: []\n---\n\nCreated outside Arke.\n",
      "utf8",
    );

    const second = await WorldStore.open(dir, { clock: CLOCK });
    await second.reconcileExternalEdit(path);

    const adopted = MarkdownFile.parse(await readFile(join(dir, path), "utf8"));
    assert.equal(adopted.data["introducedAt"], 105);
    assert.equal(adopted.data["amendedAt"], undefined);
    assert.equal(await readFile(join(dir, ".history/canon/CANON-999/v105.md"), "utf8").then(Boolean), true);
    await second.close();
  });

  it("refuses adoption when a legacy baseline has no recoverable committed bytes", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    await rm(join(dir, ".history/characters/bray-half-hitch/v6.md"));
    const path = join(dir, "characters", "bray-half-hitch.md");
    const committed = await readFile(path, "utf8");
    await writeFile(path, committed.replace("three belts", "four belts"), "utf8");

    const second = await WorldStore.open(dir, { clock: CLOCK });
    await second.reconcileExternalEdit("characters/bray-half-hitch.md");
    assert.equal(second.getBundle().externalEdits.length, 1, "refusal preserves the pending edit");
    assert.match(second.getBundle().externalEdits[0]?.refusal ?? "", /last committed version is unavailable/);
    await second.close();
  });

  it("releases ownership when history seeding fails during open", async () => {
    const dir = await makeTempWorld();
    const first = await WorldStore.open(dir, { clock: CLOCK });
    await first.close();
    const live = await readFile(join(dir, "characters/bray-half-hitch.md"), "utf8");
    const snapshot = join(dir, ".history/characters/bray-half-hitch/v6.md");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(snapshot, ".."), { recursive: true });
    await writeFile(snapshot, "conflicting history", "utf8");

    await assert.rejects(() => WorldStore.open(dir, { clock: CLOCK }), /history snapshot conflicts/);
    await writeFile(snapshot, live, "utf8");
    const reopened = await WorldStore.open(dir, { clock: CLOCK });
    await reopened.close();
  });

  it("adopts a world with no history or scan-state as-is (R-28)", async () => {
    const dir = await makeTempWorld();
    const { rm } = await import("node:fs/promises");
    await rm(join(dir, ".index"), { recursive: true, force: true });
    const store = await WorldStore.open(dir, { clock: CLOCK });
    assert.deepEqual(store.getBundle().externalEdits, [], "no scan-state → adopted, not reported");
    await store.close();
  });

  it("survives being moved to a different path (R-24 portability)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    await store.close();

    const newParent = await tempDir("arke-moved-");
    const newDir = join(newParent, "the-undersong-moved");
    await rename(dir, newDir);
    const reopened = await WorldStore.open(newDir, { clock: CLOCK });
    const bundle = reopened.getBundle();
    assert.equal(bundle.sheets.length, 12);
    assert.deepEqual(bundle.problems, []);
    await reopened.close();
  });

  it("refuses a newer schema version without modifying the world (R-25)", async () => {
    const dir = await tempDir("arke-newer-");
    const worldDir = join(dir, "future-world");
    await cp(FIXTURE_WORLD, worldDir, { recursive: true });
    const metaPath = join(worldDir, "world.json");
    const meta = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown>;
    meta["schemaVersion"] = 99;
    const raw = JSON.stringify(meta, null, 2);
    await writeFile(metaPath, raw, "utf8");

    await assert.rejects(() => readWorldMeta(worldDir), WorldOpenError);
    await assert.rejects(() => WorldStore.open(worldDir, { clock: CLOCK }), WorldOpenError);
    assert.equal(await readFile(metaPath, "utf8"), raw, "the world was not modified");
  });

  it("contains no absolute path in any world file (R-24)", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    await store.retire("characters/the-chorister.md", "test");
    await store.close();
    const { readdir } = await import("node:fs/promises");
    const walk = async (d: string): Promise<string[]> => {
      const out: string[] = [];
      for (const entry of await readdir(d, { withFileTypes: true })) {
        const p = join(d, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(p)));
        else if (/\.(md|json|jsonl)$/.test(entry.name)) out.push(p);
      }
      return out;
    };
    for (const file of await walk(dir)) {
      const text = await readFile(file, "utf8");
      assert.ok(!/[A-Za-z]:\\/.test(text), `${file} must not contain a Windows absolute path`);
      assert.ok(!text.includes(tmpdir().replaceAll("\\", "/")), `${file} must not contain the temp root`);
    }
  });
});
