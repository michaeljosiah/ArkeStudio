import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ART_DIRECTION_PATH, ArtDirectionRecordSchema } from "@arke-studio/contracts";
import { ProposalManager } from "../../src/gate/proposals.js";
import { projectReview } from "../../src/gate/review.js";
import { WorldStore } from "../../src/world/store.js";
import { readChanges } from "../../src/world/change-writer.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { closeOnCleanup } from "../tmp.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";
const MAREN = "characters/maren-kest.md";

async function openGate() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store, gate: new ProposalManager(store) };
}

async function editedMaren(dir: string, replace: [string, string]): Promise<string> {
  const live = await readFile(join(dir, MAREN), "utf8");
  const doc = MarkdownFile.parse(live);
  doc.setBody(doc.body.replace(replace[0], replace[1]));
  return doc.serialize();
}

describe("proposal lifecycle (R-1..R-4, R-16)", () => {
  it("materialises with bases captured at copy time (R-2) and survives restart (R-16)", async () => {
    const { dir, store, gate } = await openGate();
    const live = await readFile(join(dir, MAREN), "utf8");
    const proposal = await gate.stage({
      kind: "sheet-edit",
      summary: "test",
      source: "test",
      targets: [{ path: MAREN }],
    });
    assert.equal(proposal.targets[0]!.baseVersion, 5);
    assert.equal(proposal.targets[0]!.baseHash, sha256(live));
    assert.ok(await stat(join(dir, ".proposals", proposal.id, "characters", "maren-kest.md")));
    assert.ok(await stat(join(dir, ".proposals", proposal.id, "_base", "characters", "maren-kest.md")));
    await store.close();

    const reopened = await WorldStore.open(dir, { clock: CLOCK });
    const bundle = reopened.getBundle();
    const found = bundle.proposals.find((p) => p.proposal.id === proposal.id);
    assert.ok(found, "the proposal survives restart with its manifest");
    assert.equal(found.proposal.targets[0]!.baseHash, sha256(live));
    await reopened.close();
  });

  it("reports a no-op rather than committing an empty change (R-3)", async () => {
    const { store, gate } = await openGate();
    const proposal = await gate.stage({
      kind: "sheet-edit",
      summary: "no changes",
      source: "test",
      targets: [{ path: MAREN }],
    });
    const outcome = await gate.accept(proposal.id);
    assert.equal(outcome.status, "no-op");
    assert.equal(store.getBundle().sheets.find((s) => s.id === "maren-kest")!.version, 5, "no version bumped");
    await store.close();
  });

  it("discard leaves only a log line, and reserved ids are never reissued (R-4, R-13, D9)", async () => {
    const { dir, store, gate } = await openGate();
    const first = await gate.stage({
      kind: "new-canon",
      summary: "reserve one",
      source: "test",
      targets: [{ path: MAREN }],
      reserveCanonIds: 1,
    });
    assert.deepEqual(first.reservedCanonIds, ["CANON-072"]);
    await gate.discard(first.id);

    await assert.rejects(() => stat(join(dir, ".proposals", first.id)), "the directory is gone");
    const changes = await readChanges(join(dir, "changes.jsonl"));
    assert.ok(changes.some((c) => c["discarded"] === true && String(c["entity"]).includes(first.id)));

    const second = await gate.stage({
      kind: "new-canon",
      summary: "reserve again",
      source: "test",
      targets: [{ path: MAREN }],
      reserveCanonIds: 1,
    });
    assert.deepEqual(second.reservedCanonIds, ["CANON-073"], "the discarded 072 is a gap, never reissued");
    await store.close();
  });

  it("a proposal whose target was retired can only be discarded (§2.11)", async () => {
    const { store, gate } = await openGate();
    const path = "characters/the-chorister.md";
    const proposal = await gate.stage({
      kind: "sheet-edit",
      summary: "edit the chorister",
      source: "test",
      targets: [{ path }],
    });
    await store.retire(path, "test");
    const outcome = await gate.accept(proposal.id);
    assert.equal(outcome.status, "target-retired");
    await store.close();
  });
});

