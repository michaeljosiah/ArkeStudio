import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { BenchSession, ClientState, ManifestModel } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { ReferencePickerBody, type PickerSource } from "../src/components/reference-picker.js";
import { BenchBrief } from "../src/components/bench-brief.js";
import type { MentionOption } from "../src/lib/bench-mention.js";

/**
 * The bench (issue 305): the screen restores a session — strip, references, brief, selection —
 * from state alone, which is exactly what surviving a restart means (§1). And the picker's
 * refusals are the coordinator's own sentences, predicted with the same shared functions.
 */

const SESSION_ID = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
const TAKE_ID = "tk_01J8F3K2QW9VZX4N7M0RTYB6HE";

const IMAGE_MODEL: ManifestModel = {
  id: "test-image",
  provider: "fal",
  capability: "image",
  displayName: "Test Image",
  accepts: { referenceImages: 2, referenceRoles: false, startFrame: false, endFrame: false },
  limits: { maxPromptChars: 500 },
  pricing: { kind: "perImage", microUsdPerImage: 60000 },
};

function benchSession(): BenchSession {
  return {
    schemaVersion: 1,
    id: SESSION_ID,
    title: "Harbour night studies",
    composer: {
      mode: "image",
      provider: "fal",
      model: "test-image",
      params: { kind: "image", count: 2 },
      brief: "A rusted tide-clock face, citing Image 1.",
      activeTokens: ["Image 1"],
      keyframeTokens: [],
    },
    tokenRegistry: [
      {
        token: "Image 1",
        kind: "image",
        source: { source: "artifact", artifactId: "ar_01J8F3K2QW9VZX4N7M0RTYB6HF", hash: "sha256:deadbeef" },
      },
    ],
    nextToken: { image: 2 },
    nextTake: 2,
    selectedTakeId: TAKE_ID,
    takes: [
      {
        id: TAKE_ID,
        n: 1,
        requestId: "r1",
        status: "succeeded",
        request: {
          mode: "image",
          brief: "A rusted tide-clock face, citing Image 1.",
          references: [],
          keyframes: [],
          provider: "fal",
          model: "test-image",
          params: { kind: "image", count: 1 },
        },
        media: { file: "take.png", hash: "sha256:beefbeef" },
        cost: { estimatedMicroUsd: 60000, actualMicroUsd: 60000 },
        disposition: "open",
        createdAt: "2026-08-16T10:00:00.000Z",
        completedAt: "2026-08-16T10:01:00.000Z",
      },
    ],
    createdAt: "2026-08-16T10:00:00.000Z",
    updatedAt: "2026-08-16T10:01:00.000Z",
  };
}

function stateWithBench(): ClientState {
  const base = FIXTURE_STATE;
  return {
    ...base,
    app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, IMAGE_MODEL] } },
    bench: { worldId: FIXTURE_WORLD_ID, session: benchSession() },
  };
}

function renderAt(path: string, state: ClientState): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("the bench screen (issue 305 §3)", () => {
  it("restores the session whole: title, brief, token, numbered take, selection", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(html, /Harbour night studies/);
    assert.match(html, /A rusted tide-clock face, citing Image 1\./);
    assert.match(html, /Image 1/);
    assert.match(html, /data-testid="strip-take"/);
    assert.match(html, /TAKE 1/); // the wall names the selected take by its number
    assert.match(html, /Keep · file as artifact/);
  });

  it("the counter exists exactly where the model publishes a cap (issue 305 §5.1)", () => {
    const withCap = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(withCap, /data-testid="prompt-counter"/);
    assert.match(withCap, /41\/500/); // the brief's own length against the row's figure

    // The same screen under a model with no published cap shows NO counter — not a default.
    const state = stateWithBench();
    const capless = {
      ...state,
      app: {
        ...state.app,
        manifest: {
          ...state.app.manifest!,
          models: state.app.manifest!.models.map((m) => (m.id === "test-image" ? { ...m, limits: {} } : m)),
        },
      },
    };
    const without = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, capless);
    assert.doesNotMatch(without, /data-testid="prompt-counter"/);
  });

  it("the estimate follows the count: two takes price twice one", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    // count: 2 at $0.06/image → ~$0.12
    assert.match(html, /~\$0\.12/);
  });
});

