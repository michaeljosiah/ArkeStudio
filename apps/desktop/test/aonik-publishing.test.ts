import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";
import { createDesktopCreatorPublishing } from "../src/aonik-publishing.js";

it("loads the shipped dev configuration without a machine-specific configuration file", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-desktop-dev-"));
  const configurationFile = fileURLToPath(new URL("../config/aonik-dev.json", import.meta.url));
  const host = await createDesktopCreatorPublishing({ appRoot: root, configurationFile,
    cipher: { isAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    openExternal: async () => { throw new Error("No sign-in without a user action"); }, secrets: { register() {} } });
  try {
    assert.ok(host.creatorPublishing);
    assert.equal(host.account!.current().kind, "signed-out");
  } finally {
    await host.creatorPublishing?.stop(); await host.account?.stop?.();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

it("keeps local Studio available without configuration and refuses secrets/arbitrary endpoints in host configuration", async () => {
  const root = await mkdtemp(join(tmpdir(), "arke-desktop-creator-")); const rel = relative(tmpdir(), root); assert.ok(!isAbsolute(rel) && !rel.startsWith("..")); let opened = false;
  const options = { appRoot: root, cipher: { isAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => "" }, openExternal: async () => { opened = true; }, secrets: { register() {} } };
  try { for (const content of [null, "{malformed", JSON.stringify({ apiBaseUrl: "http://evil.invalid", clientSecret: "never-accepted" })]) { if (content) await writeFile(join(root, "aonik-publishing.json"), content); const host = await createDesktopCreatorPublishing(options); assert.equal(host.creatorPublishing, undefined); await host.account!.signIn(); assert.match(JSON.stringify(host.account!.current()), /not configured/); } assert.equal(opened, false); }
  finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
});
