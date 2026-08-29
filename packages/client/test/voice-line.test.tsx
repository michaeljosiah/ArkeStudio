import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __applyForTest, __handleFrameForTest, __setStateForTest, __stateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { orderedShots, writerSceneView } from "@arke-studio/contracts";

/**
 * The voice-line dialog (built 2026-08-17). Everything around it already existed — the Audio
 * screen, the route, the dialog, and the coordinator's own request builder — but nothing
 * connected them: the action was hardcoded `disabled` with "Voice generation arrives with
 * SPEC-011", and the dialog always showed whichever spoken line came first, so pressing
 * Generate beside one character opened another character's line.
 */

function render(path: string, state: ClientState = FIXTURE_STATE, extra: Record<string, unknown> = {}): string {
  __setStateForTest(state, extra);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

const production = () => FIXTURE_STATE.world?.productions?.[0];
const spokenShots = () =>
  (production()?.scenes ?? []).flatMap((s) => orderedShots(s)).filter((s) => s.audio?.line && s.audio.speaker);

describe("the voice-line dialog", () => {
  /** The fixture ships one spoken shot; a second is added here so the test can discriminate. */
  function twoSpeakers(): { state: ClientState; prodId: string; secondId: string; secondLine: string } {
    const prod = production()!;
    const first = spokenShots()[0]!;
    const secondLine = "the ledger is not the tide, and the tide does not read";
    const second = { ...first, id: "sh_99", number: 99, audio: { ...first.audio!, line: secondLine } };
    const scenes = prod.scenes.map((record) => writerSceneView(record)).map((scene, i) => (i === 0 ? { ...scene, shots: [...scene.shots, second] } : scene));
    return {
      state: {
        ...FIXTURE_STATE,
        world: {
          ...FIXTURE_STATE.world!,
          productions: [{ ...prod, scenes }, ...FIXTURE_STATE.world!.productions.slice(1)],
        },
      },
      prodId: prod.meta.id,
      secondId: second.id,
      secondLine,
    };
  }

  it("opens on the line that was asked for, not the first one in the production", () => {
    const { state, prodId, secondId, secondLine } = twoSpeakers();
    const asked = render(`/w/${FIXTURE_WORLD_ID}/p/${prodId}/generate/voice-line?shot=${secondId}`, state);
    assert.ok(asked.includes(secondLine), "the dialog shows the line the row asked for");
    // Without the shot in the address it falls back to the first, which is what it used to do
    // for every row — the bug this replaced.
    const unasked = render(`/w/${FIXTURE_WORLD_ID}/p/${prodId}/generate/voice-line`, state);
    assert.equal(unasked.includes(secondLine), false, "and the fallback is the first line, not the second");
  });

  it("offers the action, rather than a control that says the feature has not arrived", () => {
    const prodId = production()?.meta.id;
    if (prodId === undefined) return;
    const html = render(`/w/${FIXTURE_WORLD_ID}/p/${prodId}/generate/voice-line`);
    assert.match(html, /data-testid="voice-line-generate"/);
    assert.doesNotMatch(html, /Voice generation arrives with SPEC-011/);
  });

  it("offers only deliveries the assigned model declares", () => {
    const prodId = production()?.meta.id;
    if (prodId === undefined) return;
    const state: ClientState = {
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        manifest: FIXTURE_STATE.app.manifest
          ? {
              ...FIXTURE_STATE.app.manifest,
              models: [
                ...FIXTURE_STATE.app.manifest.models,
                {
                  id: "eleven_multilingual_v2",
                  provider: "elevenlabs",
                  capability: "voice-tts",
                  displayName: "Eleven Multilingual v2",
                  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
                  limits: { deliveries: ["measured", "urgent"] },
                  pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
                },
              ],
            }
          : {
              manifestVersion: 1,
              generated: "2026-08-25",
              models: [
                {
                  id: "eleven_multilingual_v2",
                  provider: "elevenlabs",
                  capability: "voice-tts",
                  displayName: "Eleven Multilingual v2",
                  accepts: { referenceImages: 0, startFrame: false, endFrame: false },
                  limits: { deliveries: ["measured", "urgent"] },
                  pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
                },
              ],
            },
      },
      world: {
        ...FIXTURE_STATE.world!,
        sheets: FIXTURE_STATE.world!.sheets.map((sheet) =>
          sheet.voice
            ? { ...sheet, voice: { ...sheet.voice, provider: "elevenlabs", model: "eleven_multilingual_v2" } }
            : sheet,
        ),
      },
    };
    const html = render(`/w/${FIXTURE_WORLD_ID}/p/${prodId}/generate/voice-line`, state);
    assert.match(html, /aria-label="Delivery"/);
    assert.match(html, />measured</);
    assert.match(html, />urgent</);
    assert.doesNotMatch(html, />breaking</);
  });

  it("will not dispatch for a speaker with no voice, and says where one is given", () => {
    // A sheet is where a voice is assigned, so the refusal names the sheet rather than the
    // button — there is nothing to press until somebody goes there.
    const prodId = production()?.meta.id;
    if (prodId === undefined) return;
    const voiceless: ClientState = {
      ...FIXTURE_STATE,
      world: {
        ...FIXTURE_STATE.world!,
        sheets: FIXTURE_STATE.world!.sheets.map((s) => ({ ...s, voice: undefined })),
      },
    };
    const html = render(`/w/${FIXTURE_WORLD_ID}/p/${prodId}/generate/voice-line`, voiceless);
    assert.match(html, /has no assigned voice/);
  });

  it("shows an existing unready cloned assignment and disables production composition", () => {
    const prodId = production()?.meta.id;
    if (prodId === undefined) return;
    const clonedModel = {
      id: "comfyui-cloned-voice",
      provider: "comfyui" as const,
      capability: "voice-tts" as const,
      displayName: "Local Cloned Voice",
      accepts: { referenceImages: 0, startFrame: false, endFrame: false },
      limits: { maxPromptChars: 400, audioFormat: "flac" as const },
      pricing: { kind: "unmetered" as const },
    };
    const state: ClientState = {
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        manifest: {
          ...(FIXTURE_STATE.app.manifest ?? { manifestVersion: 1, generated: "2026-08-25", models: [] }),
          models: [...(FIXTURE_STATE.app.manifest?.models ?? []), clonedModel],
        },
        comfyui: {
          engine: {
            source: "absent",
            state: "absent",
            locality: "local",
            location: null,
            version: null,
            instanceId: null,
            detail: null,
            detected: [],
          },
          recipes: [{
            recipeId: clonedModel.id,
            recipeVersion: 1,
            displayName: clonedModel.displayName,
            capability: "voice-tts",
            state: "disabled",
            reason: "Cloned voice setup is unavailable in this build.",
          }],
          checkedAt: "2026-08-25T12:00:00.000Z",
        },
      },
      world: {
        ...FIXTURE_STATE.world!,
        clonedVoices: [{ id: "harbour", name: "Harbour", clip: "voices/harbour.wav" } as never],
        sheets: FIXTURE_STATE.world!.sheets.map((sheet) => ({
          ...sheet,
          voice: {
            provider: "comfyui",
            model: clonedModel.id,
            voiceId: "harbour",
            label: "Harbour",
            assignedAtVersion: sheet.version,
          },
        })),
      },
    };
    const html = render(`/w/${FIXTURE_WORLD_ID}/p/${prodId}/generate/voice-line`, state);
    assert.match(html, /voice · Harbour \(comfyui\)/);
    assert.match(html, /Assigned voice unavailable/);
    assert.match(html, /Cloned voice setup is unavailable in this build/);
    const at = html.indexOf('data-testid="voice-line-generate"');
    assert.ok(at >= 0 && html.slice(at, html.indexOf(">", at)).includes("disabled"));
  });
});

