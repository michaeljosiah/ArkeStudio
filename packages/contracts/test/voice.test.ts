import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BREEZE_DELIVERY,
  breezeDirection,
  clonedVoiceCandidates,
  cloudReaderCandidates,
  DEFAULT_NARRATOR,
  DELIVERIES,
  deliveryParams,
  extractVoiceAttributes,
  FISH_DELIVERY,
  fishDirection,
  HOSTED_VOICE_READERS,
  isClonedVoice,
  isHostedVoiceReader,
  mintVoiceId,
  narratorFor,
  legacyVoiceModel,
  newClonedVoice,
  parseVoiceLibrary,
  rankVoices,
  supportsVoiceUse,
  voiceSourceFor,
} from "../src/voice.js";
import { ClientMessageSchema } from "../src/frames.js";
import { billableCharacters, ModelManifestSchema, type ManifestModel } from "../src/manifest.js";
import { DomainEventSchema } from "../src/events.js";
import { VoiceAssignmentSchema } from "../src/world.js";
import { voiceJobIsCandidatePreview, voiceJobReadIdentity } from "../src/job.js";

/**
 * The narrator (asked for 2026-08-17): a third voice role, and deliberately not either of the
 * other two. A character voice lives on a sheet and answers who speaks; a reading voice is
 * chosen per take on the bench and belongs to one recording. The narrator reads text *about*
 * the world rather than lines *in* it.
 */

describe("who narrates (asked for 2026-08-17)", () => {
  const catalogue = [
    {
      provider: "kokoro",
      model: "kokoro-82m",
      voiceId: "bm_george",
      label: "George",
      attributes: [],
      local: true,
      canClone: false,
    },
    {
      provider: "elevenlabs",
      model: "eleven-v2",
      voiceId: "v_roger",
      label: "Roger v2",
      attributes: [],
      local: false,
      canClone: true,
    },
    {
      provider: "elevenlabs",
      model: "eleven-v3",
      voiceId: "v_roger",
      label: "Roger v3",
      attributes: [],
      local: false,
      canClone: true,
    },
  ];

  it("reads in the shipped local voice until somebody chooses otherwise", () => {
    // Local by default on purpose: "read aloud" is a passive press, and no other preference in
    // this app spends money on one.
    const chosen = narratorFor(null, catalogue);
    assert.equal(chosen.provider, DEFAULT_NARRATOR.provider);
    assert.equal(chosen.voiceId, DEFAULT_NARRATOR.voiceId);
    assert.equal(chosen.fallback, true);
    // Local is not incidental: it is what keeps a passive press from spending.
    assert.equal(catalogue.find((v) => v.voiceId === DEFAULT_NARRATOR.voiceId)?.local, true);
  });

  it("uses the chosen voice, carrying its own provider", () => {
    // Routing picks a model and can disagree with a voice's provider; the voice wins, because
    // one that resolves to a provider unable to say it is the silent mismatch this codebase
    // keeps paying for.
    const chosen = narratorFor({ provider: "elevenlabs", model: "eleven-v3", voiceId: "v_roger" }, catalogue);
    assert.equal(chosen.provider, "elevenlabs");
    assert.equal(chosen.model, "eleven-v3");
    assert.equal(chosen.voiceId, "v_roger");
    assert.equal(chosen.label, "Roger v3", "the label comes from the exact live model, not its sibling");
    assert.equal(chosen.fallback, false);
  });

  it("migrates a legacy narrator to the shipped model, not a same-provider sibling", () => {
    const legacyCatalogue = [
      {
        provider: "elevenlabs",
        model: "eleven-v3",
        voiceId: "v_roger",
        label: "Wrong sibling",
        attributes: [],
        local: false,
        canClone: true,
      },
      {
        provider: "elevenlabs",
        model: "eleven_multilingual_v2",
        voiceId: "v_roger",
        label: "Migrated",
        attributes: [],
        local: false,
        canClone: true,
      },
    ];
    const chosen = narratorFor({ provider: "elevenlabs", voiceId: "v_roger" }, legacyCatalogue);
    assert.equal(chosen.model, "eleven_multilingual_v2");
    assert.equal(chosen.label, "Migrated");
  });

  it("falls back rather than failing when the chosen voice is gone", () => {
    // A key withdrawn or a runtime uninstalled should quieten the reading to the local voice,
    // not turn every read-aloud into an error about a voice the user can no longer see.
    const chosen = narratorFor({ provider: "elevenlabs", voiceId: "v_deleted" }, catalogue);
    assert.equal(chosen.fallback, true);
    assert.equal(chosen.provider, "kokoro");
  });
});