describe("citing a reference in the brief (issue 476)", () => {
  /** The same session, with `brief` written over it. */
  const wrote = (brief: string): ClientState => {
    const state = stateWithBench();
    const bench = state.bench!;
    return {
      ...state,
      bench: { ...bench, session: { ...bench.session, composer: { ...bench.session.composer, brief } } },
    };
  };

  it("the brief is the combobox the completion hangs off, shut until an @ is written", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(html, /role="combobox"/);
    assert.match(html, /aria-autocomplete="list"/);
    assert.match(html, /aria-expanded="false"/);
    assert.doesNotMatch(html, /data-testid="bench-mentions"/);
  });

  it("says how to cite one, rather than naming tokens the author has to remember", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(html, /Type @ to cite a reference/);
  });

  it("a citation whose picture is riding is a chip, and dispatch is not warned about", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, wrote("Lit like @Image 1."));
    assert.match(html, /fy-bench__briefchip[^"]*"[^>]*>@Image 1</);
    assert.doesNotMatch(html, /fy-bench__briefchip--lost/);
    assert.doesNotMatch(html, /data-testid="bench-lost-mentions"/);
  });

  it("a citation nothing is attached for is visibly lost, and named before Generate is pressed", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, wrote("Lit like @Image 4."));
    assert.match(html, /fy-bench__briefchip--lost/);
    assert.match(html, /data-testid="bench-lost-mentions"/);
    assert.match(html, /@Image 4 — not attached/);
  });

  it("the older bare spelling still reads as the session's own name, and warns of nothing", () => {
    // The fixture's brief cites "Image 1" without an at-sign - written before mentions existed.
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(html, /fy-bench__briefchip[^"]*"[^>]*>Image 1</);
    assert.doesNotMatch(html, /data-testid="bench-lost-mentions"/);
  });

  it("a mode that makes a sound carries no picture, so a citation in one is unresolved", () => {
    // Raised on review: `speaking` left music's hidden reference riding, which drew "@Image 1"
    // as resolved over a request that could never carry it. Both sound modes now say the same
    // thing the coordinator does.
    const state = stateWithBench();
    const bench = state.bench!;
    const singing: ClientState = {
      ...state,
      bench: {
        ...bench,
        session: {
          ...bench.session,
          composer: {
            ...bench.session.composer,
            mode: "music",
            params: { kind: "music", count: 1, lyrics: "[verse]\nnobody wound it" },
            brief: "Slow shanty, like @Image 1.",
          },
        },
      },
    };
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, singing);
    assert.match(html, /fy-bench__briefchip--lost/);
    assert.match(html, /data-testid="bench-lost-mentions"/);
  });

  it("does not chip, or warn over, an at-sign the editor would never have offered a menu at", () => {
    const html = renderAt(
      `/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`,
      wrote("released @Image 4th of May, write to me@Image 9.example"),
    );
    assert.doesNotMatch(html, /fy-bench__briefchip--lost/);
    assert.doesNotMatch(html, /data-testid="bench-lost-mentions"/);
  });

  it("the write-large window is the same editor, so the completion cannot exist in only one", () => {
    const options: MentionOption[] = [
      { token: "Image 1", kind: "image", name: "harbour-night.png", meta: "png" },
    ];
    const dressed = (variant: "compact" | "large") =>
      renderToString(
        <BenchBrief
          variant={variant}
          value="Lit like @Image 1."
          onChange={() => {}}
          options={options}
          worldSlug="the-undersong"
          underlay={<span>Lit like @Image 1.</span>}
          label="Brief"
        />,
      );
    for (const variant of ["compact", "large"] as const) {
      const html = dressed(variant);
      assert.match(html, /role="combobox"/);
      assert.match(html, /aria-autocomplete="list"/);
      assert.match(html, /class="fy-bench__brieftext"/);
      assert.match(html, /fy-bench__briefunder/);
    }
    assert.match(dressed("large"), /fy-bench__briefstack--large/);
    assert.doesNotMatch(dressed("compact"), /fy-bench__briefstack--large/);
  });
});

