import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import type { AccountState, ClientMessage } from "@arke-studio/contracts";
import { AppChrome } from "../src/components/chrome.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The Arke account in the chrome (design turn 151): the control after the gear, quiet when no
 * one is signed in; the menu under it with account things only; the browser-handoff doors; and
 * the states — waiting on the browser, a refusal, a session that expired, offline, a paid plan,
 * a person with no picture. The state is the coordinator's (`app.account`), so every test sets
 * it and reads what the chrome makes of it; the presses are frames, captured off the bridge.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Element: dom.Element,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
});
// linkedom draws no focus ring: each test that cares records where focus was asked to go.
Object.assign(dom.HTMLElement.prototype, { focus() {} });

const HELEN = { name: "Helen Marsh", email: "helen@marsh.studio", picture: "https://example.invalid/helen.png" };
const FREE = { name: "Free", paid: false };

const signedIn = (session: "ok" | "expired" | "offline" = "ok", overrides: Partial<{ picture: string | null; plan: { name: string; paid: boolean } }> = {}): AccountState => ({
  kind: "signed-in",
  person: { ...HELEN, ...(overrides.picture === undefined ? {} : { picture: overrides.picture }) },
  plan: overrides.plan ?? FREE,
  session,
});

function withAccount(account: AccountState): void {
  __setStateForTest({ ...FIXTURE_STATE, app: { ...FIXTURE_STATE.app, account } });
}

function chrome(): string {
  return renderToString(
    <MemoryRouter>
      <AppChrome />
    </MemoryRouter>,
  ).replace(/<!-- -->/g, "");
}

function control(html: string): string {
  const label = html.indexOf('aria-label="Arke account"');
  assert.ok(label > 0, "the control is drawn");
  return html.slice(html.lastIndexOf("<button", label), html.indexOf("</button>", label));
}

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

async function mounted(run: (container: HTMLElement) => Promise<void>): Promise<void> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <MemoryRouter>
          <AppChrome />
        </MemoryRouter>,
      ),
    );
    await run(container);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    __setBridgeForTest(null);
    __setStateForTest(FIXTURE_STATE);
  }
}

const press = (container: HTMLElement, selector: string) =>
  act(async () => {
    const target = container.querySelector<HTMLButtonElement>(selector);
    assert.ok(target, `${selector} is there to press`);
    target.click();
  });

const open = (container: HTMLElement) => press(container, 'button[aria-label="Arke account"]');

const items = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].map((item) => item.textContent!.trim());

function keydown(target: EventTarget, key: string): Event {
  const event = new dom.window.Event("keydown", { bubbles: true });
  Object.defineProperty(event, "key", { value: key });
  target.dispatchEvent(event);
  return event;
}

describe("the control (design turn 151)", () => {
  it("sits last in the right group, after settings, once", () => {
    const html = chrome();
    const settings = html.indexOf('aria-label="Settings"');
    const account = html.indexOf('aria-label="Arke account"');
    assert.ok(account > settings, "after the gear: the person, not the screen, goes at the end");
    assert.equal(html.split('aria-label="Arke account"').length - 1, 1, "one control, not two");
    assert.ok(!html.includes('role="menu"'), "closed at rest");
  });

  it("is the person glyph and nothing else while no one is signed in", () => {
    const button = control(chrome());
    assert.ok(button.includes("<svg"), "a glyph, not a picture");
    assert.ok(!button.includes("fy-iconbtn__dot"), "no dot: the app is whole without an account");
    assert.ok(!button.includes("ui-avatar"), "no picture and no initials to draw");
    assert.ok(button.includes('title="Arke account"'), "and no tooltip that sells");
  });

  it("is the person's picture once signed in, and their initials when there is none", () => {
    withAccount(signedIn());
    const picture = control(chrome());
    assert.ok(picture.includes('src="https://example.invalid/helen.png"'), "the picture");
    withAccount(signedIn("ok", { picture: null }));
    const initials = control(chrome());
    assert.ok(initials.includes("ui-avatar--initials") && initials.includes(">HM<"), "Avatar's initials form, smaller");
    assert.ok(!initials.includes("<img"), "no broken picture behind them");
    __setStateForTest(FIXTURE_STATE);
  });

  it("wears the warning dot for an expired session only", () => {
    withAccount(signedIn("expired"));
    const expired = control(chrome());
    assert.ok(expired.includes("fy-iconbtn__dot"), "a session that expired wants you, like the bell");
    assert.ok(expired.includes("session expired"), "and the tooltip says which");
    withAccount(signedIn("offline"));
    assert.ok(!control(chrome()).includes("fy-iconbtn__dot"), "offline is not the person's to fix");
    __setStateForTest(FIXTURE_STATE);
  });
});

