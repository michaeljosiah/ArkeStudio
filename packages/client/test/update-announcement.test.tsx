import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useNavigate } from "react-router";
import { parseHTML } from "linkedom";
import type { ClientMessage, ClientState, UpdateState } from "@arke-studio/contracts";
import type { ConnectionStatus } from "../src/lib/store.js";
import { ActivityPanel } from "../src/components/activity-panel.js";
import { ANNOUNCED_KEY, UpdateAnnouncement, __resetUpdateAnnouncementForTest } from "../src/components/update-announcement.js";
import { __resetActivityPanelForTest, closeActivityPanel, openActivityPanel, openActivityPanelOnArrival } from "../src/lib/activity-panel.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The update announced at launch (design turn 152; SPEC-016 R-20): a dialog over the first
 * screen with chrome, once per version per run, with the release's notes and two ways to take
 * it. What this file holds to: where it opens and where it does not, that it opens once, what
 * each press sends, that closing it drops the intent and keeps the download, that it leaves with
 * the update, and that it never stacks with the Activity panel or Settings, survives a renderer
 * reload, and keeps its place when a press cannot be sent (Codex on PR 1218).
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
/** Session storage as the window has it: a map that outlives a reload of the renderer, not the run. */
const stored = new Map<string, string>();
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Element: dom.Element,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  sessionStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
  },
});

let go: (to: string) => void = () => {};
/** A way to change the address the way a remedy's button or the gear would. */
function Probe() {
  go = useNavigate();
  return null;
}

/** linkedom tracks no focus, so the test that cares records every call itself. */
function trackFocus(): { focused: () => HTMLElement | null; restore: () => void } {
  const proto = dom.HTMLElement.prototype as unknown as { focus: () => void };
  const originalFocus = proto.focus;
  const active = Object.getOwnPropertyDescriptor(dom.document, "activeElement");
  let focused: HTMLElement | null = null;
  proto.focus = function focus() {
    focused = this as unknown as HTMLElement;
  };
  Object.defineProperty(dom.document, "activeElement", { configurable: true, get: () => focused });
  return {
    focused: () => focused,
    restore: () => {
      proto.focus = originalFocus;
      if (active === undefined) Reflect.deleteProperty(dom.document, "activeElement");
      else Object.defineProperty(dom.document, "activeElement", active);
    },
  };
}

const NOTES = "The Cut plays its own audio back.\n\nA second paragraph, about the lanes.";

function update(overrides: Partial<UpdateState>): UpdateState {
  return {
    status: "available",
    targetVersion: "0.5.50",
    progressPercent: null,
    flow: null,
    detail: null,
    releaseName: "v0.5.50 — the cut hears itself",
    releaseNotes: NOTES,
    ...overrides,
  };
}

function withUpdate(value: UpdateState): ClientState {
  const state = structuredClone(FIXTURE_STATE);
  state.app.update = value;
  return state;
}

const open: Array<{ root: Root; container: HTMLElement }> = [];
async function unmountAll(): Promise<void> {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
}
afterEach(async () => {
  await unmountAll();
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
  __resetUpdateAnnouncementForTest();
  __resetActivityPanelForTest();
});

function capture(): ClientMessage[] {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({
    appVersion: "test",
    platform: "test",
    connect() {},
    subscribe() {},
    send(json: string) {
      sent.push(JSON.parse(json));
    },
  });
  return sent;
}

/** `withPanel` mounts the Activity panel before the announcement, in the order App has them. */
async function mount(path: string, value: UpdateState, withPanel = false, connection: ConnectionStatus = "open"): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  open.push({ root, container });
  await act(async () => {
    __setStateForTest(withUpdate(value), { connection });
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Probe />
        {withPanel && <ActivityPanel />}
        <UpdateAnnouncement />
      </MemoryRouter>,
    );
  });
  return container;
}

/** The update state moves on under the mounted dialog, as a frame from the desktop would move it. */
async function becomes(value: UpdateState, connection: ConnectionStatus = "open"): Promise<void> {
  await act(async () => __setStateForTest(withUpdate(value), { connection }));
}

