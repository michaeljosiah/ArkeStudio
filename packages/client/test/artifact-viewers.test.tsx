import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ArtifactSidecar, ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { artifactIsServable, artifactOpenLabel, artifactViewer } from "../src/lib/artifact-view.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Opening an artifact (issue 477).
 *
 * The shelf could count files and drag them into a cut. Clicking one did nothing at all: the card
 * was a `<div>` with no handler, videos wore the generic document lines, and a markdown artifact
 * exposed neither its contents nor a way to read them. These assertions are about the three parts
 * that make an "open" real — every card is a keyboard-reachable target, the viewer that opens is
 * chosen by what the file actually is, and every branch that can fail says so instead of drawing
 * an empty frame.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout and no frame loop; the app-wide toaster asks for both before it draws.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => readFileSync(join(here, "../src", file), "utf8");
const VIEWER = source("components/artifact-viewer.tsx");
const CSS = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");
const W = `/w/${FIXTURE_WORLD_ID}`;

function artifact(over: Partial<ArtifactSidecar>): ArtifactSidecar {
  return {
    id: "ar_01J8G0000000000000000000X1",
    kind: "document",
    file: "notes.txt",
    hash: "sha256:6a1e02b9c44d7f31",
    origin: { by: "user" },
    links: [],
    created: "2026-08-01T10:00:00Z",
    ...over,
  } as ArtifactSidecar;
}

const PICTURE = artifact({ id: "ar_01J8G0000000000000000000I1", kind: "image", file: "key-art.png", links: ["the-vigil"] });
const BOARD = artifact({ id: "ar_01J8G0000000000000000000B1", kind: "board", file: "board-v2.png" });
const CLIP = artifact({
  id: "ar_01J8G0000000000000000000V1",
  kind: "video",
  file: "vigil.mp4",
  mediaInfo: { durationSec: 12, hasAudio: true },
});
const BELLS = artifact({ id: "ar_01J8G0000000000000000000A1", kind: "audio", file: "harbour-bells.wav" });
const TREATMENT = artifact({ id: "ar_01J8G0000000000000000000M1", file: "treatment.md" });
const NOTES = artifact({ id: "ar_01J8G0000000000000000000T1", file: "notes.txt" });
const BIBLE = artifact({ id: "ar_01J8G0000000000000000000P1", file: "series-bible.pdf" });
const PROJECT = artifact({ id: "ar_01J8G0000000000000000000O1", kind: "other", file: "session.psd" });

const SHELF = [PICTURE, BOARD, CLIP, BELLS, TREATMENT, NOTES, BIBLE, PROJECT];

function shelf(artifacts: readonly ArtifactSidecar[]): ClientState {
  const world = FIXTURE_STATE.world!;
  return { ...FIXTURE_STATE, world: { ...world, artifacts: [...artifacts] } };
}

function renderShelf(artifacts: readonly ArtifactSidecar[] = SHELF): string {
  __setStateForTest(shelf(artifacts));
  return renderToString(
    <MemoryRouter initialEntries={[`${W}/artifacts`]}>
      <App />
    </MemoryRouter>,
  );
}

interface Mounted {
  container: HTMLElement;
  root: Root;
}

async function mountShelf(artifacts: readonly ArtifactSidecar[] = SHELF): Promise<Mounted> {
  __setStateForTest(shelf(artifacts));
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`${W}/artifacts`]}>
        <App />
      </MemoryRouter>,
    );
  });
  return { container, root } as unknown as Mounted;
}

async function unmount(mounted: Mounted): Promise<void> {
  await act(async () => mounted.root.unmount());
  mounted.container.remove();
  dom.document.body.replaceChildren();
  __setStateForTest(FIXTURE_STATE);
}

/** Press the card's open control, the way a pointer or a keyboard would. */
async function open(mounted: Mounted, subject: ArtifactSidecar): Promise<void> {
  const button = mounted.container.querySelector<HTMLButtonElement>(
    `button.fy-gridcard__open[aria-label="${artifactOpenLabel(subject)}"]`,
  );
  assert.ok(button, `no open control for ${subject.file}`);
  await act(async () => button.click());
}

