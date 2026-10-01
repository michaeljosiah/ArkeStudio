import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { AdapterReleaseSchema, type AdapterBundle, type AdapterLibraryState } from "@arke-studio/contracts";
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
  error: null, entries: [{ release, decision: null, removed: false, owned: false, installed: false, reason: null }] };
function set(adapters: AdapterLibraryState) { __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, adapters } }); }

test("one bundle is one chip; its members' strengths open in the popover and a blocked member names itself", () => {
  const entries = Array.from({ length: 14 }, (_, i) => {
    const approved = AdapterReleaseSchema.parse({ ...release, id: `fixture-${i}`, displayName: `Member ${i + 1}`,
      source: { ...release.source, sha256: i.toString(16).padStart(64, "0") }, compatibility: [{ recipeId: "test-recipe", state: "owner-approved",
        reason: "Owner accepted", evidence: "Fixture", minStrength: 1, maxStrength: 1,
        ownerApproval: { approvedAt: "2026-09-25T00:00:00.000Z", generation: "not-run" } }] });
    return { release: approved, installed: true, owned: false, removed: false, reason: null as string | null, decision: null };
  });
  const selections = entries.map(({ release: member }) => ({ releaseId: member.id, sha256: member.source.sha256, strength: 1 }));
  const bundle: AdapterBundle = { id: "fixture-bundle", displayName: "All adapters", recipeId: "test-recipe", status: "experimental", description: "Combination not GPU-tested", selections };
  const render = (recipeId = "test-recipe", open = true) => renderToString(<MemoryRouter><AdapterPicker recipeId={recipeId} selected={selections} onChange={() => {}} initialOpen={open} /></MemoryRouter>).replaceAll("<!-- -->", "");
  const available = { ...library, entries, bundles: [bundle] };
  set(available);
  // Closed, the composer row holds one chip: the bundle's name and its member count (180c).
  const closed = render("test-recipe", false);
  assert.match(closed, /aria-label="Adapter: All adapters"[^>]*>All adapters<small>14<\/small>/);
  assert.doesNotMatch(closed, /<select|Strength for|Manage adapters/);
  assert.match(render(), /aria-pressed="true"[^>]*data-value="bundle:fixture-bundle"/);
  assert.doesNotMatch(render(), /disabled=""[^>]*data-value="bundle:fixture-bundle"/);
  // Names only: no status suffix and no description sentence on the composer.
  assert.doesNotMatch(render(), /Experimental|Combination not GPU-tested|Owner/);
  assert.equal((render().match(/aria-label="Strength for Member/g) ?? []).length, 14);
  // Each member's strength is its own field, bounded by that member's pairing range.
  assert.match(render(), /aria-label="Strength for Member 14"[^>]*min="1"[^>]*max="1"[^>]*value="1"/);
  assert.doesNotMatch(render(), /aria-label="Adapter strength"/);
  assert.match(render(), /href="\/settings\/adapters"[^>]*>Manage adapters/);
  set({ ...available, entries: entries.map((row, i) => i === 13 ? { ...row, reason: "Disabled by the user." } : row) });
  assert.match(render(), /Member 14: Disabled by the user/);
  set({ ...available, entries: entries.map((row, i) => i === 13 ? { ...row, installed: false } : row) });
  assert.match(render(), /Member 14: Not installed/);
  set({ ...available, entries: entries.slice(0, 13) });
  assert.match(render(), /A bundle member is unavailable for this model/);
  assert.match(render("another-model"), /Saved adapter unavailable/);
  set({ ...available, adultContent: { ...library.adultContent, enabled: false } });
  assert.doesNotMatch(render(), /Member|All adapters|Experimental/);
  assert.match(render(), /Clear selection/);
});

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

test("settings hide the catalogue when off and show it installable when on, with no assessment step", () => {
  set({ ...library, adultContent: { ...library.adultContent, enabled: false } });
  const off = renderToString(<MemoryRouter><SettingsAdaptersScreen /></MemoryRouter>);
  assert.doesNotMatch(off, /Fixture adapter/);
  assert.match(off, /Enable adult content/);
  set(library);
  const on = renderToString(<MemoryRouter><SettingsAdaptersScreen /></MemoryRouter>);
  assert.match(on, /Fixture adapter/);
  assert.match(on, /GPU validation pending/);
  assert.doesNotMatch(on, /[Cc]ompliance/);
  assert.match(on, /Available/);
  assert.doesNotMatch(on.replaceAll("<!-- -->", ""), /<button[^>]*disabled=""[^>]*>Install<\/button>/);
  set({ ...library, entries: [{ ...library.entries[0]!, reason: "Disabled by the user." }] });
  const disabled = renderToString(<MemoryRouter><SettingsAdaptersScreen /></MemoryRouter>);
  assert.match(disabled, /Disabled by the user/);
  assert.match(disabled, /Request fresh review/);
  assert.match(disabled.replaceAll("<!-- -->", ""), /<button[^>]*disabled=""[^>]*>Install<\/button>/);
});

test("picker never advertises an unverified entry as selectable and retains a removable hidden saved choice", () => {
  set(library);
  const picker = renderToString(<MemoryRouter><AdapterPicker recipeId="test-recipe" selected={[]} onChange={() => {}} initialOpen /></MemoryRouter>);
  assert.match(picker, /disabled=""[^>]*data-value="test-release"/);
  assert.match(picker, /fy-adapter-pop__why">Not installed/);
  set({ ...library, adultContent: { ...library.adultContent, enabled: false } });
  const off = renderToString(<MemoryRouter><AdapterPicker recipeId="test-recipe" selected={[{ releaseId: release.id, sha256: release.source.sha256, strength: 1 }]} onChange={() => {}} initialOpen /></MemoryRouter>);
  assert.doesNotMatch(off, /Fixture adapter/);
  assert.match(off, /Clear selection/);
});

test("picker follows the selected model and keeps an incompatible saved selection clearable", () => {
  set(library);
  const render = (recipeId: string, selected: { releaseId: string; sha256: string; strength: number }[] = [], open = true) =>
    renderToString(<MemoryRouter><AdapterPicker recipeId={recipeId} selected={selected} onChange={() => {}} initialOpen={open} /></MemoryRouter>);
  assert.equal(render("another-model"), "");
  assert.equal(render(""), "");
  assert.match(render("test-recipe", [], false), /No adapter/);
  assert.match(render("test-recipe"), /Fixture adapter/);
  const stale = render("another-model", [{ releaseId: release.id, sha256: release.source.sha256, strength: 1 }]);
  assert.match(stale, /Adapter unavailable/);
  assert.match(stale, /Saved adapter unavailable/);
  assert.match(stale, /Choose None to clear it/);
  assert.doesNotMatch(stale, /Adapter strength/);
});

test("an approved adapter is listed by name alone, with its strength, and a user block still names itself", () => {
  const approved = AdapterReleaseSchema.parse({ ...release, compatibility: [{ recipeId: "test-recipe", state: "owner-approved",
    reason: "Owner approved; generation not run.", evidence: "Owner acceptance record", minStrength: 1, maxStrength: 1,
    ownerApproval: { approvedAt: "2026-09-25T00:00:00.000Z", generation: "not-run" } }] });
  const entry = { ...library.entries[0]!, release: approved, installed: true, reason: null };
  const selected = [{ releaseId: approved.id, sha256: approved.source.sha256, strength: 1 }];
  const render = (open = true) => renderToString(<MemoryRouter><AdapterPicker recipeId="test-recipe" selected={selected} onChange={() => {}} initialOpen={open} /></MemoryRouter>).replaceAll("<!-- -->", "");
  set({ ...library, entries: [entry] });
  assert.match(render(false), />Fixture adapter<small>1<\/small>/);
  const available = render();
  // The approval stays in Settings (design 180c): no suffix, no reason sentence on the composer.
  assert.doesNotMatch(available, /Owner approved/);
  assert.doesNotMatch(available, /disabled=""[^>]*data-value="test-release"/);
  assert.match(available, /aria-label="Adapter strength"[^>]*min="1"[^>]*max="1"/);
  set({ ...library, entries: [{ ...entry, decision: { sha256: approved.source.sha256, decision: "disabled" as const, reason: "Disabled by the user.",
    policyRevision: "user", assessedAt: "2026-09-24T00:00:00.000Z" } }] });
  assert.match(render(), /Disabled by the user/);
  // Not chosen, the same row cannot be picked.
  const fresh = renderToString(<MemoryRouter><AdapterPicker recipeId="test-recipe" selected={[]} onChange={() => {}} initialOpen /></MemoryRouter>);
  assert.match(fresh, /disabled=""[^>]*data-value="test-release"/);
});
