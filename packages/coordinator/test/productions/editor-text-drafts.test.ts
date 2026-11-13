import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  PRESETS, ProductionTimelineSchema, TEXT_TYPEFACES, TEXT_TYPEFACE_IDS, TextDraftCommandSchema, applyTimelineCommands, layoutText, textLabel, textPicturePath,
  type TextDraftAnswer, type TextDraftCommand, type TextLook, type TextTypefaceBytes, type TimelineClip,
} from "@arke-studio/contracts";
import { loadTextFace } from "../../src/media/text-typefaces.js";
import { refuseUnpaintableText } from "../../src/productions/editor-text-cache.js";
import { TextDrafts } from "../../src/productions/editor-text-drafts.js";
import { measureTextPicture, paintTextDraft, paintTextPicture, textPicturePng, textPictureRefusal } from "../../src/productions/editor-text-pictures.js";
import { decodePng } from "../../src/references/png.js";
import { tempDir } from "../tmp.js";

// A title drawn while it is typed (SPEC-065 R-32, §2.3): the painter's own picture and the
// painter's own refusal, with the control it belongs under, answered to the window that asked and
// kept nowhere. Bounded so a window typing fast never makes the coordinator paint more than its
// latest words, and never draws for a window that has gone.

const LOOK: TextLook = { typeface: "geist", weight: "regular", italic: false, size: 0.08, tracking: 0, leading: 1.2, capitals: false,
  align: "center", x: 0.5, y: 0.5, room: 0.9, fill: { kind: "solid", color: "#ffffff" }, shadow: { color: "#000000", opacity: 0.8, blur: 0.3, dx: 0, dy: 0 } };
const FRAME = { width: PRESETS["review-cut"].width, height: PRESETS["review-cut"].height };
const JOST: TextLook = { ...LOOK, typeface: "jost" };
let asked = 0;
const requestId = () => `12345678-1234-4234-8234-${String(++asked).padStart(12, "0")}`;
const paint = (text: string, look: TextLook = LOOK, frame = FRAME): TextDraftCommand =>
  TextDraftCommandSchema.parse({ kind: "text-draft", requestId: requestId(), frame, ask: { kind: "paint", item: { text, look } } });
const measure = (items: { text: string; look: TextLook }[], frame = FRAME): TextDraftCommand =>
  TextDraftCommandSchema.parse({ kind: "text-draft", requestId: requestId(), frame, ask: { kind: "measure", items } });

/** A window as the transport hands it over: its lifetime, and the answers it was sent, in order. */
function window() {
  const lifetime = new AbortController(), answers: { requestId: string; answer: TextDraftAnswer }[] = [], faces: TextTypefaceBytes[][] = [];
  const requester = {
    signal: lifetime.signal,
    textDraft: (id: string, answer: TextDraftAnswer) => { answers.push({ requestId: id, answer }); return true; },
    textTypefaces: (_id: string, sent: TextTypefaceBytes[]) => { faces.push(sent); return true; },
  };
  /** Waits for `count` answers, then a little longer, so an answer that should not come has had its chance. */
  const settled = async (count: number) => {
    for (let turns = 0; turns < 2_000 && answers.length < count; turns++) await new Promise(resolve => setImmediate(resolve));
    for (let turns = 0; turns < 20; turns++) await new Promise(resolve => setImmediate(resolve));
    return answers;
  };
  return { lifetime, requester, answers, faces, settled };
}
type Drawn = Extract<TextDraftAnswer, { kind: "drawn" }>;
const drawn = (answer: TextDraftAnswer | undefined): Drawn => {
  assert.equal(answer?.kind, "drawn");
  return answer as Drawn;
};

const fonts = fileURLToPath(new URL("../../src/publications/fonts/", import.meta.url));
/** `dist/main.cjs` with `dist/fonts` beside it, as the packaged app is laid out, holding `files` — or no fonts at all. */
async function bundle(files: Record<string, Uint8Array> = {}): Promise<string> {
  const dist = join(await tempDir("arke-text-draft-"), "dist");
  if (Object.keys(files).length) {
    await mkdir(join(dist, "fonts"), { recursive: true });
    for (const [file, bytes] of Object.entries(files)) await writeFile(join(dist, "fonts", file), bytes);
  }
  return pathToFileURL(join(dist, "main.cjs")).href;
}
const regular = (id: (typeof TEXT_TYPEFACE_IDS)[number]) => TEXT_TYPEFACES[id].files.regular;
const shipped = (file: string) => readFileSync(join(fonts, file));
const altered = (bytes: Uint8Array) => { const copy = Uint8Array.from(bytes); copy[copy.length - 1] = copy[copy.length - 1]! ^ 1; return copy; };