describe("standing constraints through the gate (#244)", () => {
  it("an edit to the description does not quietly revert the policy", async () => {
    // The failure this exists to prevent: the gate rebuilds the record from its arguments, the
    // schema fills its defaults on parse, and a world set to allow-model-score would come back
    // environmental-only — reverted by an edit that never mentioned music, with nothing said.
    // Closed in finally: a leaked store's watcher keeps the event loop alive, and these two
    // tests leaking theirs is what held the whole coordinator suite open — locally and for six
    // billable hours on CI, where the runner had no timeout to save it.
    const { store, gate } = await openGate();
    try {
      const permissive = await gate.stageArtDirectionChange("Score is welcome here.", null, {
        audio: { music: "allow-model-score", subtitles: "never" },
        failureModes: ["Hands stay whole and countable."],
      });
      await gate.accept(permissive.id);
      assert.equal(store.getBundle().artDirection.audio.music, "allow-model-score");

      // Now an ordinary look change that says nothing about policy.
      const unrelated = await gate.stageArtDirectionChange("Ink and wash, colder.", null);
      await gate.accept(unrelated.id);
      const now = store.getBundle().artDirection;
      assert.equal(now.audio.music, "allow-model-score", "carried, not defaulted back");
      assert.deepEqual(now.failureModes, ["Hands stay whole and countable."]);
    } finally {
      await store.close();
    }
  });

  it("keeps the outgoing policy with the version it belonged to", async () => {
    const { store, gate } = await openGate();
    try {
      const first = await gate.stageArtDirectionChange("Score is welcome here.", null, {
        audio: { music: "allow-model-score", subtitles: "never" },
        failureModes: ["Old rule."],
      });
      await gate.accept(first.id);
      const versionWithScore = store.getBundle().artDirection.version;

      const tightened = await gate.stageArtDirectionChange("Now we compose our own.", null, {
        audio: { music: "environmental-only", subtitles: "never" },
        failureModes: ["New rule."],
      });
      await gate.accept(tightened.id);

      const current = store.getBundle().artDirection;
      assert.equal(current.audio.music, "environmental-only");
      assert.deepEqual(current.failureModes, ["New rule."]);
      // History answers "why does that clip from last month have music in it".
      const previous = current.history.find((entry) => entry.version === versionWithScore);
      assert.equal(previous?.audio.music, "allow-model-score", "the version keeps the policy it was made under");
      assert.deepEqual(previous?.failureModes, ["Old rule."]);
    } finally {
      await store.close();
    }
  });
});

describe("accept: one commit, versions derived (R-11, R-12)", () => {
  it("stages art direction without changing the world, then accepts the next immutable version", async () => {
    const { dir, store, gate } = await openGate();
    const before = store.getBundle().artDirection;
    const proposal = await gate.stageArtDirectionChange(
      "Editorial maritime illustration on weathered paper.",
      before.masterLook,
    );

    assert.equal(store.getBundle().artDirection.version, 3, "staging changes nothing downstream");
    assert.equal(store.getBundle().artDirection.description, before.description);
    const staged = store.getBundle().proposals.find((item) => item.proposal.id === proposal.id);
    assert.equal(staged?.artDirection?.version, 4);
    assert.equal(
      staged?.ripple?.items.find((item) => item.kind === "visual-assets-keep-look")?.targets.length,
      before.reach.visualAssets,
      "the proposal and page derive reach from one fact",
    );

    const outcome = await gate.accept(proposal.id);
    assert.equal(outcome.status, "accepted");
    const after = store.getBundle().artDirection;
    assert.equal(after.version, 4);
    assert.equal(after.description, "Editorial maritime illustration on weathered paper.");
    assert.equal(after.history.find((entry) => entry.version === 3)?.description, before.description);
    assert.equal(
      JSON.parse(await readFile(join(dir, "art-direction", "art-direction.json"), "utf8")).version,
      4,
    );
    assert.ok(await stat(join(dir, ".history", "art-direction", "v4.json")));
    await store.close();
  });

  it("lands a sheet and two canon entries as one commit with one revision bump", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await gate.stage({
      kind: "canon-edit",
      summary: "mixed",
      source: "test",
      targets: [{ path: MAREN }, { path: "canon/CANON-001.md" }, { path: "canon/CANON-007.md" }],
    });
    // Edit all three inside the proposal.
    await gate.updateFile(proposal.id, MAREN, await editedMaren(dir, ["Salt-crusted", "Salt-white"]));
    for (const canonPath of ["canon/CANON-001.md", "canon/CANON-007.md"]) {
      const raw = await readFile(join(dir, ".proposals", proposal.id, canonPath), "utf8");
      const doc = MarkdownFile.parse(raw);
      doc.setBody(doc.body + "\nAmended.");
      await gate.updateFile(proposal.id, canonPath, doc.serialize());
    }

    let commits = 0;
    const original = store.commitUnserialised.bind(store);
    store.commitUnserialised = async (input, hooks) => {
      commits++;
      return original(input, hooks);
    };

    const outcome = await gate.accept(proposal.id);
    assert.equal(outcome.status, "accepted");
    assert.equal(commits, 1, "exactly one commit() call (R-11)");
    const bundle = store.getBundle();
    assert.equal(bundle.meta.canonRevision, 105, "one increment for two entries");
    assert.equal(bundle.sheets.find((s) => s.id === "maren-kest")!.version, 6);
    assert.equal(bundle.proposals.length, 2, "only the fixture proposals remain");
    await store.close();
  });

  it("production metadata commits without a version bump (R-12)", async () => {
    const { dir, store, gate } = await openGate();
    const path = "productions/saltlight/production.json";
    const live = await readFile(join(dir, path), "utf8");
    const next = live.replace('"in-progress"', '"cutting"');
    const proposal = await gate.stage({
      kind: "scene-edit",
      summary: "status",
      source: "test",
      targets: [{ path, content: next }],
    });
    const outcome = await gate.accept(proposal.id);
    assert.equal(outcome.status, "accepted");
    const meta = JSON.parse(await readFile(join(dir, path), "utf8")) as Record<string, unknown>;
    assert.equal(meta["status"], "cutting");
    assert.equal("version" in meta, false, "unversioned per §2.4.1");
    await store.close();
  });
});

