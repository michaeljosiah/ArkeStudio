import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ManifestModel, VoiceDirectionInput } from "@arke-studio/contracts";
import {
  BenchVoiceDirection,
  benchDirectionSummary,
  benchMarkerAt,
  editBenchBrief,
  withBenchDirection,
} from "../src/components/bench-voice-direction.js";
import { BenchBrief } from "../src/components/bench-brief.js";
import type { MarkerAt } from "../src/components/voice-direction.js";

/**
 * The Bench's Voice brief directed in place (design turn 181a–d): plates on the words, the note,
 * Sent as in each reader's own syntax, typed tags become markers and a bracket that is none is
 * named. Driven on the component itself under linkedom, as the brief's own test does.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const GEMINI: ManifestModel = {
  id: "gemini-3.8-flash-tts", provider: "google", capability: "voice-tts", displayName: "Gemini 3.8 Flash TTS",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { audioFormat: "wav", maxSpeechUtf8Bytes: 7000 },
  pricing: { kind: "unmetered" },
  cadence: { deliveries: ["measured", "cold"], speed: null, pause: "best-effort-audio-tag", emphasis: "best-effort-capitalization", breath: "best-effort-audio-tag",
    outputTimestamps: "none", phrase: "best-effort-instruction", tagSyntax: "angle", sounds: { sighs: "sigh", laughs: "laugh" },
    deliveryMappings: { measured: { settings: {}, instruction: "Read calmly." }, cold: { settings: {}, instruction: "Read coldly." } } },
};
const KOKORO: ManifestModel = {
  id: "kokoro-82m", provider: "kokoro", capability: "voice-tts", displayName: "Kokoro 82M",
  accepts: { referenceImages: 0, startFrame: false, endFrame: false }, limits: { audioFormat: "wav" }, pricing: { kind: "unmetered" },
  cadence: { deliveries: ["measured", "urgent"], speed: null, pause: "best-effort-punctuation", emphasis: "unsupported", breath: "unsupported", outputTimestamps: "none",
    deliveryMappings: { measured: { settings: { speed: 0.92 } }, urgent: { settings: { speed: 1.15 } } } },
};

const LINE = "Don’t you dare walk away from me, Ade. Not this time.";
const after = (words: string) => LINE.indexOf(words) + words.length;
const NOTE = "angry and hurt — quieter, not louder; holding back tears";
const DIRECTED: VoiceDirectionInput = {
  delivery: "cold", speed: 1, note: NOTE,
  cues: [
    { kind: "pause", at: after("Ade."), length: "long" },
    { kind: "emphasis", span: { from: LINE.indexOf("this"), to: LINE.indexOf("this") + 4, text: "this" }, level: "strong" },
    { kind: "sound", at: LINE.length, sound: "sighs" },
  ],
};

interface Mounted { container: HTMLElement; root: Root }
const open: Mounted[] = [];
afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

async function mount(node: React.ReactNode): Promise<Mounted> {
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(node));
  const mounted = { container, root };
  open.push(mounted);
  return mounted;
}

type Calls = { direction: VoiceDirectionInput[]; brief: Array<[string, VoiceDirectionInput]>; kept: string[]; marker: Array<MarkerAt | null> };
function editor(brief: string, direction: VoiceDirectionInput, model: ManifestModel, calls: Calls, marker: MarkerAt | null = null) {
  return (
    <BenchVoiceDirection
      brief={brief}
      direction={direction}
      model={model}
      marker={marker}
      noteRef={createRef<HTMLInputElement>()}
      kept={new Set()}
      onMarker={(at) => calls.marker.push(at)}
      onDirection={(next) => calls.direction.push(next)}
      onBrief={(words, next) => calls.brief.push([words, next])}
      onKeep={(bracket) => calls.kept.push(bracket)}
    />
  );
}
const calls = (): Calls => ({ direction: [], brief: [], kept: [], marker: [] });

describe("the Bench's Voice brief (design turn 181)", () => {
  it("draws the plates on the words and says exactly what Gemini is sent (181a)", async () => {
    const m = await mount(editor(LINE, DIRECTED, GEMINI, calls()));
    const plates = [...m.container.querySelectorAll(".fy-ab__mk")].map((plate) => plate.getAttribute("data-mk"));
    assert.deepEqual(plates, ["[long pause]", "[emphasis]", "[sighs]"]);
    assert.ok(m.container.querySelector(".fy-ab__mk--sound"), "a sound is outlined, not filled");
    const sent = m.container.querySelector('[data-testid="sent-as"]')!.textContent!;
    assert.match(sent, /style Read coldly\. Angry and hurt — quieter, not louder; holding back tears\./);
    assert.match(sent, /text Don’t you dare walk away from me, Ade\. <long pause> Not THIS time\. <sigh>/);
    assert.doesNotMatch(sent, /Held/);
    assert.match(m.container.textContent!, new RegExp(`${NOTE.length} / 300`));
  });

  it("holds, strikes and lists what Kokoro cannot take, and never sends it (181d)", async () => {
    const m = await mount(editor(LINE, DIRECTED, KOKORO, calls()));
    const sent = m.container.querySelector('[data-testid="sent-as"]')!.textContent!;
    assert.match(sent, /text Don’t you dare walk away from me, Ade… Not this time\./);
    assert.match(sent, /Held cold · emphasis · sighs · note — Kokoro 82M/);
    assert.equal(m.container.querySelectorAll(".fy-ab__mk--held").length, 2, "the emphasis and the sound are struck; the pause is punctuation");
  });

  it("names a bracket that is not a marker, and makes it the note or keeps it as words (181c)", async () => {
    const said = calls();
    const brief = "Say it [like a pirate] one more time.";
    const m = await mount(editor(brief, { speed: 1, cues: [] }, GEMINI, said));
    const row = m.container.querySelector('[data-testid="bench-unknown-bracket"]')!;
    assert.match(row.textContent!, /\[like a pirate\]not a marker · would be read aloud/);
    const [makeNote, keep] = [...row.querySelectorAll("button")] as HTMLButtonElement[];
    await act(async () => makeNote!.click());
    assert.deepEqual(said.brief[0], ["Say it one more time.", { speed: 1, cues: [], note: "like a pirate" }]);
    await act(async () => keep!.click());
    assert.deepEqual(said.kept, ["[like a pirate]"]);
  });

  it("opens the shared marker menu with the sounds a reader makes, and strikes a delivery one request cannot carry", async () => {
    const said = calls();
    const at = benchMarkerAt(LINE, 0, 0);
    const m = await mount(editor(LINE, { speed: 1, cues: [] }, GEMINI, said, at));
    const menu = m.container.querySelector('[aria-label="Marker"][role="menu"]')!;
    const chip = (label: string) => [...menu.querySelectorAll("button")].find((button) => button.textContent === label) as HTMLButtonElement;
    assert.ok(chip("sighs") && !chip("sighs").disabled, "Gemini makes a sigh");
    assert.ok(chip("coughs").disabled, "and holds a cough it does not list");
    assert.ok(chip("cold").disabled, "an instruction reader's marker needs a read in parts");
    assert.match(chip("cold").title, /needs a read in parts/);
    await act(async () => chip("sighs").click());
    assert.deepEqual(said.direction[0]?.cues, [{ kind: "sound", at: 0, sound: "sighs" }]);
    assert.ok([...menu.querySelectorAll("button")].some((button) => button.textContent?.startsWith("Note…")), "the note is the menu's last item");
  });

  it("[ in the words opens the menu rather than typing", async () => {
    let opened: [number, number] | null = null;
    const m = await mount(
      <BenchBrief value={LINE} onChange={() => {}} options={[]} worldSlug={undefined} underlay={LINE} label="Words" onBracket={(start, end) => (opened = [start, end])} />,
    );
    // React's keydown under linkedom trips its input polyfill, so the handler is called as React
    // would call it, with the event it would pass.
    const textarea = m.container.querySelector("textarea")!;
    const props = (textarea as unknown as Record<string, { onKeyDown: (event: unknown) => void }>)[Object.keys(textarea).find((key) => key.startsWith("__reactProps"))!]!;
    let prevented = false;
    await act(async () => {
      props.onKeyDown({ key: "[", ctrlKey: false, metaKey: false, altKey: false, nativeEvent: { isComposing: false }, currentTarget: { selectionStart: 4, selectionEnd: 7 }, preventDefault: () => (prevented = true) });
    });
    assert.deepEqual(opened, [4, 7], "the bracket key opened the marker menu on the selection");
    assert.equal(prevented, true, "and typed nothing");
  });
});

describe("the line's direction through edits", () => {
  it("turns pasted tags in any reader's spelling into markers, and keeps them through typing", () => {
    const pasted = "[whispers] I’m here. <laugh> You came back (sighs) Say it [like a pirate] one more time.";
    const first = editBenchBrief("", pasted, { speed: 1, cues: [] });
    assert.equal(first.brief, "I’m here. You came back Say it [like a pirate] one more time.");
    assert.deepEqual(first.direction.cues.map((cue) => cue.kind), ["delivery", "sound", "sound"]);
    const typed = editBenchBrief(first.brief, `${first.brief} Now.`, first.direction);
    assert.deepEqual(typed.direction.cues, first.direction.cues, "typing after the words moves nothing");
  });

  it("writes the direction, retires an old session's delivery, and names it on a take", () => {
    const old = { kind: "voice" as const, count: 1, delivery: "cold" as const };
    const written = withBenchDirection(old, { delivery: "cold", speed: 1, cues: [], note: "flat" });
    assert.deepEqual(written, { kind: "voice", count: 1, direction: { delivery: "cold", speed: 1, cues: [], note: "flat" } });
    assert.deepEqual(withBenchDirection(written, { speed: 1, cues: [] }), { kind: "voice", count: 1 }, "nothing said, nothing written");
    assert.deepEqual(benchDirectionSummary({ direction: DIRECTED }), ["cold", "note", "3 markers"]);
    assert.deepEqual(benchDirectionSummary(old), ["cold"]);
  });
});
