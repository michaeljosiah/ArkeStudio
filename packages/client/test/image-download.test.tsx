import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ClientState, LocationView, ReferenceKit } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { ImageDownload } from "../src/components/image-actions.js";
import { downloadMedia } from "../src/lib/download.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Saving a picture out of the app (issue 478).
 *
 * The files were always on this machine, which is exactly why nothing offered to give you one:
 * the way out was the world folder. The control that fixes that has three properties worth
 * pinning, because all three are the kind that decay quietly — it is reachable without a pointer,
 * a click on it is not a click on whatever it is sitting on, and the bytes it saves are the
 * file's own rather than anything the screen re-drew.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
// linkedom has no layout, and the toaster mounted app-wide asks the document which way it reads
// before it draws anything. Left to right, which is what every screen render here assumes.
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const here = dirname(fileURLToPath(import.meta.url));
const source = (file: string): string => readFileSync(join(here, "../src", file), "utf8");
const CSS = readFileSync(join(here, "../src/components/image-actions.css"), "utf8");
const W = `/w/${FIXTURE_WORLD_ID}`;

function renderAt(path: string, state: ClientState = FIXTURE_STATE): string {
  __setStateForTest(state);
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

/** The `<button>` tag that carries this accessible name, so its attributes can be read. */
function buttonFor(html: string, label: string): string {
  const at = html.indexOf(`aria-label="${label}"`);
  assert.ok(at > 0, `no control named “${label}”`);
  return html.slice(html.lastIndexOf("<button", at), html.indexOf(">", at) + 1);
}

describe("the control over a picture", () => {
  it("names the file it would save, for the tooltip and the screen reader alike", () => {
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    // The offered name, with the file's own extension on the end — never the other way round.
    const tag = buttonFor(html, "Download Maren Kest main photo.png");
    assert.match(tag, /class="fy-imgdl"/);
    assert.ok(html.includes('aria-label="Download Maren Kest character sheet.png"'), "and the sheet beside it");
  });

  it("stands beside the enlarge trigger rather than inside it", () => {
    // A <button> within a <button> is invalid markup and browsers drop one of the two — usually
    // the one you wanted. The pair are siblings, so the enlarge and the save both survive.
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    const zoom = html.indexOf('aria-label="View larger main photo of Maren Kest"');
    const save = html.indexOf('aria-label="Download Maren Kest main photo.png"');
    assert.ok(zoom > 0 && save > zoom, "the save follows the trigger");
    const between = html.slice(zoom, html.lastIndexOf("<button", save));
    assert.ok(between.includes("</button>"), "the trigger has closed before the save opens");
    assert.ok(!between.includes("<button"), "and nothing else opened in between");
  });

  it("stays with the picture when it is opened full size", () => {
    // Somebody who enlarged an image to look at it should not have to close it to keep a copy.
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    const dialogAt = html.indexOf('class="fy-portrait-dialog__image fy-imghost"');
    assert.ok(dialogAt > 0, "the enlarged copy sits in a host box");
    assert.ok(
      html.indexOf('aria-label="Download Maren Kest main photo.png"', dialogAt) > 0,
      "and the save is in there with it",
    );
    // Closing still lands the keyboard back on the trigger, whatever it was on last.
    assert.ok(source("components/image-dialog.tsx").includes("onClose={() => trigger.current?.focus()}"));
  });

  it("will not offer to save a picture that has not arrived", () => {
    // Nothing has loaded in a server render, so nothing may promise to write bytes yet.
    const html = renderAt(`${W}/cast/maren-kest/kit`);
    const tag = buttonFor(html, "Download Maren Kest main photo.png");
    assert.match(tag, /\bdisabled\b/, "the control waits for the image");
    assert.match(tag, /title="That image is not here to save"/, "and says why rather than failing after a click");
  });
});

describe("the surfaces that expose a picture as media", () => {
  it("puts it on an artifact card, under the artifact's own filename", () => {
    const state = structuredClone(FIXTURE_STATE) as ClientState;
    const artifacts = state.world!.artifacts as unknown as Record<string, unknown>[];
    artifacts.push({ ...structuredClone(artifacts[0]!), id: "af_image", kind: "image", file: "key-art.webp" });
    const html = renderAt(`${W}/artifacts`, state);
    // The artifact's name, and its real format: a WebP does not land as a PNG.
    assert.ok(html.includes('aria-label="Download key-art.webp"'));
    __setStateForTest(FIXTURE_STATE);
  });

  it("puts it on the cast page's featured portrait", () => {
    const html = renderAt(`${W}/cast`);
    assert.ok(html.includes('aria-label="Download Maren Kest main photo.png"'));
  });

  it("puts it on accepted location views, unreviewed candidates and the assembled sheet", () => {
    const view: LocationView = {
      id: "lv_01",
      name: "Establishing view",
      file: "takes/tk_01J8F0000000000000000001/view.png",
      sourceTakeId: "tk_01J8F0000000000000000001" as LocationView["sourceTakeId"],
      sheetVersion: 2,
      artDirectionVersion: 3,
      acceptedAt: "2026-08-02T10:00:00Z",
      status: "active",
    };
    const kit: ReferenceKit = {
      sheetId: "the-vigil",
      tiles: [],
      locationViews: [view],
      establishingViewId: "lv_01",
      compilations: [
        {
          file: "location-sheet-8f2c1d0a4b77.png",
          format: "location-sheet",
          sheetVersion: 2,
          tiles: [view.file],
          compiledAt: "2026-08-02T10:00:00Z",
          source: "local",
          accepted: true,
        },
      ],
    };
    // Unreviewed, so it has no name of its own yet — it saves under the take that made it.
    const candidate = {
      id: "tk_01J8F000000000000000000C",
      coversShots: [],
      kind: "location-view",
      reference: { sheetId: "the-vigil" },
      provider: "openai",
      model: "gpt-image-2",
      provenance: { canonRevision: 42, sheets: { "the-vigil": 2 } },
      references: [],
      params: {},
      cost: { estimatedMicroUsd: 150000, actualMicroUsd: 150000 },
      dispatchedAt: "2026-08-03T09:00:00Z",
      completedAt: "2026-08-03T09:02:00Z",
      media: "view.png",
    } as unknown as NonNullable<ClientState["world"]>["referenceTakes"][number];
    const world = FIXTURE_STATE.world!;
    const state: ClientState = {
      ...FIXTURE_STATE,
      world: { ...world, referenceKits: [kit], referenceTakes: [candidate], referenceReviews: [] },
    };
    const html = renderAt(`${W}/locations/the-vigil/reference`, state);
    assert.ok(html.includes('aria-label="Download The Vigil Establishing view.png"'), "the accepted view");
    assert.ok(
      html.includes('aria-label="Download The Vigil candidate view tk_01J8F000000000000000000C.png"'),
      "the candidate waiting on a decision, under a name that says which take it is",
    );
    assert.ok(html.includes('aria-label="Download The Vigil location sheet.png"'), "and the sheet it assembles into");
    __setStateForTest(FIXTURE_STATE);
  });

  it("is not put on the chips and avatars that merely stand in for something else", () => {
    // A row thumbnail, a header avatar and a production card frame are pictures of a subject, not
    // the subject's media. Offering to save one is offering a copy of a decoration.
    const html = renderAt(`${W}/cast`);
    const rowAt = html.indexOf('class="fy-row__thumb"');
    assert.ok(rowAt > 0, "the ledger rows are on this page");
    const row = html.slice(rowAt, rowAt + 600);
    assert.ok(!row.includes("fy-imgdl"), "and carry no save control");
  });

  it("offers the generated candidates a person is choosing between", () => {
    // The one preview grid every generation screen shares — main photos, character sheets, looks,
    // location views, master look and key art all land in it, so this is where they are covered.
    const dialog = source("components/generation-dialog.tsx");
    assert.match(dialog, /<ImageDownload\s/, "the preview cell offers a save");
    assert.ok(
      dialog.includes('<div key={preview.key} className="fy-imghost">'),
      "and the cell holds the pick and the save as siblings",
    );
  });

  it("offers a completed bench take without touching what the take is", () => {
    const bench = source("screens/bench.tsx");
    assert.match(bench, /name=\{`Take \$\{selected\.n\}`\}/, "a take saves under the only name it has");
    const at = bench.indexOf("<ImageDownload");
    const region = bench.slice(at, at + 400);
    for (const mutation of ["sendBenchKeep", "sendBenchDiscard", "sendBenchSelectTake"]) {
      assert.ok(!region.includes(mutation), `saving a copy must not ${mutation}`);
    }
  });
});

describe("revealing it", () => {
  it("is hidden until the frame is hovered or something in it holds focus", () => {
    assert.match(CSS, /\.fy-imghost:hover > \.fy-imgdl,\s*\n\.fy-imghost:focus-within > \.fy-imgdl/);
  });

  it("moves nothing when it appears", () => {
    // Opacity, never display: a control that reflows the picture on hover makes the picture jump
    // under the pointer that was reaching for it.
    const block = CSS.slice(CSS.indexOf(".fy-imgdl {"), CSS.indexOf("}", CSS.indexOf(".fy-imgdl {")));
    assert.match(block, /position: absolute/);
    assert.match(block, /opacity: 0/);
    assert.ok(!/display: none/.test(block), "hidden by opacity, so it holds its place in the layout");
  });

  it("is simply there where there is no hover to reveal it with", () => {
    // A control that only exists under a pointer does not exist at all on a touch screen.
    const at = CSS.indexOf("@media (hover: none)");
    assert.ok(at > 0, "touch has no hover state and the stylesheet answers for it");
    assert.match(CSS.slice(at, at + 160), /opacity: 1/);
  });

  it("shows its own focus ring, so the keyboard can see where it is", () => {
    assert.match(CSS, /\.fy-imgdl:focus-visible \{[^}]*outline: 2px solid var\(--ring\)/s);
  });
});

describe("clicking it", () => {
  it("saves, and does not reach the card underneath", async () => {
    const fetched: string[] = [];
    let cardClicks = 0;
    await withBrowserSave(fetched, async () => {
      const container = dom.document.createElement("div");
      dom.document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(
          // The picture underneath is normally inside something that opens, selects or accepts.
          <div className="fy-imghost" onClick={() => (cardClicks += 1)}>
            <ImageDownload worldSlug="the-undersong" path="artifacts/key-art.png" name="Key art" />
          </div>,
        );
      });
      const button = container.querySelector("button.fy-imgdl") as HTMLElement;
      assert.ok(button, "the control rendered");
      await act(async () => button.click());
      await act(async () => {});
      assert.equal(cardClicks, 0, "saving a copy is not selecting, opening or accepting");
      assert.equal(fetched.length, 1, "and it did save");
      assert.match(fetched[0]!, /\/media\/the-undersong\/artifacts\/key-art\.png$/);
      await act(async () => root.unmount());
      container.remove();
    });
  });
});

