import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProductionSetupDraftSchema,
  newId,
  ulid,
  type AppSettings,
  type ConversationId,
  type ManifestModel,
  type MessageId,
  type ModelManifest,
  type TurnId,
  type WorldChatMessage,
} from "@arke-studio/contracts";
import { WorldStore } from "../../src/world/store.js";
import { imageModelFor } from "../../src/references/generate.js";
import { planProductionSetup } from "../../src/productions/setup-plan.js";
import { validateTurnResult } from "../../src/world-chat/turn-result.js";
import { scanWorld } from "../../src/world/scan.js";
import { FIXTURE_WORLD, WORLD_ID, makeTempWorld } from "./helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Models for a world and for a production (design turn 153).
 *
 * Two scopes, one parent: a world's own choice outranks Settings for world work, a production's
 * for production work, and neither falls back to the other. A choice that cannot run is refused
 * rather than replaced — the same rule a requested id has always had — because falling back to
 * the default is spending money on a model the person turned away from.
 */

const CLOCK = "2026-09-24T09:00:00.000Z";

async function open() {
  const store = await WorldStore.open(await makeTempWorld(), { clock: () => CLOCK });
  closeOnCleanup(() => store.close());
  return store;
}

const image = (id: string): ManifestModel => ({
  id,
  provider: "fal",
  capability: "image",
  displayName: id,
  accepts: { referenceImages: 4, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perImage", microUsdPerImage: 40000 },
});
const MANIFEST = { models: [image("routed"), image("chosen"), image("requested")] } as unknown as ModelManifest;
const settings = (disabled: string[] = []) =>
  ({ routing: { image: "routed" }, models: { disabled } }) as unknown as AppSettings;

describe("a world's own models (design turn 153)", () => {
  it("records a choice on world.json and removes the key when the last one is cleared", async () => {
    const store = await open();
    await store.setWorldModel("image", "chosen");
    await store.setWorldModel("video", "some-video");
    assert.deepEqual(store.getBundle().meta.models, { image: "chosen", video: "some-video" });

    await store.setWorldModel("image", null);
    assert.deepEqual(store.getBundle().meta.models, { video: "some-video" });

    await store.setWorldModel("video", null);
    assert.equal(store.getBundle().meta.models, undefined);
    const raw = JSON.parse(await readFile(join(store.dir, "world.json"), "utf8")) as Record<string, unknown>;
    // An empty map reads as a choice made and then emptied; never having chosen has no key.
    assert.equal("models" in raw, false);
  });
});

describe("two rows changed at once", () => {
  it("keeps both — the second change does not erase the first", async () => {
    // Each change builds its map from the live bundle. Unserialized, both copied the same empty
    // map and the later commit silently put the first capability back on Settings (Codex, #1237).
    const store = await open();
    await Promise.all([store.setWorldModel("image", "chosen"), store.setWorldModel("video", "some-video")]);
    assert.deepEqual(store.getBundle().meta.models, { image: "chosen", video: "some-video" });
  });
});

describe("the image model for world work", () => {
  it("takes the scope's choice over Settings, and a requested id over both", () => {
    assert.equal(imageModelFor(settings(), MANIFEST)?.id, "routed");
    assert.equal(imageModelFor(settings(), MANIFEST, undefined, { image: "chosen" })?.id, "chosen");
    assert.equal(imageModelFor(settings(), MANIFEST, "requested", { image: "chosen" })?.id, "requested");
    assert.equal(imageModelFor(settings(), MANIFEST, undefined, { video: "elsewhere" })?.id, "routed",
      "another capability's choice says nothing about images");
  });

  it("refuses a chosen model that is turned off or gone, rather than falling back to the default", () => {
    assert.equal(imageModelFor(settings(["chosen"]), MANIFEST, undefined, { image: "chosen" }), null);
    assert.equal(imageModelFor(settings(), MANIFEST, undefined, { image: "no-such-model" }), null);
  });
});

describe("a production set up with its own models", () => {
  it("writes the setup card's choices onto the production, and nothing when there were none", async () => {
    const store = await open();
    const base = {
      schemaVersion: 1, setupId: `cv_${ulid()}`, worldId: WORLD_ID, revision: 1,
      title: "The crossing", kind: "film", aspect: "16:9", frameRate: 24,
      narrative: {}, arcs: [], references: [], openQuestions: [], episodes: [],
      scenes: [{ key: "arrival", title: "Arrival" }],
    };
    const chosen = planProductionSetup(
      store.getBundle(),
      ProductionSetupDraftSchema.parse({ ...base, models: { video: "kling-3" } }),
      CLOCK,
    );
    assert.deepEqual(chosen.production.models, { video: "kling-3" });
    const none = planProductionSetup(store.getBundle(), ProductionSetupDraftSchema.parse(base), CLOCK);
    assert.equal(none.production.models, undefined);
  });

  it("does not let the setup conversation choose a model — that is the author's, on the card", async () => {
    const message: WorldChatMessage = {
      id: newId("msg") as MessageId,
      turnId: newId("turn") as TurnId,
      role: "user",
      text: "Make it a film.",
      attachmentIds: [],
      createdAt: CLOCK,
    };
    const bundle = (await scanWorld(FIXTURE_WORLD)).bundle;
    const outcome = validateTurnResult({
      draftOnly: true,
      raw: JSON.stringify({
        reply: "Done.",
        candidateOperations: [],
        groupOperations: [],
        setupUpdate: { expectedRevision: 1, fields: { models: { video: "kling-3" } } },
      }),
      conversationId: newId("cv") as ConversationId,
      messages: [message],
      existing: [],
      groups: [],
      tombstones: [],
      receiptsThisRun: [],
      evidenceSources: { messages: [message], bundle, attachments: [], attachmentText: new Map() },
      checksFor: () => {
        throw new Error("no candidates in a setup turn");
      },
      now: () => CLOCK,
    });
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.problems[0]?.code, "setup-authority");
    assert.match(outcome.problems[0]?.safeMessage ?? "", /does not choose models/);
  });
});
