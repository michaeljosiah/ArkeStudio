import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";

/**
 * Copying a picture out of the app.
 *
 * Saving to disk existed; copying did not, and the whole point of a copy is that it can be
 * pasted somewhere else — into a message, or back into the composer beside it. Four things here
 * decay quietly, so they are pinned: the menu is offered on any picture rather than the handful
 * of frames somebody remembered, it stands down where a screen answers the right-click itself,
 * it never offers a copy of bytes it cannot actually read back, and what crosses to the host is
 * an image and never a place on disk.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1440, innerHeight: 900 });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Element: dom.Element,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { ImageContextMenu } = await import("../src/components/image-context-menu.js");
const { copyImage, copyableImageSource } = await import("../src/lib/clipboard-image.js");

/** A right-click on this element, as the browser would deliver it. */
async function rightClick(target: Element): Promise<Event> {
  const event = new dom.window.Event("contextmenu", { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 120, clientY: 80 });
  await act(async () => void target.dispatchEvent(event as Event));
  return event as Event;
}

async function withMenu(
  body: (container: HTMLElement) => Promise<void>,
  markup: (props: Record<string, never>) => JSX.Element,
): Promise<void> {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <>
        <ImageContextMenu />
        {markup({})}
      </>,
    );
  });
  try {
    await body(container as unknown as HTMLElement);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
}

describe("right-clicking a picture", () => {
  it("offers to copy it, and takes the click off the platform's own menu", async () => {
    await withMenu(
      async (container) => {
        const image = container.querySelector("img")!;
        const event = await rightClick(image);
        assert.ok(event.defaultPrevented, "the platform menu does not also open");
        const item = container.querySelector('.fy-imgmenu [role="menuitem"]');
        assert.ok(item, "the menu is there");
        assert.equal(item!.textContent, "Copy image");
      },
      () => <img src="http://127.0.0.1:8791/media/the-undersong/artifacts/key-art.png" alt="Key art" />,
    );
  });

  it("is offered on a picture inside something that opens on click, not only on a bare one", async () => {
    // Nearly every picture in the app sits inside a card, a cell or a trigger. A menu that only
    // answered a bare <img> would answer almost nowhere.
    await withMenu(
      async (container) => {
        await rightClick(container.querySelector("img")!);
        assert.ok(container.querySelector(".fy-imgmenu"), "the card underneath is not in the way");
      },
      () => (
        <button type="button" className="fy-imghost">
          <img src="http://127.0.0.1:8791/media/the-undersong/artifacts/key-art.png" alt="Key art" />
        </button>
      ),
    );
  });

  it("stands down where a screen answers the right-click itself", async () => {
    // The flow canvas, the timeline and the season board each open a menu of their own. Two
    // menus on one click is one too many, and theirs is the one that knows the subject.
    await withMenu(
      async (container) => {
        await rightClick(container.querySelector("img")!);
        assert.equal(container.querySelector(".fy-imgmenu"), null);
      },
      () => (
        <div onContextMenu={(event) => event.preventDefault()}>
          <img src="http://127.0.0.1:8791/media/the-undersong/artifacts/key-art.png" alt="Key art" />
        </div>
      ),
    );
  });
});

describe("which pictures have a copy to offer", () => {
  const source = (src: string): string | null =>
    copyableImageSource({
      currentSrc: src,
      getAttribute: () => src,
    } as unknown as HTMLImageElement);

  it("offers the world's own media, which the page reads over the coordinator's HTTP side", () => {
    const url = "http://127.0.0.1:8791/media/the-undersong/artifacts/key-art.png";
    assert.equal(source(url), url);
  });

  it("refuses a plate that ships with the build, whose bytes a file:// page may not fetch", () => {
    // Found by reasoning about the packaged app rather than the dev browser: the studio loads
    // from file:// there, and `fetch` of a file:// asset is refused — so a menu on the launch
    // plate would have been a copy that always failed after the click.
    assert.equal(source("file:///C:/Program%20Files/Arke/doors/story.webp"), null);
    assert.equal(source(""), null);
  });
});

describe("what the copy actually puts on the clipboard", () => {
  it("hands the desktop host the image and nothing that names a place on disk", async () => {
    const asked: Uint8Array[] = [];
    const outcome = await withFetch(
      async () => ({ ok: true, status: 200, blob: async () => new Blob(["png!"], { type: "image/png" }) }),
      () =>
        withHost(async (bytes: Uint8Array) => {
          asked.push(bytes);
          return { ok: true };
        }, () => copyImage("http://127.0.0.1:8791/media/the-undersong/artifacts/key-art.png")),
    );
    assert.deepEqual(outcome, { ok: true });
    assert.equal(asked.length, 1);
    assert.deepEqual([...asked[0]!], [...new TextEncoder().encode("png!")]);
  });

  it("refuses a picture the coordinator will not serve, rather than copying nothing at all", async () => {
    const outcome = await withFetch(async () => ({ ok: false, status: 404 }), () =>
      copyImage("http://127.0.0.1:8791/media/the-undersong/artifacts/gone.png"),
    );
    assert.deepEqual(outcome, { ok: false, reason: "the image could not be read (404)" });
  });
});

/* ---- the stubs, kept below the tests they serve --------------------------- */

async function withFetch<T>(
  stub: (url: string) => Promise<{ ok: boolean; status: number; blob?: () => Promise<Blob> }>,
  body: () => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  (globalThis as Record<string, unknown>)["fetch"] = stub;
  try {
    return await body();
  } finally {
    (globalThis as Record<string, unknown>)["fetch"] = real;
  }
}

async function withHost<T>(
  copyImageHost: (bytes: Uint8Array) => Promise<unknown>,
  body: () => Promise<T>,
): Promise<T> {
  const holder = globalThis as unknown as { window: { arke?: unknown } };
  const real = holder.window.arke;
  holder.window.arke = { copyImage: copyImageHost };
  try {
    return await body();
  } finally {
    holder.window.arke = real;
  }
}