describe("what the save actually reads", () => {
  it("asks the coordinator for the same confined file the picture came from", async () => {
    const fetched: string[] = [];
    await withBrowserSave(fetched, async () => {
      const outcome = await downloadMedia("the-undersong", "references/maren-kest/head-front.png");
      assert.deepEqual(outcome, { ok: true });
    });
    assert.equal(fetched.length, 1);
    assert.match(fetched[0]!, /^http:\/\/127\.0\.0\.1:\d+\/media\/the-undersong\/references\/maren-kest\/head-front\.png$/);
    // A world-relative path, never a filesystem one: nothing here could name a place on disk.
    assert.ok(!fetched[0]!.includes(":\\") && !fetched[0]!.includes("file:"));
  });

  it("saves the file's own bytes under the file's own extension", async () => {
    const saved: { name: string; bytes: number }[] = [];
    await withBrowserSave([], async () => {
      await downloadMedia("the-undersong", "artifacts/board.webp", "The harbour board");
    }, saved);
    assert.deepEqual(saved, [{ name: "The harbour board.webp", bytes: 4 }]);
  });

  it("refuses a picture the coordinator will not serve, rather than writing an empty file", async () => {
    const outcome = await withFetch(async () => ({ ok: false, status: 404 }), () =>
      downloadMedia("the-undersong", "artifacts/gone.png"),
    );
    assert.deepEqual(outcome, { ok: false, reason: "the image could not be read (404)" });
  });

  it("refuses an empty body, which is a broken file wearing a 200", async () => {
    const outcome = await withFetch(
      async () => ({ ok: true, status: 200, blob: async () => new Blob([]) }),
      () => downloadMedia("the-undersong", "artifacts/empty.png"),
    );
    assert.deepEqual(outcome, { ok: false, reason: "that image is empty" });
  });

  it("refuses a request with no picture in it at all", async () => {
    assert.deepEqual(await downloadMedia(undefined, "artifacts/a.png"), {
      ok: false,
      reason: "there is no image here to save",
    });
    assert.deepEqual(await downloadMedia("the-undersong", ""), {
      ok: false,
      reason: "there is no image here to save",
    });
  });
});

