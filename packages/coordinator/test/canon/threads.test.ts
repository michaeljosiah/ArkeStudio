import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openThread, stageCanonEntry, stageThreadSettlement } from "../../src/canon/authoring.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { searchCanon } from "../../src/index-db/queries.js";
import { WorldStore } from "../../src/world/store.js";
import { MarkdownFile } from "../../src/world/text-files.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store, gate: new ProposalManager(store) };
}

describe("threads (R-14..R-16, D5, D6)", () => {
  it("opens a thread with its id allocated now, revision moved once, citable immediately", async () => {
    const { store, gate } = await open();
    const revisionBefore = store.getBundle().meta.canonRevision;
    const { entryId } = await openThread(store, gate, {
      title: "Who pays the Vigil watch?",
      question: "The watch is a civic office — but who actually pays the wages?",
      candidates: ["CANON-019", "CANON-001"],
    });
    assert.equal(entryId, "CANON-045", "allocated from nextCanonId");
    const bundle = store.getBundle();
    const entry = bundle.canon.find((c) => c.id === entryId);
    assert.equal(entry?.type, "thread");
    assert.equal(entry?.status, "open");
    assert.equal(bundle.meta.canonRevision, revisionBefore + 1, "one revision for the opening");
    assert.ok(entry?.body.includes("CANON-019"), "the candidates travelled with it");
    await store.close();
  });

  it("never retrieves a thread as an answer (R-16, D5)", async () => {
    const { store, gate } = await open();
    await openThread(store, gate, {
      title: "Does the tide tithe fund the watch?",
      question: "Tide tithe watch wages — the exact vocabulary a later question would use.",
      candidates: [],
    });
    const index = store.getIndex()!;
    const result = searchCanon(index.db, "tide tithe watch wages");
    assert.ok(
      result.candidates.every((c) => c.entryId !== "CANON-045"),
      "the thread shares the vocabulary and still never surfaces",
    );
    // The fixture's own open thread is excluded too, and the searched count says so honestly.
    assert.ok(result.candidates.every((c) => c.entryId !== "CANON-044"));
    assert.equal(result.searched, 5, "6 entries minus the open thread");
    await store.close();
  });

  it("settles through the gate: type resolves, status settles, settledAt stamped, one revision", async () => {
    const { dir, store, gate } = await open();
    const revisionBefore = store.getBundle().meta.canonRevision;
    const staged = await stageThreadSettlement(store, gate, {
      entryId: "CANON-044",
      resolvedType: "lore",
      statement: "The Chorister was taught by the god itself, in the winter it walked in.",
    });
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted");

    const raw = await readFile(join(dir, "canon", "CANON-044.md"), "utf8");
    const doc = MarkdownFile.parse(raw);
    assert.equal(doc.data["status"], "settled");
    assert.equal(doc.data["type"], "lore");
    assert.equal(doc.data["settledAt"], revisionBefore + 1, "the committer stamped the settlement");
    assert.equal(store.getBundle().meta.canonRevision, revisionBefore + 1);

    // Settled now, it retrieves.
    const result = searchCanon(store.getIndex()!.db, "Chorister taught god winter");
    assert.ok(result.candidates.some((c) => c.entryId === "CANON-044"));
    await store.close();
  });

  it("stages a new settled entry with a pre-reserved id (R-1)", async () => {
    const { store, gate } = await open();
    const staged = await stageCanonEntry(store, gate, {
      entryType: "rule",
      title: "The tithe is paid at slack water",
      statement: "No tithe changes hands while the tide is moving.",
    });
    assert.deepEqual(staged.reservedCanonIds, ["CANON-045"]);
    assert.equal(staged.targets[0]!.path, "canon/CANON-045.md");
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted");
    const entry = store.getBundle().canon.find((c) => c.id === "CANON-045");
    assert.equal(entry?.status, "settled");
    assert.equal(entry?.introducedAt, store.getBundle().meta.canonRevision);
    await store.close();
  });

  it("a retired entry resolves for citations but never retrieves (R-19, D9)", async () => {
    const { store } = await open();
    await store.retire("canon/CANON-002.md", "test");
    const bundle = store.getBundle();
    assert.equal(bundle.canon.find((c) => c.id === "CANON-002")?.retired, true, "still resolvable");
    const result = searchCanon(store.getIndex()!.db, "tide calling stood in");
    assert.ok(result.candidates.every((c) => c.entryId !== "CANON-002"), "absent from retrieval");
    assert.equal(result.searched, 4, "5 searchable minus the retired one");
    await store.close();
  });
});
