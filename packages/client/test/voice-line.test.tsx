import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

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
  (production()?.scenes ?? []).flatMap((s) => s.shots).filter((s) => s.audio?.line && s.audio.speaker);

describe("the voice-line dialog", () => {
  /** The fixture ships one spoken shot; a second is added here so the test can discriminate. */
  function twoSpeakers(): { state: ClientState; prodId: string; secondId: string; secondLine: string } {
    const prod = production()!;
    const first = spokenShots()[0]!;
    const secondLine = "the ledger is not the tide, and the tide does not read";
    const second = { ...first, id: "sh_99", number: 99, audio: { ...first.audio!, line: secondLine } };
    const scenes = prod.scenes.map((scene, i) => (i === 0 ? { ...scene, shots: [...scene.shots, second] } : scene));
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
});

/**
 * The character's voice picker, organised the way the bench's reading picker is (design 70).
 * Six local voices were otherwise lost among fifty cloud ones, and "can this machine say it
 * without spending" is the first question anyone asks of the list.
 */
describe("choosing a character's voice", () => {
  const sheetId = FIXTURE_STATE.world!.sheets[0]!.id;
  const candidate = (voiceId: string, provider: string, local: boolean) => ({
    candidate: { provider, voiceId, label: voiceId, attributes: ["warm"], local, canClone: !local },
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
});