/**
 * The character's voice picker, organised the way the bench's reading picker is (design 70).
 * Six local voices were otherwise lost among fifty cloud ones, and "can this machine say it
 * without spending" is the first question anyone asks of the list.
 */
describe("choosing a character's voice", () => {
  const sheetId = FIXTURE_STATE.world!.sheets[0]!.id;
  const candidate = (voiceId: string, provider: string, local: boolean) => ({
    candidate: {
      provider,
      model: provider === "kokoro" ? "kokoro-82m" : "eleven_multilingual_v2",
      voiceId,
      label: voiceId,
      attributes: ["warm"],
      local,
      canClone: !local,
    },
    matched: [],
    overlap: 0,
  });
  const candidates = {
    [sheetId]: {
      extracted: ["warm"],
      ranked: [
        candidate("v_cloud_1", "elevenlabs", false),
        candidate("v_cloud_2", "elevenlabs", false),
        candidate("af_bella", "kokoro", true),
      ],
      previewLine: { text: "the verse, under the water", source: "own-line" as const },
      cloudPreviewMicroUsd: 30000,
      previewMicroUsdByVoice: {},
    },
  };

  it("sorts the catalogue by where a voice lives, and counts each", () => {
    const html = render(`/w/${FIXTURE_WORLD_ID}/cast/${sheetId}/voice`, FIXTURE_STATE, {
      voiceCandidates: candidates,
    });
    assert.match(html, /data-testid="voice-tab-all"/);
    assert.match(html, /data-testid="voice-tab-cloud"/);
    assert.match(html, /data-testid="voice-tab-local"/);
    // The counts are the list's own, so "two cloud, one here" is readable before any filtering.
    assert.match(html, />All 3</);
    assert.match(html, />Cloud 2</);
    assert.match(html, />On this machine 1</);
  });

  it("scrolls the catalogue in place rather than growing the page", () => {
    // A world with fifty cloud voices would otherwise push the assign controls below the fold,
    // which is the one place a long list must not reach.
    const html = render(`/w/${FIXTURE_WORLD_ID}/cast/${sheetId}/voice`, FIXTURE_STATE, {
      voiceCandidates: candidates,
    });
    assert.match(html, /class="fy-voicelist"/);
  });

  it("keeps the current unready clone visible, with Preview and Assign disabled", () => {
    const baseSheet = FIXTURE_STATE.world!.sheets[0]!;
    const clone = {
      candidate: {
        provider: "comfyui",
        model: "comfyui-cloned-voice",
        voiceId: "harbour",
        label: "Harbour",
        attributes: ["warm"],
        local: true,
        canClone: false,
        unavailableReason: "Cloned voice setup is unavailable in this build.",
      },
      matched: [],
      overlap: 0,
    };
    const state: ClientState = {
      ...FIXTURE_STATE,
      world: {
        ...FIXTURE_STATE.world!,
        clonedVoices: [{ id: "harbour", name: "Harbour", clip: "voices/harbour.wav" } as never],
        sheets: FIXTURE_STATE.world!.sheets.map((sheet) =>
          sheet.id === baseSheet.id
            ? {
                ...sheet,
                voice: {
                  provider: "comfyui",
                  model: "comfyui-cloned-voice",
                  voiceId: "harbour",
                  label: "Harbour",
                  assignedAtVersion: sheet.version,
                },
              }
            : sheet,
        ),
      },
    };
    const html = render(`/w/${FIXTURE_WORLD_ID}/cast/${sheetId}/voice`, state, {
      voiceCandidates: {
        [sheetId]: {
          ...candidates[sheetId],
          ranked: [clone],
        },
      },
    });
    assert.match(html, /Harbour/);
    assert.match(html, /current/);
    assert.match(html, /Cloned voice setup is unavailable in this build/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Preview · free<\/button>/);
    assert.match(html, /<button[^>]*disabled=""[^>]*>Assigned<\/button>/);
  });
});

