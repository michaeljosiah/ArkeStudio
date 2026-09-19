import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { DEFAULT_NARRATOR, type ClientMessage } from "@arke-studio/contracts";
import { ReadAloud, ReadAloudButton } from "../src/components/read-aloud.js";
import { ReadAloudConfirmation } from "../src/components/read-aloud-confirmation.js";
import { ClipPlayButton } from "../src/components/player.js";
import { App } from "../src/App.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { dismissPlayback, emitForTest, playbackSnapshot, playClip, setAudioFactoryForTest } from "../src/lib/audio.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Reading a sheet aloud is narration: the app's narrator reads prose ABOUT the character, so the
 * clip names the narrator, never the character's own voice. There are two clip builders — the
 * effect that plays a read as soon as it lands, and the row's control that replays it — and only
 * the first actually sounded when the second was written, so the player once named a voice that
 * had not read a word. Both are driven here, with a narrator distinct from the character's voice.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { focus() {} });
Object.assign(globalThis, {
  window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const open: Root[] = [];
afterEach(async () => {
  for (const root of open.splice(0)) await act(async () => root.unmount());
  dom.document.body.replaceChildren();
  dismissPlayback();
  setAudioFactoryForTest(null);
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});

it("names the narrator on the clip, both when a read lands and when the row replays it", async () => {
  const dock = { playbackRate: 1, src: "", currentTime: 0, duration: NaN, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
  setAudioFactoryForTest(() => dock as never);
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
  // Maren's own voice is "Low tide"; the app's narrator is somebody else.
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, narrator: { provider: "kokoro", model: "kokoro-82m", voiceId: "bf_emma", label: "Emma" } } });
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  open.push(root);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/cast/maren-kest`]}>
      <App />
    </MemoryRouter>,
  ));
  const read = () => container.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]')!;
  assert.ok(read(), "the sheet offers a read");
  await act(async () => read().click());
  const asked = sent.find((message): message is Extract<ClientMessage, { kind: "read-sheet-section" }> => message.kind === "read-sheet-section");
  assert.ok(asked, "the read was asked for");

  // The read lands: the effect plays it at once, and the clip says who read it.
  await act(async () => __applyEventForTest({
    type: "voice.audio", at: "2026-09-12T08:00:00.000Z", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, sheetId: "maren-kest", sheetVersion: 4,
    purpose: "sheet-section", sectionHeading: asked.sectionHeading, provider: "kokoro", model: "kokoro-82m", voiceId: "bf_emma", format: "wav",
    status: "ready", file: ".cache/voice/maren-essence.wav", cached: false, characterCount: 120, estimatedMicroUsd: 0,
  }));
  assert.equal(playbackSnapshot().clip?.sub, "read aloud · Emma", "the landed read names the narrator");
  assert.doesNotMatch(playbackSnapshot().clip?.sub ?? "", /Low tide/, "not the character's own voice");

  // The row replays the same read: the other builder, the same name.
  dismissPlayback();
  assert.equal(playbackSnapshot().clip, null);
  await act(async () => read().click());
  assert.equal(sent.filter((message) => message.kind === "read-sheet-section").length, 1, "a landed read replays rather than being asked for again");
  assert.equal(playbackSnapshot().clip?.sub, "read aloud · Emma");
  assert.match(playbackSnapshot().clip?.title ?? "", /^Maren Kest · /);
});


/*
 * A section over the reader's cap arrives in pieces (issue 1208), the way a long local read
 * always has. This screen played only the newest event, so the second piece replaced the first
 * mid-sentence; now each is queued as it lands and the player walks on when one ends.
 */
it("queues the pieces of a chunked sheet read behind the first rather than replacing it", async () => {
  const dock = { playbackRate: 1, src: "", currentTime: 0, duration: NaN, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
  setAudioFactoryForTest(() => dock as never);
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  open.push(root);
  await act(async () => root.render(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/cast/maren-kest`]}>
      <App />
    </MemoryRouter>,
  ));
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]')!.click());
  const asked = sent.find((message): message is Extract<ClientMessage, { kind: "read-sheet-section" }> => message.kind === "read-sheet-section")!;
  const piece = (part: number, file: string) => ({
    type: "voice.audio" as const, at: "2026-09-16T08:00:00.000Z", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, sheetId: "maren-kest", sheetVersion: 4,
    purpose: "sheet-section" as const, sectionHeading: asked.sectionHeading, provider: "mistral" as const, model: "voxtral-mini-tts", voiceId: "en_paul_neutral", format: "wav" as const,
    status: "ready" as const, file, cached: false, characterCount: 200, estimatedMicroUsd: 3200, part, parts: 2,
  });
  await act(async () => __applyEventForTest(piece(0, ".cache/voice-previews/first.wav")));
  assert.match(playbackSnapshot().clip?.url ?? "", /first\.wav$/, "the first piece sounds the moment it lands");
  await act(async () => __applyEventForTest(piece(1, ".cache/voice-previews/second.wav")));
  assert.match(playbackSnapshot().clip?.url ?? "", /first\.wav$/, "the second piece waits its turn rather than replacing the first");
  await act(async () => emitForTest("ended"));
  assert.match(playbackSnapshot().clip?.url ?? "", /second\.wav$/, "and follows when the first ends");
  assert.equal(playbackSnapshot().clip?.sub, `read aloud · ${DEFAULT_NARRATOR.label}`);
});

