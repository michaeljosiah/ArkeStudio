import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  confinementFor,
  confinementStatement,
  ToolIntent,
  type AgentConfinement,
  type HarnessEvent,
} from "@arke-studio/contracts";
import { ClaudeAdapter, decideTool, type RunQuery } from "../src/index.js";
import { tempDir } from "./tmp.js";

/**
 * The confinement is a place as well as a verb.
 *
 * `ToolIntent.read` was specified as "read a file inside the working directory" and only the
 * first half was enforced: the gate matched tool NAMES, so `Read` mapped to `read`, both roles
 * permit `read`, and the argument naming the file went straight back out untouched. Proven by
 * having World Chat — the read-only role, the MORE restricted one — read a sentinel out of
 * `%LOCALAPPDATA%\Temp` while confined to a proposal directory.
 *
 * These run against REAL directories. Symlink resolution and case folding are properties of a
 * filesystem, and a boundary tested only against invented path strings is a boundary tested
 * against the version of the world where it already works.
 */

/** A real directory to be confined to; paths are resolved against it and symlinks followed. */
const CWD = await tempDir("arke-claude-root-");

const authoring = confinementFor({ readOnly: false });
const readOnly = confinementFor({ readOnly: true });

const decide = (confinement: AgentConfinement, tool: string, input: Record<string, unknown>) =>
  decideTool(confinement, tool, { input, root: CWD });

/** Scripted SDK messages, plus a hook onto the options the adapter actually passed. */
function fakeQuery(): { run: RunQuery; options: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const run: RunQuery = ({ prompt, options }) => {
    captured = options;
    return (async function* () {
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next();
      yield { type: "result", subtype: "success", is_error: false, result: "done" };
    })();
  };
  return { run, options: () => captured };
}

type Gate = (n: string, i: Record<string, unknown>) => Promise<{ behavior: string; message?: string }>;

describe("what a permitted tool may be pointed at", () => {
  it("lets a permitted tool work inside the working directory", async () => {
    assert.deepEqual(await decide(readOnly, "Read", { file_path: join(CWD, "notes.md") }), { allow: true });
    assert.deepEqual(await decide(authoring, "Write", { file_path: join(CWD, "new", "sheet.md") }), { allow: true });
  });

  it("resolves a relative argument against the working directory rather than refusing it", async () => {
    // A relative path in a tool call MEANS relative to the working directory. Refusing it would
    // be a false refusal; resolving it against process.cwd() would be a real hole.
    assert.deepEqual(await decide(readOnly, "Read", { file_path: "notes.md" }), { allow: true });
  });

  it("refuses the read that proved this bug: a permitted intent aimed outside the directory", async () => {
    const outside = await tempDir("arke-claude-outside-");
    const decision = await decide(readOnly, "Read", { file_path: join(outside, "credentials.txt") });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, "outside");
    assert.equal(decision.reason === "outside" && decision.intent, "read");
  });

  it("refuses the write the same reasoning predicts, which is worse than the read", async () => {
    // World Chat's write refusal came from the role allowlist — READ_ONLY has no `edit` — and
    // said nothing about paths. AUTHORING does allow `edit`, so the identical hole let it create
    // a file anywhere on the disk. The target does not exist yet, which is the ordinary case for
    // Write and the one a naive realpath() throws on.
    const outside = await tempDir("arke-claude-outside-");
    const decision = await decide(authoring, "Write", { file_path: join(outside, "not-yet.txt") });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, "outside");
  });

  it("refuses a traversal back out through the directory it started in", async () => {
    const decision = await decide(readOnly, "Read", { file_path: join(CWD, "..", "elsewhere.txt") });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, "outside");
  });

  it("requires a separator boundary, so a sibling sharing the name's prefix is outside", async () => {
    // `cv_1-evil` starts with `cv_1`, and these working directories are named `cv_<id>`. A bare
    // startsWith would call the sibling inside — the failure the string test always has.
    const sibling = `${CWD}-evil`;
    await mkdir(sibling, { recursive: true });
    try {
      const decision = await decide(readOnly, "Read", { file_path: join(sibling, "sibling.txt") });
      assert.equal(decision.allow, false);
      assert.equal(decision.reason, "outside");
    } finally {
      await rm(sibling, { recursive: true, force: true });
    }
  });

  it("follows a symlink before judging it, not after", async () => {
    // A link INSIDE the directory pointing out of it passes every string test there is. This is
    // the case that decides whether the boundary is real or decorative.
    const outside = await tempDir("arke-claude-outside-");
    await writeFile(join(outside, "secret.txt"), "ARKE-SENTINEL", "utf8");
    const link = join(CWD, "escape.txt");
    try {
      await symlink(join(outside, "secret.txt"), link, "file");
    } catch {
      // Windows refuses symlinks without Developer Mode or elevation. The rule still holds —
      // this is the one platform where a test cannot demonstrate it.
      return;
    }
    try {
      const decision = await decide(readOnly, "Read", { file_path: link });
      assert.equal(decision.allow, false, "a link out of the directory is a path out of the directory");
      assert.equal(decision.reason, "outside");
    } finally {
      await rm(link, { force: true });
    }
  });

  it("resolves BOTH sides, so a root that itself needs resolving still contains its own files", async () => {
    // Resolving the target and not the root compares two spellings of the same place and refuses
    // work that was inside all along. Caught by CI rather than here: GitHub's Windows runner puts
    // an 8.3 short name (`RUNNER~1`) in its temp path, so every in-directory case failed there
    // while passing on a machine whose paths need no resolving. A symlinked root is the portable
    // way to reproduce that asymmetry.
    const real = await tempDir("arke-claude-real-");
    const link = `${real}-link`;
    try {
      await symlink(real, link, "dir");
    } catch {
      return; // Windows without Developer Mode; the rule is unchanged.
    }
    try {
      const decision = await decideTool(readOnly, "Read", {
        input: { file_path: join(link, "notes.md") },
        root: link,
      });
      assert.deepEqual(decision, { allow: true }, "a file inside the root is inside the root");
    } finally {
      await rm(link, { recursive: true, force: true });
    }
  });

  it("treats the working directory itself as inside — Glob's optional path is the ordinary case", async () => {
    assert.deepEqual(await decide(readOnly, "Glob", { pattern: "**/*.md" }), { allow: true });
    assert.deepEqual(await decide(readOnly, "Glob", { pattern: "**/*.md", path: CWD }), { allow: true });
  });

  it("confines search too, because a listing is a read of the directory", async () => {
    const outside = await tempDir("arke-claude-outside-");
    const decision = await decide(readOnly, "Grep", { pattern: "secret", path: outside });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, "outside");
  });

  it("refuses a path argument it cannot check rather than passing it through unlooked-at", async () => {
    for (const value of [42, true, {}, ""]) {
      const decision = await decide(readOnly, "Read", { file_path: value });
      assert.equal(decision.allow, false, `${JSON.stringify(value)} is not a path this gate can judge`);
    }
  });

  it("refuses a known tool that has GROWN a path argument the table does not declare", async () => {
    // The backstop for a binary that updates itself: `Read` gaining a second path argument would
    // otherwise go unchecked, silently, on whatever day that ships.
    const decision = await decide(readOnly, "Read", { file_path: join(CWD, "a.md"), output_dir: "/etc" });
    assert.equal(decision.allow, false);
    assert.equal(decision.reason, "undeclared-path");
  });

  it("leaves the world-query surface alone — it takes ids and a url, not paths", async () => {
    assert.deepEqual(await decide(readOnly, "mcp__arke-world__get_sheet", { id: "maren-kest" }), { allow: true });
    assert.deepEqual(await decide(readOnly, "mcp__arke-world__fetch_url", { url: "https://example.com" }), {
      allow: true,
    });
  });
});