describe("the voice catalogue belongs to the app, not a world", () => {
  it("asks for voices with no world open", () => {
    // Settings is reached from the world picker, where no world is open. An empty worldId
    // failed frame validation and the request was dropped, so the narrator's picker sat on
    // "Reading the catalogue…" forever — found on the first press in the installed app.
    assert.equal(ClientMessageSchema.safeParse({ kind: "voice-catalogue" }).success, true);
    assert.equal(
      ClientMessageSchema.safeParse({ kind: "voice-catalogue", worldId: "" }).success,
      false,
      "an empty id is still a bad id — absent is the way to say 'no world'",
    );
  });
});

/**
 * The cloned-voice library (SPEC-022 §2.3). IndexTTS ships with no voices at all — a voice in its
 * world is a wav file — so this is the adapter that makes a clip addressable as `{provider,
 * voiceId}` the way every other surface already expects.
 */
describe("a clip becomes a voice", () => {
  const base = {
    name: "Harbour glass",
    description: "Low, dry, unhurried. Coastal.",
    clip: "voices/harbour-glass.wav",
    consent: true,
    created: "2026-08-18T10:00:00.000Z",
    taken: [] as string[],
  };

  it("mints a readable id and extracts the description into matchable attributes", () => {
    const made = newClonedVoice(base);
    assert.equal(made.ok, true);
    assert.ok(made.ok);
    assert.equal(made.voice.id, "harbour-glass");
    // The description is not decoration: these are what rankVoices matches a written voice on.
    assert.deepEqual(made.voice.attributes, extractVoiceAttributes(base.description));
    assert.ok(made.voice.attributes.includes("coastal"));
  });

  it("refuses a voice with no description, because the picker would bury it (D3)", () => {
    const made = newClonedVoice({ ...base, description: "   " });
    assert.equal(made.ok, false);
    assert.ok(!made.ok);
    assert.match(made.reason, /what the picker matches on/);
  });

  it("refuses a voice whose speaker never agreed", () => {
    const made = newClonedVoice({ ...base, consent: false });
    assert.ok(!made.ok);
    assert.match(made.reason, /agreed to have their voice cloned/);
  });

  it("refuses a new voice whose clip is not world-relative", () => {
    const made = newClonedVoice({ ...base, clip: "../outside.wav" });
    assert.ok(!made.ok);
    assert.match(made.reason, /safe world-relative/);
  });

  it("a cloned voice ranks against a written voice like any other candidate", () => {
    const made = newClonedVoice(base);
    assert.ok(made.ok);
    const ranked = rankVoices(extractVoiceAttributes("A low, dry voice. Coastal, unhurried."), [
      ...clonedVoiceCandidates([made.voice]),
      {
        provider: "kokoro",
        model: "kokoro-82m",
        voiceId: "af_bella",
        label: "Bella",
        attributes: [],
        local: true,
        canClone: false,
      },
    ]);
    assert.equal(ranked[0]?.candidate.voiceId, "harbour-glass", "described beats undescribed");
    assert.ok(ranked[0]!.overlap > 0);
    // Local, and not itself cloneable — the original recording is already in the library.
    assert.equal(ranked[0]?.candidate.local, true);
    assert.equal(ranked[0]?.candidate.canClone, false);
  });

  it("can remain visible with an execution refusal and remote locality", () => {
    const made = newClonedVoice(base);
    assert.ok(made.ok);
    const [candidate] = clonedVoiceCandidates([made.voice], {
      local: false,
      unavailableReason: "the recipe is not ready",
    });
    assert.equal(candidate?.local, false);
    assert.equal(candidate?.unavailableReason, "the recipe is not ready");
  });

  it("names collide readably rather than clobbering", () => {
    assert.equal(mintVoiceId("Harbour glass", ["harbour-glass"]), "harbour-glass-2");
    assert.equal(mintVoiceId("Harbour glass", ["harbour-glass", "harbour-glass-2"]), "harbour-glass-3");
    assert.equal(mintVoiceId("!!!", []), "voice", "a name with nothing to slug still gets an id");
  });

  it("keeps what parses and drops only the bad entry", () => {
    // A hand-edited or older file must not delete every voice the world owns — the failure
    // SheetSchema's leniency exists to avoid, applied to the read path for voices.
    const voices = parseVoiceLibrary({
      voices: [
        { id: "a", name: "A", clip: "voices/a.wav" },
        { id: "", name: "broken", clip: "voices/b.wav" },
        { name: "no id either", clip: "voices/c.wav" },
        { id: "d", name: "D", clip: "voices/d.wav", description: "warm", attributes: ["warm"] },
      ],
    });
    assert.deepEqual(
      voices.map((v) => v.id),
      ["a", "d"],
    );
    // Defaults fill in rather than refusing: an entry written before consent was asked for reads.
    assert.equal(voices[0]?.consent, false);
    assert.deepEqual(voices[0]?.attributes, []);
  });

  it("a library that is not a library is empty, not a crash", () => {
    assert.deepEqual(parseVoiceLibrary(null), []);
    assert.deepEqual(parseVoiceLibrary({ voices: "nope" }), []);
  });

  it("drops unsafe clip paths from a hand-edited library", () => {
    for (const clip of [
      "../outside.wav",
      "/outside.wav",
      "C:/outside.wav",
      String.raw`voices\outside.wav`,
      "voices/a.wav:stream",
    ]) {
      assert.deepEqual(parseVoiceLibrary({ voices: [{ id: "v", name: "V", clip }] }), [], clip);
    }
  });
});

