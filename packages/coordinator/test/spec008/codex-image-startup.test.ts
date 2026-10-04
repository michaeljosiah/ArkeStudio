import assert from "node:assert/strict";
import { it } from "node:test";
import { join } from "node:path";
import { SHIPPED_MANIFEST } from "@arke-studio/providers";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { makeTempRoot } from "../world/helpers.js";
import { until } from "../wait.js";
import { FakeProvider } from "../queue/fake-provider.js";

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
      await until(() => coordinator.getState().app.providers.find(row => row.id === "codex")?.validation === (available ? "valid" : "invalid"), "Codex startup validation");
      const status = coordinator.getState().app.providers.find(row => row.id === "codex");
      assert.equal(status?.configured, available);
      assert.equal(status?.validation, available ? "valid" : "invalid");
      assert.equal(status?.probes[0]?.available, available);
    } finally { await coordinator.stop(); await provider.close(); }
  }
  assert.equal(probes, 2);
});

it("opens the transport before a slow Codex probe and admits founding images only after external validation", async () => {
  const { root } = await makeTempRoot();
  const provider = new FsWorldProvider(root);
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let available = true;
  const coordinator = new Coordinator({ provider, adapter: null, appRoot: root, appVersion: "test",
    changeLogPath: join(root, "changes.jsonl"), manifest: SHIPPED_MANIFEST,
    dispatchClients: { codex: new FakeProvider({}) },
    validators: { codex: { validateKey: async key => {
      assert.equal(key, ""); await pending;
      return [{ capability: "image", available }];
    } } } });
  // Exercise the service assembled by the real coordinator, rather than a fake credential port.
  const founding = (coordinator as unknown as { foundingBuild: {
    resolveImageRoute(models: { image: string }): Promise<{ route: { model: { id: string } } | null }>;
  } }).foundingBuild;
  let opened = false;
  const starting = coordinator.start(0).then(value => { opened = true; return value; });
  try {
    await until(() => opened, "transport to open without waiting for Codex", 30_000);
    assert.ok((await starting).port > 0);
    assert.equal((await founding.resolveImageRoute({ image: "codex-image" })).route, null);
    release();
    await until(() => coordinator.getState().app.providers.find(row => row.id === "codex")?.validation === "valid", "external login to become available");
    assert.equal((await founding.resolveImageRoute({ image: "codex-image" })).route?.model.id, "codex-image");
    available = false;
    await (coordinator as unknown as { handleClientMessage(message: { kind: "validate-provider"; provider: "codex" }): Promise<void> })
      .handleClientMessage({ kind: "validate-provider", provider: "codex" });
    assert.equal((await founding.resolveImageRoute({ image: "codex-image" })).route, null);
  } finally {
    release(); await starting.catch(() => {}); await coordinator.stop(); await provider.close();
  }
});
