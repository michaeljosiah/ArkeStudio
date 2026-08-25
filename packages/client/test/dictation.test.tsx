import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import type { VoiceRuntimeStatus } from "@arke-studio/contracts";
import { renderToString } from "react-dom/server";
import { Composer } from "../src/components/composer.js";
import { whyDictationIsOff } from "../src/components/dictation.js";

/**
 * Speaking instead of typing (SPEC-018 R-1, R-14, R-16).
 *
 * The tests that matter here are about what the surface says rather than about capture, which
 * needs a microphone. Two properties carry the design: a refusal names *which* of the things
 * dictation needs is missing, and a state is legible without motion or colour.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");

const noop = () => {};

function runtime(whisper: Partial<VoiceRuntimeStatus["engineStatus"]["whisper"]>): VoiceRuntimeStatus {
  const engine = { state: "ready" as const };
  return {
    source: "bundled",
    configured: true,
    bundledAvailable: true,
    executableName: "voxa.exe",
    version: "1.0.0",
    protocolVersion: 1,
    architecture: "x64",
    expectedArchitecture: "x64",
    processState: "healthy",
    endpointCompatible: true,
    failureCategory: null,
    detail: "running",
    configurationWarning: null,
    engines: ["kokoro", "whisper"],
    engineStatus: {
      kokoro: engine,
      phonemizer: engine,
      whisper: { ...engine, ...whisper } as VoiceRuntimeStatus["engineStatus"]["whisper"],
    },
  } as VoiceRuntimeStatus;
}

describe("naming what dictation is missing", () => {
  it("says nothing is wrong when the model is ready", () => {
    assert.equal(whyDictationIsOff({ state: "ready", detail: "Voxa 1.0.0" }, runtime({})), null);
  });

  it("is optimistic before anything has reported in", () => {
    assert.equal(
      whyDictationIsOff(null, null),
      null,
      "a control that refuses because no status has arrived yet is wrong more often than right",
    );
  });

  /**
   * The point of R-14. "Voice is unavailable" tells someone nothing they can act on; which of
   * these it is tells them exactly what to do — wait, download, or go and look at settings.
   */
  it("distinguishes downloading from missing from failed, rather than collapsing them", () => {
    const said = [
      whyDictationIsOff(null, runtime({ state: "downloading" })),
      whyDictationIsOff(null, runtime({ state: "missing" })),
      whyDictationIsOff(null, runtime({ state: "verification-failed", detail: "checksum did not match" })),
    ];
    assert.equal(new Set(said).size, 3, "each is a different sentence");
    assert.match(said[0]!, /downloading/);
    assert.match(said[1]!, /not been downloaded/);
    assert.match(said[2]!, /checksum did not match/, "and it passes on the detail it was given");
  });

  it("names the model rather than the sidecar when both could be blamed", () => {
    const off = whyDictationIsOff({ state: "unavailable", detail: "Voxa is not running" }, runtime({ state: "missing" }));
    assert.match(
      off!,
      /not been downloaded/,
      "the more specific cause is the one that tells them what to do about it",
    );
  });

  it("falls back to the sidecar's own words when the model is fine", () => {
    assert.equal(
      whyDictationIsOff({ state: "not-started", detail: "Voxa is not running — dictation is off" }, null),
      "Voxa is not running — dictation is off",
    );
  });

  it("keeps dictation available when Whisper is ready and Kokoro makes aggregate voice unavailable", () => {
    assert.equal(
      whyDictationIsOff({ state: "unavailable", detail: "Kokoro failed to load" }, runtime({ state: "ready" })),
      null,
    );
  });
});

describe("the composer's microphone", () => {
  it("appears only where dictation was asked for", () => {
    const without = renderToString(
      <Composer value="" onChange={noop} onSubmit={noop} placeholder="…" />,
    );
    assert.doesNotMatch(without, /fy-cx__mic/, "and the composer stays free of the store without it");

    const withMic = renderToString(
      <Composer value="" onChange={noop} onSubmit={noop} placeholder="…" onDictate={noop} />,
    );
    assert.match(withMic, /fy-cx__mic/);
  });

  it("is unavailable while a turn is in flight, like everything else on the bar", () => {
    const html = renderToString(
      <Composer value="" onChange={noop} onSubmit={noop} placeholder="…" onDictate={noop} busy />,
    );
    assert.match(html, /class="fy-cx__mic"[^>]*disabled/);
  });

  it("says whether it is listening in text and in ARIA, not by appearance alone", () => {
    const html = renderToString(
      <Composer value="" onChange={noop} onSubmit={noop} placeholder="…" onDictate={noop} />,
    );
    assert.match(html, /aria-pressed/, "so it is not only the fill that says it is on");
    assert.match(html, /aria-label="Dictate"/);
  });

  /**
   * Listening is drawn as a filled control rather than a pulsing one. Under reduced motion a
   * pulse and a resting mic collapse to the same still glyph, exactly for the people least able
   * to guess which one they are looking at.
   */
  it("marks listening with a fill rather than with animation", () => {
    const listening = /\.fy-cx__mic\[data-listening\] \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    assert.match(listening, /background:/, "the state is drawn");
    assert.doesNotMatch(listening, /animation|@keyframes/, "and not animated, which reduced motion removes");
  });
});
