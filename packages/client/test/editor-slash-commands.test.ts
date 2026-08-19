import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  filterSlashCommands,
  matchSlashTrigger,
  moveSelection,
  SLASH_COMMANDS,
  SLASH_QUERY_MAX_LENGTH,
} from "../src/components/editor/slash-commands.js";

describe("the block menu", () => {
  it("opens on a slash at the start of a block", () => {
    assert.equal(matchSlashTrigger("/"), "");
    assert.equal(matchSlashTrigger("/head"), "head");
    assert.equal(matchSlashTrigger("  /quote"), "quote", "leading whitespace is still a block start");
  });

  it("stays shut for a slash inside a sentence", () => {
    for (const typed of [
      "the harbour and/or the verse",
      "written 12/05",
      "see docs/bible",
      "a line then /quote",
    ]) {
      assert.equal(matchSlashTrigger(typed), null, `"${typed}" must not open the menu`);
    }
  });

  it("closes once the query stops looking like a label", () => {
    assert.equal(matchSlashTrigger("/head "), null, "a space ends it");
    assert.equal(matchSlashTrigger("/head/er"), null, "and so does a second slash");
  });

  it("ignores a pasted paragraph that happens to begin with a slash", () => {
    assert.equal(matchSlashTrigger(`/${"a".repeat(SLASH_QUERY_MAX_LENGTH + 1)}`), null);
  });

  it("matches on labels and on the words people reach for instead", () => {
    const ids = (query: string) => filterSlashCommands(SLASH_COMMANDS, query).map((c) => c.id);
    assert.deepEqual(ids("todo"), ["task-list"], "nobody calls it a check list first");
    assert.deepEqual(ids("h2"), ["heading-2"]);
    assert.ok(ids("list").includes("bullet-list") && ids("list").includes("ordered-list"));
    assert.deepEqual(ids("zzz"), []);
    assert.equal(filterSlashCommands(SLASH_COMMANDS, "").length, SLASH_COMMANDS.length);
  });

  it("wraps the selection at both ends", () => {
    assert.equal(moveSelection(0, -1, 4), 3, "arrowing up from the top lands on the bottom");
    assert.equal(moveSelection(3, 1, 4), 0, "and down from the bottom lands on the top");
    assert.equal(moveSelection(0, 1, 0), 0, "with no rows there is nowhere to go");
  });

  it("groups every row under a heading the menu can draw", () => {
    for (const command of SLASH_COMMANDS) {
      assert.ok(command.group, `${command.id} needs a group`);
      assert.ok(command.label, `${command.id} needs a label`);
    }
  });
});
