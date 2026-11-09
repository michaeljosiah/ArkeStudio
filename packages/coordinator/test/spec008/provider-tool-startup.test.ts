import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";
import { until } from "../wait.js";

it("opens the transport before a slow provider tool probe, and publishes the tool once it settles (issue 2814)", async () => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "test",
    changeLogPath: join(root, "changes.jsonl"), manifest: SHIPPED_MANIFEST,
    toolProbes: { higgsfield: {
      discover: async () => { await pending; return { command: "higgsfield", source: "path", version: "1.2.3" }; },
      whoAmI: async () => ({ account: "maren@example.com" }),
      signIn: async () => ({ code: 0, detail: null }),
    } } });
  let opened = false;
  const starting = coordinator.start(0).then(value => { opened = true; return value; });
  try {
    await until(() => opened, "transport to open without waiting for the tool", 30_000);
    assert.equal(coordinator.getState().app.providerTools.find(tool => tool.provider === "higgsfield")?.state, "absent");
    release();
    await until(() => coordinator.getState().app.providerTools.find(tool => tool.provider === "higgsfield")?.state === "ready", "the tool's status to arrive");
    assert.equal(coordinator.getState().app.providerTools.find(tool => tool.provider === "higgsfield")?.account, "maren@example.com");
  } finally {
    release(); await starting.catch(() => {}); await coordinator.stop(); await provider.close();
  }
});
