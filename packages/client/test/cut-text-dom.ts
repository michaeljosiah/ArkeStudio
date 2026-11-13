import { parseHTML } from "linkedom";

/**
 * The document the text controls' tests run in. Imported before react-dom, which decides when it
 * loads whether the page has an `input` event: linkedom's document says no unless `oninput` is on
 * it, and React then falls back to an old polyfill that breaks on a focused field.
 */

export const dom = parseHTML("<!doctype html><html><head></head><body></body></html>");
let width = 1024;
const listeners = new Set<() => void>();
// The phone's queries are answered by width, as cut-layout.test.tsx answers them.
Object.assign(dom.window, {
  innerWidth: width, innerHeight: 844, getComputedStyle: () => ({ direction: "ltr" }),
  matchMedia: (query: string) => ({
    media: query,
    get matches() {
      return width < 1024 && query.split(",").some(part => !part.includes("orientation: landscape") && (!part.includes("hover:") || part.includes("hover: none"))
        && (!part.includes("pointer:") || part.includes("pointer: coarse"))
        && [...part.matchAll(/\((min|max)-width: (\d+)px\)/g)].every(([, kind, value]) => (kind === "min" ? width >= Number(value) : width <= Number(value))));
    },
    addEventListener: (_: string, listener: () => void) => listeners.add(listener), removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }),
});
export const seen = { focused: null as Element | null, selected: null as Element | null };
Object.assign(dom.HTMLElement.prototype, {
  focus(this: HTMLElement) { seen.focused = this; },
  select(this: HTMLElement) { seen.selected = this; },
  showModal(this: HTMLElement) { this.setAttribute("open", ""); }, close(this: HTMLElement) { this.removeAttribute("open"); },
  scrollIntoView() {}, setPointerCapture() {}, releasePointerCapture() {},
});
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), { pause() {}, play: () => Promise.resolve() });
Object.assign(dom.document, { oninput: null });
Object.assign(globalThis, { window: dom.window, document: dom.document, HTMLElement: dom.HTMLElement, HTMLMediaElement: dom.HTMLMediaElement,
  Element: dom.Element, Node: dom.Node, Event: dom.Event, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: () => 1, cancelAnimationFrame() {} });

/** The window's width for the tests that follow: below 600 is a phone. */
export function setWidth(next: number): void {
  width = next;
  Object.assign(dom.window, { innerWidth: next });
}