/**
 * The prompt's claims, checked against the gate rather than against themselves (issue 506).
 *
 * `confinementStatement` is derived from the allowlist, so it cannot contradict the INTENTS. What
 * it cannot see is this adapter's table, which decides which tool names carry which intent — and
 * the sentence a person and an agent both rely on ("there is no shell here") is a claim about
 * that table. A row added there could make the prompt a lie without touching the prompt.
 */
describe("what the prompt promises, and what the gate does", () => {
  it("refuses every shell name for every role, which is what the prompt says outright", async () => {
    for (const confinement of [authoring, readOnly, confinementFor({ readOnly: false }, { web: true })]) {
      assert.match(confinementStatement(confinement), /no Bash, no PowerShell, no terminal/);
      for (const tool of ["Bash", "BashOutput", "KillShell", "PowerShell", "Shell", "Execute", "Run"]) {
        const decision = await decide(confinement, tool, { command: "echo probe" });
        assert.equal(decision.allow, false, `${tool} is refused, so the prompt is telling the truth`);
      }
    }
  });

  it("permits exactly the intents the prompt offers, and nothing the prompt denies", async () => {
    // One representative tool per intent, so the table and the statement are compared through
    // the thing that actually decides — `decideTool` — rather than through the allowlist twice.
    const SAMPLE: Record<ToolIntent, [string, Record<string, unknown>] | null> = {
      read: ["Read", { file_path: join(CWD, "a.md") }],
      edit: ["Write", { file_path: join(CWD, "a.md") }],
      search: ["Grep", { pattern: "x" }],
      // Claude Code has no tool carrying `list`: listing a directory is `Glob`, which is
      // `search`. Null rather than a stand-in, so this does not quietly assert `search` twice.
      list: null,
      todo: ["TodoWrite", {}],
      "world-query": ["mcp__arke-world__get_sheet", { id: "maren-kest" }],
      skill: ["Skill", {}],
      delegate: ["Task", {}],
      web: ["WebSearch", { query: "x" }],
    };
    for (const readOnlyRole of [true, false]) {
      for (const web of [true, false]) {
        const confinement = confinementFor({ readOnly: readOnlyRole }, { web });
        const statement = confinementStatement(confinement);
        const offered = statement.slice(0, statement.indexOf("What you cannot do:"));
        for (const intent of ToolIntent.options) {
          const sample = SAMPLE[intent];
          if (sample === null) continue;
          const decision = await decide(confinement, sample[0], sample[1]);
          const promised = offered.includes(PHRASE[intent]);
          assert.equal(
            decision.allow,
            promised,
            `${intent}: the gate says ${decision.allow}, the prompt says ${promised}`,
          );
        }
      }
    }
  });
});