const dialog = (container: HTMLElement): HTMLElement | null => container.querySelector('.fy-upd[role="dialog"]');
const text = (container: HTMLElement): string => (container.textContent ?? "").replace(/\s+/g, " ");
function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label,
  );
  assert.ok(found, `a button reading ${label}`);
  return found;
}
async function press(container: HTMLElement, label: string): Promise<void> {
  await act(async () => button(container, label).click());
}

describe("the update announced at launch (design turn 152)", () => {
  it("opens over the world picker with the mark, the version and name, the notes and two ways to take it", async () => {
    const container = await mount("/worlds", update({}));
    const sheet = dialog(container);
    assert.ok(sheet, "the dialog is up");
    assert.equal(sheet.getAttribute("aria-labelledby"), "fy-upd-title");
    const shown = text(container);
    assert.ok(shown.includes("Update available"));
    assert.ok(shown.includes("v0.5.50 · the cut hears itself"), "the version and the release's name as one line, the version not said twice");
    assert.ok(shown.includes("What's new"), "the eyebrow over the notes");
    assert.equal(container.querySelectorAll(".fy-upd__pane p").length, 2, "the notes as paragraphs");
    assert.ok(container.querySelector('img[src="./marks/arke.ico"]'), "the app's own mark");
    button(container, "Update now");
    button(container, "Next start");
    button(container, "Close");
    assert.ok(shown.indexOf("Update now") < shown.indexOf("Next start"), "Update now leads");
  });

  it("does not open over the launch plate, the starting screen or the founding build", async () => {
    for (const path of ["/", "/starting", "/building/w_01"]) {
      const container = await mount(path, update({}));
      assert.equal(dialog(container), null, `nothing over ${path}`);
      await unmountAll();
    }
    // The same version, once the app is on a screen with chrome, is still unannounced.
    const container = await mount("/worlds", update({}));
    assert.ok(dialog(container), "announced on arrival");
  });

  it("announces a version once per run: closed, it stays closed; a newer version opens again", async () => {
    const first = await mount("/worlds", update({}));
    await press(first, "Close");
    assert.equal(dialog(first), null);
    // The app mounts one announcement; a second window would be a second run of this module.
    await unmountAll();
    const again = await mount("/worlds", update({}));
    assert.equal(dialog(again), null, "the same version is not announced twice");
    await unmountAll();
    const newer = await mount("/worlds", update({ targetVersion: "0.5.51" }));
    assert.ok(dialog(newer), "a version this run has not seen is announced");
  });

  it("keeps the pane out with the eyebrow when the release carries no notes", async () => {
    const container = await mount("/worlds", update({ releaseNotes: null, releaseName: null }));
    const shown = text(container);
    assert.ok(shown.includes("v0.5.50"));
    assert.ok(!shown.includes("What's new"));
    assert.equal(container.querySelector(".fy-upd__pane"), null);
  });

  it("Update now downloads, shows the download in the primary's place, and installs when it lands", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}));
    await press(container, "Update now");
    assert.deepEqual(sent.map((m) => m.kind), ["download-update"]);

    await becomes(update({ status: "downloading", progressPercent: 42.4 }));
    assert.ok(text(container).includes("Downloading · 42%"), "the figure over the bar");
    assert.equal(container.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow"), "42");
    assert.equal([...container.querySelectorAll("button")].some((b) => b.textContent?.trim() === "Update now"), false, "the primary gave its place to the download");
    button(container, "Next start");

    await becomes(update({ status: "ready", progressPercent: 100 }));
    assert.deepEqual(sent.map((m) => m.kind), ["download-update", "install-update-and-restart"], "the dialog held the intent and pressed Install and restart itself");
    // The same frame again, as a re-render would deliver it: no second press.
    await becomes(update({ status: "ready", progressPercent: 100 }));
    assert.equal(sent.filter((m) => m.kind === "install-update-and-restart").length, 1);

    await becomes(update({ status: "shutting-down", flow: "restart", progressPercent: 100 }));
    assert.equal(dialog(container), null, "the finishing-local-work surface takes over");
  });

  it("closing during the download drops the intent and keeps the download", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}));
    await press(container, "Update now");
    await becomes(update({ status: "downloading", progressPercent: 10 }));
    await press(container, "Close");
    assert.equal(dialog(container), null);
    await becomes(update({ status: "ready", progressPercent: 100 }));
    assert.deepEqual(sent.map((m) => m.kind), ["download-update"], "nothing installs and nothing restarts once the dialog is gone");
    assert.equal(dialog(container), null, "and the dialog does not come back for the download it started");
  });

  it("Escape closes it the same way", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}));
    await press(container, "Update now");
    const escape = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    await act(async () => { dom.window.dispatchEvent(escape); });
    assert.equal(dialog(container), null);
    await becomes(update({ status: "ready", progressPercent: 100 }));
    assert.deepEqual(sent.map((m) => m.kind), ["download-update"]);
  });

  it("Next start hands the update to the on-close flow and closes", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}));
    await press(container, "Next start");
    assert.deepEqual(sent.map((m) => m.kind), ["install-update-on-close"]);
    assert.equal(dialog(container), null);
  });

  it("Next start while Update now's download runs takes over the intent", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}));
    await press(container, "Update now");
    await becomes(update({ status: "downloading", progressPercent: 30 }));
    await press(container, "Next start");
    assert.deepEqual(sent.map((m) => m.kind), ["download-update", "install-update-on-close"]);
    assert.equal(dialog(container), null);
    await becomes(update({ status: "ready", progressPercent: 100 }));
    assert.equal(sent.some((m) => m.kind === "install-update-and-restart"), false, "the intent to restart went with the press");
  });

  it("Update now on an update already downloaded installs and restarts at once", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}));
    await becomes(update({ status: "ready", progressPercent: 100 }));
    await press(container, "Update now");
    assert.deepEqual(sent.map((m) => m.kind), ["install-update-and-restart"]);
  });

  it("a failed download keeps the dialog: one clause, Try again, Next start", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}));
    await press(container, "Update now");
    await becomes(update({ status: "error", detail: "The update download failed. Check your connection and try again." }));
    assert.ok(dialog(container), "the dialog stays");
    const shown = text(container);
    assert.ok(shown.includes("The download failed."), "one clause");
    assert.ok(!shown.includes("Check your connection"), "and not the controller's sentence");
    button(container, "Next start");
    await press(container, "Try again");
    assert.deepEqual(sent.map((m) => m.kind), ["download-update", "download-update"]);
    await becomes(update({ status: "ready", progressPercent: 100 }));
    assert.deepEqual(sent.map((m) => m.kind), ["download-update", "download-update", "install-update-and-restart"], "Try again is Update now");
  });

  it("waits while the Activity panel is open, and opens when the panel closes", async () => {
    openActivityPanel("inbox");
    const container = await mount("/worlds", update({}));
    assert.equal(dialog(container), null, "nothing under the panel");
    await act(async () => closeActivityPanel());
    assert.ok(dialog(container), "announced once the panel is gone");
  });

  it("the retired route's arrival opens the panel in the same commit; the announcement waits for it", async () => {
    // /activity redirects to /worlds and the panel opens itself on arrival, from its own effect,
    // in the commit the announcement's effect also runs in — rendered against a closed panel.
    openActivityPanelOnArrival("inbox");
    const container = await mount("/worlds", update({}), true);
    assert.ok(container.querySelector(".fy-ap"), "the panel is up");
    assert.equal(dialog(container), null, "the announcement did not open under it");
    await act(async () => closeActivityPanel());
    assert.ok(dialog(container), "and it opens once the panel closes, still unannounced");
  });

  it("the Activity panel opening over it wins: the dialog closes and drops the intent", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}));
    await press(container, "Update now");
    await becomes(update({ status: "downloading", progressPercent: 20 }));
    // A notification's click, a receipt's action: the panel over the dialog.
    await act(async () => openActivityPanel("inbox"));
    assert.equal(dialog(container), null);
    await act(async () => closeActivityPanel());
    assert.equal(dialog(container), null, "closed, not hidden: the version was announced");
    await becomes(update({ status: "ready", progressPercent: 100 }));
    assert.deepEqual(sent.map((m) => m.kind), ["download-update"], "the intent went with the dialog");
  });

  it("waits while Settings is open, and leaves for Settings opened over it", async () => {
    const container = await mount("/settings/general", update({}));
    assert.equal(dialog(container), null, "nothing under the Settings sheet");
    await act(async () => go("/worlds"));
    assert.ok(dialog(container), "announced once the sheet is closed");
    await act(async () => go("/settings/about"));
    assert.equal(dialog(container), null, "Settings over it wins");
    await act(async () => go("/worlds"));
    assert.equal(dialog(container), null, "and the version stays announced");
  });

  it("keeps its place while the coordinator is away: the buttons wait, a press sends nothing and closes nothing", async () => {
    const sent = capture();
    const container = await mount("/worlds", update({}), false, "connecting");
    assert.ok(dialog(container), "the dialog is up on the snapshot it has");
    assert.equal(button(container, "Next start").disabled, true);
    assert.equal(button(container, "Update now").disabled, true);
    await press(container, "Next start");
    assert.equal(sent.length, 0, "nothing left");
    assert.ok(dialog(container), "and the dialog did not close on a press that went nowhere");
    await becomes(update({}));
    assert.equal(button(container, "Next start").disabled, false, "back with the connection");
    await press(container, "Next start");
    assert.deepEqual(sent.map((m) => m.kind), ["install-update-on-close"]);
    assert.equal(dialog(container), null);
  });

  it("remembers the announcement across a renderer reload, in session storage", async () => {
    const first = await mount("/worlds", update({}));
    assert.ok(dialog(first));
    assert.deepEqual(JSON.parse(stored.get(ANNOUNCED_KEY) ?? "[]"), ["0.5.50"], "the run's memory of it outlives the module");
    // A reload: fresh module state, the same window's storage, the same snapshot.
    await unmountAll();
    __resetUpdateAnnouncementForTest();
    stored.set(ANNOUNCED_KEY, JSON.stringify(["0.5.50"]));
    const again = await mount("/worlds", update({}));
    assert.equal(dialog(again), null, "not announced twice for one run");
    await unmountAll();
    const newer = await mount("/worlds", update({ targetVersion: "0.5.51" }));
    assert.ok(dialog(newer), "a newer version still is");
    assert.deepEqual(JSON.parse(stored.get(ANNOUNCED_KEY) ?? "[]"), ["0.5.50", "0.5.51"], "every version the run announced");
  });

  it("remembers every version it announced: a withdrawn release does not bring the one before it back", async () => {
    const container = await mount("/worlds", update({}));
    await press(container, "Close");
    await becomes(update({ targetVersion: "0.5.51" }));
    assert.ok(dialog(container), "the newer one is announced");
    await press(container, "Close");
    await becomes(update({ targetVersion: "0.5.50" }));
    assert.equal(dialog(container), null, "the earlier one was seen already");
  });

  it("hands focus to the panel that wins, not back to its own opener", async () => {
    const focus = trackFocus();
    // Something had focus before the sheet took it — the bell, say — as it always does in the app.
    const bell = document.createElement("button");
    document.body.append(bell);
    bell.focus();
    try {
      const container = await mount("/worlds", update({}), true);
      assert.equal(focus.focused()?.textContent?.trim(), "Update now", "the sheet focused its first control");
      // A notification's click: the panel opens over the dialog and focuses itself. The dialog
      // has to be gone in that same render — a render later, its cleanup would hand focus back
      // to whatever it had taken it from, over the panel's head.
      await act(async () => openActivityPanel("inbox"));
      assert.equal(dialog(container), null);
      assert.ok(focus.focused()?.classList.contains("fy-ap"), `focus is on the panel, not ${focus.focused()?.outerHTML.slice(0, 60)}`);
    } finally {
      focus.restore();
      bell.remove();
    }
  });

  it("the Next start hint rides above the button, clear of the sheet's clipping edge", async () => {
    const container = await mount("/worlds", update({}));
    const next = button(container, "Next start");
    assert.ok(next.className.includes("fy-tip--up"), next.className);
    assert.equal(next.getAttribute("data-tip"), "Downloads now, installs after you close");
  });

  it("leaves with the update: armed for the close, or gone", async () => {
    const container = await mount("/worlds", update({}));
    await becomes(update({ status: "install-on-close", flow: "on-close" }));
    assert.equal(dialog(container), null);
    await unmountAll();
    const other = await mount("/worlds", update({ targetVersion: "0.5.51" }));
    assert.ok(dialog(other));
    await becomes(update({ status: "none", targetVersion: null, releaseName: null, releaseNotes: null }));
    assert.equal(dialog(other), null);
  });
});
