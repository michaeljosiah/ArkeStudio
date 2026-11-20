import assert from "node:assert/strict";
import { it } from "node:test";
import { BibleEditError, SceneOperationRefused } from "@arke-studio/contracts";
import { describeRefusal } from "../../src/errors/refusal.js";
import { EditorRequestRefused } from "../../src/productions/editor-requests.js";
import { MusicRefusal } from "../../src/productions/music.js";
import { SceneDeleteRefused } from "../../src/productions/ops.js";
import { SceneCommandRefused, SceneVersionMoved } from "../../src/productions/scene-commands.js";
import { SceneEditRefused } from "../../src/productions/scene-edits.js";
import { AudioSpineCommandRefused } from "../../src/productions/spine.js";
import { TimelineCommandRefused } from "../../src/productions/timeline.js";
import { BibleStaleError } from "../../src/world/bible.js";
import { CommitPlanError, CommitStaleError } from "../../src/world/commit.js";
import { WorldStateStaleError } from "../../src/world/store.js";

const ANCHORED = "shot 1 is anchored to the track — move or clear the anchor first";

// The reason a card failed, on the day it was found: one clause from the authority, which the
// card replaced with "The authority failed while executing the approved action." (issue 3135).
it("says a refused shot deletion as the sentence the authority wrote", () => {
  assert.equal(describeRefusal(new SceneCommandRefused([ANCHORED])), "Shot 1 is anchored to the track — move or clear the anchor first.");
});

it("says several blockers as that many sentences, and counts the ones past six", () => {
  assert.equal(
    describeRefusal(new SceneCommandRefused([ANCHORED, "shot 2 has an accepted take — reject it first, or the footage is left belonging to nothing"])),
    "Shot 1 is anchored to the track — move or clear the anchor first. Shot 2 has an accepted take — reject it first, or the footage is left belonging to nothing.",
  );
  assert.equal(
    describeRefusal(new SceneDeleteRefused(Array.from({ length: 8 }, (_, index) => `shot ${index + 1} has an accepted take`))),
    `${Array.from({ length: 6 }, (_, index) => `Shot ${index + 1} has an accepted take.`).join(" ")} And 2 more.`,
  );
});

it("reads every refusal an approved card's authority throws on purpose", () => {
  const refusals: Array<[Error, string]> = [
    [new SceneOperationRefused(["a scene needs at least one shot"]), "A scene needs at least one shot."],
    [new SceneVersionMoved(3, 4), "The scene moved from v3 to v4 while this edit was being made — it was not overwritten."],
    [new SceneEditRefused("The scene changed while you were answering, so it was left alone."), "The scene changed while you were answering, so it was left alone."],
    [new AudioSpineCommandRefused("the command changes nothing"), "The command changes nothing."],
    [new TimelineCommandRefused("the timeline moved from revision 2 to 3"), "The timeline moved from revision 2 to 3."],
    [new EditorRequestRefused("the timeline is invalid and cannot take a request"), "The timeline is invalid and cannot take a request."],
    [new MusicRefusal("that take has not finished"), "That take has not finished."],
    [new BibleEditError("Rules", 'the bible has no section headed "Rules"'), 'The bible has no section headed "Rules".'],
    [new BibleStaleError(3, 4), "The bible moved from v3 to v4 while this change was being made — it was not overwritten."],
    [new WorldStateStaleError("The scene changed after this card was prepared."), "The scene changed after this card was prepared."],
    // Its own message names the commit machinery and a file; `describeCoordinatorError` has the sentence.
    [new CommitStaleError([{ path: "productions/p1/spine.json", expected: "abc", found: "def" }]), "Something changed while this was saving — try again."],
  ];
  for (const [refusal, shown] of refusals) assert.equal(describeRefusal(refusal), shown, refusal.name);
});

it("keeps an id that opens a reason as it is written", () => {
  const reason = "sh_01J8G000000000000000000001 overlaps sh_01J8G000000000000000000002 by 1.000s";
  assert.equal(describeRefusal(new AudioSpineCommandRefused(reason)), `${reason}.`);
  assert.equal(describeRefusal(new SceneCommandRefused(['"intro copy" is not a scene file name'])), '"intro copy" is not a scene file name.');
});

it("answers null for anything that is not a refusal, whatever its message says", () => {
  // A plain Error may be a sentence or a file that would not read; nothing tells the two apart.
  for (const error of [new Error("That scene is no longer in this production."), new TypeError("x is undefined"),
    new CommitPlanError("characters/maren-kest.md: create requires content"), "a thrown string", undefined, null]) {
    assert.equal(describeRefusal(error), null);
  }
});

it("answers null for a refusal that quotes a path off the disk", () => {
  const refusal = new SceneCommandRefused([
    "the selections for p1 could not be read, so this shot's selection cannot be removed with it: EIO: i/o error, read 'C:\\Users\\alex\\worlds\\w1\\productions\\p1\\selections.json'",
  ]);
  assert.equal(describeRefusal(refusal), null);
});
