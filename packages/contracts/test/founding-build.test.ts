import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUILD_STAGES,
  buildWorkingLine,
  compileBuildItems,
  foldFoundingBuild,
  newId,
  ulid,
  type BuildJournalEntry,
  type FoundingBuildRecord,
  type GenesisBlueprint,
  type ManifestModel,
} from "../src/index.js";

const MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 3, startFrame: false, endFrame: false },
  limits: { maxReferenceAudioSec: 60 },
  pricing: { kind: "perImage", microUsdPerImage: 40000 },
};

function blueprint(overrides: Partial<GenesisBlueprint> = {}): GenesisBlueprint {
  return {
    name: "The Undersong",
    logline: "A drowned god still sings beneath the harbour.",
    look: "salt-bleached watercolour",
    threads: ["Who governs what the water leaves behind?"],
    keyArt: { subject: "Maren at the tideline", characters: ["Maren Kest"], moment: undefined as never },
    characters: [
      { slug: "maren-kest", name: "Maren Kest", line: "Tide-caller", brief: { apparentAge: "forty" } },
      { slug: "brother-ellum", name: "Brother Ellum", line: "Keeps the ledger of the drowned" },
    ],
    locations: [{ slug: "the-vigil", name: "The Vigil", line: "A lighthouse facing the wrong way" }],
    factions: [],
    dropped: [],
    ...overrides,
  } as GenesisBlueprint;
}

function record(bp: GenesisBlueprint, route: { model: ManifestModel; referenceImages: number } | null): FoundingBuildRecord {
  const items = compileBuildItems(bp, route, () => ulid());
  return {
    buildId: newId("fb"),
    requestId: ulid(),
    worldId: ulid(),
    genesisId: "gen-test",
    blueprint: bp,
    artDirectionVersion: 1,
    capMicroUsd: items.filter((i) => i.authorized).reduce((sum, i) => sum + i.estimatedMicroUsd, 0),
    image:
      route === null
        ? null
        : {
            provider: route.model.provider,
            model: route.model.id,
            displayName: route.model.displayName,
            referenceImages: route.referenceImages,
          },
    items,
    createdAt: "2026-08-26T12:00:00.000Z",
  };
}

const AT = "2026-08-26T12:00:01.000Z";
const landed = (key: string): BuildJournalEntry[] => [
  { kind: "intent", key, at: AT },
  { kind: "terminal", key, outcome: "landed", at: AT },
];

describe("compiling the blueprint into items (SPEC-031 R-13)", () => {
  it("derives a stable key for every item the press authorizes", () => {
    const items = compileBuildItems(blueprint(), { model: MODEL, referenceImages: 3 });
    const keys = items.map((item) => item.key);
    assert.deepEqual(keys, [
      "world:world",
      "author-sheet:location:the-vigil",
      "thread:1",
      "author-sheet:character:maren-kest",
      "main-photo:maren-kest",
      "author-sheet:character:brother-ellum",
      "main-photo:brother-ellum",
      "establishing-view:the-vigil",
      "sheet-image:maren-kest",
      "sheet-image:brother-ellum",
      "key-art:world",
      "finalize:world",
    ]);
    assert.ok(items.every((item) => item.authorized), "with a full route, everything is authorized");
    const images = items.filter((item) => item.idempotencyKey !== undefined);
    assert.equal(images.length, 6, "two photos, one view, two sheets, key art");
  });

  it("a key-art brief never settled means no key-art item — nothing invented from a logline (row 9a)", () => {
    const items = compileBuildItems(blueprint({ keyArt: undefined as never }), { model: MODEL, referenceImages: 3 });
    assert.ok(!items.some((item) => item.kind === "key-art"));
  });

  it("no route records the image work unauthorized with the refusal stated (R-11, R-48)", () => {
    const items = compileBuildItems(blueprint(), null);
    const images = items.filter((item) => item.kind !== "world" && item.kind !== "author-sheet" && item.kind !== "thread" && item.kind !== "finalize");
    assert.ok(images.length > 0);
    assert.ok(images.every((item) => !item.authorized && item.refusal !== undefined));
    assert.ok(items.filter((item) => item.kind === "author-sheet").every((item) => item.authorized));
  });

  it("a route with no reference slots refuses the character sheets by name, and only them (R-10)", () => {
    const items = compileBuildItems(blueprint(), { model: MODEL, referenceImages: 0 });
    assert.ok(items.filter((item) => item.kind === "main-photo").every((item) => item.authorized));
    const sheets = items.filter((item) => item.kind === "sheet-image");
    assert.ok(sheets.every((item) => !item.authorized));
    assert.match(sheets[0]!.refusal ?? "", /reference images/);
  });
});