it("a draft paints the picture the painter paints, under the name a record would keep it by", async () => {
  const drafts = new TextDrafts(), one = window(), words = "Harbour lights\nAdé";
  drafts.ask(paint(words), one.requester);
  const [answered] = await one.settled(1), answer = drawn(answered?.answer);
  assert.equal(one.answers.length, 1);
  const kept = paintTextPicture({ text: words, look: LOOK, ...FRAME });
  assert.ok(kept.ok);
  assert.deepEqual(answer.results, [{ ok: true, drawnSize: kept.drawnSize }]);
  // The name the plan would give these words at this frame, so the Viewer can put the draft where the picture goes.
  const ref = textPicturePath({ text: words, look: LOOK }, FRAME);
  assert.ok(ref.ok);
  assert.equal(answer.picture?.name, ref.name);
  assert.equal(answer.picture.name, kept.name);
  const decoded = decodePng(Buffer.from(answer.picture.png, "base64"));
  assert.deepEqual([decoded.width, decoded.height], [FRAME.width, FRAME.height]);
  assert.ok(Buffer.from(decoded.pixels).equals(Buffer.from(kept.rgba)), "the same pixels a commit would keep");
});

it("a draft's PNG at level 3 decodes to the painter's pixels", () => {
  for (const frame of [FRAME, PRESETS.master, PRESETS["vertical-master"]]) {
    const picture = paintTextDraft({ text: "The Lady\nin White", look: { ...JOST, capitals: true, tracking: 0.2, edge: { color: "#1a1208", width: 0.022 } }, width: frame.width, height: frame.height });
    assert.ok(picture.ok);
    const fast = textPicturePng(picture, { level: 3 }), kept = textPicturePng(picture);
    for (const png of [fast, kept]) assert.ok(Buffer.from(decodePng(png).pixels).equals(Buffer.from(picture.rgba)), `${frame.width}x${frame.height}`);
  }
});

it("a draft reports the drawn size Fit chose", async () => {
  const drafts = new TextDrafts(), one = window();
  const narrow: TextLook = { ...LOOK, size: 0.2, room: 0.3 }, words = "A title far too wide for its room";
  drafts.ask(paint(words, narrow), one.requester);
  drafts.ask(measure([{ text: words, look: narrow }, { text: "Ade", look: narrow }]), one.requester);
  const answers = await one.settled(2);
  const face = loadTextFace("geist", "regular", false);
  assert.ok(face.ok);
  const laid = layoutText(words, narrow, FRAME, face.face);
  assert.ok(laid.ok && laid.layout.drawnSize < narrow.size, "Fit drew it smaller");
  const painted = drawn(answers[0]?.answer), measured = drawn(answers[1]?.answer);
  assert.deepEqual(painted.results, [{ ok: true, drawnSize: laid.layout.drawnSize }]);
  assert.deepEqual(measured.results, [{ ok: true, drawnSize: laid.layout.drawnSize }, { ok: true, drawnSize: 0.2 }], "and leaves a size that fits alone");
  assert.equal(measured.picture, undefined);
});

it("a draft the painter refuses answers in its words, with the field: \"Jost has no ẹ\", words", async () => {
  const drafts = new TextDrafts(), one = window();
  drafts.ask(paint("Ifẹ", JOST), one.requester);
  drafts.ask(measure([{ text: "Ifẹ", look: { ...JOST, capitals: true } }]), one.requester);
  const answers = await one.settled(2);
  assert.deepEqual(answers.map(({ answer }) => answer), [
    { kind: "drawn", results: [{ ok: false, reason: "Jost has no ẹ", field: "words" }] },
    // Capitals is a display style, so the letter refused is the one that would be drawn.
    { kind: "drawn", results: [{ ok: false, reason: "Jost has no Ẹ", field: "words" }] },
  ]);
  // A mark the face has and cannot place is the words' to fix too; a weight or slant the face lacks is the typeface's.
  const fields = (text: string, look: TextLook) => { const measured = measureTextPicture({ text, look, ...FRAME }); return measured.ok ? null : [measured.reason, measured.field]; };
  assert.deepEqual(fields("a̧", { ...LOOK, typeface: "cinzel" }), ["Cinzel cannot draw a̧", "words"]);
  assert.deepEqual(fields("Ade", { ...LOOK, italic: true }), ["Geist has no italic", "typeface"]);
  assert.deepEqual(fields("Ade", { ...LOOK, typeface: "bangers", weight: "bold" }), ["Bangers has no bold", "typeface"]);
  assert.deepEqual(fields(" \n ", LOOK), ["Type some words", "words"]);
  assert.deepEqual(fields("a".repeat(501), LOOK), ["Text holds at most 500 characters", "words"]);
  assert.deepEqual(fields("Ade", { ...LOOK, size: 5 }), ["A text look's size is out of range", "look"]);
  assert.deepEqual(fields("Ade", { ...LOOK, stray: 1 } as TextLook), ["A text look has no stray", "look"]);
  assert.equal(fields("Ifẹ", { ...LOOK, typeface: "eb-garamond" }), null, "the one face that draws it");
});

