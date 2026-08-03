import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProposalManager } from "../../src/gate/proposals.js";
import { WorldStore } from "../../src/world/store.js";
import { readChanges } from "../../src/world/change-writer.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
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
    assert.equal(proposal.targets[0]!.baseVersion, 4);
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
    assert.equal(store.getBundle().sheets.find((s) => s.id === "maren-kest")!.version, 4, "no version bumped");
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
    assert.deepEqual(first.reservedCanonIds, ["CANON-045"]);
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
    assert.deepEqual(second.reservedCanonIds, ["CANON-046"], "the discarded 045 is a gap, never reissued");
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
    assert.equal(bundle.meta.canonRevision, 43, "one increment for two entries");
    assert.equal(bundle.sheets.find((s) => s.id === "maren-kest")!.version, 5);
    assert.equal(bundle.proposals.length, 1, "only the fixture proposal remains");
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
    assert.equal(doc.data["version"], 6, "v5 was the competing commit; the rebase landed v6");
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