describe("the fold (SPEC-031 R-32, R-39, R-40, R-46)", () => {
  it("progress is items terminal over items authorized, and stages never advance ahead of their work", () => {
    const rec = record(blueprint(), { model: MODEL, referenceImages: 3 });
    const stage1Keys = rec.items.filter((item) => item.stage === 1).map((item) => item.key);
    const state = foldFoundingBuild(rec, stage1Keys.flatMap(landed), [], "The Undersong");
    assert.equal(state.progress.terminal, stage1Keys.length);
    assert.equal(state.progress.authorized, rec.items.length);
    assert.equal(state.stages[0]!.state, "complete", "planning completed when the record was written");
    assert.equal(state.stages[1]!.state, "complete");
    assert.equal(state.stages[2]!.state, "pending", "no stage fills while the wave behind it runs");
    assert.equal(state.stages[3]!.state, "pending");
    assert.equal(state.stages[4]!.state, "pending");
    assert.equal(state.status, "running");
  });

  it("the working line names the item, not the stage (R-41)", () => {
    const rec = record(blueprint(), { model: MODEL, referenceImages: 3 });
    const entries: BuildJournalEntry[] = [{ kind: "intent", key: "main-photo:maren-kest", at: AT }];
    const state = foldFoundingBuild(rec, entries, [], "The Undersong");
    assert.deepEqual(state.working, ["Maren Kest · main photo"]);
    assert.equal(buildWorkingLine({ kind: "sheet-image", name: "Nadia" }), "Nadia · character sheet");
  });

  it("the shortfall is a count and one cause, never a list (R-46)", () => {
    const rec = record(blueprint(), { model: MODEL, referenceImages: 3 });
    const failedAll = rec.items
      .filter((item) => item.idempotencyKey !== undefined)
      .flatMap((item): BuildJournalEntry[] => [
        { kind: "intent", key: item.key, at: AT },
        { kind: "terminal", key: item.key, outcome: "failed", detail: "the provider rejected the credential", at: AT },
      ]);
    const rest = rec.items
      .filter((item) => item.idempotencyKey === undefined)
      .flatMap((item) => landed(item.key));
    const state = foldFoundingBuild(
      rec,
      [...failedAll, ...rest, { kind: "completed", at: AT }],
      [],
      "The Undersong",
    );
    assert.equal(state.status, "completed");
    assert.equal(state.shortfall?.count, 6);
    assert.equal(state.shortfall?.cause, "the provider rejected the credential");
  });

  it("a re-run after a terminal outcome reads as running again — the last word wins (R-48)", () => {
    const rec = record(blueprint(), { model: MODEL, referenceImages: 3 });
    const key = "main-photo:maren-kest";
    const entries: BuildJournalEntry[] = [
      { kind: "intent", key, at: AT },
      { kind: "terminal", key, outcome: "failed", detail: "402", at: AT },
      { kind: "intent", key, at: AT },
    ];
    const state = foldFoundingBuild(rec, entries, [], "The Undersong");
    assert.equal(state.items.find((item) => item.key === key)?.state, "running");
  });

  it("an unauthorized item a later press ran folds by its journal, not its refusal", () => {
    const rec = record(blueprint(), null);
    const key = "main-photo:maren-kest";
    const state = foldFoundingBuild(rec, landed(key), [], "The Undersong");
    assert.equal(state.items.find((item) => item.key === key)?.state, "landed");
  });

  it("stopping marks what never ran as skipped and keeps what landed (R-35)", () => {
    const rec = record(blueprint(), { model: MODEL, referenceImages: 3 });
    const entries: BuildJournalEntry[] = [...landed("world:world"), { kind: "stopped", at: AT }];
    const state = foldFoundingBuild(rec, entries, [], "The Undersong");
    assert.equal(state.status, "stopped");
    assert.equal(state.items.find((item) => item.key === "world:world")?.state, "landed");
    assert.equal(state.items.find((item) => item.key === "thread:1")?.state, "skipped");
  });

  it("the notice persists until dismissed, and dismissal is a journal fact (R-45)", () => {
    const rec = record(blueprint(), { model: MODEL, referenceImages: 3 });
    const entries: BuildJournalEntry[] = [
      { kind: "intent", key: "main-photo:maren-kest", at: AT },
      { kind: "terminal", key: "main-photo:maren-kest", outcome: "failed", detail: "x", at: AT },
      { kind: "completed", at: AT },
    ];
    assert.equal(foldFoundingBuild(rec, entries, [], "w").noticeDismissed, false);
    assert.equal(
      foldFoundingBuild(rec, [...entries, { kind: "notice-dismissed", at: AT }], [], "w").noticeDismissed,
      true,
    );
  });

  it("five stages, and the design's own names (R-38)", () => {
    assert.deepEqual(
      BUILD_STAGES.map((stage) => stage.label),
      [
        "Understanding your vision",
        "Shaping the world",
        "Creating characters",
        "Forging history and lore",
        "Finalizing the details",
      ],
    );
  });
});