/**
 * The world look is the one proposal target that is not Markdown, and the generic gate assumed
 * everything was. Both of these are about the JSON surviving a path built for prose.
 */
describe("a world look through the generic gate", () => {
  /**
   * Move the world's look on without staging a second proposal.
   *
   * Only one look change may wait at a time now, so a test that needs a *stale* proposal cannot
   * make one by staging a rival — it writes the next accepted look straight to disk, which is what
   * another accept would have left behind anyway.
   */
  async function moveLookOn(dir: string, description: string): Promise<void> {
    const path = join(dir, "art-direction", "art-direction.json");
    const current = JSON.parse(await readFile(path, "utf8")) as {
      version: number;
      description: string;
      acceptedAt: string;
      history: Array<{ version: number; description: string; acceptedAt: string }>;
    };
    const next = {
      version: current.version + 1,
      description,
      acceptedAt: CLOCK(),
      history: [
        ...current.history,
        { version: current.version, description: current.description, acceptedAt: current.acceptedAt },
      ],
    };
    await writeFile(path, `${JSON.stringify(next, null, 2)}
`, "utf8");
  }

  /** An open store holds the event loop, so a failure before close hangs the file (see test/tmp). */
  async function openGateSafely() {
    const opened = await openGate();
    closeOnCleanup(() => opened.store.close());
    return opened;
  }

  it("shows the proposed look on the review, rather than an empty one", async () => {
    const { dir, gate } = await openGateSafely();
    const proposal = await gate.stageArtDirectionChange(
      "Painterly and hand-animated, with visible brushwork.",
      null,
    );
    const staged = await readFile(join(dir, ".proposals", proposal.id, "art-direction", "art-direction.json"), "utf8");

    const review = projectReview({
      proposal,
      proposed: (path) => (path === ART_DIRECTION_PATH ? staged : null),
      base: () => null,
    });

    const target = review.targets.find((t) => t.path === ART_DIRECTION_PATH);
    assert.ok(target, "the look is a reviewable target, not a file the panel silently skips");
    const look = target.fields.find((f) => f.field === "Look");
    assert.ok(look, "and its description is the field a reviewer has to read before accepting");
    assert.match(look.proposed ?? "", /visible brushwork/);
  });

  /*
   * A world always has a look, even before it has a file for one: until somebody changes it, the
   * look is derived from the world's tone and genre. So the first change stages as a create with
   * no base, and the review showed a new art direction with no `was` — never naming the words
   * about to be replaced, which are the only reason to read the screen.
   */
  it("names the inherited look a first change replaces", async () => {
    const { dir, gate } = await openGateSafely();
    const inherited = JSON.parse(await readFile(join(dir, "art-direction", "art-direction.json"), "utf8")) as {
      description: string;
    };
    await rm(join(dir, "art-direction", "art-direction.json"));

    const proposal = await gate.stageArtDirectionChange("Painterly, with visible brushwork.", null);
    const staged = await readFile(join(dir, ".proposals", proposal.id, "art-direction", "art-direction.json"), "utf8");

    const review = projectReview({ proposal, proposed: () => staged, base: () => null });
    const target = review.targets.find((t) => t.path === ART_DIRECTION_PATH);
    assert.equal(target?.action, "amend", "changing the look is an amendment even the first time");
    const look = target?.fields.find((f) => f.field === "Look");
    assert.equal(look?.before, inherited.description, "the words being replaced are on the screen");
    assert.match(look?.proposed ?? "", /visible brushwork/);
  });

  /*
   * Staged when the world had no look at all, and one exists by the time it is rebased.
   *
   * `base` is null for a create, and the create branch returns before anything else runs — so
   * this used to refresh the hash and leave a record whose version and history had been computed
   * against nothing, presented for review as though it followed the look now on disk.
   */
  it("a rebase keeps the policy the proposal decided, and files the live one under its version", async () => {
    // The third rebuilder, after the gate and the commit (#244). Dropping the fields here would
    // revert a policy specifically when two people touched the look at once — the case nobody
    // re-reads afterwards, because the rebase already said it handled it.
    const { dir, gate, store } = await openGateSafely();

    // Somebody else lands a permissive policy while my proposal is open.
    const theirs = await gate.stageArtDirectionChange("Score is welcome.", null, {
      audio: { music: "allow-model-score", subtitles: "never" },
      failureModes: ["Live rule."],
    });
    await gate.accept(theirs.id);
    const liveVersion = store.getBundle().artDirection.version;

    // Mine was staged to tighten it, and now has to be restated onto theirs.
    const mine = await gate.stageArtDirectionChange("Ink and wash.", null, {
      audio: { music: "environmental-only", subtitles: "never" },
      failureModes: ["My rule."],
    });
    const { conflicts } = await gate.rebase(mine.id);
    assert.deepEqual(conflicts, []);

    const restated = JSON.parse(
      await readFile(join(dir, ".proposals", mine.id, "art-direction", "art-direction.json"), "utf8"),
    ) as {
      audio: { music: string };
      failureModes: string[];
      history: Array<{ version: number; audio: { music: string }; failureModes: string[] }>;
    };
    assert.equal(restated.audio.music, "environmental-only", "my decision survives the restatement");
    assert.deepEqual(restated.failureModes, ["My rule."]);
    const theirEntry = restated.history.find((entry) => entry.version === liveVersion);
    assert.equal(theirEntry?.audio.music, "allow-model-score", "and theirs goes to history under its own version");
    assert.deepEqual(theirEntry?.failureModes, ["Live rule."]);
  });

  it("restates a look staged before the world had one", async () => {
    const { dir, gate } = await openGateSafely();
    const noLook = join(dir, "art-direction", "art-direction.json");
    const had = await readFile(noLook, "utf8");
    await rm(noLook);

    const mine = await gate.stageArtDirectionChange("Painterly, with visible brushwork.", null);
    assert.equal(mine.targets[0]!.baseHash, null, "staged as a create, because there was no look");

    // The look exists again — as though another proposal created it first.
    await writeFile(noLook, had, "utf8");
    const { conflicts } = await gate.rebase(mine.id);
    assert.deepEqual(conflicts, []);

    const restated = JSON.parse(
      await readFile(join(dir, ".proposals", mine.id, "art-direction", "art-direction.json"), "utf8"),
    ) as { version: number; history: Array<{ version: number }> };
    const live = JSON.parse(had) as { version: number };
    assert.equal(restated.version, live.version + 1, "it follows the look that is actually there now");
    assert.ok(
      restated.history.some((h) => h.version === live.version),
      "and that look is in its history rather than nowhere",
    );
  });

  /*
   * The look file deleted, and the staged document unreadable.
   *
   * Restating is what a look rebase does, and with nothing to restate the code fell through to the
   * branch for a file this proposal creates: no conflict reported, the malformed document kept,
   * and a rebase that came back clean. Accept then threw inside the commit gate, and the conflict
   * controls had nothing to offer because no conflict had ever been raised.
   */
  it("blocks a look that cannot be restated after the live one was deleted", async () => {
    const { dir, store, gate } = await openGateSafely();
    const mine = await gate.stageArtDirectionChange("Painterly, with visible brushwork.", null);

    // The world's look file goes; the world still has a look, derived from its tone and genre.
    await rm(join(dir, "art-direction", "art-direction.json"));
    const staged = join(dir, ".proposals", mine.id, "art-direction", "art-direction.json");
    await writeFile(staged, "{ this is not a look", "utf8");

    const { conflicts } = await gate.rebase(mine.id);
    assert.equal(conflicts.length, 1, "a rebase that could not restate anything is not a clean rebase");
    assert.equal(conflicts[0]!.field, "Look");
    await gate.markSeen(mine.id);
    assert.equal(
      (await gate.accept(mine.id, {})).status,
      "unresolved-conflicts",
      "and having been seen is not enough — it cannot be accepted into a throw in the commit gate",
    );

    // The side offered is a look the world can be given, rather than the document that will not
    // parse — without which the repair controls are two buttons and no way out but discarding.
    const theirs = ArtDirectionRecordSchema.parse(JSON.parse(conflicts[0]!.theirs ?? ""));
    assert.equal(conflicts[0]!.mine, "{ this is not a look");
    await assert.rejects(
      () => gate.resolveConflict(mine.id, ART_DIRECTION_PATH, "Look", "mine"),
      /cannot be read as a world look/,
      "and the unreadable side is still refused, rather than reported as resolved",
    );

    await gate.resolveConflict(mine.id, ART_DIRECTION_PATH, "Look", "theirs");
    // Losing the file moved what this change reaches, so the ripple is restated before it lands —
    // the ordinary path for a proposal whose world changed under it, and not what is under test.
    const restated = await gate.accept(mine.id, {});
    assert.equal(restated.status, "needs-reconfirm");
    assert.equal(
      (await gate.accept(mine.id, restated.status === "needs-reconfirm" ? { confirmRipples: restated.signature } : {}))
        .status,
      "accepted",
    );
    assert.equal(store.getBundle().artDirection.description, theirs.description, "and it is a look again");
  });

  /*
   * When one side will not parse there is a conflict, and choosing a side takes that whole
   * document. Sent through the Markdown resolver instead, the chosen JSON came back wrapped in
   * frontmatter — no longer readable as a look, produced by the control offered to repair it.
   */
  it("resolves a look conflict to a document that is still a look", async () => {
    const { dir, gate } = await openGateSafely();
    const mine = await gate.stageArtDirectionChange("Painterly, with visible brushwork.", null);

    // The staged side is the unreadable one this time, so the live look can still be chosen.
    const staged = join(dir, ".proposals", mine.id, "art-direction", "art-direction.json");
    await writeFile(staged, "{ this is not a look", "utf8");
    await writeFile(
      join(dir, "art-direction", "art-direction.json"),
      await readFile(join(dir, ".proposals", mine.id, "_base", "art-direction", "art-direction.json"), "utf8"),
      "utf8",
    );
    // Move the live look on so the rebase is not a no-op.
    await moveLookOn(dir, "Ink and wash.");

    const { conflicts } = await gate.rebase(mine.id);
    assert.equal(conflicts.length, 1, "a side has to be chosen; it cannot be merged");
    assert.equal(conflicts[0]!.field, "Look");

    await gate.resolveConflict(mine.id, ART_DIRECTION_PATH, "Look", "theirs");

    const resolved = await readFile(staged, "utf8");
    assert.doesNotMatch(resolved, /^---/, "no frontmatter was wrapped around it");
    const record = ArtDirectionRecordSchema.parse(JSON.parse(resolved));
    assert.match(record.description, /Ink and wash/, "and it is the side that was chosen");
  });

  /*
   * The commit gate parses the live record before writing the next version, so with an unreadable
   * one on disk neither side can actually be accepted. Offering a choice that reports success and
   * then cannot commit is worse than refusing: the file has to be repaired first, and only this
   * says so.
   */
  it("refuses to resolve a look conflict while the live look is unreadable", async () => {
    const { dir, gate } = await openGateSafely();
    const mine = await gate.stageArtDirectionChange("Painterly, with visible brushwork.", null);

    await writeFile(join(dir, "art-direction", "art-direction.json"), "{ this is not a look", "utf8");
    const { conflicts } = await gate.rebase(mine.id);
    assert.equal(conflicts.length, 1);

    await assert.rejects(
      () => gate.resolveConflict(mine.id, ART_DIRECTION_PATH, "Look", "mine"),
      /repair the file first/,
    );
  });

  /*
   * The number a person reads before accepting. It counted only takes already pinned to an older
   * look — the consequence of the *previous* change — while the takes made under the look being
   * replaced, usually the ones they are thinking of, become pinned the moment this lands.
   */
  it("counts takes made under the current look as pinned by this change", async () => {
    const { store, gate } = await openGateSafely();
    // Delegating rather than snapshotting: staging refreshes the real bundle, and a frozen copy
    // would not contain the proposal this test then looks for.
    const realBundle = store.getBundle.bind(store);
    store.getBundle = () => {
      const bundle = realBundle();
      return {
        ...bundle,
        artDirection: {
          ...bundle.artDirection,
          reach: { ...bundle.artDirection.reach, earlierAcceptedTakes: 2, acceptedTakesAtCurrentVersion: 3 },
        },
      };
    };

    const proposal = await gate.stageArtDirectionChange("Ink and wash.", null);
    const staged = store.getBundle().proposals.find((item) => item.proposal.id === proposal.id);
    const pinned = staged?.ripple?.items.find((item) => item.kind === "takes-pinned-to-old-version");
    assert.equal(pinned?.targets.length, 5, "the two already behind, and the three about to be");
    assert.match(pinned?.summary ?? "", /^5 accepted takes/);
  });

  it("rebases by restating the look, not by merging it as prose", async () => {
    const { dir, store, gate } = await openGateSafely();
    const mine = await gate.stageArtDirectionChange("Painterly and hand-animated, with visible brushwork.", null);

    // Somebody else's look lands first, so mine is stale.
    await moveLookOn(dir, "Ink and wash: brush contour, washed tone.");

    assert.equal((await gate.accept(mine.id, {})).status, "stale");
    const { conflicts } = await gate.rebase(mine.id);
    assert.deepEqual(conflicts, [], "there is nothing to merge — a look is one whole description");

    await gate.markSeen(mine.id);
    assert.equal((await gate.accept(mine.id, {})).status, "accepted");

    const record = store.getBundle().artDirection;
    assert.match(record.description, /visible brushwork/, "the look that was proposed is the look that landed");
    assert.equal(record.version, 5, "the fixture's look was v3, theirs landed v4, and this follows it");
    assert.ok(
      record.history.some((h) => /Ink and wash/.test(h.description)),
      "the look it replaced stays in history, because accepted takes are pinned to it",
    );
  });
});