/** The open frame, or nothing. */
function panel(mounted: Mounted): HTMLElement | null {
  return mounted.container.querySelector(".fy-artview__panel");
}

/** Stand in for the media route while a text viewer reads. */
async function withFetch<T>(reply: () => Promise<unknown>, body: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  Object.assign(globalThis, { fetch: reply });
  try {
    return await body();
  } finally {
    Object.assign(globalThis, { fetch: original });
  }
}

const textReply = (text: string) => async () => ({ ok: true, status: 200, text: async () => text });

describe("choosing a viewer", () => {
  it("goes by what the file is, not by what the sidecar calls it", () => {
    // A board holding a PNG is a picture; a `document` holding a PDF is a PDF. `kind` is a
    // declaration made at filing time, and it disagrees with the bytes often enough to matter.
    assert.equal(artifactViewer(BOARD), "image");
    assert.equal(artifactViewer(BIBLE), "pdf");
    assert.equal(artifactViewer(TREATMENT), "markdown");
    assert.equal(artifactViewer(artifact({ kind: "image", file: "mislabelled.mp4" })), "video");
    assert.equal(artifactViewer(artifact({ kind: "other", file: "field-recording.wav" })), "audio");
  });

  it("answers `details` for a file nothing renders, and will not offer to save it either", () => {
    // The viewer set and the servable set are the same set: a file with no viewer is a file the
    // media route refuses, so a save control on it would fail after the click rather than before.
    assert.equal(artifactViewer(PROJECT), "details");
    assert.equal(artifactIsServable(PROJECT), false);
    assert.equal(artifactIsServable(CLIP), true);
  });

  it("names the file and the viewer in one accessible name", () => {
    assert.equal(artifactOpenLabel(PICTURE), "Open key-art.png — image");
    assert.equal(artifactOpenLabel(BELLS), "Open harbour-bells.wav — audio");
    assert.equal(artifactOpenLabel(PROJECT), "Open session.psd — details");
  });
});

describe("the card as an open target", () => {
  it("gives every visible card one, whatever kind it is", () => {
    const html = renderShelf();
    for (const subject of SHELF) {
      assert.ok(
        html.includes(`aria-label="${artifactOpenLabel(subject)}"`),
        `${subject.file} has no open control`,
      );
    }
  });

  it("is a real <button>, so Enter and Space come from the element rather than a handler", () => {
    const html = renderShelf([PICTURE]);
    const at = html.indexOf(`aria-label="${artifactOpenLabel(PICTURE)}"`);
    const tag = html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
    assert.match(tag, /type="button"/);
    assert.match(tag, /class="fy-gridcard__open"/);
  });

  it("is a sibling of the card's other controls, never a button wrapped around them", () => {
    // A button inside a button is markup the browser resolves by dropping one of the two, and the
    // one it drops is usually the one you wanted.
    const screen = source("screens/world.tsx");
    const at = screen.indexOf('className="fy-gridcard__open"');
    assert.ok(at > 0, "the open control is on the artifact card");
    const card = screen.slice(screen.lastIndexOf("<div", at), at);
    assert.ok(card.includes("fy-gridcard--openable"), "the card, not a wrapper, is the open target's host");
  });

  it("leaves Lift facts and the audio transport exactly where they were", async () => {
    const mounted = await mountShelf();
    assert.ok(
      [...mounted.container.querySelectorAll("button.fy-liftfacts")].length >= 3,
      "every document still offers extraction",
    );
    assert.ok(
      mounted.container.querySelector('button[aria-label="Play harbour-bells.wav"]'),
      "and the audio card still plays through the dock",
    );
    await unmount(mounted);
  });

  it("lifts those controls above the open target so a press on one is not a press on the card", () => {
    assert.match(CSS, /\.fy-gridcard__open \{[^}]*z-index: 1/s);
    assert.match(
      CSS,
      /\.fy-gridcard--openable \.fy-clipbtn,\s*\.fy-gridcard--openable \.fy-liftfacts \{[^}]*z-index: 2/s,
    );
    // The save control reveals on hovering its own host, which the open target now covers.
    assert.match(CSS, /\.fy-gridcard--openable:hover \.fy-imgdl/);
  });
});

