import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { resetFilmstrips, useFilmstrip } from "../src/lib/filmstrip.js";

function setup(fail: (src: string) => boolean = () => false) {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window: dom.window, document: dom.document, HTMLVideoElement: dom.HTMLVideoElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let decoded = 0;
  let paused = false;
  const loading: Array<() => void> = [];
  const createElement = document.createElement.bind(document);
  document.createElement = ((name: string) => {
    const element = createElement(name);
    if (name === "canvas") Object.assign(element, {
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => `data:image/jpeg;base64,${++decoded}`,
    });
    if (name === "video") {
      Object.assign(element, { readyState: 2, videoWidth: 160, videoHeight: 90, load() {} });
      Object.defineProperty(element, "src", { set(src: string) {
        const loaded = () => element.dispatchEvent(new dom.Event(fail(src) ? "error" : "loadeddata"));
        if (paused) loading.push(loaded);
        else queueMicrotask(loaded);
      } });
      Object.defineProperty(element, "currentTime", {
        get: () => 0,
        set() { queueMicrotask(() => element.dispatchEvent(new dom.Event("seeked"))); },
      });
    }
    return element;
  }) as typeof document.createElement;
  function Strip({ id }: { id: number }) {
    const frames = useFilmstrip({ src: `video-${id}`, inSec: 0, durationSec: 1, widthPx: 50 });
    return <span data-id={id} data-decoded={frames[0] !== null && frames[0] !== undefined} />;
  }
  const container = createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (ids: number[]) => act(async () => { root.render(<>{ids.map(id => <Strip key={id} id={id} />)}</>); });
  return {
    container, render, decoded: () => decoded,
    pause: () => { paused = true; },
    resume: async () => act(async () => { paused = false; for (const loaded of loading.splice(0)) loaded(); }),
    close: async () => {
      await act(async () => root.unmount());
      resetFilmstrips();
      container.remove();
      document.createElement = createElement;
    },
  };
}

it("bounds thousands of active strips and admits waiting frames when strips leave (#1060)", async () => {
  const { container, render, decoded, close } = setup();
  const strips = (start: number) => Array.from({ length: 2002 - start }, (_, index) => index + start);
  try {
    await render(strips(0));
    assert.equal(decoded(), 2000, "requests beyond the shared cache budget stay on posters");
    assert.equal(container.querySelectorAll('[data-decoded="true"]').length, 2000);
    assert.equal(container.querySelector('[data-id="2000"]')?.getAttribute("data-decoded"), "false");
    await render(strips(2));
    assert.equal(decoded(), 2002, "waiting strips decode without changing their own props");
    assert.equal(container.querySelectorAll('[data-decoded="true"]').length, 2000);
  } finally {
    await close();
  }
});

it("releases permanently failed requests while their strips remain mounted", async () => {
  const { container, render, decoded, close } = setup(src => src === "video-0" || src === "video-1");
  try {
    await render(Array.from({ length: 2002 }, (_, index) => index));
    assert.equal(decoded(), 2000);
    assert.equal(container.querySelectorAll('[data-decoded="true"]').length, 2000);
    assert.equal(container.querySelector('[data-id="0"]')?.getAttribute("data-decoded"), "false");
    assert.equal(container.querySelector('[data-id="2001"]')?.getAttribute("data-decoded"), "true");
  } finally {
    await close();
  }
});

it("hides an inactive cached frame until its new strip is admitted", async () => {
  const { container, render, decoded, pause, resume, close } = setup();
  try {
    await render([0]);
    assert.equal(decoded(), 1);
    await render([]);
    pause();
    const ids = Array.from({ length: 2000 }, (_, index) => index + 1);
    await render(ids);
    await render([...ids, 0]);
    assert.equal(container.querySelector('[data-id="0"]')?.getAttribute("data-decoded"), "false", "cached bytes are not exposed without a claim");
    await render([...ids.slice(1), 0]);
    assert.equal(container.querySelector('[data-id="0"]')?.getAttribute("data-decoded"), "true", "admission wakes the cached strip without another decode");
    assert.equal(decoded(), 1);
    await resume();
  } finally {
    await close();
  }
});