describe("staleness and rebase (R-5..R-7, R-15)", () => {
  it("refuses a stale accept, rebases disjoint edits silently, then lands both (R-5, R-6)", async () => {
    const { dir, store, gate } = await openGate();
    // Proposal A edits Appearance.
    const a = await gate.stage({
      kind: "sheet-edit",
      summary: "appearance",
      source: "a",
      targets: [{ path: MAREN }],
    });
    await gate.updateFile(a.id, MAREN, await editedMaren(dir, ["Salt-crusted braids", "Iron-grey braids"]));

    // A competing commit lands first, touching a different section.
    const live = await readFile(join(dir, MAREN), "utf8");
    const competing = MarkdownFile.parse(live);
    competing.setBody(competing.body.replace("Low and even.", "Lower than the tide."));
    await store.commit({
      kind: "sheet-edit",
      source: "b",
      files: [{ path: MAREN, action: "replace", content: competing.serialize(), baseHash: sha256(live) }],
    });

    const refused = await gate.accept(a.id);
    assert.equal(refused.status, "stale");

    const { conflicts } = await gate.rebase(a.id);
    assert.deepEqual(conflicts, [], "disjoint edits merge without intervention");

    const pending = await gate.accept(a.id);
    assert.equal(pending.status, "pending-review", "a rebase must be seen before accept (R-7)");
    await gate.markSeen(a.id);

    const outcome = await gate.accept(a.id);
    assert.equal(outcome.status, "accepted");
    const final = await readFile(join(dir, MAREN), "utf8");
    assert.ok(final.includes("Iron-grey braids"), "the proposal's edit landed");
    assert.ok(final.includes("Lower than the tide."), "the competing edit survived");
    const doc = MarkdownFile.parse(final);
    assert.equal(doc.data["version"], 7, "v6 was the competing commit; the rebase landed v7");
    await store.close();
  });

  it("same-field competition conflicts, resolves by choice, then lands (R-6, D4)", async () => {
    const { dir, store, gate } = await openGate();
    const a = await gate.stage({
      kind: "sheet-edit",
      summary: "mine",
      source: "a",
      targets: [{ path: MAREN }],
    });
    await gate.updateFile(a.id, MAREN, await editedMaren(dir, ["Salt-crusted braids", "Iron-grey braids"]));

    const live = await readFile(join(dir, MAREN), "utf8");
    const competing = MarkdownFile.parse(live);
    competing.setBody(competing.body.replace("Salt-crusted braids", "White braids"));
    await store.commit({
      kind: "sheet-edit",
      source: "b",
      files: [{ path: MAREN, action: "replace", content: competing.serialize(), baseHash: sha256(live) }],
    });

    const { conflicts } = await gate.rebase(a.id);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.field, "Appearance");

    const blocked = await gate.accept(a.id);
    assert.equal(blocked.status, "pending-review");
    await gate.markSeen(a.id);
    const stillBlocked = await gate.accept(a.id);
    assert.equal(stillBlocked.status, "unresolved-conflicts");

    await gate.resolveConflict(a.id, MAREN, "Appearance", "mine");
    const outcome = await gate.accept(a.id);
    assert.equal(outcome.status, "accepted");
    assert.ok((await readFile(join(dir, MAREN), "utf8")).includes("Iron-grey braids"));
    await store.close();
  });

  it("verifies bases under the lock even after rebase bookkeeping (hand edit between)", async () => {
    const { dir, store, gate } = await openGate();
    const a = await gate.stage({
      kind: "sheet-edit",
      summary: "x",
      source: "a",
      targets: [{ path: MAREN }],
    });
    await gate.updateFile(a.id, MAREN, await editedMaren(dir, ["Salt-crusted", "Salt-white"]));
    // Hand edit the live file directly — no commit, just bytes moving (R-5's second cause).
    const live = await readFile(join(dir, MAREN), "utf8");
    await writeFile(join(dir, MAREN), live + "\n<!-- hand edit -->\n", "utf8");
    const refused = await gate.accept(a.id);
    assert.equal(refused.status, "stale");
    await store.close();
  });
});