describe("the Artifacts door (issue 305 §2)", () => {
  it("carries Generate, and the made-here count appears only when a bench artifact exists", () => {
    const plain = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts`, FIXTURE_STATE);
    assert.match(plain, /data-testid="artifacts-generate"/);
    assert.doesNotMatch(plain, /Made here/);

    const state = stateWithBench();
    const withMade = {
      ...state,
      world: {
        ...state.world!,
        artifacts: [
          ...state.world!.artifacts,
          {
            id: "ar_01J8F3K2QW9VZX4N7M0RTYB6HG",
            kind: "image" as const,
            file: "bench-take-1.png",
            hash: "sha256:beadbead",
            origin: { by: "system" as const, producedBy: "bench" },
            links: [],
            created: "2026-08-16T10:02:00.000Z",
          },
        ],
      },
    };
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts`, withMade);
    assert.match(html, /Made here 1/);
    assert.match(html, /1 made here/);
  });
});

describe("the reference picker's refusals (issue 305 §9)", () => {
  const audioSource: PickerSource = {
    key: "artifact:ar_a",
    kind: "audio",
    name: "harbour-bells.wav",
    meta: "wav · 2:14",
    durationSec: 134,
    pick: { source: "artifact", artifactId: "ar_a" },
  };
  const documentSource: PickerSource = {
    key: "artifact:ar_d",
    kind: "document",
    name: "treatment.pdf",
    meta: "pdf",
    durationSec: null,
    pick: { source: "artifact", artifactId: "ar_d" },
  };

  it("speaks the coordinator's own sentences on the tile", () => {
    const html = renderToString(
      <ReferencePickerBody
        mode="bench"
        worldSlug="the-undersong"
        model={IMAGE_MODEL}
        carried={[]}
        world={[audioSource, documentSource]}
        session={[]}
        onUpload={() => {}}
        onClose={() => {}}
      />,
    );
    // No audio allowance on the row → the kind refuses; a document refuses whatever the model.
    assert.match(html, /this model takes no audio/);
    assert.match(html, /a document cannot be sent/);
  });

  it("states capacity in the row's own numbers, never a house figure", () => {
    const html = renderToString(
      <ReferencePickerBody
        mode="bench"
        worldSlug="the-undersong"
        model={IMAGE_MODEL}
        carried={[{ kind: "image", durationSec: 0 }]}
        world={[]}
        session={[]}
        onUpload={() => {}}
        onClose={() => {}}
      />,
    );
    assert.match(html, /1 of 2 images/);
  });
});

describe("the Keyframe tab (issue 305 §3)", () => {
  const FRAME_VIDEO: ManifestModel = {
    id: "test-frame-video",
    provider: "fal",
    capability: "video",
    displayName: "Frame Video",
    accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { maxDurationSec: 10 },
    pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
    modes: {
      generate: { locked: [] },
      "first-frame": { route: "t/image-to-video", locked: ["aspect"] },
      "first-and-last-frame": { route: "t/image-to-video", locked: ["aspect"] },
    },
  };
  const PLAIN_VIDEO: ManifestModel = {
    ...FRAME_VIDEO,
    id: "test-plain-video",
    displayName: "Plain Video",
    modes: { generate: { locked: [] } },
  };

  function videoState(model: ManifestModel): ClientState {
    const base = stateWithBench();
    const session = base.bench!.session;
    return {
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, model] } },
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: {
          ...session,
          composer: {
            ...session.composer,
            mode: "video",
            provider: model.provider,
            model: model.id,
            params: { kind: "video" },
          },
        },
      },
    };
  }

  it("the tab exists exactly where the model verifies a frame task mode", () => {
    const withTabs = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, videoState(FRAME_VIDEO));
    assert.match(withTabs, /Keyframe/);
    assert.doesNotMatch(withTabs, /takes no keyframes/);
  });

  it("a model with no frame mode shows no tab, and the composer says so in a line", () => {
    const without = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, videoState(PLAIN_VIDEO));
    assert.doesNotMatch(without, /Keyframe/);
    assert.match(without, /Plain Video takes no keyframes\./);
  });
});

describe("presets (issue 305 §3)", () => {
  it("the dispatch row carries the Presets trigger", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(html, /data-testid="bench-presets"/);
    assert.match(html, /Presets/);
  });
});