/**
 * The wire can name a third voice provider (SPEC-022 T-7). The preview frame typed `provider` as
 * the two that existed when it was written, so a cloned voice could be offered by the catalogue
 * and never asked for — the same assumption the cache key carried, one layer out.
 */
describe("a voice preview can name any provider the app knows", () => {
  const frame = (provider: string, model: string) => ({
    kind: "voice-preview" as const,
    requestId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    sheetId: "maren-kest",
    provider,
    model,
    voiceId: "harbour-glass",
  });

  it("accepts the local recipe engine, not only kokoro and elevenlabs", () => {
    for (const [provider, model] of [
      ["kokoro", "kokoro-82m"],
      ["elevenlabs", "eleven_multilingual_v2"],
      ["comfyui", "comfyui-cloned-voice"],
    ]) {
      assert.equal(ClientMessageSchema.safeParse(frame(provider!, model!)).success, true, provider);
    }
  });

  it("still refuses a provider this app has never heard of", () => {
    // A provider id, not a free string: a typo fails at the frame rather than reaching the
    // coordinator's own check.
    assert.equal(ClientMessageSchema.safeParse(frame("elevenlabz", "made-up")).success, false);
  });

  it("can carry destination-specific confirmation without carrying a URL", () => {
    const parsed = ClientMessageSchema.parse({
      ...frame("comfyui", "comfyui-cloned-voice"),
      voiceUploadConfirmedFor: "opaque-engine-instance",
    });
    assert.ok(parsed.kind === "voice-preview");
    assert.equal(parsed.voiceUploadConfirmedFor, "opaque-engine-instance");
    assert.equal(JSON.stringify(parsed).includes("http"), false);
  });

  it("returns a safe destination label and opaque token for renderer confirmation", () => {
    const event = DomainEventSchema.parse({
      at: "2026-08-25T12:00:00.000Z",
      type: "voice.upload-confirmation-required",
      requestId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HD",
      command: "voice-preview",
      destinationLabel: "voice-box.example:8188",
      confirmationToken: "opaque-engine-instance",
    });
    assert.equal(event.type, "voice.upload-confirmation-required");
    assert.equal(event.destinationLabel, "voice-box.example:8188");
    assert.equal(event.confirmationToken, "opaque-engine-instance");
  });
});

