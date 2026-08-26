import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { refusalLabel, wordRefusals } from "../../src/world-chat/project.js";

/**
 * What a person is shown when the confinement refused something (SPEC-005 R-10b, R-16, issue 506).
 *
 * The line exists to be read against the reply above it. Its whole job is to let "I ran it, exit
 * 0" be recognised as false, so it has to name the capability the reply is claiming — not the
 * tool, which R-16 forbids showing, and not the adapter's summary, which is operator text.
 */
describe("wording a refusal", () => {
  it("names a shell as running a command, whichever shell it was", () => {
    for (const tool of ["Bash", "bash", "PowerShell", "BashOutput", "KillShell"]) {
      assert.equal(refusalLabel(tool), "run a command on your computer", tool);
    }
  });

  it("never puts a harness tool name in front of a person (R-16)", () => {
    /*
     * The failure this guards is a label reading "refused Bash" — a name from a vocabulary that
     * is not this product's, which the person has no way to interpret.
     *
     * `Read`, `Write` and `Edit` are excluded, not overlooked: their names are also this
     * product's own plain verbs, so "read a file outside this conversation" is the right sentence
     * and happens to contain one of them.
     */
    for (const tool of ["Bash", "PowerShell", "WebSearch", "WebFetch", "Glob", "Task", "Unheard"]) {
      const label = refusalLabel(tool);
      assert.equal(label.toLowerCase().includes(tool.toLowerCase()), false, `${tool} is not echoed`);
      assert.ok(label.length > 0);
    }
  });

  it("says a refused read as a place, because the place is what was wrong with it", () => {
    // The intent is permitted for both roles; the path was outside the working directory. Saying
    // "read a file" would report a refusal of something the agent may plainly do.
    assert.equal(refusalLabel("Read"), "read a file outside this conversation");
    assert.equal(refusalLabel("Write"), "write a file outside this conversation");
  });

  it("folds the MCP namespace, so a namespaced tool is not a stranger", () => {
    // opencode keys MCP tools `${server}_${tool}`; the same suffix rule `workingLabel` needs.
    assert.equal(refusalLabel("arke-world_websearch"), "search online");
  });

  it("falls back rather than inventing, for a tool no table has heard of", () => {
    assert.equal(refusalLabel("ScheduleWakeup"), "use a tool it does not have");
  });

  it("says one thing once, however many tools said it", () => {
    assert.deepEqual(wordRefusals(["Bash", "PowerShell", "BashOutput"]), ["run a command on your computer"]);
    assert.deepEqual(wordRefusals([]), []);
  });

  it("keeps distinct refusals distinct", () => {
    assert.deepEqual(wordRefusals(["Bash", "WebSearch"]), [
      "run a command on your computer",
      "search online",
    ]);
  });
});