describe("ripples: preview and authority (R-8..R-10)", () => {
  it("previews from the index and re-confirms on a material difference (R-9, R-10, D6)", async () => {
    const { dir, store, gate } = await openGate();
    const a = await gate.stage({
      kind: "sheet-edit",
      summary: "appearance",
      source: "a",
      targets: [{ path: MAREN }],
    });
    await gate.updateFile(a.id, MAREN, await editedMaren(dir, ["Salt-crusted", "Salt-white"]));

    const staged = store.getBundle().proposals.find((p) => p.proposal.id === a.id);
    assert.ok(staged?.ripple, "a preview was computed at materialisation");
    assert.ok(
      staged.ripple.items.some((i) => i.kind === "stale-reference-tiles"),
      "the fixture's v4/v3 tiles show as stale against v5",
    );

    // Change the world so the authoritative set materially differs: lock the draft tile at v4.
    const kitPath = join(dir, "references", "maren-kest", "kit.json");
    const kit = JSON.parse(await readFile(kitPath, "utf8")) as {
      tiles: Array<{ angle: string; status: string; sheetVersion?: number }>;
    };
    kit.tiles = kit.tiles.filter((t) => t.angle !== "body-full");
    await writeFile(kitPath, JSON.stringify(kit, null, 2), "utf8");
    await store.reload(); // structural change → index resyncs

    const blocked = await gate.accept(a.id);
    assert.equal(blocked.status, "needs-reconfirm", "tile count changed: 3 → 2 (category count)");
    assert.ok(blocked.status === "needs-reconfirm" && blocked.signature.length > 0);

    const outcome = await gate.accept(a.id, {
      confirmRipples: blocked.status === "needs-reconfirm" ? blocked.signature : "",
    });
    assert.equal(outcome.status, "accepted", "echoing the authoritative signature lands it");
    await store.close();
  });
});

