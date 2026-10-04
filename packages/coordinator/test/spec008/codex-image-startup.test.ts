import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";

it("restores Codex image availability at startup and observes sign-out on restart", async () => {
  const { root } = await makeTempRoot();
  let probes = 0;
  for (const available of [true, false]) {
    const provider = new FsWorldProvider(root);
    const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "test",
      changeLogPath: join(root, "changes.jsonl"), manifest: SHIPPED_MANIFEST,
      validators: { codex: { validateKey: async key => {
        assert.equal(key, ""); probes++;
        return [{ capability: "image", available, ...(available ? {} : { reason: "signed out" }) }];
      } } } });
    try {
      await coordinator.start(0);
      const status = coordinator.getState().app.providers.find(row => row.id === "codex");
      assert.equal(status?.configured, available);
      assert.equal(status?.validation, available ? "valid" : "invalid");
      assert.equal(status?.probes[0]?.available, available);
    } finally { await coordinator.stop(); await provider.close(); }
  }
  assert.equal(probes, 2);
});
