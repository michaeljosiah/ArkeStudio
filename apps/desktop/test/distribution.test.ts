import assert from "node:assert/strict";
import { join } from "node:path";
import { it } from "node:test";
import { desktopDistribution } from "../src/distribution.js";

it("isolates the installed dev workspace and account state and refuses production updates", () => {
  const dev = desktopDistribution("development", "home", "app-data");
  const production = desktopDistribution("production", "home", "app-data");
  assert.equal(dev.name, "Arke Studio Dev");
  assert.equal(dev.appUserModelId, "studio.arke.app.dev");
  assert.equal(production.appUserModelId, "studio.arke.app");
  assert.equal(dev.workspace, join("home", "ArkeStudioDev"));
  assert.equal(dev.userData, join("app-data", "ArkeStudioDev"));
  assert.equal(dev.allowUpdates, false);
  assert.notEqual(dev.workspace, production.workspace);
  assert.equal(production.userData, undefined);
  assert.equal(production.allowUpdates, true);
  assert.throws(() => desktopDistribution("typo", "home", "app-data"), /Unknown/);
});
