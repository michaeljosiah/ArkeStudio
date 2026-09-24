import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { AdapterReleaseSchema, type AdapterLibraryState } from "@arke-studio/contracts";
import { SettingsAdaptersScreen } from "../src/screens/settings-adapters.js";
import { AdapterPicker } from "../src/components/adapter-picker.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { adapterPreviewHidden, mediaUrl } from "../src/lib/media.js";

const release = AdapterReleaseSchema.parse({ id: "test-release", adapterId: "test", publisher: "Test", displayName: "Fixture adapter",
  source: { repository: "test/fixture", revision: "a".repeat(40), file: "fixture.safetensors", bytes: 1000, sha256: "b".repeat(64) },
  license: { name: "Test", url: "https://example.com/license" }, classification: "adult", baseFamily: "minimax-h3", supersedes: [],
  assessedAt: "2026-09-24T00:00:00.000Z", compatibility: [{ recipeId: "test-recipe", state: "unverified", reason: "GPU validation pending" }] });
const library: AdapterLibraryState = { revision: 1, adultContent: { enabled: true, acknowledgedAt: "2026-09-24T00:00:00.000Z", acknowledgementVersion: 1 },
  scannerAvailable: false, error: null, entries: [{ release, decision: null, removed: false, owned: false, installed: false, reason: "Awaiting compliance assessment." }] };
function set(adapters: AdapterLibraryState) { __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, adapters } }); }

test("turning access off changes a loaded take's media URL without rewriting its record", () => {
  const state = structuredClone(FIXTURE_STATE);
  const world = state.world!;
  const production = world.productions[0]!;
  const take = production.takes[0]!;
  take.params.adapters = [{ releaseId: release.id, sha256: release.source.sha256, strength: 0.5 }];
  state.app.adapters = library;
  const path = `productions/${production.meta.id}/takes/${take.id}/frame.png`;
  __setStateForTest(state);
  assert.notEqual(mediaUrl(world.meta.slug, path), "about:blank");
  const disabled = { ...state, app: { ...state.app, adapters: { ...library, adultContent: { ...library.adultContent, enabled: false } } } };
  __setStateForTest(disabled);
  assert.equal(adapterPreviewHidden(disabled, world.meta.slug, path), true);
  assert.equal(mediaUrl(world.meta.slug, path), "about:blank");
  assert.deepEqual(take.params.adapters, [{ releaseId: release.id, sha256: release.source.sha256, strength: 0.5 }]);
});

test("settings hide the catalogue when off and state pending review when on", () => {
  set({ ...library, adultContent: { ...library.adultContent, enabled: false } });
  const off = renderToString(<MemoryRouter><SettingsAdaptersScreen /></MemoryRouter>);
  assert.doesNotMatch(off, /Fixture adapter/);
  assert.match(off, /Enable adult content/);
  set(library);
  const on = renderToString(<MemoryRouter><SettingsAdaptersScreen /></MemoryRouter>);
  assert.match(on, /Fixture adapter/);
  assert.match(on, /GPU validation pending/);
  assert.match(on, /No compliance agent/);
});

test("picker never advertises an unverified entry as selectable and retains a removable hidden saved choice", () => {
  set(library);
  const picker = renderToString(<MemoryRouter><AdapterPicker recipeId="test-recipe" selected={[]} onChange={() => {}} /></MemoryRouter>);
  assert.match(picker, /<option[^>]*value="test-release"[^>]*disabled=""/);
  set({ ...library, adultContent: { ...library.adultContent, enabled: false } });
  const off = renderToString(<MemoryRouter><AdapterPicker recipeId="test-recipe" selected={[{ releaseId: release.id, sha256: release.source.sha256, strength: 1 }]} onChange={() => {}} /></MemoryRouter>);
  assert.doesNotMatch(off, /Fixture adapter/);
  assert.match(off, /Clear selection/);
});
