import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { mkdir, readFile, readdir, symlink, unlink, writeFile } from "node:fs/promises";
import type { HarnessAdapter } from "@arke-studio/contracts";
import { createPreparedSession } from "../../src/harness/session-files.js";
import { privateFileRetirement } from "../../src/harness/private-files.js";
import { tempDir } from "../tmp.js";

function adapter(contents = "owned-control") {
  return { createSession: async () => ({ sessionId: "private-files" }), sessionFiles: (_input: unknown, directory: string) => {
    assert(directory); return [{ name: "control/index.js", contents }, { name: "opencode.json", contents: "{}" }];
  } } as unknown as HarnessAdapter;
}
const input = { agent: "studio-assistant", model: "ollama/local" };
const session = { purpose: "ask" as const, visibility: "private" as const, agent: input.agent };

it("retires captured private config/control bytes while preserving changed files and creative contents", async () => {
  const directory = await tempDir("arke-private-files-");
  const prepared = await createPreparedSession(adapter(), directory, input, session); assert(prepared.retirePrivateFiles);
  await writeFile(join(directory, "control/index.js"), "KEEP_CHANGED_BYTES");
  await writeFile(join(directory, "creative.txt"), "KEEP_CREATIVE_BYTES");
  await prepared.retirePrivateFiles();
  assert.equal(await readFile(join(directory, "control/index.js"), "utf8"), "KEEP_CHANGED_BYTES");
  assert.equal(await readFile(join(directory, "creative.txt"), "utf8"), "KEEP_CREATIVE_BYTES");
  await assert.rejects(readFile(join(directory, "opencode.json")), { code: "ENOENT" });
});

it("an old preparation cannot remove a successor's files even when their bytes match", async () => {
  const directory = await tempDir("arke-private-successor-");
  const first = await createPreparedSession(adapter(), directory, input, session);
  const next = await createPreparedSession(adapter(), directory, input, session);
  await first.retirePrivateFiles!(); assert.equal(await readFile(join(directory, "control/index.js"), "utf8"), "owned-control");
  await next.retirePrivateFiles!(); assert.deepEqual(await readdir(directory), []);
  assert.equal(await next.retirePrivateFiles!(), true);
});

it("failed unsent creation retires only its written private control files", async () => {
  const directory = await tempDir("arke-private-unsent-");
  const owner = adapter(); owner.createSession = async () => { throw new Error("synthetic creation refusal"); };
  await assert.rejects(createPreparedSession(owner, directory, input, session), /synthetic creation refusal/);
  assert.deepEqual(await readdir(directory), []);
});

it("refuses private control file traversal before writing or creating a session", async () => {
  const directory = await tempDir("arke-private-traversal-"); let created = false;
  const owner = { sessionFiles: () => [{ name: "../creative.txt", contents: "MUST_NOT_WRITE" }], createSession: async () => { created = true; return { sessionId: "never" }; } } as unknown as HarnessAdapter;
  await assert.rejects(createPreparedSession(owner, directory, input, session), /relative names/); assert.equal(created, false);
  assert.deepEqual(await readdir(directory), []);
});

it("private control retirement does not traverse or remove a directory link", async () => {
  const directory = await tempDir("arke-private-link-"), target = await tempDir("arke-private-protected-");
  await mkdir(join(directory, "parent")); await writeFile(join(target, "index.js"), "same-bytes");
  await symlink(target, join(directory, "parent/control"), process.platform === "win32" ? "junction" : "dir");
  const retire = privateFileRetirement(directory, [{ name: "parent/control/index.js", contents: "same-bytes" }], () => true);
  await retire(); assert.equal(await readFile(join(target, "index.js"), "utf8"), "same-bytes");
  assert((await readdir(join(directory, "parent"))).includes("control"));
});

it("an uncertain unlink stays unconfirmed and reconciliation retries only those same files", async () => {
  const directory = await tempDir("arke-private-file-fault-"); await writeFile(join(directory, "control.js"), "owned");
  let refused = true;
  const retire = privateFileRetirement(directory, [{ name: "control.js", contents: "owned" }], () => true, async path => {
    if (refused) throw Object.assign(new Error("synthetic held native file"), { code: "EBUSY" }); await unlink(path);
  });
  assert.equal(await retire(), false); assert.equal(await readFile(join(directory, "control.js"), "utf8"), "owned");
  refused = false; assert.equal(await retire(), true); assert.deepEqual(await readdir(directory), []);
  assert.equal(await retire(), true);
});
