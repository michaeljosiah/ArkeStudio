import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentPromptFor,
  confinementFor,
  confinementStatement,
  permits,
  ROSTER,
  ToolIntent,
} from "../src/index.js";

/** The two halves of the statement, read back the way an agent reads them. */
function halves(statement: string): { can: string; cannot: string } {
  const split = statement.indexOf("What you cannot do:");
  assert.ok(split > 0, "the statement has both headings");
  return { can: statement.slice(0, split), cannot: statement.slice(split) };
}

describe("agent confinement (SPEC-005 R-10, R-17)", () => {
  it("lets an authoring agent edit inside its proposal and read the world", () => {
    const authoring = confinementFor({ readOnly: false });
    for (const intent of ["read", "edit", "search", "list", "todo", "world-query", "skill"] as const) {
      assert.equal(permits(authoring, intent), true, `authoring may ${intent}`);
    }
  });

  it("takes editing away entirely from an agent that answers rather than authors (#70 §8.1)", () => {
    const readOnly = confinementFor({ readOnly: true });
    assert.equal(permits(readOnly, "edit"), false, "its propositions go through the accept gate, not the filesystem");
    assert.equal(permits(readOnly, "read"), true);
    assert.equal(permits(readOnly, "world-query"), true, "it still has to be able to check canon");
  });

  it("gives a read-only agent no skill, because nothing is drafted for one to shape (R-17)", () => {
    assert.equal(permits(confinementFor({ readOnly: true }), "skill"), false);
  });

  it("lets neither role delegate — a deliberate change, not a preserved behaviour", () => {
    // v2 denied `subagent` to read-only agents and never granted it to authoring ones; v1 left
    // `task` unlisted for authoring, so it landed on the harness's ask default. There was no
    // single prior behaviour to keep, and v2's stricter reading wins: a child session escapes
    // the per-prompt agent pinning and was observed burning a live turn's budget for nothing.
    assert.equal(permits(confinementFor({ readOnly: false }), "delegate"), false);
    assert.equal(permits(confinementFor({ readOnly: true }), "delegate"), false);
  });

  it("is an allowlist — nothing outside `allow` is permitted, including intents added later", () => {
    for (const agent of [{ readOnly: true }, { readOnly: false }]) {
      const confinement = confinementFor(agent);
      for (const intent of ToolIntent.options) {
        assert.equal(
          permits(confinement, intent),
          confinement.allow.includes(intent),
          `${intent} is decided by the allowlist alone`,
        );
      }
    }
  });

  /**
   * The gap this closes was not a policy anyone chose. "No network" was written as a permanent
   * NEVER in both OpenCode renderers and as an absence from Claude's table, so asking an agent to
   * go and look something up produced a refusal no confinement had decided and none could undo —
   * while the person who asked saw only an agent that would not do as it was told.
   */
  it("lets both roles research online when Settings permits it, and neither when it does not", () => {
    for (const readOnly of [true, false]) {
      assert.equal(permits(confinementFor({ readOnly }, { web: true }), "web"), true);
      assert.equal(permits(confinementFor({ readOnly }, { web: false }), "web"), false);
      assert.equal(
        permits(confinementFor({ readOnly }), "web"),
        false,
        "and a caller that never read settings grants nothing — off is the setting's own default",
      );
    }
  });

  it("takes nothing else away when research is on", () => {
    // The grant is additive: an earlier draft rebuilt the allowlist and it would have been easy
    // to drop an intent while adding one, silently, since every role still has most of them.
    for (const readOnly of [true, false]) {
      const off = confinementFor({ readOnly });
      const on = confinementFor({ readOnly }, { web: true });
      for (const intent of off.allow) assert.equal(permits(on, intent), true, `${intent} survives`);
    }
  });

  it("tells an agent to cite what it read, exactly when it is the one permitted to read", () => {
    for (const member of ROSTER) {
      const cite = /Say the URL you took a claim from/;
      assert.match(
        agentPromptFor({ ...member, researchWeb: true }),
        cite,
        `${member.name} is told to cite a source it fetched`,
      );
      assert.equal(
        cite.test(agentPromptFor({ ...member, researchWeb: false })),
        false,
        `${member.name} is not offered a tool the gate would refuse`,
      );
      // The shipped roster prompt is the research-off one, because that is the shipped setting.
      assert.equal(cite.test(member.prompt), false, `${member.name}'s default prompt stays offline`);
    }
  });

  it("covers every agent actually on the roster, so none falls through to a default", () => {
    for (const member of ROSTER) {
      const confinement = confinementFor(member);
      assert.ok(confinement.allow.length > 0, `${member.name} has a confinement`);
      assert.equal(
        permits(confinement, "edit"),
        member.readOnly !== true,
        `${member.name}'s editing rights follow its readOnly flag, not its name`,
      );
    }
  });
});

