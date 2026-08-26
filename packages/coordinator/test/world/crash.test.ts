import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CrashSignal, Committer, type CommitInput } from "../../src/world/commit.js";
import { appendChanges, readChanges } from "../../src/world/change-writer.js";
import { scanWorld } from "../../src/world/scan.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { makeTempWorld } from "./helpers.js";

/**
 * The crash-safety suite (SPEC-002 §3.2): kill at every step of a multi-file commit, run
 * recovery, and assert the world is in exactly one of the two valid states — wholly old or
 * wholly new — with history, world.json and the change log in step (R-15).
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

const KILL_POINTS = [
  "prepared-written",
  "snapshots-written",
  "staged-written",
  "committing-marked",
  "snapshots-installed",
  "renamed:0",
  "renamed:1",
  "renamed:2",
  "world-renamed",
  "changes-appended",
] as const;

interface Prepared {
  dir: string;
  input: CommitInput;
  oldSheet: string;
  oldCanon: string;
  newSheetBody: string;
  /**
   * Read off the fixture rather than written down here. This file asserts that recovery lands
   * wholly on one side of a commit, which is a claim about *before and after*, not about any
   * particular number — and hardcoding the numbers made a growing fixture look like a recovery
   * bug nine times over.
   */
  baseRevision: number;
  baseSheetVersion: number;
}

async function prepare(): Promise<Prepared> {
  const dir = await makeTempWorld();
  const sheetPath = "characters/maren-kest.md";
  const canonPath = "canon/CANON-002.md";
  const oldSheet = await readFile(join(dir, sheetPath), "utf8");
  const oldCanon = await readFile(join(dir, canonPath), "utf8");
  const baseRevision = (
    JSON.parse(await readFile(join(dir, "world.json"), "utf8")) as { canonRevision: number }
  ).canonRevision;
  const baseSheetVersion = Number(MarkdownFile.parse(oldSheet).data["version"]);

  const sheetDoc = MarkdownFile.parse(oldSheet);
  const newSheetBody = sheetDoc.body.replace("Salt-crusted braids", "Salt-white braids");
  sheetDoc.setBody(newSheetBody);
  const canonDoc = MarkdownFile.parse(oldCanon);
  canonDoc.setBody(canonDoc.body + "\nAmended under test.");
  const canonNew =
    "---\nid: CANON-072\ntype: rule\ntitle: The test rule\nstatus: settled\nintroducedAt: 0\nlinks: []\n---\n\nA rule created mid-crash.\n";

  const input: CommitInput = {
    kind: "mixed",
    source: "crash-test",
    files: [
      { path: sheetPath, action: "replace", content: sheetDoc.serialize(), baseHash: sha256(oldSheet) },
      { path: canonPath, action: "replace", content: canonDoc.serialize(), baseHash: sha256(oldCanon) },
      { path: "canon/CANON-072.md", action: "create", content: canonNew, baseHash: null },
    ],
  };
  return { dir, input, oldSheet, oldCanon, newSheetBody, baseRevision, baseSheetVersion };
}

async function assertConsistent(p: Prepared): Promise<"old" | "new"> {
  const world = JSON.parse(await readFile(join(p.dir, "world.json"), "utf8")) as { canonRevision: number };
  const sheet = await readFile(join(p.dir, "characters/maren-kest.md"), "utf8");
  const canon = await readFile(join(p.dir, "canon/CANON-002.md"), "utf8");
  const created = await readFile(join(p.dir, "canon/CANON-072.md"), "utf8").catch(() => null);
  const changes = await readChanges(join(p.dir, "changes.jsonl"));
  const commitLines = changes.filter((c) => c["source"] === "crash-test");

  if (world.canonRevision === p.baseRevision + 1) {
    // The new state — every part of it, not some (R-15).
    assert.ok(sheet.includes("Salt-white braids"), "sheet is new");
    assert.ok(canon.includes("Amended under test."), "canon is new");
    assert.ok(created !== null, "created entry exists");
    assert.equal(commitLines.length, 3, "the change log records the commit exactly once");
    assert.ok(
      await readFile(join(p.dir, `.history/characters/maren-kest/v${p.baseSheetVersion}.md`), "utf8"),
      "outgoing snapshot exists",
    );
    return "new";
  }
  assert.equal(world.canonRevision, p.baseRevision, "world.json is wholly old");
  assert.equal(sheet, p.oldSheet, "sheet is byte-identical to before");
  assert.equal(canon, p.oldCanon, "canon is byte-identical to before");
  assert.equal(created, null, "no created entry");
  assert.equal(commitLines.length, 0, "no change line from the failed commit");
  return "old";
}

