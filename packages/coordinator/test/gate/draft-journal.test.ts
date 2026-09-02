import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DraftUnresolvedError, ProposalManager } from "../../src/gate/proposals.js";
import { draftRecordPath, draftStagingPath, DRAFT_JOURNAL_DIR } from "../../src/gate/draft-journal.js";
import { WorldStore } from "../../src/world/store.js";
import { MarkdownFile, sha256 } from "../../src/world/text-files.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * In-place edits on the approvals screen, and what survives a crash (#70 §11.4.1).
 *
 * The unjournaled write has a window in which the target file has moved on and the manifest has
 * not. Nothing in a passing test suite would notice that window; it only shows up as a proposal
 * whose recorded revision understates what its files say, and the next edit checks itself against
 * exactly that revision. So the interesting tests here are the ones that stop halfway on purpose.
 *
 * The rule the whole thing exists to keep: what the manifest says the draft is, and what the
 * draft's files actually say, never disagree — not after a refusal, not after a crash, and not
 * after the same edit arrives twice.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";
const MAREN = "characters/maren-kest.md";

async function openGate() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store, gate: new ProposalManager(store) };
}

async function stagedProposal(gate: ProposalManager) {
  return gate.stage({ kind: "sheet-edit", summary: "test", source: "test", targets: [{ path: MAREN }] });
}

function proposalDir(dir: string, id: string): string {
  return join(dir, ".proposals", id);
}

async function draftFile(dir: string, id: string): Promise<string> {
  return readFile(join(proposalDir(dir, id), "characters", "maren-kest.md"), "utf8");
}

async function roleOf(dir: string, id: string): Promise<unknown> {
  return MarkdownFile.parse(await draftFile(dir, id)).data["role"];
}

async function journalEntries(dir: string, id: string): Promise<string[]> {
  return readdir(join(proposalDir(dir, id), DRAFT_JOURNAL_DIR)).catch(() => [] as string[]);
}

describe("an in-place edit lands, once", () => {
  it("changes the field and bumps the revision together", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    assert.equal(proposal.draftRevision, 1);

    const outcome = await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-1",
      path: MAREN,
      field: "Role",
      value: "Harbour pilot",
      expectedDraftRevision: 1,
    });

    assert.equal(outcome.status, "updated");
    assert.equal(await roleOf(dir, proposal.id), "Harbour pilot");
    assert.equal(
      (await gate.readManifest(proposal.id)).draftRevision,
      2,
      "the file and the manifest move together",
    );
    await store.close();
  });

  it("leaves no journal behind when it finishes", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-1",
      path: MAREN,
      field: "Role",
      value: "Harbour pilot",
      expectedDraftRevision: 1,
    });
    assert.deepEqual(await journalEntries(dir, proposal.id), [], "a settled edit keeps nothing");
    await store.close();
  });

  it("treats the same request arriving twice as the one edit it is", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    const edit = {
      proposalId: proposal.id,
      requestId: "req-1",
      path: MAREN,
      field: "Role",
      value: "Harbour pilot",
      expectedDraftRevision: 1,
    };
    await gate.updateField(edit);
    // The retry a screen sends after a lost reply carries the same expectation, which is now
    // stale — so without the request id this would come back refused and the person would be
    // told somebody else edited it, when in fact they themselves did.
    const again = await gate.updateField(edit);

    assert.equal(again.status, "updated");
    assert.equal((await gate.readManifest(proposal.id)).draftRevision, 2, "not bumped twice");
    assert.equal(await roleOf(dir, proposal.id), "Harbour pilot");
    await store.close();
  });
});