describe("what opens", () => {
  it("shows a picture at size, named, over the confined media identity", async () => {
    const mounted = await mountShelf();
    assert.equal(panel(mounted), null, "nothing is open to begin with");
    await open(mounted, PICTURE);
    const frame = panel(mounted);
    assert.ok(frame, "the viewer opened");
    assert.equal(frame.querySelector("h2")?.textContent, "key-art.png");
    const image = frame.querySelector<HTMLImageElement>("img.fy-artview__image");
    assert.ok(image, "at a size, not as a thumbnail");
    assert.match(image.getAttribute("src") ?? "", /\/media\/the-undersong\/artifacts\/key-art\.png/);
    // A world-relative identity, never a filesystem path (SPEC-001 R-9).
    assert.ok(!(image.getAttribute("src") ?? "").includes("file:"));
    await unmount(mounted);
  });

  it("opens an image-backed board as the picture it is, not as document lines", async () => {
    const mounted = await mountShelf();
    await open(mounted, BOARD);
    assert.ok(panel(mounted)?.querySelector("img.fy-artview__image"), "a board is a picture");
    await unmount(mounted);
  });

  it("gives a video real controls over the range-capable route, and does not start it", async () => {
    const mounted = await mountShelf();
    await open(mounted, CLIP);
    const video = panel(mounted)?.querySelector<HTMLVideoElement>("video.fy-artview__media");
    assert.ok(video, "a <video>, never a thumbnail pointed at an .mp4");
    assert.ok(video.hasAttribute("controls"), "with its own transport and scrubber");
    assert.equal(video.getAttribute("preload"), "metadata");
    assert.equal(video.hasAttribute("autoplay"), false, "opening a viewer is not asking for sound");
    assert.match(video.getAttribute("src") ?? "", /\/media\/the-undersong\/artifacts\/vigil\.mp4/);
    // The head carries what the card's meta said, so the frame identifies its own subject.
    assert.match(panel(mounted)?.querySelector(".fy-artview__sub")?.textContent ?? "", /video · mp4 · 0:12/);
    await unmount(mounted);
  });

  it("gives audio play, pause, seek and volume for that one artifact", async () => {
    const mounted = await mountShelf();
    await open(mounted, BELLS);
    const audio = panel(mounted)?.querySelector<HTMLAudioElement>("audio.fy-artview__media");
    assert.ok(audio, "the artifact plays where it was opened, not only through the dock");
    assert.ok(audio.hasAttribute("controls"));
    assert.equal(audio.hasAttribute("autoplay"), false);
    assert.equal(audio.getAttribute("aria-label"), "harbour-bells.wav", "and says which file it is");
    await unmount(mounted);
  });

  it("embeds a PDF, and keeps the identity and a save around it", async () => {
    const mounted = await mountShelf();
    await open(mounted, BIBLE);
    const frame = panel(mounted);
    const embed = frame?.querySelector("object.fy-artview__pdf");
    assert.ok(embed, "the host's own PDF viewer, in the frame");
    assert.equal(embed.getAttribute("type"), "application/pdf");
    assert.match(embed.getAttribute("aria-label") ?? "", /series-bible\.pdf/);
    assert.match(
      embed.textContent ?? "",
      /Could not display this PDF/,
      "a fallback that says what is known — these children stand in for any failure, a refused load included",
    );
    /*
     * Neither `object-src` nor `frame-src` has a default of its own: both fall back to
     * `default-src 'self'`, which refuses a loopback embed and leaves an empty frame. Both are
     * needed, because an `<object>` holding a PDF is framing to Chromium — naming only
     * `object-src` left the load blocked under `frame-src` (issue 530).
     */
    const policy = /content="([^"]*)"/.exec(readFileSync(join(here, "../index.html"), "utf8"))?.[1] ?? "";
    for (const directive of ["object-src", "frame-src"]) {
      const allowed = new RegExp(`${directive} ([^;"]*)`).exec(policy)?.[1] ?? "";
      for (const origin of ["http://127.0.0.1:*", "http://localhost:*"]) {
        assert.ok(allowed.includes(origin), `${directive} must allow ${origin}`);
      }
    }
    assert.ok(
      frame?.querySelector('button[aria-label="Download series-bible.pdf"]'),
      "with a way out that does not depend on the embed working",
    );
    await unmount(mounted);
  });

  it("explains a file nothing renders instead of opening an empty frame", async () => {
    const mounted = await mountShelf();
    await open(mounted, PROJECT);
    const frame = panel(mounted);
    assert.match(frame?.textContent ?? "", /No viewer for psd/);
    assert.equal(frame?.querySelector(".fy-artview__save"), null, "and offers no save it cannot honour");
    assert.match(frame?.textContent ?? "", /session\.psd/, "the metadata is still the answer it has");
    await unmount(mounted);
  });
});