describe("a lingering keyframe stays visible (issue 305 §3)", () => {
  it("the tab renders for riding frames even when the model verifies no frame mode", () => {
    const PLAIN: ManifestModel = {
      id: "test-plain-video2",
      provider: "fal",
      capability: "video",
      displayName: "Plain Video 2",
      accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
      limits: { maxDurationSec: 10 },
      pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
      modes: { generate: { locked: [] } },
    };
    const base = stateWithBench();
    const session = base.bench!.session;
    const state: ClientState = {
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, PLAIN] } },
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: {
          ...session,
          composer: {
            ...session.composer,
            mode: "video",
            provider: PLAIN.provider,
            model: PLAIN.id,
            params: { kind: "video" },
            keyframeTokens: ["Image 1"],
          },
        },
      },
    };
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, state);
    // What is attached stays visible and removable — no hidden state, no dead end.
    assert.match(html, /Keyframe/);
    assert.doesNotMatch(html, /takes no keyframes/);
  });
});

describe("the video length and its sound (asked for 2026-08-16)", () => {
  const LONG: ManifestModel = {
    id: "test-long-video",
    provider: "fal",
    capability: "video",
    displayName: "Long Video",
    accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { maxDurationSec: 8, durations: { 4: "4s", 6: "6s", 8: "8s" }, soundChoice: true, durationAuto: true },
    pricing: { kind: "perSecond", microUsdPerSecond: 100000 },
    modes: { generate: { locked: [] } },
  };
  /** The same row without the two declarations, to prove each control is earned, not decorative. */
  const BARE: ManifestModel = {
    ...LONG,
    id: "test-bare-video",
    displayName: "Bare Video",
    limits: { maxDurationSec: 8, durations: { 4: "4s", 6: "6s", 8: "8s" } },
  };
  /** A row whose reference route runs shorter than its text route, as wan's does. */
  const SHORTER: ManifestModel = {
    ...LONG,
    id: "test-shorter-with-refs",
    displayName: "Shorter With Refs",
    accepts: { referenceImages: 4, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { ...LONG.limits, maxReferenceDurationSec: 6 },
  };

  function lengthState(model: ManifestModel, params: Record<string, unknown>, tokens?: string[]): ClientState {
    const base = stateWithBench();
    const session = base.bench!.session;
    return {
      ...base,
      app: { ...base.app, manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, model] } },
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: {
          ...session,
          composer: {
            ...session.composer,
            mode: "video",
            provider: model.provider,
            model: model.id,
            params: { kind: "video", ...params },
            ...(tokens === undefined ? {} : { activeTokens: tokens }),
          },
        },
      },
    };
  }

  const render = (model: ManifestModel, params: Record<string, unknown> = {}, tokens?: string[]) =>
    renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, lengthState(model, params, tokens));

  it("offers each control only where the route publishes the choice", () => {
    const offered = render(LONG);
    assert.match(offered, /data-testid="bench-sound"/);
    // A switch over a route that publishes no such field would change nothing, and a control
    // that changes nothing is a control that lies.
    assert.doesNotMatch(render(BARE), /data-testid="bench-sound"/);
    // The length is not conditional on either: every row with lengths gets its pill.
    assert.match(offered, /data-testid="duration-open"/);
    assert.match(render(BARE), /data-testid="duration-open"/);
  });

  /**
   * The panel is a popover. Shut, none of the track is in the document, so the pill has to
   * carry the answer — otherwise the row goes quiet about what will be made. (The track's own
   * geometry is pinned in duration-track.test.ts, where it can be read directly.)
   */
  it("the closed pill says the length, or who is choosing it", () => {
    assert.match(render(LONG, { durationSec: 6 }), /data-testid="duration-open"[^>]*>[\s\S]{0,600}?6s</);
    assert.match(render(LONG), /data-testid="duration-open"[^>]*>[\s\S]{0,600}?Auto</);
    // BARE declares lengths but no `auto`: no duration goes on the wire, and printing the
    // shortest stop would name a length nobody asked for.
    assert.match(render(BARE), /data-testid="duration-open"[^>]*>[\s\S]{0,600}?default</);
  });

  it("marks a length the chosen route will not make, on the pill itself", () => {
    // Shut, the panel cannot warn: a refusal the user cannot see coming arrives as a surprise.
    const held = render(SHORTER, { durationSec: 8 }, ["Image 1"]);
    assert.match(held, /fy-bench__durationtrigger--over/);
    // The same length without the reference is perfectly reachable and unmarked.
    assert.doesNotMatch(render(SHORTER, { durationSec: 8 }, []), /fy-bench__durationtrigger--over/);
  });

  it("says in words which way the sound sits, rather than leaving an icon to be read", () => {
    assert.match(render(LONG), />sound</);
    assert.match(render(LONG, { sound: false }), />silent</);
  });
});

