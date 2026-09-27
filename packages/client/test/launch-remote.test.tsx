import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { App } from "../src/App.js";
import { __connectionStatusForTest, __setStateForTest } from "../src/lib/store.js";
import { remoteStudio } from "../src/screens/launch.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The launch surface reached from another device (design turn 158). "On this device" is false
 * on a phone that reached the studio over a tunnel, so the local way names the machine it goes
 * to, and an expired link says what a phone can actually do about it.
 */

__setStateForTest(FIXTURE_STATE);

const previous = globalThis.window;
function browserAt(hostname: string, arke?: object): void {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { hostname, hash: "", search: "" }, ...(arke === undefined ? {} : { arke }) },
  });
}

function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("launch surface from another device", () => {
  afterEach(() => {
    if (previous === undefined) delete (globalThis as { window?: Window }).window;
    else Object.defineProperty(globalThis, "window", { configurable: true, value: previous });
    __connectionStatusForTest("open");
  });

  it("is local on the studio's own machine and in the desktop app", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      browserAt(host);
      assert.equal(remoteStudio(), null, host);
    }
    browserAt("michael-desktop.tail1234.ts.net", {});
    assert.equal(remoteStudio(), null, "the desktop app is local whatever its page's address");
  });

  it("names a tailnet machine by its first label, and an address whole", () => {
    browserAt("michael-desktop.tail1234.ts.net");
    assert.equal(remoteStudio(), "michael-desktop");
    browserAt("100.101.102.103");
    assert.equal(remoteStudio(), "100.101.102.103");
  });

  it("offers the studio by name, and an expired link without a button", () => {
    browserAt("michael-desktop.tail1234.ts.net");
    const html = renderAt("/");
    assert.ok(html.includes("Your studio") && html.includes("michael-desktop"), "the way names where it goes");
    assert.ok(!html.includes("on this device"), "and never claims to be local");
    assert.ok(html.includes(">Continue<"));

    __connectionStatusForTest("auth-refused");
    const refused = renderAt("/");
    assert.ok(refused.includes("This link has expired"));
    assert.ok(refused.includes("Open a new one from Arke Studio on your computer."));
    assert.ok(!refused.includes("Restart the frontend"), "the developer's instruction is not a phone's");
  });
});
