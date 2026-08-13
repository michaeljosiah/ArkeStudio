import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ArtifactSidecarSchema,
  ArtDirectionRecordSchema,
  AppSettingsSchema,
  canDeleteJob,
  CanonEntrySchema,
  ChangeRecordSchema,
  CHARACTER_ROLE_MAX,
  ClientMessageSchema,
  ClientStateSchema,
  computeNeedsYou,
  DomainEventSchema,
  FrameSchema,
  HarnessEventSchema,
  JobSchema,
  LedgerEntrySchema,
  REPLAYABLE_FINALIZATION_TARGETS,
  type ClientState,
  type Job,
  ProposalSchema,
  ProductionSchema,
  ProductionSpineSchema,
  SpineAnchorSchema,
  SpineMarkerImportSchema,
  MediaInfoSchema,
  TakeMediaInfoRecordSchema,
  anchorProblems,
  anchorBudgetSec,
  orderedAnchors,
  orderedMarkers,
  ReferenceKitSchema,
  compilationIsStale,
  orderedLocationViews,
  normalizeViewName,
  ReviewDecisionSchema,
  RipplePreviewSchema,
  SceneSchema,
  SelectionsSchema,
  SheetSchema,
  TakeSchema,
  ulid,
  UlidSchema,
  WorldMetaSchema,
  deriveArtDirectionDescription,
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

