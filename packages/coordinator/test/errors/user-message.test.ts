import assert from "node:assert/strict";
import { it } from "node:test";
import { describeCoordinatorError } from "../../src/errors/user-message.js";
import { CommitPlanError, CommitStaleError } from "../../src/world/commit.js";

it("gives every CommitStaleError one universal, plain sentence", () => {
  const err = new CommitStaleError([{ path: "references/tunde/kit.json", expected: "abc", found: "def" }]);
  assert.match(err.message, /staleness is detected, never merged/); // the raw message stays dev-facing
  assert.equal(describeCoordinatorError(err), "Something changed while this was saving — try again.");
});

it("gives a persistent history conflict a repair-oriented sentence, not a retry", () => {
  const err = new CommitPlanError("characters/maren-kest.md: history snapshot conflicts with this commit");
  const copy = describeCoordinatorError(err);
  assert.match(copy, /doesn't match what Arke Studio expected/);
  assert.equal(/try again/i.test(copy), false, "retrying a damaged snapshot deterministically fails again");
});

it("gives a staging-window race the retry sentence, since retrying is the actual remedy", () => {
  const err = new CommitPlanError("characters/maren-kest.md: history snapshot moved while this commit was staged");
  assert.equal(describeCoordinatorError(err), "Something changed while this was saving — try again.");
});

it("points a hand-edited world at reviewing the outside edits, not at reopening", () => {
  const err = new CommitPlanError("world has external edits awaiting reconciliation");
  const copy = describeCoordinatorError(err);
  assert.match(copy, /outside Arke Studio/);
  assert.match(copy, /review/i);
  assert.equal(/reopen/i.test(copy), false, "reopening does not clear the write gate");
});

it("gives the internal-invariant CommitPlanError variants a safe generic sentence, never their own jargon", () => {
  const messages = [
    "callers never write world.json; the committer owns it",
    "characters/maren-kest.md: create requires content",
    "characters/maren-kest.md: binary content cannot bypass versioned records",
    "characters/maren-kest.md: a committed base is only valid for an outside edit",
  ];
  for (const message of messages) {
    const copy = describeCoordinatorError(new CommitPlanError(message));
    assert.equal(copy.includes("commit"), false, `"${copy}" still names the commit machinery`);
    assert.equal(copy.includes(".md"), false, `"${copy}" still names a file path`);
  }
});

it("passes an already-plain CommitPlanError message through unchanged", () => {
  assert.equal(describeCoordinatorError(new CommitPlanError("a world needs a name")), "a world needs a name");
});

it("falls back to the shared translator for every other error", () => {
  const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  assert.equal(describeCoordinatorError(enoent), "That file no longer exists.");
  assert.equal(describeCoordinatorError(new Error("the world has no name yet")), "the world has no name yet");
});

it("redacts a local disk path from an fs error this module does not otherwise recognize", () => {
  const err = new Error(
    "EIO: i/o error, read 'C:\\Users\\alex\\AppData\\Roaming\\Arke Studio\\worlds\\w1\\productions\\p1\\performance.json'",
  );
  assert.equal(describeCoordinatorError(err), "Something went wrong. Try again.");
});
