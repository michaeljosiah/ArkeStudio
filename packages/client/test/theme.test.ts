import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { initializeTheme, resetThemeForTests, setThemePreference } from "../src/lib/theme.js";

interface FakeMedia {
  matches: boolean;
  listeners: Set<() => void>;
}

function browser(systemDark: boolean) {
  const classes = new Set<string>();
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  const media: FakeMedia = { matches: systemDark, listeners: new Set() };
  const hostChanges: string[] = [];
  const fakeWindow = {
    matchMedia: () => ({
      get matches() {
        return media.matches;
      },
      addEventListener: (_type: string, listener: () => void) => media.listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => media.listeners.delete(listener),
    }),
    arke: {
      setHostTheme: (preference: string) => hostChanges.push(preference),
      themeReady: () => {},
    },
  };
  const fakeDocument = {
    documentElement: {
      classList: {
        toggle: (name: string, force: boolean) => (force ? classes.add(name) : classes.delete(name)),
      },
      dataset,
      style,
    },
  };
  Object.assign(globalThis, { window: fakeWindow, document: fakeDocument });
  return {
    classes,
    dataset,
    style,
    hostChanges,
    changeSystem(dark: boolean) {
      media.matches = dark;
      for (const listener of media.listeners) listener();
    },
  };
}

afterEach(() => resetThemeForTests());

describe("client appearance bootstrap", () => {
  it("applies system dark mode before React and follows system changes", () => {
    const page = browser(true);
    initializeTheme();
    assert.equal(page.classes.has("dark"), true);
    assert.equal(page.dataset["theme"], "dark");
    assert.equal(page.style["colorScheme"], "dark");

    page.changeSystem(false);
    assert.equal(page.classes.has("dark"), false);
    assert.equal(page.dataset["theme"], "light");
    assert.equal(page.style["colorScheme"], "light");
  });

  it("keeps an explicit theme stable when the system changes", () => {
    const page = browser(false);
    initializeTheme();
    setThemePreference("dark");
    page.changeSystem(false);
    assert.equal(page.classes.has("dark"), true);
    assert.deepEqual(page.hostChanges, ["dark"]);
  });
});