describe("kill-at-every-step recovery (R-15)", () => {
  for (const point of KILL_POINTS) {
    it(`killed at ${point} → recovery leaves exactly one valid state`, async () => {
      const p = await prepare();
      const committer = new Committer(p.dir, CLOCK);
      await assert.rejects(
        () =>
          committer.commit(p.input, {
            at: (where) => {
              if (where === point) throw new CrashSignal(`killed at ${where}`);
            },
          }),
        CrashSignal,
      );

      // Next open: recovery runs before anything reads.
      const recovered = new Committer(p.dir, CLOCK);
      const actions = await recovered.recover();

      const state = await assertConsistent(p);
      const beforePointOfNoReturn = point === "prepared-written" || point === "snapshots-written" || point === "staged-written";
      if (beforePointOfNoReturn) {
        assert.equal(state, "old", `${point} is before committing — roll back (R-15)`);
        assert.ok(actions.some((a) => a.action === "rolled-back"));
      } else {
        assert.equal(state, "new", `${point} is at/after committing — roll forward`);
        assert.ok(actions.some((a) => a.action === "rolled-forward"));
      }

      // Recovery is idempotent and the world scans clean afterwards.
      assert.deepEqual(await recovered.recover(), []);
      const { problems } = await scanWorld(p.dir);
      assert.deepEqual(problems, []);
    });
  }

  it("rolled-back worlds are byte-identical including history — no stray snapshots", async () => {
    const p = await prepare();
    const currentSnapshot = join(p.dir, `.history/characters/maren-kest/v${p.baseSheetVersion}.md`);
    await mkdir(join(p.dir, ".history/characters/maren-kest"), { recursive: true });
    await writeFile(currentSnapshot, p.oldSheet, "utf8");
    const committer = new Committer(p.dir, CLOCK);
    await assert.rejects(
      () =>
        committer.commit(p.input, {
          at: (where) => {
            if (where === "staged-written") throw new CrashSignal("kill");
          },
        }),
      CrashSignal,
    );
    await new Committer(p.dir, CLOCK).recover();
    assert.equal(
      await readFile(currentSnapshot, "utf8"),
      p.oldSheet,
      "prepared rollback leaves a history snapshot that predated the transaction intact",
    );
  });

  it("recovers a same-version history refresh after snapshots are installed", async () => {
    const dir = await makeTempWorld();
    const path = "productions/the-ledger-of-nights/chapters/01-neap.md";
    const live = await readFile(join(dir, path), "utf8");
    const next = MarkdownFile.parse(live);
    next.setBody(`${next.body}\n\nA same-version continuation.`);
    const committer = new Committer(dir, CLOCK);

    await assert.rejects(
      () =>
        committer.commit(
          {
            kind: "chapter-save",
            source: "crash-test",
            files: [
              {
                path,
                action: "replace",
                content: next.serialize(),
                baseHash: sha256(live),
                preserveVersion: true,
              },
            ],
          },
          {
            at: (point) => {
              if (point === "snapshots-installed") throw new CrashSignal("kill");
            },
          },
        ),
      CrashSignal,
    );

    await new Committer(dir, CLOCK).recover();
    assert.match(await readFile(join(dir, path), "utf8"), /same-version continuation/);
    assert.match(
      await readFile(join(dir, ".history/productions/the-ledger-of-nights/chapters/01-neap/v4.md"), "utf8"),
      /same-version continuation/,
    );
  });

  it("repairs a partial multi-line audit append without duplicating completed records", async () => {
    const p = await prepare();
    await assert.rejects(
      () =>
        new Committer(p.dir, CLOCK).commit(p.input, {
          at: (point) => {
            if (point === "world-renamed") throw new CrashSignal("kill");
          },
        }),
      CrashSignal,
    );
    const journalName = (await readdir(join(p.dir, ".commit"))).find((entry) => entry.endsWith(".json"))!;
    const journal = JSON.parse(await readFile(join(p.dir, ".commit", journalName), "utf8")) as {
      changes: object[];
    };
    const changesPath = join(p.dir, "changes.jsonl");
    await appendChanges(changesPath, [journal.changes[0]!]);
    const partial = JSON.stringify(journal.changes[1]!);
    await appendFile(changesPath, partial.slice(0, Math.floor(partial.length / 2)), "utf8");

    await new Committer(p.dir, CLOCK).recover();

    const lines = (await readChanges(changesPath)).filter((line) => line["source"] === "crash-test");
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((line) => line["commitIndex"]), [0, 1, 2]);
  });

  it("migrates a protocol-v1 prepared journal without deleting its outgoing snapshot", async () => {
    const p = await prepare();
    await assert.rejects(
      () =>
        new Committer(p.dir, CLOCK).commit(p.input, {
          at: (point) => {
            if (point === "snapshots-written") throw new CrashSignal("kill");
          },
        }),
      CrashSignal,
    );
    const journalName = (await readdir(join(p.dir, ".commit"))).find((entry) => entry.endsWith(".json"))!;
    const journalPath = join(p.dir, ".commit", journalName);
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      protocolVersion?: number;
      phase: string;
      files: Array<{ historyPrev: string | null; historyNew: string | null; prevContent?: string; newContent?: string }>;
    };
    assert.equal(journal.phase, "planning", "new journals are safe for an older reader to discard");
    delete journal.protocolVersion;
    journal.phase = "prepared";
    for (const file of journal.files) {
      if (file.historyPrev && file.prevContent) {
        await mkdir(join(p.dir, file.historyPrev, ".."), { recursive: true });
        await writeFile(join(p.dir, file.historyPrev), file.prevContent, "utf8");
      }
      if (file.historyNew && file.newContent) {
        await mkdir(join(p.dir, file.historyNew, ".."), { recursive: true });
        await writeFile(join(p.dir, file.historyNew), file.newContent, "utf8");
      }
    }
    await writeFile(journalPath, JSON.stringify(journal), "utf8");

    await new Committer(p.dir, CLOCK).recover();

    assert.equal(
      await readFile(join(p.dir, `.history/characters/maren-kest/v${p.baseSheetVersion}.md`), "utf8"),
      p.oldSheet,
    );
    await assert.rejects(() => readFile(join(p.dir, `.history/characters/maren-kest/v${p.baseSheetVersion + 1}.md`)));
    await rm(join(p.dir, ".commit"), { recursive: true, force: true });
  });
});
