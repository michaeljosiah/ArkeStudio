import assert from "node:assert/strict";
import { it } from "node:test";
import { Coordinator } from "../../src/coordinator.js";

it("a healthy isolated worker releases the provider recovery lane while the primary is unavailable", async () => {
  const calls: string[] = [];
  let routes: string[] = [];
  const coordinator = Object.assign(Object.create(Coordinator.prototype), {
    comfyUiLifecycleWork: Promise.resolve(),
    stopping: false,
    opts: { comfyui: { service: {
      engineIdentity: () => ({ source: "managed", instanceId: "primary", processEpoch: "restarting" }),
      baseUrl: () => null,
      baseUrls: () => routes,
    } } },
    jobQueue: {
      resetProviderTransport: () => calls.push("reset"),
      blockRecovery: () => calls.push("block"),
      failJobsForRetiredEngine: async () => [],
      releaseRecovery: () => calls.push("release"),
    },
  }) as { retireAndReleaseComfyUi(): Promise<void> };
  await coordinator.retireAndReleaseComfyUi();
  assert.deepEqual(calls, ["reset", "block"]);
  calls.length = 0;
  routes = ["http://127.0.0.1:8101"];
  await coordinator.retireAndReleaseComfyUi();
  assert.deepEqual(calls, ["release"], "the isolated route must not remain behind the primary's gate");
});