describe("appearance settings", () => {
  it("defaults missing and malformed values to system", () => {
    assert.equal(AppSettingsSchema.parse({}).appearance.theme, "system");
    assert.equal(AppSettingsSchema.parse({ appearance: { theme: "sepia" } }).appearance.theme, "system");
  });

  it("validates appearance commands and events", () => {
    assert.deepEqual(ClientMessageSchema.parse({ kind: "set-appearance-theme", preference: "dark" }), {
      kind: "set-appearance-theme",
      preference: "dark",
    });
    assert.deepEqual(
      DomainEventSchema.parse({
        at: "2026-08-04T10:00:00Z",
        type: "appearance.changed",
        preference: "light",
      }),
      { at: "2026-08-04T10:00:00Z", type: "appearance.changed", preference: "light" },
    );
    assert.throws(() => ClientMessageSchema.parse({ kind: "set-appearance-theme", preference: "sepia" }));
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

describe("world art direction", () => {
  it("validates a versioned record with image-bearing history", () => {
    const record = {
      version: 3,
      description: "Painterly, tidal, restrained.",
      masterLook: "art-direction/master-look-v3.png",
      acceptedAt: "2026-07-18T10:00:00Z",
      history: [
        {
          version: 2,
          description: "Cold-water realism.",
          masterLook: "art-direction/master-look-v2.png",
          acceptedAt: "2026-06-04T10:00:00Z",
        },
      ],
    };
    // Not a round trip any more (#244): parsing fills the standing constraints a record written
    // before them does not carry. Everything the file did say survives untouched — the defaults
    // are added in memory, and nothing here rewrites the file or moves the version.
    const parsed = ArtDirectionRecordSchema.parse(record);
    const { audio, failureModes, ...asWritten } = parsed;
    assert.deepEqual(asWritten, { ...record, history: record.history.map((h) => ({ ...h, audio, failureModes })) });
    assert.deepEqual(audio, { music: "environmental-only", subtitles: "never" });
    assert.deepEqual(failureModes, []);
  });

  it("derives a non-blank description even when tone and genre are absent", () => {
    assert.match(
      deriveArtDirectionDescription({
        worldId: WORLD_ID,
        slug: "the-undersong",
        schemaVersion: 1,
        name: "The Undersong",
        canonRevision: 42,
        nextCanonId: 45,
        created: "2026-05-02T09:14:00Z",
        updated: "2026-07-30T18:22:00Z",
      }),
      /The Undersong/,
    );
  });

  it("rejects blank direction and history at or beyond the current version", () => {
    assert.throws(() =>
      ArtDirectionRecordSchema.parse({
        version: 2,
        description: " ",
        acceptedAt: "2026-07-18T10:00:00Z",
        history: [],
      }),
    );
    assert.throws(() =>
      ArtDirectionRecordSchema.parse({
        version: 2,
        description: "Graphic maritime illustration.",
        acceptedAt: "2026-07-18T10:00:00Z",
        history: [{ version: 2, description: "Same version.", acceptedAt: "2026-06-04T10:00:00Z" }],
      }),
    );
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

  describe("role is bounded when written, unbounded when read (R-18)", () => {
    const overLong = "x".repeat(CHARACTER_ROLE_MAX + 1);
    const edit = {
      kind: "stage-sheet-edit" as const,
      worldId: WORLD_ID,
      path: "characters/maren-kest.md",
      summary: "Edit Maren Kest",
      sections: [{ heading: "Essence", body: "She hears the verse." }],
    };

    /** Parse and narrow off the discriminated union, so `.role` is reachable. */
    function stageEdit(role?: string) {
      const parsed = ClientMessageSchema.parse(role === undefined ? edit : { ...edit, role });
      if (parsed.kind !== "stage-sheet-edit") throw new Error(`parsed as ${parsed.kind}`);
      return parsed;
    }

    it("reads a sheet whose role already exceeds the cap", () => {
      // The read path must stay permissive: scan.ts drops a sheet it cannot parse, so a max
      // here would erase a character from a world that opened fine before the cap existed.
      assert.equal(SheetSchema.parse({ ...maren, role: overLong }).role, overLong);
    });

    it("refuses to stage an edit whose role exceeds the cap", () => {
      assert.throws(() => stageEdit(overLong));
    });

    it("stages an edit whose role is exactly the cap", () => {
      const atCap = "x".repeat(CHARACTER_ROLE_MAX);
      assert.equal(stageEdit(atCap).role, atCap);
    });

    it("trims before measuring, so padding does not spend the budget", () => {
      assert.equal(stageEdit(` ${"x".repeat(CHARACTER_ROLE_MAX)} `).role, "x".repeat(CHARACTER_ROLE_MAX));
    });

    it("accepts an edit that omits role entirely — the field is left untouched", () => {
      assert.equal(stageEdit().role, undefined);
    });
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

  it("validates selections.json, defaulting the trim to the start of the media", () => {
    const selections = { sh_12: { acceptedTakeId: newId("tk"), startFrameTakeId: newId("tk") } };
    // No longer a round trip (#253): a selection written before trims existed reads as trimmed
    // from zero, which is what it always meant. Nothing rewrites the file to say so.
    assert.deepEqual(SelectionsSchema.parse(selections), {
      sh_12: { ...selections.sh_12, trimInSec: 0 },
    });
    assert.equal(SelectionsSchema.parse({ sh_12: { trimInSec: 4.25 } })["sh_12"]?.trimInSec, 4.25);
    assert.throws(() => SelectionsSchema.parse({ sh_12: { acceptedTakeId: "not-a-take" } }));
    // A negative in-point is a cut before the file begins.
    assert.throws(() => SelectionsSchema.parse({ sh_12: { trimInSec: -1 } }));
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

  it("validates a reference take without a production job or shot", () => {
    const referenceTake = {
      id: newId("tk"),
      coversShots: [],
      kind: "main-photo",
      reference: { sheetId: "maren-kest" },
      provider: "user",
      model: "upload",
      provenance: { canonRevision: 42, sheets: { "maren-kest": 4 }, artDirectionVersion: 3 },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 0, actualMicroUsd: 0, actualSource: "local-zero" },
      dispatchedAt: "2026-08-03T12:00:00Z",
      completedAt: "2026-08-03T12:00:00Z",
      media: "portrait.png",
    };
    assert.deepEqual(TakeSchema.parse(referenceTake), referenceTake);
  });

  it("has no status field — review decisions are not properties of the take", () => {
    assert.throws(() => TakeSchema.parse({ ...take, status: "accepted" }));
  });

  it("take QC is optional, strict, and accepts the adjacent-framemd5-v1 record", () => {
    // Absent is the legacy and the unmeasured state, and both must keep parsing (#248).
    assert.equal(TakeSchema.parse(take).qc, undefined);

    const qc = {
      method: "adjacent-framemd5-v1",
      scope: "source-media",
      status: "degraded",
      nominalFps: 24,
      effectiveFps: 14,
      duplicateFrames: 10,
      duplicateRatio: 0.416667,
      sampledFrames: 25,
      thresholdRatio: 0.8,
    };
    assert.deepEqual(TakeSchema.parse({ ...take, qc }).qc, qc);

    // Strict about what a measurement claims to be: a different method or scope is a different
    // number, and a take that mislabels one is worse than a take that records none.
    assert.throws(() => TakeSchema.parse({ ...take, qc: { ...qc, method: "some-other-metric" } }));
    assert.throws(() => TakeSchema.parse({ ...take, qc: { ...qc, scope: "segment" } }));
    assert.throws(() => TakeSchema.parse({ ...take, qc: { ...qc, thresholdRatio: 0.5 } }));
    assert.throws(() => TakeSchema.parse({ ...take, qc: { ...qc, extra: true } }));
    assert.throws(() => TakeSchema.parse({ ...take, qc: { ...qc, sampledFrames: 1 } }), "two rows describe one transition; one row describes nothing");
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
    // Defaulted by the schema (#70 §11.1), so a proposal that omits it parses — but round-trip
    // identity only holds for one that carries it.
    draftRevision: 1,
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

describe("a failed finalization always leaves the user a way out", () => {
  const failed = (kind: string): Job => ({
    id: newId("jb"),
    idempotencyKey: ulid(),
    worldId: WORLD_ID,
    target: { kind },
    capability: "image",
    provider: "openai",
    model: "gpt-image-2",
    params: {},
    estimatedMicroUsd: 1,
    status: "succeeded",
    providerJobId: null,
    attempt: 1,
    error: null,
    finalization: { status: "failed", error: "could not be prepared", updatedAt: "2026-07-30T14:02:04Z" },
    createdAt: "2026-07-30T14:01:00Z",
    updatedAt: "2026-07-30T14:02:04Z",
  });

  const needsYouFor = (kind: string) =>
    computeNeedsYou({
      app: { jobs: [failed(kind)], queues: [] },
      world: null,
      worlds: [],
    } as unknown as ClientState).filter((entry) => entry.kind === "job-finalization-failed");

  // The queue stopped auto-replaying failed finalizations, so the row's only escape is its own
  // retry — and canDeleteJob refuses to delete it. A replayable kind without the action strands.
  for (const kind of REPLAYABLE_FINALIZATION_TARGETS) {
    it(`offers retry-finalization for ${kind}, which canDeleteJob will not let the user drop`, () => {
      const [entry] = needsYouFor(kind);
      assert.ok(entry, `${kind} should raise a needs-you entry`);
      assert.deepEqual(entry.actions, ["retry-finalization"]);
      assert.equal(canDeleteJob(failed(kind)), false);
    });
  }

  it("leaves a kind the queue cannot replay without a retry it would never honour", () => {
    const [entry] = needsYouFor("shot");
    assert.ok(entry);
    assert.deepEqual(entry.actions, []);
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

  it("adds the two-image kit without making legacy tiles migrate", () => {
    const next = {
      ...kit,
      mainPhoto: {
        file: "main-photo.png",
        source: "generated",
        sourceJobId: newId("jb"),
        sheetVersion: 4,
        artDirectionVersion: 3,
        acceptedAt: "2026-08-03T12:00:00Z",
      },
      compilations: [
        ...kit.compilations,
        {
          file: "character-sheet-v4.png",
          format: "character-sheet",
          sheetVersion: 4,
          tiles: [],
          compiledAt: "2026-08-03T12:02:00Z",
          source: newId("jb"),
          accepted: true,
          anchorFile: "main-photo.png",
          artDirectionVersion: 3,
        },
      ],
      looks: [],
    };
    assert.deepEqual(ReferenceKitSchema.parse(next), next);
    assert.deepEqual(ReferenceKitSchema.parse(kit), kit, "the six-tile shape still parses unchanged");
  });

  // #243 / design turn 57: a location's accepted angles.
  const view = (id: string, name: string, acceptedAt: string, status = "active") => ({
    id,
    name,
    file: `takes/tk_${id}/view.png`,
    sourceTakeId: newId("tk"),
    sheetVersion: 3,
    artDirectionVersion: 4,
    acceptedAt,
    status,
  });
  const locationKit = {
    sheetId: "the-vigil",
    tiles: [],
    compilations: [
      {
        file: "location-sheet-8f2c1d0a4b77.png",
        format: "location-sheet",
        sheetVersion: 3,
        tiles: ["takes/tk_v1/view.png", "takes/tk_v2/view.png"],
        compiledAt: "2026-08-10T09:00:00Z",
        source: "local",
        accepted: true,
      },
    ],
    designatedCompilation: "location-sheet-8f2c1d0a4b77.png",
    locationViews: [view("v1", "Establishing view", "2026-08-08T09:00:00Z"), view("v2", "Reverse angle", "2026-08-09T09:00:00Z")],
    establishingViewId: "v1",
  };

  it("accepts a location kit and leaves a character kit alone", () => {
    assert.deepEqual(ReferenceKitSchema.parse(locationKit), locationKit);
    // The two shapes share a file and never each other's fields.
    assert.equal(ReferenceKitSchema.parse(kit).locationViews, undefined);
    assert.equal(ReferenceKitSchema.parse(locationKit).mainPhoto, undefined);
  });

  it("refuses a location kit whose establishing view does not resolve", () => {
    assert.throws(
      () => ReferenceKitSchema.parse({ ...locationKit, establishingViewId: "nope" }),
      /establishingViewId/,
      "a dangling anchor makes the panel map unanswerable",
    );
    assert.throws(
      () => ReferenceKitSchema.parse({ ...locationKit, establishingViewId: undefined }),
      /establishing/,
      "active views without an establishing view have no panel 1",
    );
    // Superseded is not a candidate: the anchor has to be a view that still exists.
    assert.throws(() =>
      ReferenceKitSchema.parse({
        ...locationKit,
        locationViews: [view("v1", "Establishing view", "2026-08-08T09:00:00Z", "superseded"), view("v2", "Reverse angle", "2026-08-09T09:00:00Z")],
      }),
    );
  });

  it("holds the active-view ceiling and refuses two views by the same name", () => {
    const seven = Array.from({ length: 7 }, (_, i) => view(`v${i}`, `View ${i}`, `2026-08-0${i + 1}T09:00:00Z`));
    assert.throws(
      () => ReferenceKitSchema.parse({ ...locationKit, locationViews: seven, establishingViewId: "v0" }),
      /6 active/,
      "the seventh is refused at the door, not discovered at dispatch",
    );

    // Case and spacing do not make a second name.
    assert.throws(
      () =>
        ReferenceKitSchema.parse({
          ...locationKit,
          locationViews: [view("v1", "Establishing view", "2026-08-08T09:00:00Z"), view("v2", "  reverse   ANGLE ", "2026-08-09T09:00:00Z"), view("v3", "Reverse angle", "2026-08-10T09:00:00Z")],
        }),
      /duplicate active view name/,
    );

    // A superseded record may keep a name an active view has taken back.
    const reused = {
      ...locationKit,
      locationViews: [
        view("v1", "Establishing view", "2026-08-08T09:00:00Z"),
        view("v2", "Reverse angle", "2026-08-09T09:00:00Z", "superseded"),
        view("v3", "Reverse angle", "2026-08-10T09:00:00Z"),
      ],
    };
    assert.deepEqual(ReferenceKitSchema.parse(reused), reused, "history keeps its name; only active names are unique");
  });

  it("orders panels establishing-first, then by acceptance", () => {
    const kitOut = ReferenceKitSchema.parse({
      ...locationKit,
      // Deliberately out of order, and with the establishing view accepted last.
      locationViews: [
        view("v3", "Day", "2026-08-07T09:00:00Z"),
        view("v1", "Establishing view", "2026-08-10T09:00:00Z"),
        view("v2", "Reverse angle", "2026-08-08T09:00:00Z"),
      ],
      establishingViewId: "v1",
    });
    assert.deepEqual(
      orderedLocationViews(kitOut).map((v) => v.name),
      ["Establishing view", "Day", "Reverse angle"],
      "the anchor leads whenever it was accepted; the rest follow the order they were accepted in",
    );
    assert.equal(normalizeViewName("  Reverse   ANGLE "), "reverse angle");
  });

  it("keeps a replaced view in the panel it replaced, however late the replacement arrived", () => {
    // Panel 2 is replaced after panel 3 already exists. Ordering on acceptedAt alone would move
    // the replacement to panel 3 — and every prompt already citing "panel 2" would then be
    // describing the wrong side of the room. Design turn 57 settles that replacement "leaves the
    // panel order unchanged", so the replacement inherits the slot rather than the timestamp.
    const kitOut = ReferenceKitSchema.parse({
      ...locationKit,
      locationViews: [
        view("v1", "Establishing view", "2026-08-01T09:00:00Z"),
        { ...view("v2", "Reverse angle", "2026-08-02T09:00:00Z", "superseded") },
        view("v3", "Day", "2026-08-03T09:00:00Z"),
        { ...view("v4", "Reverse angle", "2026-08-09T09:00:00Z"), slotAt: "2026-08-02T09:00:00Z" },
      ],
      establishingViewId: "v1",
    });
    assert.deepEqual(
      orderedLocationViews(kitOut).map((v) => v.name),
      ["Establishing view", "Reverse angle", "Day"],
      "the replacement holds panel 2; Day is not pushed up and does not become panel 2 itself",
    );
  });

  it("orders by the instant, not by the string — an offset timestamp sorts where it happened", () => {
    // Both forms are valid IsoDateTimeSchema. 09:00+02:00 is 07:00Z, so it happened BEFORE
    // 08:00Z — and sorts after it lexically. A panel map derived from string order would put
    // these two the wrong way round.
    const kitOut = ReferenceKitSchema.parse({
      ...locationKit,
      locationViews: [
        view("v1", "Establishing view", "2026-08-01T09:00:00Z"),
        view("v2", "Later", "2026-08-10T08:00:00Z"),
        view("v3", "Earlier", "2026-08-10T09:00:00+02:00"),
      ],
      establishingViewId: "v1",
    });
    assert.deepEqual(
      orderedLocationViews(kitOut).map((v) => v.name),
      ["Establishing view", "Earlier", "Later"],
    );
  });

  it("measures a location sheet against its views, not against locked tiles it has none of", () => {
    // A location kit has no tiles, so the character-sheet grid comparison called every location
    // sheet stale — a warning on the dispatch dialog that no rebuild could ever clear.
    const parsed = ReferenceKitSchema.parse(locationKit);
    const files = orderedLocationViews(parsed).map((v) => v.file);
    const current = {
      file: "location-sheet-8f2c1d0a4b77.png",
      format: "location-sheet" as const,
      sheetVersion: 3,
      tiles: files,
      compiledAt: "2026-08-09T10:00:00Z",
      source: "local" as const,
      accepted: true,
    };
    assert.equal(compilationIsStale(parsed, current, 3), false, "the sheet matches its views");
    assert.equal(compilationIsStale(parsed, { ...current, sheetVersion: 2 }, 3), true, "the sheet advanced");
    assert.equal(
      compilationIsStale(parsed, { ...current, tiles: [...files].reverse() }, 3),
      true,
      "order is content: the same views stacked differently are a different sheet",
    );
    assert.equal(compilationIsStale(parsed, { ...current, tiles: files.slice(1) }, 3), true, "a view was added");
  });

  it("records a location view as its own immutable take kind", () => {
    const take = {
      id: newId("tk"),
      coversShots: [],
      kind: "location-view",
      reference: { sheetId: "the-vigil" },
      provider: "openai",
      model: "gpt-image-2",
      provenance: { canonRevision: 12, sheets: { "the-vigil": 3 }, artDirectionVersion: 4 },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 150000, actualMicroUsd: 150000, actualSource: "manifest-derived" },
      dispatchedAt: "2026-08-10T08:59:00Z",
      completedAt: "2026-08-10T09:00:00Z",
      media: "view.png",
    };
    assert.deepEqual(TakeSchema.parse(take), take);
  });
});

describe("art direction's standing constraints (#244)", () => {
  const base = {
    version: 2,
    description: "Painterly, tidal, restrained.",
    acceptedAt: "2026-07-18T10:00:00Z",
  };

  it("reads a record written before the policy existed, without changing it", () => {
    // The whole compatibility story: an old file parses, resolves to the defaults in memory, and
    // is not rewritten or re-versioned by having been read.
    const parsed = ArtDirectionRecordSchema.parse({ ...base, history: [] });
    assert.deepEqual(parsed.audio, { music: "environmental-only", subtitles: "never" });
    assert.deepEqual(parsed.failureModes, []);
    assert.equal(parsed.version, 2, "reading is not a version bump");
  });

  it("carries the policy on history too, so a take can be explained later", () => {
    const parsed = ArtDirectionRecordSchema.parse({
      ...base,
      audio: { music: "environmental-only", subtitles: "never" },
      history: [{ version: 1, description: "First look", acceptedAt: "2026-05-19T10:00:00Z" }],
    });
    assert.deepEqual(parsed.history[0]!.audio, { music: "environmental-only", subtitles: "never" });
  });

  it("refuses a subtitle policy other than never, and an unbounded failure list", () => {
    assert.throws(() =>
      ArtDirectionRecordSchema.parse({ ...base, audio: { music: "environmental-only", subtitles: "burn-in" } }),
    );
    // 21 is one past the ceiling: a constraint block longer than the shot it constrains stops
    // being read, by a model or by a person.
    assert.throws(() =>
      ArtDirectionRecordSchema.parse({ ...base, failureModes: Array.from({ length: 21 }, (_, i) => `rule ${i}`) }),
    );
    assert.throws(() => ArtDirectionRecordSchema.parse({ ...base, failureModes: ["x".repeat(301)] }));
    // Blank is not a rule: trim-then-min(1) refuses whitespace that would ride as an empty line.
    assert.throws(() => ArtDirectionRecordSchema.parse({ ...base, failureModes: ["  "] }));
  });

  it("gives a production one way to tighten and no way to loosen", () => {
    const production = {
      id: "saltlight",
      format: "video",
      title: "Saltlight",
      status: "in-progress",
      created: "2026-06-01T10:00:00Z",
      updated: "2026-06-01T10:00:00Z",
    };
    assert.deepEqual(ProductionSchema.parse(production).failureModes, []);
    assert.equal(ProductionSchema.parse({ ...production, musicPolicy: "environmental-only" }).musicPolicy, "environmental-only");
    // The relaxing value does not exist in the schema at all, which is a better place to make it
    // impossible than a screen is.
    assert.throws(() => ProductionSchema.parse({ ...production, musicPolicy: "allow-model-score" }));
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

  /*
   * A refused wrap-up has to name the attempt it answers. Events reach every connected client, so
   * an anonymous one lets a second window's refusal settle the first window's wrap-up while its
   * proposals are still being written. Required at the boundary rather than trusted, because
   * nothing downstream can tell an absent id from one that happens to match.
   */
  it("makes a refused wrap-up name its attempt", () => {
    const refused = {
      at: "2026-08-09T22:33:29Z",
      type: "world-chat.wrap-up-refused",
      conversationId: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
      requestId: "c9f1b0e2-0000-4000-8000-000000000000",
      reason: "in-flight",
      detail: "This conversation is already being turned into proposals. Wait for that to finish.",
    } as const;
    assert.deepEqual(DomainEventSchema.parse(refused), refused);

    const { requestId: _dropped, ...anonymous } = refused;
    assert.throws(() => DomainEventSchema.parse(anonymous));
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
    assert.doesNotThrow(() =>
      DomainEventSchema.parse({
        at: "2026-08-04T08:00:00Z",
        type: "main-photo.acceptance",
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        status: "failed",
        reason: "The main photo was not changed.",
        candidateRetained: true,
      }),
    );
    assert.doesNotThrow(() =>
      DomainEventSchema.parse({
        at: "2026-08-04T09:00:00Z",
        type: "queue.enqueue-result",
        requestId: WORLD_ID,
        command: "generate-world-image",
        disposition: "accepted",
        requestedCount: 1,
        acceptedJobIds: ["jb_01J8E0000000000000000000J1"],
        failures: [],
      }),
    );
    assert.throws(() => FrameSchema.parse({ kind: "event", seq: 0, event }));
  });

  it("carries an expected draft revision on an in-place proposal edit", () => {
    // #70 §11.4.1. The revision is what stops two windows quietly merging into a third version
    // neither person read, so it is required rather than optional, and it is a real revision:
    // a draft starts at 1, and 0 would be a client that had not loaded the proposal.
    const edit = {
      kind: "proposal-update-field",
      worldId: WORLD_ID,
      requestId: "req-1",
      proposalId: "pr_1",
      path: "canon/CANON-018.md",
      field: "Statement",
      value: "The bells cannot ring below the western lock.",
      expectedDraftRevision: 1,
    };
    assert.doesNotThrow(() => ClientMessageSchema.parse(edit));
    for (const missing of ["requestId", "expectedDraftRevision", "path", "field", "value"]) {
      const { [missing]: _dropped, ...without } = edit as Record<string, unknown>;
      assert.throws(() => ClientMessageSchema.parse(without), `${missing} must be required`);
    }
    assert.throws(() => ClientMessageSchema.parse({ ...edit, expectedDraftRevision: 0 }));
    assert.throws(() => ClientMessageSchema.parse({ ...edit, value: "x".repeat(20_001) }));
    // No path or id may ride along that the coordinator did not compute.
    assert.throws(() => ClientMessageSchema.parse({ ...edit, targetPath: "../../etc/passwd" }));
  });

  it("validates client messages", () => {
    assert.doesNotThrow(() => ClientMessageSchema.parse({ kind: "hello", lastSeq: 12 }));
    assert.doesNotThrow(() => ClientMessageSchema.parse({ kind: "open-world", worldId: WORLD_ID }));
    assert.doesNotThrow(() => ClientMessageSchema.parse({ kind: "list-provider-calls", jobId: null }));
    assert.doesNotThrow(() => ClientMessageSchema.parse({ kind: "list-provider-calls", jobId: `jb_${"0".repeat(26)}` }));
    assert.doesNotThrow(() =>
      ClientMessageSchema.parse({ kind: "generate-world-image", worldId: WORLD_ID, requestId: WORLD_ID }),
    );
    assert.throws(() => ClientMessageSchema.parse({ kind: "generate-world-image", worldId: WORLD_ID }));
    const queueMessages = [
      { kind: "establish-look", worldId: WORLD_ID, sheetId: "maren-kest", count: 4 },
      {
        kind: "generate-main-photo",
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        prompt: "portrait",
        count: 4,
        identityReferences: [],
      },
      { kind: "generate-character-sheet", worldId: WORLD_ID, sheetId: "maren-kest" },
      {
        kind: "generate-character-looks",
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        lookKind: "costume",
        mode: "stay-close",
        prompt: "coat",
        count: 4,
      },
      { kind: "generate-missing-tiles", worldId: WORLD_ID, sheetId: "maren-kest", group: "head" },
      { kind: "regenerate-tile", worldId: WORLD_ID, sheetId: "maren-kest", angle: "head-front" },
      {
        kind: "voice-preview",
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        provider: "elevenlabs",
        voiceId: "v1",
      },
      {
        kind: "dispatch-scene",
        worldId: WORLD_ID,
        productionId: "saltlight",
        sceneFile: "04-the-verse-rises",
        mode: "per-shot",
        modelId: "seedance-2.0",
      },
    ];
    for (const message of queueMessages) {
      assert.throws(() => ClientMessageSchema.parse(message), `${message.kind} requires request correlation`);
      assert.doesNotThrow(() => ClientMessageSchema.parse({ ...message, requestId: WORLD_ID }));
    }
    assert.doesNotThrow(() => ClientMessageSchema.parse({
      kind: "read-sheet-section",
      requestId: WORLD_ID,
      worldId: WORLD_ID,
      sheetId: "maren-kest",
      sectionHeading: "Essence",
    }));
    assert.doesNotThrow(() => ClientMessageSchema.parse({
      kind: "read-sheet-section",
      requestId: WORLD_ID,
      worldId: WORLD_ID,
      sheetId: "maren-kest",
      sectionHeading: "Appearance",
    }));
    // The reader names a readable section: one outside the set, or prose smuggled in a stray
    // field, is refused — the server reads the authoritative sheet, never the client's text.
    assert.throws(() => ClientMessageSchema.parse({
      kind: "read-sheet-section",
      requestId: WORLD_ID,
      worldId: WORLD_ID,
      sheetId: "maren-kest",
      sectionHeading: "Relationships",
    }));
    assert.throws(() => ClientMessageSchema.parse({
      kind: "read-sheet-section",
      requestId: WORLD_ID,
      worldId: WORLD_ID,
      sheetId: "maren-kest",
      sectionHeading: "Appearance",
      text: "renderer prose must not travel",
    }));
    assert.doesNotThrow(() =>
      ClientMessageSchema.parse({
        kind: "accept-character-sheet",
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        takeId: "tk_01J8A0000000000000000000R1",
      }),
    );
    assert.doesNotThrow(() =>
      ClientMessageSchema.parse({
        kind: "choose-anchor",
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        selection: { source: "candidate", file: "upload-test.webp" },
      }),
    );
    assert.throws(() =>
      ClientMessageSchema.parse({
        kind: "choose-anchor",
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        selection: { source: "candidate", file: "../world.json" },
      }),
    );
    assert.throws(() =>
      ClientMessageSchema.parse({
        kind: "accept-character-sheet",
        worldId: WORLD_ID,
        sheetId: "maren-kest",
        file: "references/maren-kest/takes/tk_x/sheet.png",
      }),
    );
    assert.throws(() => ClientMessageSchema.parse({ kind: "open-world", worldId: "the-undersong" }));
  });

  it("validates retained update states and install commands", () => {
    const update = {
      status: "ready",
      targetVersion: "0.2.8",
      progressPercent: 100,
      flow: null,
      detail: null,
    } as const;
    assert.doesNotThrow(() =>
      DomainEventSchema.parse({ at: "2026-08-05T12:00:00Z", type: "update.status", update }),
    );
    assert.throws(() =>
      DomainEventSchema.parse({
        at: "2026-08-05T12:00:00Z",
        type: "update.status",
        update: { ...update, progressPercent: 101 },
      }),
    );
    for (const kind of ["install-update-and-restart", "install-update-on-close", "acknowledge-update"]) {
      assert.doesNotThrow(() => ClientMessageSchema.parse({ kind }));
    }
  });

  it("validates harness events", () => {
    assert.doesNotThrow(() =>
      HarnessEventSchema.parse({ type: "message.completed", sessionId: "s1", text: "done" }),
    );
    assert.throws(() => HarnessEventSchema.parse({ type: "message.completed", sessionId: 1, text: "x" }));
  });
});

describe("the audio spine (#253, design turn 60)", () => {
  const spine = (anchors: Record<string, unknown>, markers: unknown[] = []) =>
    ProductionSpineSchema.parse({
      schemaVersion: 1,
      revision: 1,
      trackArtifactId: newId("ar"),
      markers,
      anchors,
      updatedAt: "2026-08-12T10:00:00Z",
    });

  it("refuses an anchor that ends before it starts, and mutes a clip unless told otherwise", () => {
    assert.throws(() => SpineAnchorSchema.parse({ startSec: 10, endSec: 10 }), /endSec/);
    assert.throws(() => SpineAnchorSchema.parse({ startSec: 10, endSec: 4 }), /endSec/);
    // Mute is the default because a generated clip's soundtrack is the model's invention and the
    // song is the thing being cut to.
    assert.deepEqual(SpineAnchorSchema.parse({ startSec: 0, endSec: 8 }).clipAudio, { mode: "mute" });
    assert.deepEqual(SpineAnchorSchema.parse({ startSec: 0, endSec: 8, clipAudio: { mode: "keep-diegetic" } }).clipAudio, {
      mode: "keep-diegetic",
      gainDb: -12,
    });
    // The master never ducks, so a clip cannot be mixed above it.
    assert.throws(() =>
      SpineAnchorSchema.parse({ startSec: 0, endSec: 8, clipAudio: { mode: "keep-diegetic", gainDb: 3 } }),
    );
  });

  it("treats touching anchors as legal and overlapping ones as a refusal", () => {
    const shots = new Set(["sh_1", "sh_2"]);
    // Half-open [start, end): 8.0 belongs to sh_2 alone, so this is not an overlap.
    const touching = spine({ sh_1: { startSec: 0, endSec: 8 }, sh_2: { startSec: 8, endSec: 16 } });
    assert.deepEqual(anchorProblems(touching, 60, shots), []);

    const overlapping = spine({ sh_1: { startSec: 0, endSec: 8 }, sh_2: { startSec: 6.5, endSec: 16 } });
    const problems = anchorProblems(overlapping, 60, shots);
    assert.equal(problems.length, 1);
    assert.equal(problems[0]?.kind, "overlaps");
    assert.match(problems[0]?.detail ?? "", /overlaps sh_1 by 1\.500s/, "says how much, not just that");
  });

  it("names every anchor caught inside a longer one, not just the one after it", () => {
    // Codex round 1: sorting by start puts the long anchor first, so comparing each anchor with
    // only its predecessor cleared sh_3 — checked against [1,2), sitting inside [0,100) the whole
    // time. A running furthest-endpoint is what catches it.
    const nested = spine({
      sh_1: { startSec: 0, endSec: 100 },
      sh_2: { startSec: 1, endSec: 2 },
      sh_3: { startSec: 3, endSec: 4 },
    });
    const problems = anchorProblems(nested, 200, new Set(["sh_1", "sh_2", "sh_3"]));
    assert.deepEqual(
      problems.filter((p) => p.kind === "overlaps").map((p) => p.shotId).sort(),
      ["sh_2", "sh_3"],
      "both are inside sh_1 and both are refused",
    );
    assert.ok(problems.every((p) => p.detail.includes("sh_1")), "and each names what it collides with");
    // Codex round 2: the intersection, not the distance to sh_1's end. [0,100) and [1,2) overlap
    // by one second; reporting 99 tells the user to move something 99 seconds.
    const nestedDetail = problems.find((p) => p.shotId === "sh_2")?.detail ?? "";
    assert.match(nestedDetail, /by 1\.000s/, `expected the intersection, got: ${nestedDetail}`);
  });

  it("reports an anchor whose shot is gone rather than dropping it", () => {
    // Deleting a shot must not silently delete twelve seconds of the song nobody agreed to give up.
    const orphaned = spine({ sh_1: { startSec: 0, endSec: 8 }, sh_gone: { startSec: 20, endSec: 32 } });
    const problems = anchorProblems(orphaned, 60, new Set(["sh_1"]));
    assert.deepEqual(problems.map((p) => p.kind), ["orphaned"]);
    assert.match(problems[0]?.detail ?? "", /sh_gone/);
  });

  it("refuses an anchor that runs past the end of the song", () => {
    const past = spine({ sh_1: { startSec: 50, endSec: 70 } });
    const problems = anchorProblems(past, 60, new Set(["sh_1"]));
    assert.deepEqual(problems.map((p) => p.kind), ["out-of-bounds"]);
    assert.match(problems[0]?.detail ?? "", /past the track's 60\.000s/);
  });

  it("plays in anchor order, not scene order, and states each shot's budget", () => {
    // sh_9 is a later shot number sitting earlier in the song. Anchor order is what the cut uses.
    const out = spine({ sh_9: { startSec: 5, endSec: 12 }, sh_2: { startSec: 30, endSec: 38 } });
    assert.deepEqual(orderedAnchors(out).map((a) => a.shotId), ["sh_9", "sh_2"]);
    assert.equal(anchorBudgetSec(out.anchors["sh_9"]!), 7);
  });

  it("orders markers by time and keeps insertion order on a tie", () => {
    const marker = (kind: "section" | "lyric", at: number, label: string) =>
      kind === "section"
        ? { kind, id: newId("mk"), label, atSec: at, source: "manual" as const }
        : { kind, id: newId("mk"), text: label, atSec: at, source: "lrc" as const };
    const parsed = spine({}, [
      marker("lyric", 30.25, "second by time"),
      marker("section", 0, "Intro"),
      marker("lyric", 30.25, "tied, and stays second"),
    ]);
    const ordered = orderedMarkers(parsed.markers);
    assert.deepEqual(
      ordered.map((m) => (m.kind === "section" ? m.label : m.text)),
      ["Intro", "second by time", "tied, and stays second"],
    );
  });

  it("accepts exactly the documented import shape and nothing adjacent to it", () => {
    const valid = { sections: [{ label: "Intro", atSec: 0 }], lyrics: [{ text: "forgive me", atSec: 30.25 }] };
    assert.deepEqual(SpineMarkerImportSchema.parse(valid), valid);
    // Both arrays are required: an omitted `lyrics` and an empty one would otherwise mean the
    // same thing going in and different things coming out.
    assert.throws(() => SpineMarkerImportSchema.parse({ sections: [] }));
    assert.throws(() => SpineMarkerImportSchema.parse({ sections: [], lyrics: [], bpm: 92 }));
    assert.throws(() => SpineMarkerImportSchema.parse({ sections: [], lyrics: [{ text: " ", atSec: 1 }] }));
    assert.throws(() => SpineMarkerImportSchema.parse({ sections: [], lyrics: [{ text: "x", atSec: -1 }] }));
  });

  it("measures media rather than believing a filename, and keeps the probe beside the take", () => {
    assert.throws(() => MediaInfoSchema.parse({ durationSec: 0, hasAudio: true }), /positive|greater/i);
    const record = {
      sourceHash: `sha256:${"a".repeat(64)}`,
      mediaInfo: { durationSec: 222.14, hasAudio: true, audioChannels: 2, audioSampleRateHz: 48000 },
      probedAt: "2026-08-12T10:00:00Z",
    };
    assert.deepEqual(TakeMediaInfoRecordSchema.parse(record), record);
    // A short hash would make a record that outlived its media indistinguishable from a current one.
    assert.throws(() => TakeMediaInfoRecordSchema.parse({ ...record, sourceHash: "sha256:abc" }));
  });
});