describe("role on the form edit path (SPEC-007 R-18)", () => {
  /** The sections the form always sends back — unchanged, so only role can move. */
  async function marenSections(dir: string) {
    const doc = MarkdownFile.parse(await readFile(join(dir, MAREN), "utf8"));
    return doc.sections().map((s) => ({ heading: s.heading, body: s.body }));
  }

  async function stagedFrontmatter(dir: string, id: string): Promise<Record<string, unknown>> {
    const raw = await readFile(join(dir, ".proposals", id, "characters", "maren-kest.md"), "utf8");
    return MarkdownFile.parse(raw).data;
  }

  it("writes role into the staged frontmatter, leaving the rest of it alone", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await gate.stageSheetEdit(
      MAREN,
      "Edit Maren Kest",
      await marenSections(dir),
      "form",
      "Tide-caller of the Vigil",
    );
    const data = await stagedFrontmatter(dir, proposal.id);
    assert.equal(data.role, "Tide-caller of the Vigil");
    assert.equal(data.billing, "lead", "the neighbouring keys survive the edit (SPEC-002 R-6)");
    assert.ok(data.voice, "voice assignment is untouched");
    await store.close();
  });

  it("trims the role rather than storing the author's stray whitespace", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await gate.stageSheetEdit(MAREN, "e", await marenSections(dir), "form", "  Tide-caller  ");
    assert.equal((await stagedFrontmatter(dir, proposal.id)).role, "Tide-caller");
    await store.close();
  });

  it("clears the key entirely rather than writing an empty string", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await gate.stageSheetEdit(MAREN, "e", await marenSections(dir), "form", "   ");
    const data = await stagedFrontmatter(dir, proposal.id);
    assert.ok(!("role" in data), "an empty role reads back as truthy and hides the 'no role yet' state");
    await store.close();
  });

  it("leaves role untouched when the form did not edit it", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await gate.stageSheetEdit(MAREN, "e", await marenSections(dir), "form");
    assert.equal((await stagedFrontmatter(dir, proposal.id)).role, "Tide-caller");
    await store.close();
  });
});