describe("voice assignment correlation", () => {
  const assignment = {
    kind: "assign-voice" as const,
    requestId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    path: "characters/maren-kest.md",
    voice: { provider: "comfyui", model: "comfyui-cloned-voice", voiceId: "harbour-glass" },
  };

  it("requires a request id and can carry the concrete model", () => {
    assert.equal(ClientMessageSchema.safeParse(assignment).success, true);
    const { requestId: _requestId, ...uncorrelated } = assignment;
    assert.equal(ClientMessageSchema.safeParse(uncorrelated).success, false);
  });

  it("reads legacy assignments and preserves concrete assignments", () => {
    assert.equal(
      VoiceAssignmentSchema.safeParse({ provider: "kokoro", voiceId: "bella", assignedAtVersion: 1 }).success,
      true,
    );
    const concrete = VoiceAssignmentSchema.parse({
      provider: "comfyui",
      model: "comfyui-cloned-voice",
      voiceId: "harbour",
      assignedAtVersion: 2,
    });
    assert.equal(concrete.model, "comfyui-cloned-voice");
  });

  it("migrates known legacy targets without guessing an unknown voice", () => {
    assert.equal(legacyVoiceModel("kokoro", "bella"), "kokoro-82m");
    assert.equal(legacyVoiceModel("elevenlabs", "same-id"), "eleven_multilingual_v2");
    assert.equal(
      legacyVoiceModel("comfyui", "harbour", [
        { id: "harbour", name: "Harbour", clip: "voices/harbour.wav" } as never,
      ]),
      "comfyui-cloned-voice",
    );
    assert.equal(legacyVoiceModel("comfyui", "missing", []), null);
  });
});

describe("provider-neutral voice results", () => {
  it("carries the actual provider, model, format and voice", () => {
    const event = {
      at: "2026-08-25T12:00:00.000Z",
      type: "voice.audio" as const,
      requestId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
      sheetId: "maren-kest",
      sheetVersion: 4,
      purpose: "candidate-preview" as const,
      provider: "comfyui" as const,
      model: "comfyui-cloned-voice",
      voiceId: "harbour-glass",
      format: "flac" as const,
      status: "ready" as const,
      file: ".cache/voice-previews/voice.flac",
      cached: true,
      characterCount: 20,
      estimatedMicroUsd: 0,
    };
    assert.equal(DomainEventSchema.safeParse(event).success, true);
    assert.equal(DomainEventSchema.safeParse({ ...event, provider: "elevenlabz" }).success, false);
  });

  it("keeps bible purpose separate from sheet identity", () => {
    assert.deepEqual(voiceJobReadIdentity({ params: { purpose: "bible-section" } } as never), {
      purpose: "bible-section",
    });
    assert.deepEqual(
      voiceJobReadIdentity({ params: { purpose: "sheet-section", sheetId: "maren-kest" } } as never),
      { purpose: "sheet-section", sheetId: "maren-kest" },
    );
    assert.equal(voiceJobIsCandidatePreview({ params: { purpose: "bible-section" } } as never), false);
    assert.equal(
      voiceJobIsCandidatePreview({
        params: { purpose: "candidate-preview", sheetId: "maren-kest" },
      } as never),
      true,
    );
  });
});

/**
 * Clone capture on the wire (SPEC-022 T-10). The frame is where consent is enforced, not the
 * handler — the model cannot tell whether a speaker agreed, and neither can the app.
 */