/**
 * #506. The gate refused every one of these calls correctly; what was wrong was what the agent
 * said about itself. Asked whether it could run a shell command it said yes and named Git Bash
 * and PowerShell, then reported the output and an exit code of a command that never ran.
 */
describe("what an agent is told about its own confinement (SPEC-005 R-10a)", () => {
  it("puts every intent on exactly one of the two lists, whichever role is asking", () => {
    for (const readOnly of [true, false]) {
      for (const web of [true, false]) {
        const confinement = confinementFor({ readOnly }, { web });
        const { can, cannot } = halves(confinementStatement(confinement));
        for (const intent of ToolIntent.options) {
          const allowed = permits(confinement, intent);
          // Matched on the confinement's own vocabulary, so a phrase that appeared on neither
          // list — the state this whole statement exists to prevent — fails here.
          const phrase = phraseFor(intent);
          assert.equal(can.includes(phrase), allowed, `${intent} is offered iff it is permitted`);
          assert.equal(cannot.includes(phrase), !allowed, `${intent} is denied iff it is refused`);
        }
      }
    }
  });

  it("says there is no shell, and says it as absence rather than as a locked door", () => {
    for (const readOnly of [true, false]) {
      const { cannot } = halves(confinementStatement(confinementFor({ readOnly }, { web: true })));
      assert.match(cannot, /run a shell command/);
      assert.match(cannot, /no Bash, no PowerShell, no terminal/);
      // The measured failure named both shells by name, so both are named back. And the second
      // sentence is the one that matters: an agent that thinks the shell is behind a prompt
      // spends the turn asking for it.
      assert.match(cannot, /there is no such tool here/);
    }
  });

  it("says an unlisted tool is refused outright, so nothing is waited on", () => {
    const { cannot } = halves(confinementStatement(confinementFor({ readOnly: false })));
    assert.match(cannot, /refused outright/);
    assert.match(cannot, /nobody is asked to approve it/);
    // The same turn volunteered that two MCP servers "need authorization before I can reach
    // them". Only arke-world is ever configured, and neither of those two was.
    assert.match(cannot, /MCP server other than arke-world/);
  });

  it("forbids reporting a tool result that never came back", () => {
    const statement = confinementStatement(confinementFor({ readOnly: true }));
    assert.match(statement, /Never describe the result of a tool call you did not make/);
    assert.match(statement, /denied by Arke\s+Studio confinement/, "and says the refusal verbatim");
    assert.match(statement, /exit code/, "the exact shape the fabrication took");
  });

  it("reaches every agent on the roster, including the ones with no proposal directory", () => {
    for (const member of ROSTER) {
      assert.match(member.prompt, /What you cannot do:/, `${member.name} is told its boundary`);
      assert.match(member.prompt, /no Bash, no PowerShell/, `${member.name} is told there is no shell`);
    }
    // The one that got it wrong is the one the proposal preamble skips — it has no proposal
    // directory — which is why this block is gated by nothing.
    const worldBuilder = ROSTER.find((a) => a.name === "world-builder")!;
    assert.equal(worldBuilder.needsProposal, false);
    assert.equal(
      worldBuilder.prompt.includes("You are working inside an Arke Studio proposal directory"),
      false,
      "the preamble does not reach it, and that is exactly the gap",
    );
  });

  it("writes the statement for the confinement the agent actually gets, research included", () => {
    // The invariant that keeps the prompt and the gate from disagreeing: whatever
    // `confinementFor` hands the adapter is what the prompt describes, verbatim.
    for (const member of ROSTER) {
      for (const web of [true, false]) {
        const prompt = agentPromptFor({ ...member, researchWeb: web });
        const expected = confinementStatement(confinementFor(member, { web }));
        assert.ok(prompt.includes(expected), `${member.name} is described by its own confinement`);
        const { can, cannot } = halves(expected);
        const research = "search the public web and read a page from it";
        assert.equal(can.includes(research), web, `${member.name} is offered research iff Settings allows it`);
        assert.equal(cannot.includes(research), !web);
      }
    }
  });
});

/**
 * The phrase the statement uses for one intent, derived the same way the statement derives it —
 * from a confinement that permits exactly that intent and nothing else.
 */
function phraseFor(intent: ToolIntent): string {
  const line = confinementStatement({ allow: [intent] })
    .split("\n")
    .find((l) => l.startsWith("- ") && !l.includes("shell command") && !l.includes("any other tool"));
  assert.ok(line, `the statement has a phrase for ${intent}`);
  return line.slice(2);
}