describe("the narrator in Settings", () => {
  // The narrator moved to Appearance with SPEC-033's split. It was in Local runtime's Voice
  // group and it is the one thing there that was never about a runtime: it is a voice the app
  // speaks in, and it may be a cloud one — so Local AI is forbidden it and Engines is wrong in
  // kind. What is left is how the app presents itself.
  it("names the shipped local voice, and says it is free, until one is chosen", () => {
    const html = render("/settings/appearance");
    assert.match(html, /data-testid="narrator-name"/);
    assert.match(html, /George/);
    assert.match(html, /reads on this machine · free/);
    // Nothing to reset when nothing was chosen.
    assert.doesNotMatch(html, /data-testid="narrator-reset"/);
  });

  it("is on no engine pane, which may not carry a cloud voice at all", () => {
    // An engine is not a provider and this control picks between them, so it belongs to neither
    // half of the Providers rail — it is Appearance's, where the reading voice is chosen.
    for (const engine of ["comfyui", "ollama", "voxa"]) {
      const pane = render(`/settings/providers?provider=${engine}`);
      assert.match(pane, /data-screen="settings-providers"/);
      assert.doesNotMatch(pane, /data-testid="narrator-name"/);
    }
  });

  it("says plainly when the narrator will be billed", () => {
    // The one thing this control must never do quietly: a cloud narrator bills every press of
    // "read aloud", so the row says so rather than leaving it to be discovered on the ledger.
    const chosen: ClientState = {
      ...FIXTURE_STATE,
      app: { ...FIXTURE_STATE.app, narrator: { provider: "elevenlabs", voiceId: "v_roger", label: "Roger" } },
    };
    const html = render("/settings/appearance", chosen);
    assert.match(html, /Roger · elevenlabs/);
    assert.match(html, /billed per character/);
    // And there is a way back to the free one.
    assert.match(html, /data-testid="narrator-reset"/);
  });
});