describe("the enhancer (asked for 2026-08-16)", () => {
  it("the sparkle exists exactly where a model and words both do", () => {
    const withWords = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(withWords, /data-testid="bench-enhance"/);

    const state = stateWithBench();
    const wordless = {
      ...state,
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: { ...state.bench!.session, composer: { ...state.bench!.session.composer, brief: "" } },
      },
    };
    const without = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, wordless);
    assert.doesNotMatch(without, /data-testid="bench-enhance"/);
  });
});

describe("the bench in voice mode (design 70)", () => {
  const TTS: ManifestModel = {
    id: "test-tts",
    provider: "elevenlabs",
    capability: "voice-tts",
    displayName: "Test Voice",
    accepts: { referenceImages: 0, referenceRoles: false, startFrame: false, endFrame: false },
    limits: { deliveries: ["measured", "whispered", "breaking", "cold", "warm", "urgent"] },
    pricing: { kind: "perCharacter", microUsdPerCharacter: 300 },
  };
  const TTS_SIBLING: ManifestModel = {
    ...TTS,
    id: "test-tts-sibling",
    displayName: "Test Voice Sibling",
  };
  const LINE = "The tide-clock keeps the drowned god's hours.";

  function voiceState(params: Record<string, unknown> = {}): ClientState {
    const base = stateWithBench();
    const session = base.bench!.session;
    return {
      ...base,
      app: {
        ...base.app,
        manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, TTS_SIBLING, TTS] },
        // The controls exist only for a model the key can actually reach, so the key has to be
        // in the fixture — the same gate that keeps unusable rows out of the dropdown.
        providers: [
          ...base.app.providers,
          {
            id: "elevenlabs" as const,
            configured: true,
            validation: "valid" as const,
            probes: [{ capability: "voice-tts" as const, available: true }],
            lastValidated: "2026-08-17T10:00:00.000Z",
            fault: null,
          },
        ],
      },
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: {
          ...session,
          composer: {
            ...session.composer,
            mode: "voice",
            provider: TTS.provider,
            model: TTS.id,
            params: { kind: "voice", count: 1, ...params },
            brief: LINE,
          },
        },
      },
    };
  }
  const render = (params: Record<string, unknown> = {}) =>
    renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, voiceState(params));

  it("offers a voice and a delivery, and no way to attach a picture", () => {
    const html = render();
    assert.match(html, /data-testid="voice-pick"/);
    assert.match(html, /choose a voice/);
    // A text-to-speech route takes neither references nor keyframes, so both LEAVE rather than
    // stand there to refuse a pick.
    assert.doesNotMatch(html, /data-testid="bench-add-reference"/);
    assert.doesNotMatch(html, /Keyframe/);
    assert.doesNotMatch(html, /takes no keyframes/);
  });

  it("does not offer to rewrite the line", () => {
    // The brief IS the words here. Rewriting them is editing the script, not enhancing a prompt.
    assert.doesNotMatch(render(), /data-testid="bench-enhance"/);
    // ...while the same control is there for a prompt.
    assert.match(
      renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench()),
      /data-testid="bench-enhance"/,
    );
  });

  it("prices the read exactly, with no tilde", () => {
    // 44 characters at 300 microUSD each is $0.01, and it is the price rather than a ceiling —
    // every other estimate on this screen is written with a leading tilde.
    const html = render();
    assert.match(html, /data-testid="bench-estimate"/);
    assert.doesNotMatch(html, /~\$0\.01/);
    assert.match(html, /\$0\.01/);
  });

  it("names the chosen voice on the control once one is picked", () => {
    const html = render({
      voiceId: "vale",
      voiceProvider: TTS.provider,
      voiceModel: TTS.id,
      voiceLabel: "Vale",
      delivery: "measured",
    });
    assert.match(html, />Vale</);
    assert.doesNotMatch(html, /choose a voice/);
  });

  it("shows provider defaults only when the model declares no measured delivery", () => {
    const state = voiceState({ voiceId: "clone", voiceProvider: "comfyui", voiceLabel: "Clone" });
    const clone: ManifestModel = {
      ...TTS,
      id: "comfyui-cloned-voice",
      provider: "comfyui",
      displayName: "Local Cloned Voice",
      limits: { maxPromptChars: 400, audioFormat: "flac" },
      pricing: { kind: "unmetered" },
    };
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, {
      ...state,
      app: {
        ...state.app,
        manifest: { ...state.app.manifest!, models: [...state.app.manifest!.models, clone] },
        comfyui: {
          engine: { source: "managed", state: "ready", locality: "local", location: null, version: "1", instanceId: "x", detail: null, detected: [] },
          recipes: [{ recipeId: clone.id, recipeVersion: 1, displayName: clone.displayName, capability: "voice-tts", state: "ready" }],
          checkedAt: "2026-08-25T12:00:00.000Z",
        },
      },
      bench: {
        ...state.bench!,
        session: { ...state.bench!.session, composer: { ...state.bench!.session.composer, provider: clone.provider, model: clone.id } },
      },
    });
    assert.match(html, /delivery · default only/);
    assert.doesNotMatch(html, /aria-label="Delivery"/);
  });

  it("does not carry an old provider's delivery onto a cloned voice", () => {
    const state = voiceState({ voiceId: "clone", voiceProvider: "comfyui", voiceLabel: "Clone", delivery: "breaking" });
    const clone: ManifestModel = {
      ...TTS,
      id: "comfyui-cloned-voice",
      provider: "comfyui",
      displayName: "Local Cloned Voice",
      limits: { maxPromptChars: 400, audioFormat: "flac" },
      pricing: { kind: "unmetered" },
    };
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, {
      ...state,
      app: {
        ...state.app,
        manifest: { ...state.app.manifest!, models: [...state.app.manifest!.models, clone] },
        comfyui: {
          engine: { source: "managed", state: "ready", locality: "local", location: null, version: "1", instanceId: "x", detail: null, detected: [] },
          recipes: [{ recipeId: clone.id, recipeVersion: 1, displayName: clone.displayName, capability: "voice-tts", state: "ready" }],
          checkedAt: "2026-08-25T12:00:00.000Z",
        },
      },
      bench: {
        ...state.bench!,
        session: { ...state.bench!.session, composer: { ...state.bench!.session.composer, provider: clone.provider, model: clone.id } },
      },
    });
    assert.match(html, /delivery · default only/);
    assert.doesNotMatch(html, /<option[^>]*>breaking<\/option>/);
  });
});