describe("the gate bounds authored roles (SPEC-007 R-18)", () => {
  const OVER = "x".repeat(29);

  /** Stage a raw sheet edit the way a drafting agent writes one: straight into the proposal. */
  async function stageRaw(dir: string, gate: ProposalManager, mutate: (doc: MarkdownFile) => void) {
    const live = await readFile(join(dir, MAREN), "utf8");
    const doc = MarkdownFile.parse(live);
    mutate(doc);
    return gate.stage({
      kind: "sheet-edit",
      summary: "agent draft",
      source: "chat:studio",
      targets: [{ path: MAREN, content: doc.serialize() }],
    });
  }

  it("refuses a proposal whose role is over the cap", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stageRaw(dir, gate, (doc) => doc.setData({ role: OVER }));
    const outcome = await gate.accept(proposal.id);
    assert.equal(outcome.status, "invalid", "the agent writes its own files; the gate is the only chokepoint");
    assert.equal(outcome.status === "invalid" && outcome.problems.length, 1);
    assert.match(
      outcome.status === "invalid" ? outcome.problems[0]!.message : "",
      /29 characters; the limit is 28/,
      "the refusal names the number so it can be acted on",
    );
    assert.equal(store.getBundle().sheets.find((s) => s.id === "maren-kest")!.version, 5, "nothing landed");
    await store.close();
  });

  it("accepts a role exactly at the cap", async () => {
    const { dir, store, gate } = await openGate();
    const atCap = "y".repeat(28);
    const proposal = await stageRaw(dir, gate, (doc) => doc.setData({ role: atCap }));
    assert.equal((await gate.accept(proposal.id)).status, "accepted");
    assert.equal(store.getBundle().sheets.find((s) => s.id === "maren-kest")!.role, atCap);
    await store.close();
  });

  it("still accepts an edit to a sheet whose role was already over the cap", async () => {
    // The read path is deliberately permissive (R-18), so a world may already hold a long role.
    // Refusing every later edit to that sheet would strand it, uneditable, on a rule that
    // postdates it — the proposal is judged on what it CHANGES, not on what it carries.
    const { dir, store, gate } = await openGate();
    await writeFile(
      join(dir, MAREN),
      MarkdownFile.parse(await readFile(join(dir, MAREN), "utf8")).serialize().replace("role: Tide-caller", `role: ${OVER}`),
      "utf8",
    );
    await store.reload();

    const proposal = await stageRaw(dir, gate, (doc) => doc.setBody(doc.body.replace("Salt-crusted", "Salt-white")));
    const outcome = await gate.accept(proposal.id);
    assert.equal(outcome.status, "accepted", "the prose edit lands; the untouched long role rides along");
    assert.equal(store.getBundle().sheets.find((s) => s.id === "maren-kest")!.role, OVER);
    await store.close();
  });

  it("refuses when a proposal changes an over-cap role to a different over-cap role", async () => {
    const { dir, store, gate } = await openGate();
    await writeFile(
      join(dir, MAREN),
      MarkdownFile.parse(await readFile(join(dir, MAREN), "utf8")).serialize().replace("role: Tide-caller", `role: ${OVER}`),
      "utf8",
    );
    await store.reload();

    const proposal = await stageRaw(dir, gate, (doc) => doc.setData({ role: "z".repeat(40) }));
    assert.equal((await gate.accept(proposal.id)).status, "invalid", "rewriting it is an authoring act, and is judged");
    await store.close();
  });

  it("leaves locations and factions alone — role is a character field", async () => {
    const { dir, store, gate } = await openGate();
    const path = "locations/the-vigil.md";
    const doc = MarkdownFile.parse(await readFile(join(dir, path), "utf8"));
    doc.setData({ role: OVER });
    const proposal = await gate.stage({
      kind: "sheet-edit",
      summary: "odd but not this rule's business",
      source: "test",
      targets: [{ path, content: doc.serialize() }],
    });
    assert.equal((await gate.accept(proposal.id)).status, "accepted");
    await store.close();
  });
});
