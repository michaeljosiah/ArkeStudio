import { THREE_TITLES, blur, focus, installDom, key, mountCut, settle, stateWith, type, wordsField } from "./cut-text-fixture.js";
import assert from "node:assert/strict";
import { afterEach, it } from "node:test";
import { textPictureFrame, textPicturePath, type TextDraftCommand } from "@arke-studio/contracts";
import { EditorPicturePreview } from "../src/screens/editor-picture-preview.js";

/**
 * The Cut hands a title's draft to the Viewer (SPEC-065 R-32; turn 277 rules 5 and 13). The hook
 * and the helper that choose what to draw are tested on their own; these hold the wiring between
 * them and the picture the person looks at: the plan the Viewer is given names the drafted picture,
 * the Viewer's picture source answers that name with the painted blob, Words in focus drops the
 * title's fades, a commit keeps the draft up until its revision lands, and a draft given up goes
 * back to the stored picture on the media route.
 */

installDom(1024);
afterEach(() => { document.body.replaceChildren(); });

type ViewerProps = Parameters<typeof EditorPicturePreview>[0];

/** What the compositor is handed: its projection and its picture source, read off the mounted component. */
function viewer(container: Element): ViewerProps {
  const canvas = container.querySelector(".fy-effectpreview__picture");
  assert.ok(canvas, "a title is drawn by the compositor");
  const key = Object.keys(canvas).find(name => name.startsWith("__reactFiber$"));
  assert.ok(key, "a React element");
  let fiber: object | null = Reflect.get(canvas, key);
  while (fiber !== null && Reflect.get(fiber, "type") !== EditorPicturePreview) fiber = Reflect.get(fiber, "return");
  assert.ok(fiber, "the Viewer's compositor");
  return Reflect.get(fiber, "memoizedProps");
}
function titleLayer(container: Element, clipId = "cl_one") {
  const layer = viewer(container).projection.pictureLayers.find(row => row.clipId === clipId);
  assert.ok(layer?.path, `${clipId} is drawn`);
  return { ...layer, path: layer.path, url: viewer(container).urlFor(layer.path) };
}
const paints = (sent: readonly TextDraftCommand[], text: string) => sent.filter(message => message.ask.kind === "paint" && message.ask.item.text === text);

it("typed words reach the Viewer as the drafted picture, held as a blob, with no fades while Words has focus", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    const stored = titleLayer(screen.container);
    assert.ok(stored.fadeIn, "a title drawn as it plays fades in");
    assert.doesNotMatch(stored.url ?? "", /^blob:/, "a stored title comes off the media route");
    await screen.click(screen.chip("cl_one"));
    const words = wordsField(screen.inspector());
    await focus(words);
    // Rule 5: at its first frame a fading title would be drawn faint; while Words has focus it is not.
    assert.equal(titleLayer(screen.container).fadeIn, undefined, "the fade is dropped while Words has focus");
    assert.equal(titleLayer(screen.container).path, stored.path, "still the stored words");
    await type(words, "Harbour lights at dusk");
    await settle(160);
    const [paint] = paints(screen.drafts(), "Harbour lights at dusk");
    assert.ok(paint?.ask.kind === "paint", "the draft was painted");
    const drafted = titleLayer(screen.container);
    const expected = textPicturePath({ text: "Harbour lights at dusk", look: paint.ask.item.look }, textPictureFrame(paint.frame, false));
    assert.ok(expected.ok);
    assert.equal(drafted.path, expected.path, "the plan the Viewer is given names the drafted picture");
    assert.match(drafted.url ?? "", /^blob:/, "and its picture source answers that name with the painted blob");
    assert.equal(drafted.fadeIn, undefined);
    assert.deepEqual(screen.timelineCommands(), [], "nothing is written");
    // Committed: the draft stays up until the snapshot carries the revision, so nothing flashes back.
    await blur(words);
    const [batch] = screen.timelineCommands();
    assert.deepEqual(batch?.commands, [{ kind: "text-set", clipIds: ["cl_one"], text: "Harbour lights at dusk" }]);
    assert.equal(titleLayer(screen.container).path, expected.path, "held while the revision is on its way");
    assert.match(titleLayer(screen.container).url ?? "", /^blob:/);
    await screen.apply(batch!.commands);
    const saved = titleLayer(screen.container);
    assert.equal(saved.path, expected.path, "the record now names those words");
    assert.doesNotMatch(saved.url ?? "", /^blob:/, "and the media route serves them");
    assert.ok(saved.fadeIn, "with the fade back, Words having been left");
  } finally { await screen.close(); }
});

it("a draft given up, or refused, puts the stored picture back in the Viewer", async () => {
  const screen = await mountCut(stateWith(THREE_TITLES));
  try {
    const stored = titleLayer(screen.container);
    screen.respond(ask => ask.kind === "paint" && ask.item.text.includes("ẹ")
      ? { kind: "drawn", results: [{ ok: false, reason: "Geist has no ẹ", field: "words" }] }
      : ask.kind === "paint"
        ? { kind: "drawn", results: [{ ok: true, drawnSize: ask.item.look.size }], picture: { name: "0".repeat(64), png: "iVBORw0KGgo=" } }
        : { kind: "drawn", results: ask.items.map(item => ({ ok: true as const, drawnSize: item.look.size })) });
    await screen.click(screen.chip("cl_one"));
    const words = wordsField(screen.inspector());
    await focus(words);
    await type(words, "Harbour lights at dusk");
    await settle(160);
    assert.match(titleLayer(screen.container).url ?? "", /^blob:/);
    // Refused (rule 13): the draft is withdrawn and the stored words are drawn again.
    await type(words, "Alẹ́ at dusk");
    await settle(160);
    assert.equal(paints(screen.drafts(), "Alẹ́ at dusk").length, 1);
    assert.equal(titleLayer(screen.container).path, stored.path, "the stored words");
    assert.equal(titleLayer(screen.container).url, stored.url, "off the media route");
    // Escape gives the words back, and the Viewer the stored picture.
    await type(words, "Harbour lights at night");
    await settle(160);
    assert.match(titleLayer(screen.container).url ?? "", /^blob:/);
    await key(words, "Escape");
    assert.equal(titleLayer(screen.container).path, stored.path);
    assert.equal(titleLayer(screen.container).url, stored.url);
  } finally { await screen.close(); }
});