describe("text and markdown", () => {
  it("reads a .txt over the media route and keeps its whitespace", async () => {
    const document_ = ["  indented", "", "and a blank line above"].join("\n");
    const mounted = await mountShelf();
    await withFetch(textReply(document_), async () => {
      await open(mounted, NOTES);
      await act(async () => {});
    });
    const pre = panel(mounted)?.querySelector("pre.fy-artview__text");
    assert.ok(pre, "readable text, not three grey lines");
    assert.equal(pre.textContent, document_, "byte for byte, indentation included");
    assert.ok(panel(mounted)?.querySelector('button[aria-label="Copy notes.txt"]'), "with a copy");
    assert.ok(panel(mounted)?.querySelector('button[aria-label="Download notes.txt"]'), "and a save");
    await unmount(mounted);
  });

  it("names a read failure and offers another go, rather than an empty box", async () => {
    const mounted = await mountShelf();
    await withFetch(async () => ({ ok: false, status: 404 }), async () => {
      await open(mounted, NOTES);
      await act(async () => {});
    });
    const frame = panel(mounted);
    assert.match(frame?.textContent ?? "", /Could not read notes\.txt/);
    assert.ok(
      [...(frame?.querySelectorAll("button") ?? [])].some((b) => b.textContent?.trim() === "Try again"),
      "a failure a person can act on",
    );
    await unmount(mounted);
  });

  it("says so when bytes named .txt are not text at all", async () => {
    // Decided from what came back, never from the name — the whole point of measuring.
    const binary = `PK${String.fromCharCode(3)}${String.fromCharCode(0)}${"x".repeat(40)}`;
    const mounted = await mountShelf();
    await withFetch(textReply(binary), async () => {
      await open(mounted, NOTES);
      await act(async () => {});
    });
    assert.match(panel(mounted)?.textContent ?? "", /Not text/);
    await unmount(mounted);
  });

  it("goes to the markdown stage for a .md and reads it, rather than drawing document lines", async () => {
    /*
     * Stopped at the read, deliberately. The rich editor mounts into an effect against a real
     * browser — the bible's own tests assert around it for the same reason — so what is driven
     * here is the branch and the fetch, and the read-only wiring is pinned below.
     */
    const mounted = await mountShelf();
    await withFetch(async () => new Promise(() => {}), async () => {
      await open(mounted, TREATMENT);
      await act(async () => {});
    });
    const frame = panel(mounted);
    assert.equal(frame?.querySelector(".fy-artview__stage")?.getAttribute("data-viewer"), "markdown");
    assert.match(frame?.textContent ?? "", /Reading…/, "and it is reading the file, not guessing at it");
    assert.equal(frame?.querySelector(".fy-doclines"), null, "no generic document placeholder");
    await unmount(mounted);
  });

  it("opens a .md through the markdown editor, read-only and labelled", () => {
    // Artifacts are immutable: superseding one files new bytes as a new artifact carrying
    // `supersedes` (SPEC-015 R-5), and no such filing path exists from the shelf yet. An editor
    // that took keystrokes with nowhere to put them would be the worse half of this issue.
    assert.match(VIEWER, /<RichMarkdownEditor value=\{loaded\.text\} ariaLabel=\{name\} readOnly \/>/);
    assert.match(VIEWER, /read-only/);
    const editor = source("components/editor/rich-markdown-editor.tsx");
    assert.match(editor, /editable: !readOnly/, "the editor really refuses the keystrokes");
    assert.match(editor, /if \(readOnlyRef\.current\) return;/, "and never calls back with bytes to file");
    assert.ok(
      !VIEWER.includes("onChange"),
      "nothing here is wired to a save, so nothing can overwrite immutable bytes",
    );
  });
});