/**
 * The strip's picture (2026-08-17). Every tile rendered `<Portrait>` — an `<img>` — pointed at
 * the take's media file. For an image take that is the picture; for a video take it is an
 * `.mp4`, which cannot decode, so the strip full of generated video was a column of grey
 * fallback boxes. It now asks for the frame written beside the clip.
 */
describe("the strip shows a video take's first frame", () => {
  function withTake(file: string, mode: "image" | "video"): ClientState {
    const state = stateWithBench();
    const session = state.bench!.session!;
    const take = session.takes[0]!;
    return {
      ...state,
      bench: {
        ...state.bench!,
        session: {
          ...session,
          takes: [{ ...take, media: { ...take.media!, file }, request: { ...take.request, mode } }],
        },
      },
    };
  }

  it("asks for frame.png beside the clip, never the clip itself", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, withTake("output-1.mp4", "video"));
    assert.match(html, new RegExp(`media/${TAKE_ID}/frame\\.png`));
    assert.doesNotMatch(html, /<img[^>]+output-1\.mp4/, "an img pointed at an mp4 can only fail");
  });

  it("leaves a still alone — it is already its own picture", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, withTake("take.png", "image"));
    assert.match(html, new RegExp(`media/${TAKE_ID}/take\\.png`));
    assert.doesNotMatch(html, /frame\.png/);
  });
});

