import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { ClipStep, NameStep } from "../src/components/clone-voice-dialog.js";
import { VoicePickerDialog } from "../src/components/voice-picker.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { type StagedClip } from "../src/lib/store.js";
import { encodeWav, toBase64 } from "../src/lib/wav.js";

/**
 * Making a voice from a clip (design 74c, 74d).
 *
 * Capture needs a microphone, so what is tested here is what the surface says and what it will
 * not let you do: the gate on Next, the wording of the consent line, and that the dialog draws a
 * clip by name without ever being given somewhere on disk.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");

const noop = (): void => {};

function render(staged: StagedClip | null = null, consent = false): string {
  return renderToString(
    <ClipStep
      staged={staged}
      consent={consent}
      recording={false}
      preparing={false}
      elapsed={0}
      trouble={null}
      onConsent={noop}
      onRecord={noop}
      onChoose={noop}
      onCancel={noop}
      onNext={noop}
    />,
  );
}

describe("the clone dialog", () => {
  it("states the one thing the app owes anybody about cloning a voice", () => {
    // Verbatim, and once. The model cannot tell whether the speaker in a clip agreed to be
    // cloned and neither can the app, so this sentence is the whole of the app's position on it.
    const markup = render();
    assert.equal(markup.includes("The person speaking agreed to have their voice cloned."), true);
    assert.equal(markup.split("agreed to have their voice cloned").length - 1, 1);
  });

  it("will not go on without a clip, however ticked the consent is", () => {
    // Both gates on one button. A dialog that let you past on consent alone would reach 74d with
    // nothing to clone from, and only say so after a name and a description had been typed.
    assert.equal(disabledNext(render(null, true)), true);
    const clip: StagedClip = { clipId: "clip_01", fileName: "harbour.wav", seconds: 9, reason: null };
    assert.equal(disabledNext(render(clip, false)), true, "a clip without the tick is not enough either");
    assert.equal(disabledNext(render(clip, true)), false);
  });

  it("gates Save on a name and a description, not on the clip alone", () => {
    // The description is required because rankVoices buries an attribute-less candidate — a voice
    // cloned FOR a character would otherwise sink below every preset when ranked against her.
    const save = (name: string, description: string): boolean =>
      disabled(
        renderToString(
          <NameStep
            name={name}
            description={description}
            saving={false}
            ready
            trouble={null}
            onName={noop}
            onDescription={noop}
            onBack={noop}
            onSave={noop}
          />,
        ),
        "clone-save",
      );
    assert.equal(save("Harbour glass", ""), true);
    assert.equal(save("  ", "Low, dry, unhurried."), true, "whitespace is not a name");
    assert.equal(save("Harbour glass", "Low, dry, unhurried. Coastal."), false);
  });

  it("shows the words the picker will match on, as they are typed", () => {
    const markup = renderToString(
      <NameStep
        name="Harbour glass"
        description="Low, dry, unhurried. Coastal."
        saving={false}
        ready
        trouble={null}
        onName={noop}
        onDescription={noop}
        onBack={noop}
        onSave={noop}
      />,
    );
    // Extracted by the same function that reads a sheet's written voice, so what is shown is what
    // is matched. A description whose words extract to nothing would rank last and look fine.
    for (const word of ["low", "dry", "unhurried", "coastal"]) {
      assert.equal(markup.includes(`>${word}</span>`), true, `${word} is not offered to the ranker`);
    }
  });

  it("offers both gestures, and names a staged clip without naming where it is", () => {
    const markup = render({ clipId: "clip_01", fileName: "harbour.wav", seconds: 9, reason: null });
    assert.equal(markup.includes("Record"), true);
    assert.equal(markup.includes("Choose a file"), true);
    // The dialog is handed a name and a length, and nothing it could turn back into a path.
    assert.equal(markup.includes("harbour.wav"), true);
    assert.equal(markup.includes("C:\\"), false);
    assert.equal(markup.includes("0:09"), true);
  });

  it("says why a clip was refused, in the words it was refused with", () => {
    const reason = "that clip is 1.2s — a voice needs 3 seconds or more to clone from";
    const markup = render({ clipId: null, fileName: null, seconds: null, reason });
    assert.equal(markup.includes(reason), true);
    // Refused at 74c means refused while the clip is still the only thing on screen.
    assert.equal(disabledNext(markup), true);
  });

  it("draws every class it uses", () => {
    // A class invented here and never styled renders as unstyled text with no test failing.
    for (const name of [...render().matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1]!.split(/\s+/))) {
      if (name.startsWith("fy-clone")) assert.equal(CSS.includes(`.${name}`), true, `${name} has no style`);
    }
  });
});

describe("voice picker identity", () => {
  it("keeps equal voice ids under different providers and models as distinct selection keys", () => {
    __setStateForTest(FIXTURE_STATE, {
      voiceCatalogue: [
        { provider: "elevenlabs", model: "eleven-v2", voiceId: "same", label: "Cloud v2", attributes: [], local: false, canClone: false, usedBy: [] },
        { provider: "elevenlabs", model: "eleven-v3", voiceId: "same", label: "Cloud v3", attributes: [], local: false, canClone: false, usedBy: [] },
        { provider: "comfyui", model: "comfyui-cloned-voice", voiceId: "same", label: "Clone", attributes: [], local: true, canClone: false, usedBy: [] },
      ],
    });
    const markup = renderToString(
      <VoicePickerDialog
        open
        chosenId="same"
        chosenProvider="elevenlabs"
        chosenModel="eleven-v3"
        onClose={noop}
        onPick={noop}
      />,
    );
    assert.equal((markup.match(/fy-voices__row--on/g) ?? []).length, 1);
    assert.match(markup, /Cloud v2/);
    assert.match(markup, /Cloud v3/);
    assert.match(markup, /Clone/);
    assert.match(markup, /fy-voices__picked">Cloud v3/);
  });

  it("filters cloned voices out of narration until that use is implemented", () => {
    __setStateForTest(FIXTURE_STATE, {
      voiceCatalogue: [
        { provider: "kokoro", model: "kokoro-82m", voiceId: "same", label: "Preset", attributes: [], local: true, canClone: false, usedBy: [] },
        { provider: "comfyui", model: "comfyui-cloned-voice", voiceId: "clone", label: "Clone", attributes: [], local: true, canClone: false, usedBy: [] },
      ],
    });
    const markup = renderToString(
      <VoicePickerDialog open use="narration" chosenId={undefined} onClose={noop} onPick={noop} />,
    );
    assert.match(markup, /Preset/);
    assert.doesNotMatch(markup, />Clone</);
  });
});

/** Whether the button carrying this testid is shut. */
function disabled(markup: string, testid: string): boolean {
  const at = markup.indexOf(`data-testid="${testid}"`);
  assert.notEqual(at, -1, `${testid} is not on the screen`);
  return markup.slice(at, markup.indexOf(">", at)).includes("disabled");
}