describe("the frame itself", () => {
  it("carries the artifact's record beside whatever it is showing", async () => {
    const mounted = await mountShelf();
    await open(mounted, PICTURE);
    const meta = panel(mounted)?.querySelector(".fy-artview__meta")?.textContent ?? "";
    assert.match(meta, /ar_01J8G0000000000000000000I1/, "id");
    assert.match(meta, /image/, "kind");
    assert.match(meta, /filed by hand/, "origin");
    assert.match(meta, /sha256:/, "hash");
    assert.match(meta, /The Vigil/, "links, named the way the cards name them");
    await unmount(mounted);
  });

  it("says what replaced a file, which is the one fact it cannot state about itself", async () => {
    const replacement = artifact({
      id: "ar_01J8G0000000000000000000M2",
      file: "treatment-v2.md",
      supersedes: TREATMENT.id,
    });
    const mounted = await mountShelf([TREATMENT, replacement]);
    // The replacement is what the shelf lists; the superseded original drops out as it always has.
    assert.equal(
      mounted.container.querySelector(`button[aria-label="${artifactOpenLabel(TREATMENT)}"]`),
      null,
      "a superseded artifact stays off the shelf",
    );
    await open(mounted, replacement);
    const meta = panel(mounted)?.querySelector(".fy-artview__meta")?.textContent ?? "";
    assert.match(meta, /supersedes/);
    assert.match(meta, /ar_01J8G0000000000000000000M1/);
    await unmount(mounted);
  });

  it("closes on Escape, on the backdrop, and puts focus back where it came from", () => {
    // A native <dialog> brings Escape, the focus trap and background inerting with it; what it
    // does not bring is the backdrop click or the focus return, so both are written down.
    assert.match(VIEWER, /node\.showModal/, "a real modal dialog, not a hand-rolled overlay");
    assert.match(VIEWER, /onClose=\{onClose\}/, "Escape and the close button settle the same state");
    assert.match(
      VIEWER,
      /if \(event\.target === event\.currentTarget\) dialog\.current\?\.close\(\);/,
      "a click on the dialog rather than its panel is the backdrop",
    );
    assert.match(source("screens/world.tsx"), /openTrigger\.current\?\.focus\(\);/, "focus goes back to the card");
  });

  it("is dialog state, so the shelf keeps its filters and its report underneath", async () => {
    const mounted = await mountShelf();
    const chips = () => [...mounted.container.querySelectorAll(".fy-filterchip")].map((c) => c.textContent);
    const before = chips();
    await open(mounted, PICTURE);
    assert.ok(panel(mounted), "open");
    assert.deepEqual(chips(), before, "the shelf underneath was never remounted");
    await unmount(mounted);
  });

  it("tracks the artifact rather than the row it was in", () => {
    // A world update, a filing or a replacement must move the frame's contents or close it —
    // never silently re-point it at whichever file slid into that position.
    const screen = source("screens/world.tsx");
    assert.match(screen, /artifacts\.find\(\(a\) => a\.id === openArtifactId\) \?\? null/);
  });

  it("starts no media on its own, whatever it opens", () => {
    assert.ok(!/autoPlay=/.test(VIEWER), "opening a viewer prepares media; a person starts it");
    // And one thing sounds at a time, which is the rule the app has had since SPEC-011.
    assert.match(VIEWER, /onPlay=\{hushTheDock\}/);
  });

  it("fits a narrow window: the metadata drops under the stage and long text scrolls", () => {
    assert.match(CSS, /@media \(max-width: 860px\) \{[\s\S]*?\.fy-artview \{ width: 100vw/);
    assert.match(CSS, /\.fy-artview__stage \{[^}]*overflow: auto/s);
    assert.match(CSS, /\.fy-artview__text \{[^}]*white-space: pre-wrap/s);
    assert.match(CSS, /\.fy-artview__image \{[^}]*object-fit: contain/s);
  });
});