describe("the menu with no one signed in", () => {
  it("opens on the control with one title and two doors, both a handoff to the browser", async () => {
    const sent = capture();
    await mounted(async (container) => {
      await open(container);
      const menu = container.querySelector('[role="menu"]');
      assert.ok(menu, "a menu, not a page");
      assert.equal(menu.getAttribute("aria-label"), "Arke account");
      assert.equal(container.querySelector(".fy-account__title")?.textContent, "Arke account");
      assert.deepEqual(items(container), ["Sign in", "Create account"]);
      assert.equal(container.querySelectorAll('[role="menuitem"] svg').length, 2, "each wears the ↗: both leave the app");
      assert.equal(container.querySelector('button[aria-label="Arke account"]')?.getAttribute("aria-expanded"), "true");
      assert.ok(!menu.textContent!.includes("Settings"), "nothing that lives in Settings is repeated");

      await press(container, '[role="menuitem"]');
      assert.deepEqual(sent, [{ kind: "account-sign-in" }]);
      await press(container, '[role="menuitem"]:nth-of-type(2)');
      assert.deepEqual(sent.at(-1), { kind: "account-create" });
    });
  });

  it("shows a refusal under the title as one clause, and clears it when the menu closes", async () => {
    withAccount({ kind: "signed-out", refusal: "Arke cloud is not available yet" });
    const sent = capture();
    await mounted(async (container) => {
      await open(container);
      assert.equal(container.querySelector(".fy-account__refusal")?.textContent, "Arke cloud is not available yet");
      assert.deepEqual(items(container), ["Sign in", "Create account"], "the doors stay");
      assert.deepEqual(sent, [], "nothing sent for opening");
      await act(async () => keydown(window, "Escape"));
      assert.equal(container.querySelector('[role="menu"]'), null, "Escape closes it");
      assert.deepEqual(sent, [{ kind: "account-cancel-sign-in" }], "and the refusal goes with the menu");
    });
  });

  it("while the browser has the sign-in, one line and a way back", async () => {
    withAccount({ kind: "signing-in" });
    const sent = capture();
    await mounted(async (container) => {
      await open(container);
      assert.ok(container.querySelector(".fy-account__waiting")?.textContent?.includes("waiting for the browser"));
      assert.deepEqual(items(container), ["Cancel"], "the doors give way to the wait");
      await press(container, '[role="menuitem"]');
      assert.deepEqual(sent, [{ kind: "account-cancel-sign-in" }]);
    });
  });
});

