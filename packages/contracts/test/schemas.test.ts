import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArtifactSidecarSchema,
  CanonEntrySchema,
  ChangeRecordSchema,
  ClientMessageSchema,
  ClientStateSchema,
  DomainEventSchema,
  FrameSchema,
  HarnessEventSchema,
  JobSchema,
  LedgerEntrySchema,
  ProposalSchema,
  ReferenceKitSchema,
  ReviewDecisionSchema,
  RipplePreviewSchema,
  SceneSchema,
  SelectionsSchema,
  SheetSchema,
  TakeSchema,
  ulid,
  UlidSchema,
  WorldMetaSchema,
  newId,
} from "../src/index.js";

const WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HC";

describe("ids", () => {
  it("generates 26-char Crockford ULIDs that validate", () => {
    for (let i = 0; i < 50; i++) {
      const id = ulid();
      assert.equal(id.length, 26);
      assert.doesNotThrow(() => UlidSchema.parse(id));
    }
  });

  it("prefixes record ids by kind", () => {
    assert.match(newId("tk"), /^tk_[0-9A-HJKMNP-TV-Z]{26}$/);
    assert.match(newId("jb"), /^jb_[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("orders ULIDs by generation time", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    assert.ok(a < b, "earlier timestamp must sort first");
  });
});

describe("world.json", () => {
  const valid = {
    worldId: WORLD_ID,
    slug: "the-undersong",
    schemaVersion: 1,
    name: "The Undersong",
    logline: "A drowned god still sings beneath the harbour.",
    tone: "quiet dread",
    genre: "coastal fantasy",
    canonRevision: 42,
    nextCanonId: 45,
    created: "2026-05-02T09:14:00Z",
    updated: "2026-07-30T18:22:00Z",
  };

  it("round-trips unchanged", () => {
    assert.deepEqual(WorldMetaSchema.parse(valid), valid);
  });

  it("rejects a slug as worldId — global records key on ULIDs", () => {
    assert.throws(() => WorldMetaSchema.parse({ ...valid, worldId: "the-undersong" }));
  });

  it("rejects unknown fields rather than passing a partial object through", () => {
    assert.throws(() => WorldMetaSchema.parse({ ...valid, color: "teal" }));
  });
});

describe("sheets", () => {
  const maren = {
    id: "maren-kest",
    type: "character",
    name: "Maren Kest",
    role: "Tide-caller",
    billing: "lead",
    version: 4,
    status: "locked",
    voice: { provider: "elevenlabs", voiceId: "v_8Kq2", label: "Low tide", assignedAtVersion: 4 },
    canonRules: ["CANON-002"],
    links: ["bray-half-hitch", "the-chorister"],
    created: "2026-05-02",
    updated: "2026-07-14",
    sections: [
      { heading: "Essence", body: "Tide-caller. She hears the verse under the harbour." },
      { heading: "Appearance", body: "Salt-crusted braids, pale grey eyes." },
    ],
  };

  it("round-trips a character sheet unchanged", () => {
    assert.deepEqual(SheetSchema.parse(maren), maren);
  });

  it("rejects an invalid status", () => {
    assert.throws(() => SheetSchema.parse({ ...maren, status: "final" }));
  });

  it("rejects canonRules that are not CANON ids — rules are owned by canon", () => {
    assert.throws(() => SheetSchema.parse({ ...maren, canonRules: ["tide-calling"] }));
  });
});

describe("canon entries", () => {
  const entry = {
    id: "CANON-002",
    type: "rule",
    title: "Tide-calling",
    status: "settled",
    introducedAt: 1,
    settledAt: 12,
    amendedAt: 42,
    links: ["maren-kest", "CANON-031"],
    body: "A caller cannot move a tide she has not stood in.",
  };

  it("round-trips unchanged", () => {
    assert.deepEqual(CanonEntrySchema.parse(entry), entry);
  });

  it("rejects a non-monotonic id shape", () => {
    assert.throws(() => CanonEntrySchema.parse({ ...entry, id: "CANON-2" }));
  });
});

describe("scenes and selection", () => {
  const scene = {
    id: "sc_04",
    number: 4,
    slug: "the-verse-rises",
    title: "The verse rises",
    status: "accepted",
    version: 2,
    inherits: { location: "the-vigil", timeOfDay: "night", tone: "quiet dread" },
    board: { version: 2, compiledAt: "2026-07-29T11:02:00Z", image: "board-v2.png" },
    shots: [
      {
        id: "sh_12",
        number: 12,
        title: "Maren at the rail, listening",
        description: "@maren-kest grips the rail of @the-vigil.",
        camera: "MCU · slow push-in",
        audio: { kind: "vo", speaker: "maren-kest", line: "the verse, under the water" },
        durationSec: 4,
      },
    ],
  };

  it("round-trips unchanged", () => {
    assert.deepEqual(SceneSchema.parse(scene), scene);
  });

  it("rejects selection state inside the scene file — selection lives in selections.json", () => {
    const withSelection = {
      ...scene,
      shots: [{ ...scene.shots[0], acceptedTakeId: `tk_${ulid()}` }],
    };
    assert.throws(() => SceneSchema.parse(withSelection));
  });

  it("validates selections.json", () => {
    const selections = { sh_12: { acceptedTakeId: newId("tk"), startFrameTakeId: newId("tk") } };
    assert.deepEqual(SelectionsSchema.parse(selections), selections);
    assert.throws(() => SelectionsSchema.parse({ sh_12: { acceptedTakeId: "not-a-take" } }));
  });
});

describe("takes and reviews", () => {
  const take = {
    id: newId("tk"),
    jobId: newId("jb"),
    passId: newId("ps"),
    coversShots: ["sh_12"],
    kind: "clip",
    provider: "fal",
    model: "seedance-2.0",
    provenance: { canonRevision: 42, sheets: { "maren-kest": 4, "the-vigil": 2 } },
    prompt: "Maren at the rail…",
    references: ["references/maren-kest/model-sheet-v4.png"],
    startFrame: "takes/tk_x/last-frame.png",
    params: { aspect: "16:9", durationSec: 6, seed: 4417 },
    cost: { estimatedMicroUsd: 130000, actualMicroUsd: 128400, actualSource: "provider-reported" },
    dispatchedAt: "2026-07-30T14:01:12Z",
    completedAt: "2026-07-30T14:02:04Z",
    media: "clip.mp4",
  };

  it("round-trips unchanged", () => {
    assert.deepEqual(TakeSchema.parse(take), take);
  });

  it("has no status field — review decisions are not properties of the take", () => {
    assert.throws(() => TakeSchema.parse({ ...take, status: "accepted" }));
  });

  it("rejects floating-point money", () => {
    assert.throws(() =>
      TakeSchema.parse({ ...take, cost: { estimatedMicroUsd: 0.13, actualMicroUsd: null } }),
    );
  });

  it("validates a review decision with a drift citation", () => {
    const review = {
      ts: "2026-07-30T13:58:02Z",
      takeId: take.id,
      shotId: "sh_12",
      decision: "reject",
      by: "user",
      citation: { sheet: "maren-kest", field: "appearance", note: "coat drifted off-sheet" },
    };
    assert.deepEqual(ReviewDecisionSchema.parse(review), review);
    assert.throws(() => ReviewDecisionSchema.parse({ ...review, decision: "maybe" }));
  });
});

describe("artifacts", () => {
  const sidecar = {
    id: newId("ar"),
    kind: "audio",
    file: "harbour-bells.wav",
    hash: "sha256:9f2c66a1b0e4d8c2",
    origin: { by: "user" },
    links: ["the-vigil"],
    created: "2026-06-11T10:00:00Z",
  };

  it("round-trips unchanged", () => {
    assert.deepEqual(ArtifactSidecarSchema.parse(sidecar), sidecar);
  });

  it("requires producedBy on system-produced artifacts (R-ART-2)", () => {
    assert.throws(() => ArtifactSidecarSchema.parse({ ...sidecar, origin: { by: "system" } }));
    const system = { ...sidecar, origin: { by: "system", producedBy: "board-compile:sc_04" } };
    assert.deepEqual(ArtifactSidecarSchema.parse(system), system);
  });
});

describe("proposals and ripples", () => {
  const proposal = {
    id: newId("pr"),
    kind: "sheet-edit",
    summary: "Maren's coat gains the bioluminescent thread",
    targets: [{ path: "characters/maren-kest.md", baseVersion: 4, baseHash: "sha256:9f2c66a1" }],
    baseCanonRevision: 42,
    reservedCanonIds: [],
    source: "chat:sess_9f2",
    created: "2026-07-30T18:00:00Z",
  };

  it("round-trips unchanged", () => {
    assert.deepEqual(ProposalSchema.parse(proposal), proposal);
  });

  it("requires a base hash or an explicit null — staleness is detected, never merged", () => {
    assert.throws(() =>
      ProposalSchema.parse({
        ...proposal,
        targets: [{ path: "characters/maren-kest.md", baseVersion: 4 }],
      }),
    );
  });

  it("validates a ripple preview", () => {
    const preview = {
      computedAt: "2026-07-30T18:00:01Z",
      governing: false,
      items: [
        {
          kind: "stale-reference-tiles",
          summary: "14 reference images predate v5 — regenerate looks after accept",
          targets: ["references/maren-kest"],
        },
      ],
    };
    assert.deepEqual(RipplePreviewSchema.parse(preview), preview);
  });
});

describe("jobs and ledger", () => {
  const job = {
    id: newId("jb"),
    idempotencyKey: ulid(),
    worldId: WORLD_ID,
    productionId: "saltlight",
    target: { kind: "shot", id: "sh_12", coversShots: ["sh_12"] },
    capability: "video",
    provider: "fal",
    model: "seedance-2.0",
    params: { aspect: "16:9" },
    estimatedMicroUsd: 130000,
    status: "running",
    providerJobId: "fal_abc123",
    attempt: 1,
    error: null,
    createdAt: "2026-07-30T14:01:00Z",
    updatedAt: "2026-07-30T14:01:12Z",
  };

  it("round-trips unchanged", () => {
    assert.deepEqual(JobSchema.parse(job), job);
  });

  it("rejects an unknown status — the state machine is closed", () => {
    assert.throws(() => JobSchema.parse({ ...job, status: "paused" }));
  });

  it("validates a ledger line with estimate and actual recorded separately", () => {
    const entry = {
      ts: "2026-07-30T14:02:04Z",
      worldId: WORLD_ID,
      productionId: "saltlight",
      jobId: job.id,
      provider: "fal",
      model: "seedance-2.0",
      outcome: "succeeded",
      estimatedMicroUsd: 130000,
      actualMicroUsd: 128400,
      actualSource: "provider-reported",
    };
    assert.deepEqual(LedgerEntrySchema.parse(entry), entry);
  });
});

describe("reference kits", () => {
  const kit = {
    sheetId: "maren-kest",
    anchor: "head-front.png",
    tiles: [
      { angle: "head-front", status: "locked", file: "head-front.png", sheetVersion: 4 },
      { angle: "body-full", status: "generated", file: "body-full.png", sheetVersion: 3 },
      { angle: "head-front", status: "superseded", file: "head-front-old.png", sheetVersion: 2 },
      { angle: "head-profile", status: "empty" },
    ],
    compilations: [
      {
        file: "model-sheet-v4-grid.png",
        format: "classic-grid",
        sheetVersion: 4,
        tiles: ["head-front.png"],
        compiledAt: "2026-07-14T09:00:00Z",
        source: "local",
        accepted: true,
      },
    ],
    designatedCompilation: "model-sheet-v4-grid.png",
  };

  it("round-trips unchanged", () => {
    assert.deepEqual(ReferenceKitSchema.parse(kit), kit);
  });
});

describe("change records", () => {
  it("accepts the documented shape and passes newer fields through", () => {
    const change = {
      ts: "2026-07-30T18:22:04Z",
      entity: "characters/maren-kest",
      fromVersion: 4,
      toVersion: 5,
      fieldsChanged: ["appearance", "voice-written"],
      source: "chat:sess_9f2",
      canonRevisionAfter: 42,
      proposalId: "pr_01J8H3K2QW9VZX4N7M0RTYB6",
      futureField: "kept",
    };
    assert.deepEqual(ChangeRecordSchema.parse(change), change);
  });
});

describe("domain events and frames", () => {
  const event = {
    at: "2026-07-30T18:22:04Z",
    type: "health.changed",
    component: "harness",
    status: "unavailable",
    reason: "OpenCode is not configured",
  } as const;

  it("validates events at the boundary", () => {
    assert.deepEqual(DomainEventSchema.parse(event), event);
    assert.throws(() => DomainEventSchema.parse({ ...event, type: "health.exploded" }));
  });

  it("validates snapshot and event frames", () => {
    const state = {
      app: {
        version: "0.1.0",
        health: {
          coordinator: { status: "healthy" },
          harness: { status: "unavailable", reason: "not configured" },
          voice: { status: "unavailable", reason: "not configured" },
        },
        jobs: [],
        ledger: [],
      },
      worlds: [],
      world: null,
    };
    assert.doesNotThrow(() => ClientStateSchema.parse(state));
    assert.doesNotThrow(() => FrameSchema.parse({ kind: "snapshot", seq: 1, state }));
    assert.doesNotThrow(() => FrameSchema.parse({ kind: "event", seq: 2, event }));
    assert.throws(() => FrameSchema.parse({ kind: "event", seq: 0, event }));
  });

  it("validates client messages", () => {
    assert.doesNotThrow(() => ClientMessageSchema.parse({ kind: "hello", lastSeq: 12 }));
    assert.doesNotThrow(() => ClientMessageSchema.parse({ kind: "open-world", worldId: WORLD_ID }));
    assert.throws(() => ClientMessageSchema.parse({ kind: "open-world", worldId: "the-undersong" }));
  });

  it("validates harness events", () => {
    assert.doesNotThrow(() =>
      HarnessEventSchema.parse({ type: "message.completed", sessionId: "s1", text: "done" }),
    );
    assert.throws(() => HarnessEventSchema.parse({ type: "message.completed", sessionId: 1, text: "x" }));
  });
});