it("a missing or wrong typeface file refuses under typeface", async () => {
  const { file } = regular("geist");
  for (const [from, reason] of [[await bundle(), `${file} is missing`], [await bundle({ [file]: altered(shipped(file)) }), `${file} is not the file this app shipped with`]] as const) {
    const drafts = new TextDrafts({ from }), one = window();
    drafts.ask(paint("Ade"), one.requester);
    drafts.ask(measure([{ text: "Ade", look: LOOK }]), one.requester);
    const answers = await one.settled(2);
    for (const { answer } of answers) assert.deepEqual(answer, { kind: "drawn", results: [{ ok: false, reason, field: "typeface" }] }, reason);
  }
});

it("the draft's refusal is the command's refusal, character for character", async () => {
  const none = await bundle();
  const timeline = (look: TextLook, text: string) => ProductionTimelineSchema.parse({ schemaVersion: 1, revision: 0, frameRate: 24, history: { undo: [], redo: [] }, tracks: [
    { id: "tr_names", kind: "picture", name: "Names", order: 0, muted: false, clips: [
      { id: "cl_ade", startFrame: 0, durationFrames: 48, sourceInFrames: 0, source: { kind: "text", label: textLabel(text), text, look } } satisfies TimelineClip] }] });
  const cases: [what: string, text: string, look: TextLook, from?: string][] = [
    ["a letter the face lacks", "Ifẹ", JOST],
    ["in capitals", "Ifẹ", { ...JOST, capitals: true }],
    ["a mark it cannot place", "a̧", { ...LOOK, typeface: "cinzel" }],
    ["a slant it lacks", "Ade", { ...LOOK, italic: true }],
    ["a weight it lacks", "Ade", { ...LOOK, typeface: "bangers", weight: "bold" }],
    ["a file gone", "Ade", LOOK, none],
  ];
  for (const [what, text, look, from] of cases) {
    const held = timeline(LOOK, "Held");
    const next = applyTimelineCommands(held, [{ kind: "text-set", clipIds: ["cl_ade"], text, look }], { effectAuthority: "human" });
    let command = "";
    try { refuseUnpaintableText(held, next, FRAME, from); } catch (error) { command = error instanceof Error ? error.message : String(error); }
    assert.notEqual(command, "", `${what}: the command refuses`);
    const drafts = new TextDrafts(from === undefined ? {} : { from }), one = window();
    drafts.ask(paint(text, look), one.requester);
    const [answered] = await one.settled(1), result = drawn(answered?.answer).results[0];
    assert.ok(result && !result.ok);
    assert.equal(result.reason, command, what);
    assert.equal(textPictureRefusal({ text, look, ...FRAME }, from), command, `${what}: and the export's`);
  }
});

it("three asks at once paint at most two; the replaced one is answered superseded", async () => {
  const drafts = new TextDrafts(), one = window(), asks = [paint("A"), paint("Ad"), paint("Ade")];
  for (const ask of asks) drafts.ask(ask, one.requester);
  const answers = await one.settled(3);
  assert.equal(answers.length, 3, "every ask is answered once");
  const pictures = answers.filter(({ answer }) => answer.kind === "drawn");
  assert.ok(pictures.length <= 2, "at most two are painted");
  assert.deepEqual(pictures.map(({ requestId }) => requestId).at(-1), asks[2]!.requestId, "and the last words always are");
  for (const { requestId, answer } of answers) if (answer.kind === "superseded") assert.ok(asks.slice(0, 2).some(ask => ask.requestId === requestId));
  // A paint never displaces the window's measure, nor a measure its paint: a typeface checked while the words draw is still answered.
  const two = window(), check = measure([{ text: "Ade", look: JOST }]), typing = paint("Ad");
  drafts.ask(check, two.requester);
  drafts.ask(typing, two.requester);
  drafts.ask(paint("Ade"), two.requester);
  const second = await two.settled(3);
  assert.deepEqual(second.map(({ requestId, answer }) => [requestId, answer.kind]),
    [[typing.requestId, "superseded"], [check.requestId, "drawn"], [second[2]!.requestId, "drawn"]]);
  const ref = textPicturePath({ text: "Ade", look: LOOK }, FRAME);
  assert.ok(ref.ok);
  assert.equal(drawn(second[2]!.answer).picture?.name, ref.name);
});

