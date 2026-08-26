import assert from "node:assert/strict";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { confinementFor, type AgentConfinement, type HarnessEvent } from "@arke-studio/contracts";
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
    const activity = events.filter((e) => e.type === "tool.activity");
    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.type === "tool.activity" && activity[0].summary.includes(secret), false);
    // An operator still needs to know WHICH path was refused. That is what the trace is for.
    const refusal = traces.find((l) => l["at"] === "claude.tool-refused");
    assert.equal(refusal?.["reason"], "outside");
    assert.equal(typeof refusal?.["path"], "string");
  });
});
