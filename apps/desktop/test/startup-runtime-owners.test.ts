import assert from "node:assert/strict";
import { it } from "node:test";
import { StartupRuntimeOwners } from "../src/startup-runtime-owners.js";

it("cleans failed initialization, retains failed owners for retry and transfers live owners", async () => {
  const owners = new StartupRuntimeOwners();
  let first = 0, failing = 0, transferred = 0, refuse = true;
  owners.own({ dispose: async () => { first++; } });
  owners.own({ dispose: async () => { failing++; if (refuse) throw new Error("exit unconfirmed"); } });
  const transfer = owners.own({ dispose: async () => { transferred++; } });
  transfer();
  await assert.rejects(owners.close(), /cleanup did not confirm/);
  assert.equal(first, 1);
  assert.equal(failing, 1);
  assert.equal(transferred, 0);
  refuse = false;
  await owners.close();
  await owners.close();
  assert.equal(first, 1);
  assert.equal(failing, 2);
  assert.equal(transferred, 0);
});