describe("the poster convention", () => {
  it("is spelled the same on both sides of the wire", () => {
    // The coordinator writes the file and the client asks for it. Two regexes in two packages
    // that must agree: a video kind added to one and not the other is a silently blank tile.
    const client = readFileSync(new URL("../src/lib/poster.ts", import.meta.url), "utf8");
    const server = readFileSync(
      new URL("../../coordinator/src/takes/poster.ts", import.meta.url),
      "utf8",
    );
    const extensions = (source: string) => /\/\\.\(([a-z0-9|]+)\)\$\/i/.exec(source)?.[1];
    assert.equal(extensions(client), extensions(server), "the same video extensions");
    assert.ok(extensions(client), "and both were actually found");
    for (const source of [client, server]) assert.match(source, /"frame\.png"/);
  });
});

/**
 * The waiting loop (2026-08-17). Generation takes anywhere from twenty seconds to three
 * minutes, and the panel said "Take 3 is running" and then held perfectly still for all of it.
 */
describe("something to watch while a take is out", () => {
  function atStatus(status: BenchSession["takes"][number]["status"]): ClientState {
    const state = stateWithBench();
    const session = state.bench!.session!;
    const take = session.takes[0]!;
    const { media: _dropped, ...withoutMedia } = take;
    return {
      ...state,
      bench: { ...state.bench!, session: { ...session, takes: [{ ...withoutMedia, status }] } },
    };
  }

  it("plays while the work is outstanding", () => {
    for (const status of ["allocating", "queued", "submitting", "running"] as const) {
      const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, atStatus(status));
      assert.match(html, /data-testid="bench-waiting"/, status);
      assert.match(html, /bench-generating\.mp4/, status);
      assert.match(html, /muted/, "and never makes a sound");
    }
  });

  it("holds still when nothing is happening", () => {
    // A failed take and an empty bench are both finished states. A moving picture reads as work
    // happening, and in neither case is any work happening.
    for (const status of ["failed", "cancelled", "needs-reconciliation"] as const) {
      const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, atStatus(status));
      assert.doesNotMatch(html, /data-testid="bench-waiting"/, status);
    }
    // And a take that has landed shows the take, not the loop.
    const landed = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.doesNotMatch(landed, /data-testid="bench-waiting"/);
  });

  it("keeps the status line: the picture is company, not the answer", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, atStatus("running"));
    assert.match(html, /Take 1 is running/);
  });
});