describe("the menu once signed in", () => {
  it("is the person, the plan with its one action, the account, and sign out — each door a frame", async () => {
    withAccount(signedIn());
    const sent = capture();
    await mounted(async (container) => {
      await open(container);
      const who = container.querySelector(".fy-account__who")!;
      assert.ok(who.textContent!.includes("Helen Marsh") && who.textContent!.includes("helen@marsh.studio"));
      assert.equal(container.querySelector(".fy-account__badge")?.textContent, "Free", "the plan's name as a badge");
      assert.deepEqual(items(container), ["Upgrade", "Account", "Sign out"]);
      assert.equal(container.querySelectorAll(".fy-account__band").length, 2, "the doors and the way out are two bands");

      await press(container, ".fy-account__act");
      assert.deepEqual(sent.at(-1), { kind: "account-open", page: "plan" });
      const rows = container.querySelectorAll<HTMLButtonElement>(".fy-account__row--item");
      await act(async () => rows[0]!.click());
      assert.deepEqual(sent.at(-1), { kind: "account-open", page: "account" });
      await act(async () => rows[1]!.click());
      assert.deepEqual(sent.at(-1), { kind: "account-sign-out" });
    });
  });

  it("offers Manage, not Upgrade, once the plan is paid", async () => {
    withAccount(signedIn("ok", { plan: { name: "Pro", paid: true } }));
    await mounted(async (container) => {
      await open(container);
      assert.equal(container.querySelector(".fy-account__badge")?.textContent, "Pro");
      assert.deepEqual(items(container), ["Manage", "Account", "Sign out"]);
    });
  });

  it("an expired session is the state word with Sign in as the row's action, and no plan row", async () => {
    withAccount(signedIn("expired"));
    const sent = capture();
    await mounted(async (container) => {
      await open(container);
      const state = container.querySelector(".fy-account__state--warn");
      assert.equal(state?.textContent, "session expired");
      assert.deepEqual(items(container), ["Sign in", "Sign out"]);
      assert.equal(container.querySelector(".fy-account__badge"), null, "no plan to show until the person is back");
      await press(container, ".fy-account__act");
      assert.deepEqual(sent, [{ kind: "account-sign-in" }]);
    });
  });

  it("offline sits in the plan row where the action was", async () => {
    withAccount(signedIn("offline"));
    await mounted(async (container) => {
      await open(container);
      assert.equal(container.querySelector(".fy-account__end .fy-account__state")?.textContent, "offline");
      assert.deepEqual(items(container), ["Account", "Sign out"], "no Upgrade: the cloud is out of reach");
      assert.equal(container.querySelector(".fy-account__state--warn"), null, "and it is not a warning");
    });
  });
});

describe("the menu keeps role=menu's promises", () => {
  it("the arrows move between the items and wrap", async () => {
    const focused: string[] = [];
    Object.assign(dom.HTMLElement.prototype, {
      focus(this: HTMLElement) {
        focused.push(this.textContent!.trim() || this.getAttribute("aria-label") || "?");
      },
    });
    try {
      await mounted(async (container) => {
        await open(container);
        assert.equal(focused.at(-1), "Sign in", "opening puts focus on the first item");
        const menu = container.querySelector('[role="menu"]')!;
        // linkedom has no activeElement, so every arrow counts from outside the list — which is
        // the case a browser meets when focus is on the menu itself: down is the first item, up
        // the last.
        await act(async () => keydown(menu, "ArrowDown"));
        assert.equal(focused.at(-1), "Sign in");
        await act(async () => keydown(menu, "ArrowUp"));
        assert.equal(focused.at(-1), "Create account");
      });
    } finally {
      Object.assign(dom.HTMLElement.prototype, { focus() {} });
    }
  });

  it("an outside press closes it and the control's own press does not", async () => {
    await mounted(async (container) => {
      await open(container);
      assert.ok(container.querySelector('[role="menu"]'));
      const onControl = new dom.window.Event("pointerdown", { bubbles: true });
      await act(async () => container.querySelector('button[aria-label="Arke account"]')!.dispatchEvent(onControl));
      assert.ok(container.querySelector('[role="menu"]'), "the control is the toggle, not outside");
      const outside = new dom.window.Event("pointerdown", { bubbles: true });
      await act(async () => document.body.dispatchEvent(outside));
      assert.equal(container.querySelector('[role="menu"]'), null);
      assert.equal(container.querySelector('button[aria-label="Arke account"]')?.getAttribute("aria-expanded"), "false");
    });
  });

  it("Escape puts focus back on the control", async () => {
    const focused: string[] = [];
    Object.assign(dom.HTMLElement.prototype, {
      focus(this: HTMLElement) {
        focused.push(this.getAttribute("aria-label") ?? this.textContent!.trim());
      },
    });
    try {
      await mounted(async (container) => {
        await open(container);
        await act(async () => keydown(window, "Escape"));
        assert.equal(container.querySelector('[role="menu"]'), null);
        assert.equal(focused.at(-1), "Arke account", "where it left from");
      });
    } finally {
      Object.assign(dom.HTMLElement.prototype, { focus() {} });
    }
  });
});
