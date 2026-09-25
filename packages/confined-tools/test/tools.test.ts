import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confinementFor } from "@arke-studio/contracts";
import { captureRootIdentity, executeTool, resolveRoot, toolsFor, type ToolSession } from "../src/index.js";

/**
 * The harness-neutral shapes the shared tools return (issue 1247, Phase 1).
 *
 * The confinement itself is exercised by adapter-codex's suite, which runs these tools through
 * its mapping unchanged; this file pins what a harness mapping the tools receives, so a second
 * harness can rely on it without reading the Codex code.
 */
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAZklEQVR42u3QQREAAAQAMEm89T/9yOHssQKLzprPQoAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIECLhvAVR6kdJApJA8AAAAAElFTkSuQmCC", "base64");

async function fixture(readOnly = false) {
  const base = await mkdtemp(join(tmpdir(), "arke-confined-tools-")); const root = join(base, "proposal");
  await mkdir(root);
  const canonical = await resolveRoot(root);
  const session: ToolSession = { root: canonical, rootIdentity: await captureRootIdentity(canonical), confinement: confinementFor({ readOnly }), worldTools: new Map() };
  return { base, root, session, run: (name: string, args: Record<string, unknown>) => executeTool(session, name, args, new AbortController().signal) };
}

test("definitions carry a JSON-schema parameters object and follow the confinement", async t => {
  const authoring = await fixture(); t.after(() => rm(authoring.base, { recursive: true, force: true }));
  const readOnly = await fixture(true); t.after(() => rm(readOnly.base, { recursive: true, force: true }));
  assert.deepEqual(toolsFor(authoring.session).map((tool) => tool.name), ["read", "list", "search", "write", "edit"]);
  assert.deepEqual(toolsFor(readOnly.session).map((tool) => tool.name), ["read", "list", "search"]);
  for (const tool of toolsFor(authoring.session)) {
    assert.deepEqual(Object.keys(tool), ["name", "description", "parameters"], "no harness's wire fields");
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.parameters.additionalProperties, false);
  }
});

test("results are text and base64 images with their type, not a harness's item shapes", async t => {
  const f = await fixture(); t.after(() => rm(f.base, { recursive: true, force: true }));
  const written = await f.run("write", { path: "story.txt", content: "Hello world" });
  assert.deepEqual(written, { result: { success: true, content: [{ type: "text", text: "Updated story.txt." }] }, summary: "edited story.txt" });
  await writeFile(join(f.root, "frame.png"), png);
  const image = await f.run("read", { path: "frame.png" });
  assert.deepEqual(image.result.content[0], { type: "text", text: "Read image frame.png." });
  assert.deepEqual(image.result.content[1], { type: "image", mimeType: "image/png", data: png.toString("base64") });
  await assert.rejects(f.run("exec", { command: "echo bad" }), /confinement/, "a tool that is not offered is refused");
});