describe("an edit against a revision somebody else moved on", () => {
  it("is refused rather than merged, and says what the revision now is", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-1",
      path: MAREN,
      field: "Role",
      value: "Harbour pilot",
      expectedDraftRevision: 1,
    });

    // A second window still believes it is revision 1.
    const outcome = await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-2",
      path: MAREN,
      field: "Role",
      value: "Lighthouse keeper",
      expectedDraftRevision: 1,
    });

    assert.equal(outcome.status, "stale");
    if (outcome.status === "stale") assert.equal(outcome.currentDraftRevision, 2, "so the screen can reload");
    assert.equal(await roleOf(dir, proposal.id), "Harbour pilot", "the losing edit changed nothing");
    assert.equal((await gate.readManifest(proposal.id)).draftRevision, 2);
    await store.close();
  });

  it("refuses a field the proposal does not offer, without touching the file", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    const before = await draftFile(dir, proposal.id);

    const outcome = await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-1",
      path: MAREN,
      field: "Secret ledger",
      value: "anything",
      expectedDraftRevision: 1,
    });

    assert.equal(outcome.status, "rejected");
    assert.equal(await draftFile(dir, proposal.id), before);
    assert.equal((await gate.readManifest(proposal.id)).draftRevision, 1, "a refusal is not a revision");
    assert.deepEqual(await journalEntries(dir, proposal.id), [], "and leaves nothing to roll forward");
    await store.close();
  });

  it("refuses a path that is not a target of this proposal", async () => {
    const { store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    const outcome = await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-1",
      path: "characters/somebody-else.md",
      field: "Role",
      value: "x",
      expectedDraftRevision: 1,
    });
    assert.equal(outcome.status, "unknown-target");
    await store.close();
  });
});

describe("an open-choice answer rematerialises through the draft journal", () => {
  it("replaces a reserved create with an amendment, refreshes its base, and is idempotent", async () => {
    const { dir, store, gate } = await openGate();
    closeOnCleanup(() => store.close());
    const existing = store.getBundle().canon[0]!;
    const existingPath = `canon/${existing.id}.md`;
    const live = await readFile(join(dir, existingPath), "utf8");
    const amended = MarkdownFile.parse(live);
    amended.setBody("The amended rule governs the western bell.");
    const candidateId = "cand_01J8F3K2QW9VZX4N7M0RTYB6HC";
    const createdPath = "canon/CANON-999.md";
    const proposal = await gate.stage({
      kind: "worldbuilding",
      summary: "The western bell",
      source: "world-chat:cv_1",
      preReservedCanonIds: ["CANON-999"],
      targets: [
        {
          path: createdPath,
          content: "---\nid: CANON-999\ntype: rule\ntitle: The western bell\nstatus: settled\nintroducedAt: 0\nlinks: []\n---\n\nThe western bell is separate.\n",
        },
      ],
      worldChatOrigins: [
        {
          requestId: "wrap-1",
          conversationId: "cv_1",
          candidateId,
          candidateRevision: 1,
          targetPaths: [createdPath],
          fields: ["title", "statement"],
        },
      ],
      openChoices: [
        {
          choiceId: `duplicate-or-amend:${candidateId}`,
          kind: "duplicate-or-amend",
          question: `Is this new, or a change to ${existing.id}?`,
          options: [
            { optionId: "create", label: "It is new" },
            { optionId: `amend:${existing.id}`, label: `It changes ${existing.id}` },
          ],
        },
      ],
    });
    const answer = {
      proposalId: proposal.id,
      requestId: "choice-1",
      choiceId: `duplicate-or-amend:${candidateId}`,
      optionId: `amend:${existing.id}`,
      expectedDraftRevision: 1,
    };

    const outcome = await gate.resolveOpenChoice(answer, () => ({
      candidateId,
      action: "amend",
      targets: [{ path: existingPath, content: amended.serialize() }],
      fields: ["statement"],
    }));
    assert.equal(outcome.status, "updated");
    const manifest = await gate.readManifest(proposal.id);
    assert.equal(manifest.draftRevision, 2);
    assert.deepEqual(manifest.openChoices, []);
    assert.deepEqual(manifest.targets.map((target) => target.path), [existingPath]);
    assert.equal(manifest.targets[0]!.baseHash, sha256(live), "the amendment is based on the live entry now");
    assert.equal(
      await readFile(join(proposalDir(dir, proposal.id), "_base", existingPath), "utf8"),
      live,
      "the refreshed base travels with the proposal",
    );
    assert.match(await readFile(join(proposalDir(dir, proposal.id), existingPath), "utf8"), /amended rule/);
    assert.ok(await readFile(join(proposalDir(dir, proposal.id), "ripple.json"), "utf8"), "the ripple preview refreshed");

    const retry = await gate.resolveOpenChoice(answer, () => {
      throw new Error("an idempotent retry must not rematerialise");
    });
    assert.equal(retry.status, "updated");
    assert.equal((await gate.readManifest(proposal.id)).draftRevision, 2, "the answer lands once");
    assert.deepEqual(await journalEntries(dir, proposal.id), [], "the settled answer leaves no journal behind");
  });
});

