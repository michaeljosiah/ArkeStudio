import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHTML } from "linkedom";

/**
 * One unrelated store event re-rendered most of the screen (issue 2783): the shell read the whole
 * store through `useThemePreference`, both layouts through `useOpenWorldGuard`, and the global
 * chat provider and the chrome directly, so a status that nothing on screen shows re-rendered
 * every route from the top.
 *
 * Renders are counted the way React DevTools counts them, through the hook React reports commits
 * to: a component rendered in a commit when its fiber is new to that commit's tree and carries
 * React's performed-work flag. The hook has to exist before react-dom loads, so the app is
 * imported below it.
 */
type Fiber = { type: unknown; flags: number; child: Fiber | null; sibling: Fiber | null };
const TRACKED = new Set(["AppRoutes", "WorldLayout", "ProductionLayout", "GlobalChatProvider", "AppChrome"]);
const PERFORMED_WORK = 1;
const renders = new Map<string, number>();
let previous = new WeakSet<Fiber>();
const nameOf = (type: unknown) => (typeof type === "function" ? ((type as { displayName?: string }).displayName ?? type.name) : undefined);
(globalThis as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  onCommitFiberRoot: (_renderer: number, root: { current: Fiber }) => {
    const seen = new WeakSet<Fiber>();
    const walk = (first: Fiber | null) => {
      for (let fiber = first; fiber !== null; fiber = fiber.sibling) {
        seen.add(fiber);
        const name = nameOf(fiber.type);
        if (name !== undefined && TRACKED.has(name) && !previous.has(fiber) && (fiber.flags & PERFORMED_WORK) === PERFORMED_WORK) {
          renders.set(name, (renders.get(name) ?? 0) + 1);
        }
        walk(fiber.child);
      }
    };
    walk(root.current);
    previous = seen;
  },
  onCommitFiberUnmount: () => {},
  onPostCommitFiberRoot: () => {},
  checkDCE: () => {},
};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), matchMedia: (media: string) => ({ matches: false, media, addEventListener() {}, removeEventListener() {} }) });
Object.assign(dom.HTMLElement.prototype, { scrollIntoView() {}, focus() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router");
const { App } = await import("../src/App.js");
const { __applyEventForTest, __setStateForTest } = await import("../src/lib/store.js");
const { FIXTURE_STATE } = await import("./fixture-state.js");
const WORLD_ID = FIXTURE_STATE.world!.meta.worldId;

for (const [route, layout] of [[`/w/${WORLD_ID}`, "WorldLayout"], [`/w/${WORLD_ID}/p/saltlight`, "ProductionLayout"]] as const) {
  it(`does not re-render the shell, ${layout} or the chrome for an event nothing on screen reads`, async () => {
    __setStateForTest(FIXTURE_STATE, { connection: "open" });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<MemoryRouter initialEntries={[route]}><App /></MemoryRouter>));
      assert.ok((renders.get(layout) ?? 0) > 0, `${layout} mounted`);
      renders.clear();
      // The voice sidecar's status: held by the store, shown on no screen here.
      await act(async () => __applyEventForTest({ at: "2026-11-08T10:00:00.000Z", type: "voice.sidecar", state: "ready", detail: "Voxa is ready." }));
      assert.deepEqual(Object.fromEntries(renders), {}, "nothing that reads the whole store is left above the screen");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
}