describe("the bench in music mode (design turn 73)", () => {
  const MUSIC_MODEL: ManifestModel = {
    id: "test-music",
    provider: "fal",
    capability: "music",
    displayName: "Test Music",
    accepts: { referenceImages: 0, startFrame: false, endFrame: false },
    limits: { durations: { "60": "60" }, durationWire: "number", maxDurationSec: 300 },
    pricing: { kind: "perSecond", microUsdPerSecond: 2000 },
  };
  const STYLE = "Slow sea shanty · close harmony · hand drum";

  function singing(lyrics: string): ClientState {
    const base = stateWithBench();
    const session = benchSession();
    return {
      ...base,
      app: {
        ...base.app,
        manifest: { ...base.app.manifest!, models: [...base.app.manifest!.models, MUSIC_MODEL] },
        // A control exists only for a model the key can actually reach, so the probe has to say
        // music is available — the same gate that keeps unusable rows out of the dropdown.
        providers: [
          ...base.app.providers.filter((p) => p.id !== "fal"),
          {
            id: "fal" as const,
            configured: true,
            validation: "valid" as const,
            probes: [
              { capability: "image" as const, available: true },
              { capability: "video" as const, available: true },
              { capability: "music" as const, available: true },
            ],
            lastValidated: "2026-08-18T10:00:00.000Z",
            fault: null,
          },
        ],
      },
      bench: {
        worldId: FIXTURE_WORLD_ID,
        session: {
          ...session,
          composer: {
            ...session.composer,
            mode: "music",
            provider: "fal",
            model: "test-music",
            params: { kind: "music", count: 1, lyrics },
            brief: STYLE,
            activeTokens: [],
          },
        },
      },
    };
  }

  const render = (lyrics: string) =>
    renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, singing(lyrics));

  it("offers Music as a fourth mode", () => {
    assert.match(render(""), /Music/);
  });

  it("asks for a style and the words in two separate boxes", () => {
    // One is a sentence about instrumentation, the other is what gets sung. A single box with a
    // heading in it would be asking for both in the same breath.
    const html = render("[verse]\nSalt in the rope");
    assert.match(html, /STYLE/);
    assert.match(html, /LYRICS/);
    assert.match(html, /aria-label="Style"/);
    assert.match(html, /aria-label="Lyrics"/);
  });

  it("counts the characters of the words, not of the style", () => {
    const lyrics = "[verse]\nSalt in the rope";
    const html = render(lyrics);
    assert.match(html, /data-testid="lyrics-counter"/);
    assert.match(html, new RegExp(`${lyrics.length} characters`));
  });

  it("offers to write the words, and never writes them in by itself", () => {
    const html = render("");
    assert.match(html, /data-testid="bench-write-lyrics"/);
    assert.match(html, /Write for me/);
    // The dialog is closed until asked for: a draft that appeared unbidden would be words
    // reaching the song without the author.
    assert.ok(!html.includes('data-testid="lyrics-dialog"'));
  });

  it("prices a song as a ceiling, because the route stops when the song is done", () => {
    // 60s at 2000 microUSD/s. "up to", not "~": the truth is at most, not about.
    assert.match(render("x"), /up to \$0\.12/);
  });

  it("will not offer to generate a song with no words", () => {
    const withoutWords = render("   ");
    const withWords = render("[verse]\nSalt in the rope");
    const generateDisabled = (html: string) =>
      /data-testid="bench-generate"[^>]*disabled/.test(html) ||
      /disabled[^>]*data-testid="bench-generate"/.test(html);
    assert.equal(generateDisabled(withoutWords), true, "both halves are required");
    assert.equal(generateDisabled(withWords), false, "and with them it dispatches");
  });

  it("carries none of the picture controls, and nothing that speaks", () => {
    const html = render("[verse]\nSalt in the rope");
    assert.ok(!html.includes("References"), "the row declares it takes none");
    assert.ok(!html.includes('aria-label="Aspect"'), "a song has no shape");
    assert.ok(!html.includes('data-testid="bench-enhance"'), "the style is not prose to enrich");
    assert.ok(!html.includes('data-testid="composer-mic"'), "you do not speak a song into being");
  });

  it("plays a finished song rather than trying to show it", () => {
    // Read as "video, or else a picture", a song lands on the picture branch and renders a
    // broken image. That is design 70's bug exactly, and it would have been a second first time.
    const base = singing("[verse]\nSalt in the rope");
    const session = base.bench!.session;
    const take = session.takes[0]!;
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, {
      ...base,
      bench: {
        ...base.bench!,
        session: {
          ...session,
          takes: [
            {
              ...take,
              request: {
                ...take.request,
                mode: "music",
                model: "test-music",
                params: { kind: "music", count: 1, lyrics: "[verse]\nSalt in the rope" },
              },
              media: { file: "output-1.wav", hash: take.media!.hash, info: { durationSec: 42.4, hasAudio: true } },
            },
          ],
        },
      },
    });
    assert.match(html, /data-testid="music-take"/);
    assert.match(html, /<audio/);
    assert.ok(!html.includes("output-1.wav.png"), "no poster is invented for a sound");
    assert.match(html, /Test Music/, "the take states its model");
    assert.match(html, /42s/, "and the length that was actually made, not the 60s ceiling asked for");
  });

  it("still offers all of them in image mode, so nothing was gated too broadly", () => {
    const html = renderAt(`/w/${FIXTURE_WORLD_ID}/artifacts/bench/${SESSION_ID}`, stateWithBench());
    assert.match(html, /References/);
    assert.match(html, /data-testid="bench-enhance"/);
    assert.ok(!html.includes('aria-label="Lyrics"'), "and a picture is never asked for words");
  });
});