/*
 * Cloud pieces land in whatever order the reader finishes them (codex on PR 1210). A second
 * piece landing first fills the parts array to its final length; the first piece then fills
 * the gap behind it without changing that length, and an effect keyed on the length would
 * never queue the paid read.
 */
for (const surface of ["sheet", "prose"] as const) {
  it(`${surface} read: a later piece landing first waits, and the read starts when the gap behind it fills`, async () => {
    const dock = { playbackRate: 1, src: "", currentTime: 0, duration: NaN, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
    setAudioFactoryForTest(() => dock as never);
    const sent: ClientMessage[] = [];
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json) as ClientMessage); } } as unknown as ArkeBridge);
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    const root = createRoot(container);
    open.push(root);
    const props = { source: { of: "shot", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" } as const, title: "Shot script", text: "The sea moves." };
    await act(async () => root.render(surface === "sheet"
      ? <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/cast/maren-kest`]}><App /></MemoryRouter>
      : <ReadAloud {...props} />));
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Read aloud"]')!.click());
    const asked = sent.find((message): message is Extract<ClientMessage, { kind: "read-sheet-section" | "read-prose" }> => message.kind === "read-sheet-section" || message.kind === "read-prose")!;
    const piece = (part: number, file: string) => ({
      type: "voice.audio" as const, at: "2026-09-16T08:00:00.000Z", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, sheetVersion: 4,
      purpose: surface === "sheet" ? "sheet-section" as const : "prose" as const, ...(asked.kind === "read-sheet-section" ? { sheetId: "maren-kest", sectionHeading: asked.sectionHeading } : {}),
      provider: "mistral" as const, model: "voxtral-mini-tts", voiceId: "en_paul_neutral", format: "wav" as const,
      status: "ready" as const, file, cached: false, characterCount: 200, estimatedMicroUsd: 3200, part, parts: 2,
    });
    await act(async () => __applyEventForTest(piece(1, ".cache/voice-previews/second.wav")));
    assert.equal(playbackSnapshot().clip, null, "the second piece alone starts nothing: the read begins at its first words");
    await act(async () => __applyEventForTest(piece(0, ".cache/voice-previews/first.wav")));
    assert.match(playbackSnapshot().clip?.url ?? "", /first\.wav$/, "the first piece sounds once the gap fills");
    await act(async () => emitForTest("ended"));
    assert.match(playbackSnapshot().clip?.url ?? "", /second\.wav$/, "and the second follows");
  });
}

/*
 * The bible's replay button decides whether its clip is the one sounding, and a chunked read's
 * joined whole shares the pieces' request id (codex on PR 1210): by id alone a press on the whole
 * toggled the piece that happened to be loaded rather than loading the passage.
 */
it("a clip button loads the joined whole rather than toggling the piece sounding under the same id", async () => {
  const dock = { playbackRate: 1, src: "", currentTime: 0, duration: NaN, play: async () => {}, pause() {}, load() {}, removeAttribute() {}, addEventListener() {}, removeEventListener() {} };
  setAudioFactoryForTest(() => dock as never);
  await playClip({ id: "read", url: "/piece-1.wav", title: "Essence" });
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container); open.push(root);
  await act(async () => root.render(<ClipPlayButton clip={{ id: "read", url: "/whole.wav", title: "Essence" }} />));
  const button = container.querySelector<HTMLButtonElement>("button")!;
  assert.match(button.getAttribute("aria-label") ?? "", /^Play /, "the whole is not what is sounding");
  await act(async () => button.click());
  assert.equal(playbackSnapshot().clip?.url, "/whole.wav", "pressed, it loads the whole");
});

it("says how many pieces a chunked read goes as, on the dialog that prices it", async () => {
  __setStateForTest(FIXTURE_STATE);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container); open.push(root);
  const quote = (parts?: number) => ({
    type: "voice.audio" as const, at: "2026-09-16T08:00:00.000Z", requestId: FIXTURE_WORLD_ID, worldId: FIXTURE_WORLD_ID,
    sheetVersion: 1, purpose: "sheet-section" as const, provider: "breezeblue" as const, model: "breeze-tts-2", voiceId: "voc_1", format: "wav" as const,
    status: "confirmation-required" as const, file: null, cached: false, characterCount: 1487, estimatedMicroUsd: 59480, confirmationToken: "quote-1", ...(parts !== undefined ? { parts } : {}),
  });
  await act(async () => root.render(<ReadAloudConfirmation title="Appearance" result={quote(2)} onCancel={() => {}} onConfirm={() => {}} />));
  assert.match(dom.document.querySelector('[role="dialog"]')!.textContent!, /Appearance · Breeze · 2 parts/);
  assert.match(dom.document.querySelector('[role="dialog"]')!.textContent!, /Confirm 1487 characters · \$0.06/, "priced once, for the whole read");
  await act(async () => root.render(<ReadAloudConfirmation title="Appearance" result={quote()} onCancel={() => {}} onConfirm={() => {}} />));
  assert.doesNotMatch(dom.document.querySelector('[role="dialog"]')!.textContent!, /parts/, "a read that goes whole says nothing about pieces");
});

// The bible's column was the third copy of this control, and the one PR 1209 did not reach
// (issue 1211): it named ElevenLabs whatever the quote said, as an inline ribbon, with no piece
// count. It shares the dialog now, so it is driven here beside the other three.
for (const surface of ["sheet", "prose", "button", "bible"] as const) {
  it(`${surface} read confirms the quoted reader and price in a cancelable dialog`, async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } } as ArkeBridge);
    // The quote, not the current narrator preference, decides the disclosure. The bible's text
    // carries a tag so the screen opens its plain editor: the rich one wants a selection API
    // this DOM does not have, and the column under test is the same either way.
    const world = FIXTURE_STATE.world!;
    __setStateForTest({
      ...FIXTURE_STATE,
      app: { ...FIXTURE_STATE.app, narrator: { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "old", label: "Old narrator" } },
      ...(surface === "bible" ? { world: { ...world, bible: { version: 3, updated: "2026-07-30", present: true, text: "## The tides\n\nThe tide is the world's clock <br> and its accountant.\n" } } } : {}),
    });
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    const root = createRoot(container); open.push(root);
    const props = { source: { of: "shot", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" } as const, title: "Shot script", text: "The sea moves." };
    await act(async () => root.render(surface === "sheet"
      ? <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/cast/maren-kest`]}><App /></MemoryRouter>
      : surface === "bible" ? <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/bible`]}><App /></MemoryRouter>
      : surface === "prose" ? <ReadAloud {...props} /> : <ReadAloudButton {...props} />));
    const trigger = () => container.querySelector<HTMLButtonElement>(surface === "button" ? 'button[title="Read aloud"]' : surface === "bible" ? 'button[aria-label="Read The tides aloud"]' : 'button[aria-label="Read aloud"]')!;
    const requests = () => sent.filter(message => message.kind === "read-sheet-section" || message.kind === "read-prose" || message.kind === "read-bible-section");
    await act(async () => trigger().click());
    let asked = requests().at(-1)!;
    const quote = () => ({ type: "voice.audio" as const, at: "2026-09-16T08:00:00.000Z", requestId: asked.requestId,
      worldId: FIXTURE_WORLD_ID, sheetVersion: 4, purpose: surface === "sheet" ? "sheet-section" as const : surface === "bible" ? "bible-section" as const : "prose" as const,
      ...(surface === "bible" ? { sectionHeading: "The tides" } : {}),
      provider: "mistral" as const, model: "voxtral-mini-tts", voiceId: "voice", format: "wav" as const,
      status: "confirmation-required" as const, file: null, cached: false, characterCount: 1487, estimatedMicroUsd: 23792, confirmationToken: "quote-1" });
    await act(async () => __applyEventForTest(quote()));
    let dialog = dom.document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    assert.match(dialog.textContent!, /sent to Voxtral/);
    if (surface === "bible") assert.match(dialog.textContent!, /The tides · Voxtral/, "titled by the section, as the sheet's is by the sheet and section");
    assert.doesNotMatch(dialog.textContent!, /ElevenLabs|elevenlabs|Old narrator/);
    assert.match(dialog.textContent!, /Confirm 1487 characters · \$0.02/);
    assert.equal(requests().length, 1, "quoting does not confirm a charge");
    await act(async () => [...dialog.querySelectorAll('button')].find(button => button.textContent === "Cancel")!.click());
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    assert.equal(requests().length, 1, "cancel sends no paid request");
    await act(async () => trigger().click());
    asked = requests().at(-1)!;
    await act(async () => __applyEventForTest(quote()));
    dialog = dom.document.querySelector('[role="dialog"]')!;
    const confirm = [...dialog.querySelectorAll('button')].find(button => button.textContent!.startsWith('Confirm'))!;
    await act(async () => { confirm.click(); confirm.click(); });
    assert.equal(requests().length, 3, "one confirmation despite repeated clicks");
    assert.equal(requests().at(-1)!.requestId, asked.requestId);
    assert.equal(requests().at(-1)!.confirmationToken, "quote-1");
    assert.equal(dom.document.querySelector('[role="dialog"]'), null);
    if (surface === "bible") {
      // Over the buttons rather than a selector that would match nothing: linkedom spins on those.
      const labels = [...container.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
      assert.ok(labels.includes("Preparing The tides") && !labels.includes("Read The tides aloud"), `confirmed, the speaker is busy until something lands: ${labels.join(", ")}`);
    }
    await act(async () => __applyEventForTest({ ...quote(), confirmationToken: "quote-2", estimatedMicroUsd: 50000 }));
    assert.match(dom.document.querySelector('[role="dialog"]')!.textContent!, /\$0.05/, "a revised quote needs a new decision");
  });
}

/*
 * A cloned narrator's recording is asked about before the price (issue 1215), on every surface
 * that reads a single block, the way the voiced page asks for a cloned speaker: the vendor's
 * question is its own dialog, Not now sends nothing, Send recording re-asks the same read with
 * the vendor's token, and the price that follows says the recording goes and carries the token
 * on its Confirm.
 */
for (const surface of ["sheet", "prose", "button", "bible"] as const) {
  it(`${surface} read asks the vendor's question before the price for a cloned narrator, and carries the answer`, async () => {
    const sent: ClientMessage[] = [];
    __setBridgeForTest({ appVersion: "test", platform: "test", connect() {}, subscribe() {}, send(json: string) { sent.push(JSON.parse(json)); } } as ArkeBridge);
    const world = FIXTURE_STATE.world!;
    __setStateForTest({
      ...FIXTURE_STATE,
      app: { ...FIXTURE_STATE.app, narrator: { provider: "mistral", model: "voxtral-mini-tts", voiceId: "harbour-glass", label: "Harbour glass" } },
      ...(surface === "bible" ? { world: { ...world, bible: { version: 3, updated: "2026-07-30", present: true, text: "## The tides\n\nThe tide is the world's clock <br> and its accountant.\n" } } } : {}),
    });
    const container = dom.document.createElement("div") as unknown as HTMLElement;
    dom.document.body.append(container);
    const root = createRoot(container); open.push(root);
    const props = { source: { of: "shot", productionId: "saltlight", sceneId: "sc_04", shotId: "sh_12" } as const, title: "Shot script", text: "The sea moves." };
    await act(async () => root.render(surface === "sheet"
      ? <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/cast/maren-kest`]}><App /></MemoryRouter>
      : surface === "bible" ? <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/bible`]}><App /></MemoryRouter>
      : surface === "prose" ? <ReadAloud {...props} /> : <ReadAloudButton {...props} />));
    const trigger = () => container.querySelector<HTMLButtonElement>(surface === "button" ? 'button[title="Read aloud"]' : surface === "bible" ? 'button[aria-label="Read The tides aloud"]' : 'button[aria-label="Read aloud"]')!;
    const requests = () => sent.filter((message): message is Extract<ClientMessage, { kind: "read-sheet-section" | "read-prose" | "read-bible-section" }> => message.kind === "read-sheet-section" || message.kind === "read-prose" || message.kind === "read-bible-section");
    const command = surface === "sheet" ? "read-sheet-section" as const : surface === "bible" ? "read-bible-section" as const : "read-prose" as const;
    const question = (requestId: string) => ({
      type: "voice.upload-confirmation-required" as const, at: "2026-09-18T08:00:00.000Z", requestId, worldId: FIXTURE_WORLD_ID, command,
      destinationLabel: "Mistral · Harbour glass", confirmationToken: "vendor:mistral:harbour-glass", destinationNotice: "The recording is sent with each read and not kept by Arke on the service.",
    });
    const asks = () => dom.document.querySelector('[data-testid="remote-voice-upload-confirmation"]');

    await act(async () => trigger().click());
    let asked = requests().at(-1)!;
    assert.equal(asked.voiceUploadConfirmedFor, undefined, "a fresh read carries no answer");
    await act(async () => __applyEventForTest(question(asked.requestId)));
    assert.ok(asks(), "the vendor's question is asked before any price");
    assert.match(asks()!.textContent!, /Send this voice recording\?/);
    assert.match(asks()!.textContent!, /Mistral · Harbour glass/);
    assert.match(asks()!.textContent!, /not kept by Arke/, "with what the vendor does with the clip");
    await act(async () => [...asks()!.querySelectorAll("button")].find((button) => button.textContent === "Not now")!.click());
    assert.equal(asks(), null);
    assert.equal(requests().length, 1, "Not now sends nothing");

    await act(async () => trigger().click());
    asked = requests().at(-1)!;
    await act(async () => __applyEventForTest(question(asked.requestId)));
    await act(async () => [...asks()!.querySelectorAll("button")].find((button) => button.textContent === "Send recording")!.click());
    assert.equal(asks(), null);
    assert.equal(requests().length, 3, "Send recording re-asks the same read");
    assert.equal(requests().at(-1)!.requestId, asked.requestId);
    assert.equal(requests().at(-1)!.voiceUploadConfirmedFor, "vendor:mistral:harbour-glass", "with the vendor's token");
    assert.equal(requests().at(-1)!.confirmationToken, undefined, "and no price answered yet");

    // The price follows, saying the recording goes with the words.
    await act(async () => __applyEventForTest({
      type: "voice.audio" as const, at: "2026-09-18T08:00:00.000Z", requestId: asked.requestId, worldId: FIXTURE_WORLD_ID, sheetVersion: 4,
      purpose: surface === "sheet" ? "sheet-section" as const : surface === "bible" ? "bible-section" as const : "prose" as const,
      ...(surface === "bible" ? { sectionHeading: "The tides" } : {}),
      provider: "mistral" as const, model: "voxtral-mini-tts", voiceId: "harbour-glass", format: "wav" as const,
      status: "confirmation-required" as const, file: null, cached: false, characterCount: 1487, estimatedMicroUsd: 23792, confirmationToken: "quote-1", voiceReference: true,
    }));
    const dialog = dom.document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    assert.match(dialog.textContent!, /This text and the voice recording will be sent to Voxtral/);
    await act(async () => [...dialog.querySelectorAll("button")].find((button) => button.textContent!.startsWith("Confirm"))!.click());
    assert.equal(requests().length, 4);
    assert.equal(requests().at(-1)!.confirmationToken, "quote-1");
    assert.equal(requests().at(-1)!.voiceUploadConfirmedFor, "vendor:mistral:harbour-glass", "the answer rides on the price's frame too");
  });
}