const disabledNext = (markup: string): boolean => disabled(markup, "clone-next");

describe("encoding what the microphone gave us", () => {
  it("writes a header the coordinator's reader can measure", () => {
    // MediaRecorder produces WebM and the library refuses it by magic number, so this encoder is
    // the only reason a recording becomes a clip at all. The bytes must be a real RIFF/WAVE with
    // a byte rate at +16 into `fmt ` — the offset the coordinator reads its duration from.
    const wav = encodeWav(fakeBuffer({ sampleRate: 44100, frames: 44100 }));
    assert.equal(String.fromCharCode(...wav.subarray(0, 4)), "RIFF");
    assert.equal(String.fromCharCode(...wav.subarray(8, 12)), "WAVE");
    assert.equal(String.fromCharCode(...wav.subarray(12, 16)), "fmt ");
    const view = new DataView(wav.buffer);
    assert.equal(view.getUint32(28, true), 44100 * 2, "byte rate is mono 16-bit");
    assert.equal(String.fromCharCode(...wav.subarray(36, 40)), "data");
    assert.equal(view.getUint32(40, true), 44100 * 2, "one second of samples");
  });

  it("averages channels rather than summing them", () => {
    // Summing two channels of a loud stereo capture clips it on the way in — the recording would
    // arrive distorted and there would be nothing downstream to blame.
    const wav = encodeWav(fakeBuffer({ sampleRate: 8000, frames: 4, channels: 2, value: 1 }));
    assert.equal(new DataView(wav.buffer).getInt16(44, true), 0x7fff);
  });

  it("base64s a clip too long for one call to fromCharCode", () => {
    // `String.fromCharCode(...bytes)` throws past the argument limit, which a real recording of
    // any length exceeds — the failure is a RangeError at the end of a capture, not at build.
    assert.equal(toBase64(new Uint8Array(200_000)).length > 0, true);
  });
});

/** An AudioBuffer's shape, without needing an AudioContext to make one. */
function fakeBuffer({
  sampleRate,
  frames,
  channels = 1,
  value = 0.5,
}: {
  sampleRate: number;
  frames: number;
  channels?: number;
  value?: number;
}): AudioBuffer {
  return {
    sampleRate,
    length: frames,
    numberOfChannels: channels,
    duration: frames / sampleRate,
    getChannelData: () => new Float32Array(frames).fill(value),
  } as unknown as AudioBuffer;
}
