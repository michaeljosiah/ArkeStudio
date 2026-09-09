import assert from "node:assert/strict";
import { it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { resetFilmstrips, useFilmstrip } from "../src/lib/filmstrip.js";

it("bounds thousands of active strips and admits waiting frames when strips leave (#1060)", async () => {
  const dom = parseHTML("<!doctype html><html><body></body></html>");
  Object.assign(globalThis, {
    window: dom.window, document: dom.document, HTMLVideoElement: dom.HTMLVideoElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let decoded = 0;
  const createElement = document.createElement.bind(document);
  document.createElement = ((name: string) => {
    const element = createElement(name);
    if (name === "canvas") Object.assign(element, {
      getContext: () => ({ drawImage() {} }),
      toDataURL: () => `data:image/jpeg;base64,${++decoded}`,
    });
    if (name === "video") {
      Object.assign(element, { readyState: 2, videoWidth: 160, videoHeight: 90, load() {} });
      Object.defineProperty(element, "src", { set() { queueMicrotask(() => element.dispatchEvent(new dom.Event("loadeddata"))); } });
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
  const strips = (start: number) => Array.from({ length: 2002 - start }, (_, index) => <Strip key={index + start} id={index + start} />);
  try {
    await act(async () => { root.render(<>{strips(0)}</>); });
    assert.equal(decoded, 2000, "requests beyond the shared cache budget stay on posters");
    assert.equal(container.querySelectorAll('[data-decoded="true"]').length, 2000);
    assert.equal(container.querySelector('[data-id="2000"]')?.getAttribute("data-decoded"), "false");
    await act(async () => { root.render(<>{strips(2)}</>); });
    assert.equal(decoded, 2002, "waiting strips decode without changing their own props");
    assert.equal(container.querySelectorAll('[data-decoded="true"]').length, 2000);
  } finally {
    await act(async () => root.unmount());
    resetFilmstrips();
    container.remove();
    document.createElement = createElement;
  }
});