describe("remote ComfyUI locality", () => {
  it("names a non-loopback URL as remote", () => {
    const state: ClientState = {
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        comfyui: {
          engine: {
            source: "user-url",
            state: "ready",
            locality: "remote",
            location: "http://10.0.0.4:8188",
            version: "0.33.1",
            instanceId: "remote-1",
            detail: null,
            detected: [],
          },
          recipes: [],
          checkedAt: "2026-08-25T12:00:00.000Z",
        },
      },
    };
    const html = render("/settings/providers?provider=comfyui", state);
    assert.match(html, /another machine · Your URL · never spawned/);
  });

  it("keeps managed Download beside a detected but unselected install", () => {
    const state: ClientState = {
      ...FIXTURE_STATE,
      app: {
        ...FIXTURE_STATE.app,
        comfyui: {
          engine: {
            source: "absent",
            state: "absent",
            locality: "local",
            location: null,
            version: null,
            instanceId: null,
            detail: null,
            detected: [{ location: "C:\\AI\\ComfyUI", version: null }],
          },
          recipes: [],
          checkedAt: "2026-08-25T12:00:00.000Z",
        },
        setup: {
          running: false,
          diskFreeMb: 100000,
      diskCheckedAt: null,
          components: [{
            id: "comfyui-runtime",
            displayName: "ComfyUI",
            purpose: "Runs image and video recipes",
            sizeMb: 2034,
            state: "available",
            bytesDone: 0,
            bytesTotal: 2034 * 1024 * 1024,
            bytesPerSecond: null,
          }],
        },
      },
    };
    __setStateForTest(state, { setupStatus: state.app.setup });
    const html = renderToString(
      <MemoryRouter initialEntries={["/settings/providers?provider=comfyui"]}>
        <App />
      </MemoryRouter>,
    );
    assert.match(html, /data-testid="comfyui-detected"/);
    assert.match(html, /data-testid="comfyui-managed-option"/);
    assert.match(html, />Download<\/button>/);
  });
});

describe("the narrator round trip", () => {
  /**
   * The write reached settings.json and the row never changed: the reducer existed on the
   * coordinator's read model but not on the client's, so the event arrived and nothing applied
   * it. Found on the first press in the installed app.
   */
  it("applies narrator.changed to the app state", () => {
    const before = __applyForTest(FIXTURE_STATE, {
      at: "2026-08-17T10:00:00.000Z",
      type: "narrator.changed",
      voice: { provider: "elevenlabs", voiceId: "v_roger", label: "Roger" },
    });
    assert.deepEqual(before.app.narrator, { provider: "elevenlabs", voiceId: "v_roger", label: "Roger" });
    // And clearing it returns to the shipped local voice.
    const cleared = __applyForTest(before, {
      at: "2026-08-17T10:00:01.000Z",
      type: "narrator.changed",
      voice: null,
    });
    assert.equal(cleared.app.narrator, null);
  });
});

describe("bible read restoration", () => {
  it("restores bible purpose without inventing a sheet id", () => {
    const requestId = "01J8F3K2QW9VZX4N7M0RTYB6HZ";
    const job = {
      id: "jb_01J8F3K2QW9VZX4N7M0RTYB6HZ",
      idempotencyKey: "01J8F3K2QW9VZX4N7M0RTYB6HY",
      worldId: FIXTURE_WORLD_ID,
      target: { kind: "voice-preview", id: "bible/elevenlabs/eleven-v2/roger" },
      capability: "voice-tts",
      provider: "elevenlabs",
      model: "eleven-v2",
      params: {
        requestId,
        purpose: "bible-section",
        sectionHeading: "The tide",
        sheetVersion: 2,
        voiceId: "roger",
        audioFormat: "mp3",
      },
      estimatedMicroUsd: 10,
      status: "succeeded",
      providerJobId: "remote-1",
      attempt: 1,
      landedFiles: [".cache/voice-previews/read.mp3"],
      error: null,
      createdAt: "2026-08-25T12:00:00.000Z",
      updatedAt: "2026-08-25T12:00:01.000Z",
    } satisfies ClientState["app"]["jobs"][number];
    __setStateForTest(FIXTURE_STATE);
    __handleFrameForTest({
      kind: "snapshot",
      seq: 2,
      state: { ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, jobs: [job] } },
    });
    const restored = __stateForTest().voiceAudio[requestId];
    assert.equal(restored?.purpose, "bible-section");
    assert.equal(restored && "sheetId" in restored, false);
  });
});