describe("the clone-voice frame", () => {
  const base = {
    kind: "clone-voice" as const,
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    clipId: "clip_01J8F3K2QW9VZX4N7M0RTYB6HD",
    name: "Harbour glass",
    description: "Low, dry, unhurried. Coastal.",
    consent: true as const,
  };

  it("accepts a consented clone, with or without the sheet it was made for", () => {
    assert.equal(ClientMessageSchema.safeParse(base).success, true);
    assert.equal(ClientMessageSchema.safeParse({ ...base, sheetId: "maren-kest" }).success, true);
  });

  it("cannot be spelled without consent", () => {
    // z.literal(true), not a boolean: there is no shape of this frame that carries false, so a
    // handler cannot forget to check it.
    assert.equal(ClientMessageSchema.safeParse({ ...base, consent: false }).success, false);
    // Built without the field rather than destructured out of it: an unused binding is a lint
    // error, and the point here is the SHAPE that omits consent, not a variable holding it.
    const noConsent = { ...base, consent: undefined };
    assert.equal(ClientMessageSchema.safeParse(noConsent).success, false);
  });

  it("cannot be spelled without a description", () => {
    // rankVoices buries an attribute-less candidate, so a voice cloned FOR a character would sink
    // below every preset when ranked against her. Refused at the wire as well as at creation.
    assert.equal(ClientMessageSchema.safeParse({ ...base, description: "" }).success, false);
  });

  it("takes a staged clip and has no way to name a path", () => {
    // SPEC-001 R-9: the host owns its file dialog and what it returns. A renderer that could put
    // a path here could clone from anywhere on the disk without the host ever opening a dialog.
    assert.equal(ClientMessageSchema.safeParse({ ...base, clipId: "" }).success, false);
    const { clipId, ...rest } = base;
    assert.equal(clipId.length > 0, true);
    assert.equal(ClientMessageSchema.safeParse({ ...rest, sourcePath: "C:/anywhere.wav" }).success, false);
  });
});

/** Staging is what gives the dialog a clip to draw without ever learning where it lives. */
describe("the stage-voice-clip frame", () => {
  const base = {
    kind: "stage-voice-clip" as const,
    worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
    requestId: "stage-1",
  };

  it("takes either gesture: bytes for a recording, nothing for a chosen file", () => {
    assert.equal(ClientMessageSchema.safeParse({ ...base, source: { from: "chosen" } }).success, true);
    assert.equal(
      ClientMessageSchema.safeParse({
        ...base,
        source: { from: "recorded", audioBase64: "UklGRg==", contentType: "audio/wav" },
      }).success,
      true,
    );
  });

  it("refuses a chosen clip that smuggles a path, and a recording with no bytes", () => {
    assert.equal(
      ClientMessageSchema.safeParse({ ...base, source: { from: "chosen", path: "C:/anywhere.wav" } }).success,
      false,
    );
    assert.equal(
      ClientMessageSchema.safeParse({ ...base, source: { from: "recorded", contentType: "audio/wav" } })
        .success,
      false,
    );
  });
});

describe("the hosted readers' deliveries (SPEC-046 R-19, R-22)", () => {
  it("Voxtral honours only the read the recording already has, and says why for the rest", () => {
    assert.deepEqual(deliveryParams("mistral", "measured"), { ok: true, params: {} });
    const refused = deliveryParams("mistral", "whispered");
    assert.equal(refused.ok, false);
    assert.match(!refused.ok ? refused.reason : "", /the way the recording was spoken/);
  });
  it("Breeze maps every delivery to a guidance scale, with a tag or a sentence read back by name", () => {
    for (const delivery of DELIVERIES) {
      const mapped = deliveryParams("breezeblue", delivery);
      assert.ok(mapped.ok && mapped.params.guidance_scale === BREEZE_DELIVERY[delivery].settings.guidance_scale);
      const words = breezeDirection(delivery);
      assert.ok(words.tag !== undefined || words.instruction !== undefined, `${delivery} has neither a tag nor a sentence`);
    }
    assert.equal(breezeDirection("whispered").tag, "whispers");
    assert.ok(breezeDirection("whispered").instruction, "a tag never travels alone: the line's language may not be known");
    assert.equal(breezeDirection("cold").tag, undefined);
  });
  it("Fish takes every delivery as a phrase in the text, and carries no numbers for it (§2.9)", () => {
    for (const delivery of DELIVERIES) {
      assert.deepEqual(deliveryParams("fishaudio", delivery), { ok: true, params: {} });
      assert.ok(fishDirection(delivery).tag.length > 0, `${delivery} has a phrase`);
      assert.equal(FISH_DELIVERY[delivery].tag, fishDirection(delivery).tag);
    }
    assert.equal(fishDirection("whispered").tag, "whispering");
    assert.equal(HOSTED_VOICE_READERS["fishaudio"], "fish-s2.1-pro");
  });
});