it("windows take turns, one draft at a time", async () => {
  const drafts = new TextDrafts(), one = window(), two = window(), order: string[] = [];
  const watch = (name: string, target: ReturnType<typeof window>) => {
    const send = target.requester.textDraft;
    target.requester.textDraft = (id, answer) => { order.push(name); return send(id, answer); };
  };
  watch("one", one); watch("two", two);
  drafts.ask(paint("Ade"), one.requester);
  drafts.ask(measure([{ text: "Ade", look: LOOK }]), one.requester);
  drafts.ask(paint("Ife"), two.requester);
  await one.settled(2); await two.settled(1);
  assert.deepEqual(order, ["one", "two", "one"], "the second window is not kept waiting behind the first one's queue");
});

it("an ask from a closed socket is never painted", async () => {
  const drafts = new TextDrafts(), gone = window(), closing = window();
  gone.lifetime.abort();
  drafts.ask(paint("Ade"), gone.requester);
  // Closed after asking and before its turn: the waiting ask is dropped, not drawn.
  drafts.ask(paint("Ife"), closing.requester);
  closing.lifetime.abort();
  assert.deepEqual(await gone.settled(1), []);
  assert.deepEqual(await closing.settled(1), []);
  // A stopped coordinator answers nobody, and takes no more.
  const stopped = new TextDrafts(), last = window();
  stopped.ask(paint("Ade"), last.requester);
  stopped.stop();
  stopped.ask(paint("Ife"), last.requester);
  stopped.typefaces({ kind: "text-typefaces", requestId: requestId() }, last.requester);
  assert.deepEqual(await last.settled(1), []);
  assert.deepEqual(last.faces, []);
});

it("a measure of fifty items paints nothing", async () => {
  const drafts = new TextDrafts(), one = window();
  const items = Array.from({ length: 50 }, (_, index) => ({ text: index === 17 ? "Oṣun" : `Name ${index}`, look: index === 31 ? { ...LOOK, italic: true } : LOOK }));
  drafts.ask(measure(items), one.requester);
  const [answered] = await one.settled(1), answer = drawn(answered?.answer);
  assert.equal(answer.picture, undefined);
  assert.equal(answer.results.length, 50);
  // Each in the order asked, the two that cannot be drawn by their own reasons and the rest by the size they draw at.
  assert.deepEqual(answer.results[17], { ok: false, reason: "Geist has no ṣ", field: "words" });
  assert.deepEqual(answer.results[31], { ok: false, reason: "Geist has no italic", field: "typeface" });
  assert.equal(answer.results.filter(result => result.ok).length, 48);
});

it("the typefaces answer carries each face's Regular file, and leaves out one whose hash fails", async () => {
  const drafts = new TextDrafts(), one = window();
  drafts.typefaces({ kind: "text-typefaces", requestId: requestId() }, one.requester);
  assert.equal(one.faces.length, 1, "answered at once, with nothing painted");
  assert.deepEqual(one.faces[0]!.map(face => face.id), [...TEXT_TYPEFACE_IDS]);
  for (const face of one.faces[0]!) {
    const bytes = Buffer.from(face.data, "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), regular(face.id).sha256, face.id);
  }
  // The same files read once: a second window is sent what the first was.
  const two = window();
  drafts.typefaces({ kind: "text-typefaces", requestId: requestId() }, two.requester);
  assert.equal(two.faces[0], one.faces[0]);

  // A bundle whose Geist is one byte off, beside the other five as shipped.
  const files = Object.fromEntries(TEXT_TYPEFACE_IDS.map(id => [regular(id).file, id === "geist" ? altered(shipped(regular(id).file)) : shipped(regular(id).file)]));
  const packaged = new TextDrafts({ from: await bundle(files) }), three = window();
  packaged.typefaces({ kind: "text-typefaces", requestId: requestId() }, three.requester);
  assert.deepEqual(three.faces[0]!.map(face => face.id), TEXT_TYPEFACE_IDS.filter(id => id !== "geist"));
});
