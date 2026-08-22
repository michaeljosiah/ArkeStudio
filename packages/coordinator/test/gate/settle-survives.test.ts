import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ProposalManager } from "../../src/gate/proposals.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * An accepted change stays accepted, even when its directory will not go away.
 *
 * Driven 2026-08-22 on a brand-new world: all eight sheets the door drafted were committed and
 * all eight stayed on the approvals screen. Removing the proposal directory was the last line of
 * accept, unguarded — and on Windows the drafting agent's own session holds that directory as
 * its working directory, so the delete failed with a busy handle and threw AFTER the commit had
 * landed. The caller saw a failed accept over a world that already had the change, and accepting
 * again found the file live and answered "stale" forever. The commit is the decision; deleting
 * the folder is tidying, and tidying must never be able to undo it.
 */

const CLOCK = () => "2026-08-22T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, gate: new ProposalManager(store) };
}

async function stageOne(gate: ProposalManager) {
  return gate.stage({
    kind: "new-sheet",
    summary: "New character: Ife",
    source: "chat:studio",
    targets: [
      {
        path: "characters/ife.md",
        content: [
          "---",
          "id: ife",
          "type: character",
          "name: Ife",
          "status: sketch",
          "version: 1",
          "created: 2026-08-22",
          "updated: 2026-08-22",
          "canonRules: []",
          "links: []",
          "---",
          "",
          "## Essence",
          "",
          "Eighteen, and already fluent in the arithmetic of other people's days.",
          "",
        ].join("\n"),
      },
    ],
  });
}

describe("an accepted proposal is over, whatever is left on disk", () => {
  it("survives a directory that cannot be deleted, and never comes back as open", async () => {
    const { dir, gate } = await open();
    const staged = await stageOne(gate);

    // Stand in for the busy handle: something inside the directory that refuses to go.
    const locked = join(dir, ".proposals", staged.id, "held-open");
    await mkdir(locked, { recursive: true });
    await writeFile(join(locked, "session.lock"), "held", "utf8");
    const outcome = await gate.accept(staged.id);
    assert.equal(outcome.status, "accepted", "the commit is the decision");

    const live = await readFile(join(dir, "characters", "ife.md"), "utf8");
    assert.match(live, /Eighteen, and already fluent/, "and the world has the change");

    // Whether or not the bytes went, the gate must not offer the decision again.
    const open2 = await gate.listOpen();
    assert.ok(
      !open2.some((p) => p.id === staged.id),
      "a proposal whose change landed is never listed open again",
    );
  });

  it("a tombstone alone retires it, even if the delete never succeeds", async () => {
    const { dir, gate } = await open();
    const staged = await stageOne(gate);
    const accepted = await gate.accept(staged.id);
    assert.equal(accepted.status, "accepted");

    // Re-create the directory the way a failed delete would leave it, tombstone included.
    const proposalDir = join(dir, ".proposals", staged.id);
    await mkdir(proposalDir, { recursive: true });
    await writeFile(
      join(proposalDir, "settled.json"),
      JSON.stringify({ commitId: "cm_whatever", at: CLOCK() }) + "\n",
      "utf8",
    );
    assert.ok(await stat(join(proposalDir, "settled.json")).then(() => true));

    assert.deepEqual(
      (await gate.listOpen()).filter((p) => p.id === staged.id),
      [],
      "the tombstone is what listOpen believes, not the surviving folder",
    );
  });

  it("an ordinary accept still clears its directory completely", async () => {
    const { dir, gate } = await open();
    const staged = await stageOne(gate);
    assert.equal((await gate.accept(staged.id)).status, "accepted");
    await assert.rejects(
      () => stat(join(dir, ".proposals", staged.id)),
      "nothing is left behind when nothing was holding it",
    );
  });
});

/**
 * The other half of the same bug (driven 2026-08-22).
 *
 * When the delete after a commit failed, the proposal came back as open over a world that already
 * had its change. Accepting it again found every target identical, which the gate answered with
 * `no-op` — and left the proposal exactly where it was. Eight of them sat in Needs you across
 * two builds; Accept all did nothing, said nothing, and logged nothing. A decision nobody can
 * make and nobody can clear is not a decision.
 */
describe("a proposal the world already agrees with", () => {
  it("retires instead of asking forever", async () => {
    const { gate } = await open();
    const staged = await stageOne(gate);
    assert.equal((await gate.accept(staged.id)).status, "accepted");

    // Stage the identical sheet again: every target now reads exactly as proposed.
    const again = await stageOne(gate);
    const outcome = await gate.accept(again.id);
    assert.equal(outcome.status, "no-op", "there is genuinely nothing to write");

    assert.ok(
      !(await gate.listOpen()).some((p) => p.id === again.id),
      "and it stops being offered, rather than sitting there unacceptable",
    );
  });

  it("leaves the world exactly as it was", async () => {
    const { dir, gate } = await open();
    const first = await gate.accept((await stageOne(gate)).id);
    assert.equal(first.status, "accepted");
    const after = await readFile(join(dir, "characters", "ife.md"), "utf8");

    await gate.accept((await stageOne(gate)).id);
    assert.equal(
      await readFile(join(dir, "characters", "ife.md"), "utf8"),
      after,
      "retiring the offer is not a write",
    );
  });
});