it("the confirmation says what a first read through a slot-keeping reader adds, on the read that incurs it (SPEC-046 R-14)", async () => {
  __setStateForTest(FIXTURE_STATE);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container); open.push(root);
  await act(async () => root.render(<ReadAloudConfirmation title="Appearance" result={{
    type: "voice.audio", at: "2026-09-18T08:00:00.000Z", requestId: FIXTURE_WORLD_ID, worldId: FIXTURE_WORLD_ID,
    sheetVersion: 1, purpose: "prose", provider: "breezeblue", model: "breeze-tts-2", voiceId: "harbour-glass", format: "wav",
    status: "confirmation-required", file: null, cached: false, characterCount: 20, estimatedMicroUsd: 800, confirmationToken: "q",
    voiceReference: true, notices: ["first read · clone charge, priced by BreezeBlue"],
  }} onCancel={() => {}} onConfirm={() => {}} />));
  const dialog = dom.document.querySelector('[role="dialog"]')!;
  assert.match(dialog.textContent!, /This text and the voice recording will be sent to Breeze/);
  assert.equal(dialog.querySelector('[data-testid="read-aloud-notice"]')?.textContent, "first read · clone charge, priced by BreezeBlue");
});

for (const [provider, model, expected, local] of [["kokoro", "kokoro-82m", "Kokoro", true], ["elevenlabs", "eleven_multilingual_v2", "ElevenLabs", false]] as const) {
it(`${expected} confirmation identifies its destination accurately`, async () => {
  __setStateForTest(FIXTURE_STATE);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container); open.push(root);
  await act(async () => root.render(<ReadAloudConfirmation title="Appearance" result={{
    type: "voice.audio", at: "2026-09-16T08:00:00.000Z", requestId: FIXTURE_WORLD_ID, worldId: FIXTURE_WORLD_ID,
    sheetVersion: 1, purpose: "prose", provider, model, voiceId: "bf_emma", format: "wav",
    status: "confirmation-required", file: null, cached: false, characterCount: 20, estimatedMicroUsd: 0, confirmationToken: "local",
  }} onCancel={() => {}} onConfirm={() => {}} />));
  const dialog = dom.document.querySelector('[role="dialog"]')!;
  assert.ok(dialog.textContent!.includes(local ? `Read locally with ${expected}` : `sent to ${expected}`));
  if (local) assert.doesNotMatch(dialog.textContent!, /sent to|ElevenLabs/);
});

}