describe("on the desktop", () => {
  it("hands the host the identity it displayed the picture with, and no path", async () => {
    const asked: unknown[] = [];
    await withHost(
      async (...args: unknown[]) => {
        asked.push(args);
        return { ok: true };
      },
      async () => {
        const outcome = await downloadMedia("the-undersong", "artifacts/key-art.png", "Key art");
        assert.deepEqual(outcome, { ok: true });
      },
    );
    assert.deepEqual(asked, [["the-undersong", "artifacts/key-art.png", "Key art.png"]]);
  });

  it("passes a closed save dialog back as cancelled, which the screen says nothing about", async () => {
    const outcome = await withHost(
      async () => ({ ok: false, cancelled: true }),
      () => downloadMedia("the-undersong", "artifacts/key-art.png"),
    );
    assert.deepEqual(outcome, { ok: false, cancelled: true });
  });

  it("does not fall through to the browser path when the host throws", async () => {
    let fetches = 0;
    await withFetch(
      async () => {
        fetches += 1;
        return { ok: true, status: 200, blob: async () => new Blob(["a"]) };
      },
      async () => {
        const outcome = await withHost(
          async () => {
            throw new Error("the bridge is gone");
          },
          () => downloadMedia("the-undersong", "artifacts/key-art.png"),
        );
        assert.deepEqual(outcome, { ok: false, reason: "the app could not save that image" });
      },
    );
    assert.equal(fetches, 0, "a host that refused is an answer, not a reason to go around it");
  });
});