/** The statement's own phrase for an intent, read back out of a single-intent statement. */
const PHRASE = Object.fromEntries(
  ToolIntent.options.map((intent) => [
    intent,
    confinementStatement({ allow: [intent] })
      .split("\n")
      .find((l) => l.startsWith("- ") && !l.includes("shell command") && !l.includes("any other tool"))!
      .slice(2),
  ]),
) as Record<ToolIntent, string>;

describe("the gate the adapter actually installs", () => {
  it("judges a path against the session's own directory, not the process's", async () => {
    const outside = await tempDir("arke-claude-outside-");
    const fake = fakeQuery();
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: fake.run });
    const { sessionId } = await adapter.createSession({ purpose: "authoring", cwd: CWD, agent: "world-builder" });
    await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "go" }] });
    const gate = fake.options()["canUseTool"] as Gate;

    assert.equal((await gate("Read", { file_path: join(CWD, "inside.md") })).behavior, "allow");
    const denied = await gate("Read", { file_path: join(outside, "credentials.txt") });
    assert.equal(denied.behavior, "deny", "the same tool, the same intent, a different place");
    assert.match(denied.message ?? "", /working directory/);
    await adapter.dispose();
  });

  /**
   * The shell, which is what #506 was actually about.
   *
   * `Bash` is absent from the intent table, so it is refused as unknown — the allowlist working
   * exactly as designed. What was missing is any record of it: the refusal was an activity event,
   * and an activity event is a progress verb that is gone the moment the turn ends.
   */
  it("refuses a shell and says so as a refusal, so the turn leaves a record of it", async () => {
    const events: HarnessEvent[] = [];
    const fake = fakeQuery();
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: fake.run });
    const stream = adapter.streamEvents();
    const pump = (async () => {
      for await (const event of stream) events.push(event);
    })();

    const { sessionId } = await adapter.createSession({ purpose: "authoring", cwd: CWD, agent: "sheet-editor" });
    await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "go" }] });
    const gate = fake.options()["canUseTool"] as Gate;
    const denied = await gate("Bash", { command: "echo ARKE_SHELL_PROBE_7731" });
    await adapter.dispose();
    await pump;

    assert.equal(denied.behavior, "deny", "no role has a shell, and the authoring role least of all");
    const refused = events.filter((e) => e.type === "tool.refused");
    assert.equal(refused.length, 1);
    assert.equal(refused[0]?.type === "tool.refused" && refused[0].tool, "Bash");
    assert.equal(
      events.some((e) => e.type === "tool.activity"),
      false,
      "and it is never reported as something the studio did",
    );
  });

  it("keeps the refused path out of what it shows and what it tells the agent", async () => {
    const outside = await tempDir("arke-claude-outside-");
    const secret = join(outside, "credentials.txt");
    const traces: Array<Record<string, unknown>> = [];
    const events: HarnessEvent[] = [];
    const fake = fakeQuery();
    const adapter = new ClaudeAdapter({ command: "claude", runQuery: fake.run, onTrace: (l) => traces.push(l) });
    const stream = adapter.streamEvents();
    const pump = (async () => {
      for await (const event of stream) events.push(event);
    })();

    const { sessionId } = await adapter.createSession({ purpose: "authoring", cwd: CWD, agent: "world-builder" });
    await adapter.sendMessage({ sessionId, parts: [{ type: "text", text: "go" }] });
    const gate = fake.options()["canUseTool"] as Gate;
    const denied = await gate("Read", { file_path: secret });
    await adapter.dispose();
    await pump;

    assert.equal(denied.behavior, "deny");
    assert.equal(denied.message?.includes(secret), false, "the refusal must not echo the file back to the agent");
    const refused = events.filter((e) => e.type === "tool.refused");
    assert.equal(refused.length, 1, "a refusal is its own event, never progress (#506)");
    assert.equal(
      events.some((e) => e.type === "tool.activity"),
      false,
      "nothing happened, so nothing is reported as activity",
    );
    assert.equal(refused[0]?.type === "tool.refused" && refused[0].summary.includes(secret), false);
    // An operator still needs to know WHICH path was refused. That is what the trace is for.
    const refusal = traces.find((l) => l["at"] === "claude.tool-refused");
    assert.equal(refusal?.["reason"], "outside");
    assert.equal(typeof refusal?.["path"], "string");
  });
});