describe("the voice tabs stay readable", () => {
  it("gives the chosen tab a hover rule of its own", () => {
    // `:hover` outranks a single class, so the tab you just clicked went white on white —
    // invisible precisely while the pointer was still on it. Found in the installed app.
    const css = readFileSync(new URL("../src/screens/fidelity.css", import.meta.url), "utf8");
    const rule = css.slice(css.indexOf(".fy-voices__tab--on"));
    assert.match(rule.slice(0, 200), /\.fy-voices__tab--on:hover/);
  });
});

describe("reading a sheet aloud", () => {
  const sheetId = FIXTURE_STATE.world!.sheets[0]!.id;

  it("offers the read to a character with no voice of their own", () => {
    // The client half of the same mistake the coordinator made: read-aloud was gated on
    // `sheet.voice`, so it sent you to the voice picker instead of reading. Narration uses the
    // app's narrator, so having a voice of one's own has nothing to do with it.
    const voiceless: ClientState = {
      ...FIXTURE_STATE,
      world: {
        ...FIXTURE_STATE.world!,
        sheets: FIXTURE_STATE.world!.sheets.map((s) => ({ ...s, voice: undefined })),
      },
    };
    const html = render(`/w/${FIXTURE_WORLD_ID}/cast/${sheetId}`, voiceless);
    assert.match(html, /Read aloud/);
    assert.doesNotMatch(html, /Choose a voice to read this aloud/);
  });

  it("names the narrator on the clip, in both places that build one", () => {
    // There are two: the one the section control offers, and the effect that plays a read as
    // soon as it lands. Only the second actually sounds, and it still said the character's
    // voice — so the player named a voice that had not read a word of it.
    const source = readFileSync(new URL("../src/screens/world.tsx", import.meta.url), "utf8");
    const subs = [...source.matchAll(/sub: `read aloud · \$\{([^}]+)\}`/g)].map((m) => m[1]);
    assert.equal(subs.length, 2, "both clip builders are accounted for");
    for (const sub of subs) assert.equal(sub, "narratorLabel", "each names who is reading");
  });
});

describe("the Audio row reports what exists", () => {
  /**
   * "not generated" was hardcoded, so a line that had been read landed in the production and
   * the row went on claiming nothing existed — with no way to hear it. The same
   * correct-on-disk-invisible-in-the-app shape as the narrator's three layers.
   */
  function withVoiceTake(): { state: ClientState; prodId: string } {
    const prod = production()!;
    const shot = spokenShots()[0]!;
    // Derived from a take the fixture already ships, so this stays a Take when Take changes.
    const take = {
      ...prod.takes[0]!,
      id: "tk_voice_1",
      coversShots: [shot.id],
      kind: "voice" as const,
      provider: "kokoro",
      model: "kokoro-82m",
      media: "speech.wav",
    };
    return {
      state: {
        ...FIXTURE_STATE,
        world: {
          ...FIXTURE_STATE.world!,
          productions: [
            { ...prod, takes: [...prod.takes, take] },
            ...FIXTURE_STATE.world!.productions.slice(1),
          ],
        },
      },
      prodId: prod.meta.id,
    };
  }

  it("says a line is read, and offers it back, once one exists", () => {
    const { state, prodId } = withVoiceTake();
    const html = render(`/w/${FIXTURE_WORLD_ID}/p/${prodId}/audio`, state);
    assert.match(html, />read</);
    assert.match(html, />Again</, "and the action becomes a retake rather than a first read");
    // Before it exists, the row says so and offers the first read.
    const empty = render(`/w/${FIXTURE_WORLD_ID}/p/${prodId}/audio`);
    assert.match(empty, /not generated/);
    assert.match(empty, />Generate</);
  });
});