describe("what the browser is allowed to do", () => {
  it("may read the loopback files it is already allowed to show", () => {
    // Found by running it: `img-src` and `media-src` name the coordinator's origin, `connect-src`
    // named only its socket, so every save failed the Content Security Policy while the very
    // same picture sat on screen beside the control that had just failed to save it.
    const html = readFileSync(join(here, "../index.html"), "utf8");
    const policy = /content="([^"]*)"/.exec(html)?.[1] ?? "";
    const directive = (name: string): string =>
      new RegExp(`${name} ([^;"]*)`).exec(policy)?.[1] ?? "";
    for (const origin of ["http://127.0.0.1:*", "http://localhost:*"]) {
      assert.ok(directive("connect-src").includes(origin), `connect-src must allow ${origin}`);
      // The same origin, because it is the same files: shown and read are one permission here.
      assert.ok(directive("img-src").includes(origin), `img-src must allow ${origin}`);
    }
  });

  it("keeps the two selection grids off the control that shares their cell", () => {
    // Also found by running it: `.fy-...-grid button { position: relative; aspect-ratio... }`
    // reached the save control as well as the choice, which took it out of the corner it is
    // placed in and gave the cell 26px it never had. The rules name the choice now.
    const css = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");
    const grids = /^\.fy-(gendialog__previews-grid|looks-results__grid)/;
    for (const line of css.split("\n")) {
      if (!grids.test(line) || !/\bbutton\b/.test(line)) continue;
      assert.ok(
        line.includes(":not(.fy-imgdl)"),
        `a rule for the cell's choice that also catches its save control:\n${line}`,
      );
    }
  });
});

/* ---- the stubs, kept below the tests they serve --------------------------- */

type Stub = (url: string) => Promise<{ ok: boolean; status: number; blob?: () => Promise<Blob> }>;

async function withFetch<T>(stub: Stub, body: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  (globalThis as Record<string, unknown>)["fetch"] = stub;
  try {
    return await body();
  } finally {
    (globalThis as Record<string, unknown>)["fetch"] = real;
  }
}

async function withHost<T>(
  saveMedia: (...args: unknown[]) => Promise<unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const holder = globalThis as unknown as { window: { arke?: unknown } };
  const real = holder.window.arke;
  holder.window.arke = { saveMedia };
  try {
    return await body();
  } finally {
    holder.window.arke = real;
  }
}

/**
 * The browser path with its two edges stubbed: what was asked of the network, and what the
 * anchor was told to write. Everything between the two is the code under test.
 */
function withBrowserSave<T>(
  fetched: string[],
  body: () => Promise<T>,
  saved: { name: string; bytes: number }[] = [],
): Promise<T> {
  const realCreate = dom.document.createElement.bind(dom.document);
  const realObjectUrl = (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  const realRevoke = (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  const sizes = new Map<string, number>();
  let next = 0;
  Object.assign(URL, {
    createObjectURL: (blob: Blob) => {
      const url = `blob:arke/${(next += 1)}`;
      sizes.set(url, blob.size);
      return url;
    },
    revokeObjectURL: () => {},
  });
  Object.assign(dom.document, {
    createElement: (tag: string) => {
      const node = realCreate(tag) as HTMLElement & { click: () => void; href: string; download: string };
      // Read back off the attributes: linkedom reflects an anchor's own properties through URL
      // normalisation, which percent-encodes the very spaces a filename is allowed to have.
      if (tag === "a")
        node.click = () =>
          saved.push({
            name: node.getAttribute("download") ?? "",
            bytes: sizes.get(node.getAttribute("href") ?? "") ?? -1,
          });
      return node;
    },
  });
  return withFetch(
    async (url: string) => {
      fetched.push(url);
      return { ok: true, status: 200, blob: async () => new Blob(["abcd"]) };
    },
    body,
  ).finally(() => {
    delete (dom.document as unknown as Record<string, unknown>)["createElement"];
    Object.assign(URL, { createObjectURL: realObjectUrl, revokeObjectURL: realRevoke });
  });
}