describe("one voice, several readers (SPEC-046 D1, R-10, R-13)", () => {
  const harbour = { id: "harbour-glass", name: "Harbour glass", clip: "voices/harbour-glass.wav", attributes: ["low", "coastal"] } as never;

  it("a hosted reader reads the library's voice under its own provider and row, and says which voice it reads", () => {
    const [mistral] = cloudReaderCandidates([harbour], { provider: "mistral", model: HOSTED_VOICE_READERS["mistral"]! });
    assert.deepEqual(mistral, {
      provider: "mistral", model: "voxtral-mini-tts", voiceId: "harbour-glass", label: "Harbour glass",
      attributes: ["low", "coastal"], local: false, canClone: false, readsClone: "harbour-glass",
    });
    // The recipe's candidate says the same thing about itself: a picker groups the three by it.
    assert.equal(clonedVoiceCandidates([harbour])[0]?.readsClone, "harbour-glass");
    assert.ok(isClonedVoice(mistral!));
    assert.ok(isClonedVoice({ provider: "comfyui", model: "comfyui-cloned-voice" }));
    assert.equal(isClonedVoice({ provider: "mistral", model: "voxtral-mini-tts" }), false, "a preset through the same reader is not a clone");
    const [unready] = cloudReaderCandidates([harbour], { provider: "breezeblue", model: "breeze-tts-2" }, { unavailableReason: "no key" });
    assert.equal(unready?.unavailableReason, "no key");
  });

  it("the library decides what a hosted reader's voice id is: a match is the clone, anything else a preset", () => {
    assert.deepEqual(voiceSourceFor([harbour], "mistral", "voxtral-mini-tts", "harbour-glass"), { kind: "cloned", voice: harbour });
    assert.deepEqual(voiceSourceFor([harbour], "breezeblue", "breeze-tts-2", "harbour-glass"), { kind: "cloned", voice: harbour });
    // A preset was never in the library, so it is not missing from it.
    assert.deepEqual(voiceSourceFor([harbour], "mistral", "voxtral-mini-tts", "gb_jane_neutral"), { kind: "catalogue" });
    assert.deepEqual(voiceSourceFor([], "mistral", "voxtral-mini-tts", "harbour-glass"), { kind: "catalogue" });
    // The recipe keeps its stricter answer: an id it cannot find is a voice that went missing.
    assert.deepEqual(voiceSourceFor([], "comfyui", "comfyui-cloned-voice", "harbour-glass"), { kind: "missing-clone" });
    // Only the reader row reads a clip; another model behind the same vendor is a catalogue voice.
    assert.deepEqual(voiceSourceFor([harbour], "mistral", "some-other-model", "harbour-glass"), { kind: "catalogue" });
    assert.ok(isHostedVoiceReader("mistral") && isHostedVoiceReader("breezeblue", "breeze-tts-2"));
    assert.equal(isHostedVoiceReader("elevenlabs"), false);
    assert.equal(isHostedVoiceReader("mistral", "some-other-model"), false);
  });

  it("a library voice through a hosted reader is not a narrator, any more than through the recipe", () => {
    const [mistral] = cloudReaderCandidates([harbour], { provider: "mistral", model: "voxtral-mini-tts" });
    assert.equal(supportsVoiceUse(mistral!, "narration"), false);
    assert.equal(supportsVoiceUse(mistral!, "line"), true);
    assert.equal(supportsVoiceUse({ provider: "mistral", model: "voxtral-mini-tts", voiceId: "gb_jane_neutral" } as never, "narration"), true, "a preset narrates");
    assert.equal(supportsVoiceUse({ provider: "comfyui", model: "comfyui-cloned-voice" }, "narration"), false);
  });

  it("a legacy assignment through a hosted reader migrates to the reader's row", () => {
    assert.equal(legacyVoiceModel("mistral", "harbour-glass", [harbour]), "voxtral-mini-tts");
    assert.equal(legacyVoiceModel("breezeblue", "voc_1"), "breeze-tts-2");
  });

  it("what a reader holds of a voice reads with the entry, and reads as absent rather than losing the voice", () => {
    const held = {
      id: "harbour-glass", name: "Harbour glass", clip: "voices/harbour-glass.wav",
      remote: { mistral: { confirmedAt: "2026-09-13T10:00:00.000Z" }, breezeblue: { confirmedAt: "2026-09-13T10:00:00.000Z", voiceId: "voc_9", clipHash: `sha256:${"a".repeat(64)}`, savedAt: "2026-09-13T10:00:01.000Z", newer: true } },
    };
    const [voice] = parseVoiceLibrary({ voices: [held] });
    assert.equal(voice?.remote?.["breezeblue"]?.voiceId, "voc_9");
    assert.equal(voice?.remote?.["mistral"]?.voiceId, undefined);
    // A hand-edited field, or one from a build this one has never met: the person is asked
    // again and a slot is made again — the voice itself is not the thing to lose (D3 posture).
    const [edited] = parseVoiceLibrary({ voices: [{ ...held, remote: "yes" }] });
    assert.equal(edited?.id, "harbour-glass");
    assert.equal(edited?.remote, undefined);
  });
});