describe("a crash in the middle", () => {
  /**
   * Stop an edit after its record says `committing` but before anything else runs, which is the
   * one window where the target file may already have moved and the manifest has not.
   */
  async function halfDoneEdit(dir: string, gate: ProposalManager, proposalId: string, renameLanded: boolean) {
    const proposal = await gate.readManifest(proposalId);
    const current = await draftFile(dir, proposalId);
    const doc = MarkdownFile.parse(current);
    doc.setData({ role: "Harbour pilot" });
    const next = doc.serialize();

    const operationId = "dop_01J8F3K2QW9VZX4N7M0RTYB6HC";
    const pdir = proposalDir(dir, proposalId);
    await mkdir(join(pdir, DRAFT_JOURNAL_DIR), { recursive: true });
    const record = {
      operationId,
      requestId: "req-crashed",
      proposalId,
      expectedDraftRevision: proposal.draftRevision,
      currentDraftRevision: proposal.draftRevision,
      nextDraftRevision: proposal.draftRevision + 1,
      state: "committing" as const,
      files: [{ path: MAREN, content: next }],
      nextManifest: {
        ...proposal,
        draftRevision: proposal.draftRevision + 1,
        lastDraftRequestId: "req-crashed",
      },
      at: CLOCK(),
    };
    await writeFile(draftRecordPath(pdir, operationId), JSON.stringify(record, null, 2), "utf8");
    if (renameLanded) {
      // The rename already happened; only the manifest and preview did not.
      await writeFile(join(pdir, "characters", "maren-kest.md"), next, "utf8");
    } else {
      await writeFile(draftStagingPath(pdir, operationId, MAREN), next, "utf8");
    }
    return { operationId, next };
  }

  it("rolls a committing operation forward, from before the rename", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    const { next } = await halfDoneEdit(dir, gate, proposal.id, false);

    const recovery = await gate.recoverDrafts(proposal.id);

    assert.equal(recovery.status, "settled");
    assert.equal(recovery.rolledForward, 1);
    assert.equal(await draftFile(dir, proposal.id), next, "the file finishes moving");
    assert.equal((await gate.readManifest(proposal.id)).draftRevision, 2, "and the manifest catches up");
    assert.deepEqual(await journalEntries(dir, proposal.id), []);
    await store.close();
  });

  it("rolls it forward from after the rename too, because it cannot tell which happened", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    const { next } = await halfDoneEdit(dir, gate, proposal.id, true);

    const recovery = await gate.recoverDrafts(proposal.id);

    assert.equal(recovery.status, "settled");
    assert.equal(await draftFile(dir, proposal.id), next);
    assert.equal((await gate.readManifest(proposal.id)).draftRevision, 2);
    await store.close();
  });

  it("is idempotent — recovering twice is recovering once", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    await halfDoneEdit(dir, gate, proposal.id, false);

    await gate.recoverDrafts(proposal.id);
    const afterFirst = await gate.readManifest(proposal.id);
    await gate.recoverDrafts(proposal.id);

    assert.equal(
      (await gate.readManifest(proposal.id)).draftRevision,
      afterFirst.draftRevision,
      "not bumped again",
    );
    await store.close();
  });

  it("drops a prepared-only operation, because none of it landed", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    const before = await draftFile(dir, proposal.id);
    const pdir = proposalDir(dir, proposal.id);
    await mkdir(join(pdir, DRAFT_JOURNAL_DIR), { recursive: true });
    const operationId = "dop_01J8F3K2QW9VZX4N7M0RTYB6HD";
    await writeFile(
      draftRecordPath(pdir, operationId),
      JSON.stringify({
        operationId,
        requestId: "req-abandoned",
        proposalId: proposal.id,
        expectedDraftRevision: 1,
        currentDraftRevision: 1,
        nextDraftRevision: 2,
        state: "prepared",
        files: [{ path: MAREN, content: "never applied" }],
        nextManifest: { ...proposal, draftRevision: 2 },
        at: CLOCK(),
      }),
      "utf8",
    );

    const recovery = await gate.recoverDrafts(proposal.id);

    assert.equal(recovery.dropped, 1);
    assert.equal(recovery.rolledForward, 0);
    assert.equal(await draftFile(dir, proposal.id), before, "an edit that never committed leaves no trace");
    assert.equal((await gate.readManifest(proposal.id)).draftRevision, 1);
    assert.deepEqual(await journalEntries(dir, proposal.id), []);
    await store.close();
  });

  it("recovers before judging the next edit's revision", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    await halfDoneEdit(dir, gate, proposal.id, false);

    // The screen still shows revision 1, because it never saw the crashed edit land.
    const outcome = await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-next",
      path: MAREN,
      field: "Role",
      value: "Lighthouse keeper",
      expectedDraftRevision: 1,
    });

    assert.equal(outcome.status, "stale", "the recovered edit counts, so this one is behind");
    if (outcome.status === "stale") assert.equal(outcome.currentDraftRevision, 2);
    await store.close();
  });
});

