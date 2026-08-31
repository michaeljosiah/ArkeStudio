import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import type { ClientMessage, DomainEvent } from "@arke-studio/contracts";
import { RemoteVoiceUploadConfirmation } from "../src/components/remote-voice-upload-confirmation.js";
import {
  __applyEventForTest,
  __setBridgeForTest,
  __setStateForTest,
  requestVoiceLine,
  requestVoicePreview,
  sendBenchDispatch,
  sendBenchRerun,
  subscribeVoiceUploadConfirmations,
} from "../src/lib/store.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const WORLD = "01J8F3K2QW9VZX4N7M0RTYB6HC";
const SHEET = "maren-kest";
const PRODUCTION = "saltlight";
const SHOT = "sh_12";
const SESSION = "sess_01J8F3K2QW9VZX4N7M0RTYB6HD";
const TAKE = "tk_01J8F3K2QW9VZX4N7M0RTYB6HE";

function bridge(messages: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json) => messages.push(JSON.parse(json) as ClientMessage),
  };
}

afterEach(() => __setBridgeForTest(null));

describe("remote cloned voice renderer confirmation", () => {
  it("renders only the destination-safe label", () => {
    const markup = renderToString(
      <RemoteVoiceUploadConfirmation
        destinationLabel="voice-box.example:8188"
        onCancel={() => {}}
        onConfirm={() => {}}
      />,
    );
    assert.match(markup, /Send this voice recording/);
    assert.match(markup, /voice-box\.example:8188/);
    assert.match(markup, /Send recording/);
    assert.doesNotMatch(markup, /confirmationToken|opaque-engine-instance/);
  });

  it("surfaces a correlated confirmation-required event to the renderer", () => {
    __setStateForTest(FIXTURE_STATE);
    const messages: ClientMessage[] = [];
    __setBridgeForTest(bridge(messages));
    const requestId = requestVoicePreview(WORLD, SHEET, "comfyui", "comfyui-cloned-voice", "harbour");
    const seen: Array<Extract<DomainEvent, { type: "voice.upload-confirmation-required" }>> = [];
    const unsubscribe = subscribeVoiceUploadConfirmations((event) => {
      seen.push(event);
    });
    __applyEventForTest({
      at: "2026-08-25T12:00:00.000Z",
      type: "voice.upload-confirmation-required",
      requestId,
      worldId: WORLD,
      command: "voice-preview",
      destinationLabel: "voice-box.example:8188",
      confirmationToken: "opaque-engine-instance",
    });
    unsubscribe();
    assert.equal(seen[0]?.destinationLabel, "voice-box.example:8188");
    assert.equal(seen[0]?.confirmationToken, "opaque-engine-instance");
  });

  it("carries the confirmed engine instance on preview, Bench and production retries", () => {
    __setStateForTest(FIXTURE_STATE);
    const messages: ClientMessage[] = [];
    __setBridgeForTest(bridge(messages));
    requestVoicePreview(WORLD, SHEET, "comfyui", "comfyui-cloned-voice", "harbour", "engine-1");
    requestVoiceLine({
      worldId: WORLD,
      productionId: PRODUCTION,
      shotId: SHOT,
      voiceUploadConfirmedFor: "engine-1",
    });
    sendBenchDispatch(
      WORLD,
      SESSION,
      {
        mode: "voice",
        provider: "comfyui",
        model: "comfyui-cloned-voice",
        params: { kind: "voice", count: 1, voiceId: "harbour" },
        brief: "Harbour line",
      },
      "engine-1",
    );
    sendBenchRerun(WORLD, SESSION, TAKE, "engine-1");
    assert.deepEqual(
      messages.map((message) =>
        "voiceUploadConfirmedFor" in message ? message.voiceUploadConfirmedFor : undefined,
      ),
      ["engine-1", "engine-1", "engine-1", "engine-1"],
    );
  });
});