describe("what a vendor bills as a character (SPEC-046 R-8)", () => {
  const row = (unit?: "character" | "cjk-double" | "utf8-byte") =>
    ({ pricing: { kind: "perCharacter" as const, microUsdPerCharacter: 40, ...(unit ? { unit } : {}) } });
  it("counts characters by default, twice for CJK on a cjk-double row, and bytes on a utf8-byte row", () => {
    const line = "Bell Watch — 鐘の見張り";
    assert.equal(billableCharacters(row(), line), line.length);
    assert.equal(billableCharacters(row("character"), line), line.length);
    assert.equal(billableCharacters(row("cjk-double"), line), line.length + 5);
    assert.equal(billableCharacters(row("utf8-byte"), line), new TextEncoder().encode(line).length);
    assert.equal(billableCharacters(row("utf8-byte"), "naïve"), 6);
    assert.equal(billableCharacters({ pricing: { kind: "unmetered" } }, line), line.length, "a row without per-character pricing counts characters");
  });
  it("a delivery the row carries as a tag is billed as text, in the row's own ink", () => {
    const cadence: NonNullable<ManifestModel["cadence"]> = { deliveries: ["whispered", "cold"], speed: null, pause: "unsupported", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
      deliveryMappings: { whispered: { settings: {}, tag: "whispers" }, cold: { settings: {}, instruction: "Coldly." } } };
    const paren = { ...row("cjk-double"), cadence: { ...cadence, tagSyntax: "paren" as const } };
    const bracket = { ...row("utf8-byte"), cadence };
    assert.equal(billableCharacters(paren, "Wait here."), 10);
    // A paren vendor's English tag goes only into a line stated to be English (R-23): the
    // estimate counts it only then. A bracket phrase is read in any language and always counts.
    assert.equal(billableCharacters(paren, "Wait here.", "whispered", "en"), "(whispers) Wait here.".length);
    assert.equal(billableCharacters(paren, "Wait here.", "whispered"), 10, "no language stated: no tag sent, none counted");
    assert.equal(billableCharacters(paren, "Wait here.", "whispered", "fr"), 10);
    assert.equal(billableCharacters(bracket, "Wait here.", "whispered"), "[whispers] Wait here.".length);
    assert.equal(billableCharacters(bracket, "Wait here.", "whispered", "fr"), "[whispers] Wait here.".length);
    assert.equal(billableCharacters(paren, "Wait here.", "cold"), 10, "a sentence beside the text is not in the text");
    assert.equal(billableCharacters(paren, "Wait here.", "urgent"), 10, "a delivery the row does not map adds nothing");
  });
  it("the unit is a row field the manifest accepts and nothing else is", () => {
    const base = { manifestVersion: 1, generated: "2026-09-13", models: [{
      id: "x", provider: "breezeblue", capability: "voice-tts", displayName: "x",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: {},
      pricing: { kind: "perCharacter", microUsdPerCharacter: 40, unit: "cjk-double" } }] };
    assert.ok(ModelManifestSchema.safeParse(base).success);
    const bad = JSON.parse(JSON.stringify(base)) as typeof base;
    bad.models[0]!.pricing.unit = "cjk-triple" as never;
    assert.equal(ModelManifestSchema.safeParse(bad).success, false);
  });
});