describe("an operation whose outcome cannot be determined", () => {
  async function withUnreadableRecord(dir: string, proposalId: string) {
    const pdir = proposalDir(dir, proposalId);
    await mkdir(join(pdir, DRAFT_JOURNAL_DIR), { recursive: true });
    await writeFile(draftRecordPath(pdir, "dop_broken"), "{ this is not json", "utf8");
  }

  it("blocks accept rather than letting it proceed", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    await withUnreadableRecord(dir, proposal.id);

    const outcome = await gate.accept(proposal.id);

    assert.equal(
      outcome.status,
      "draft-unresolved",
      "accepting past an unknown edit writes an unreviewed file",
    );
    await store.close();
  });

  it("blocks a further edit", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    await withUnreadableRecord(dir, proposal.id);

    const outcome = await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-1",
      path: MAREN,
      field: "Role",
      value: "Harbour pilot",
      expectedDraftRevision: 1,
    });

    assert.equal(outcome.status, "draft-unresolved");
    await store.close();
  });

  it("blocks rebase and resolve-conflict, which write the proposal's files", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    await withUnreadableRecord(dir, proposal.id);

    await assert.rejects(() => gate.rebase(proposal.id), DraftUnresolvedError);
    await assert.rejects(
      () => gate.resolveConflict(proposal.id, MAREN, "Role", "mine"),
      DraftUnresolvedError,
    );
    await store.close();
  });

  it("lets everything through again once the record is dealt with", async () => {
    const { dir, store, gate } = await openGate();
    const proposal = await stagedProposal(gate);
    await withUnreadableRecord(dir, proposal.id);
    await rm(draftRecordPath(proposalDir(dir, proposal.id), "dop_broken"));

    const outcome = await gate.updateField({
      proposalId: proposal.id,
      requestId: "req-1",
      path: MAREN,
      field: "Role",
      value: "Harbour pilot",
      expectedDraftRevision: 1,
    });

    assert.equal(outcome.status, "updated");
    await store.close();
  });
});
