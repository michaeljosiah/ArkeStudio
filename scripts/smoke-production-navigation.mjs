import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { clientStyles, buildClientPage, servePage } from "./lib/client-page.mjs";
import { openChrome, until } from "./lib/chrome.mjs";

// Turn 281's missing destinations, rendered in the actual production shell and pages.
const output = resolve("output/production-navigation-native");
await mkdir(output, { recursive: true });
await buildClientPage(output, `
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App } from "./App.js";
import { episodicLayoutFixture, audioDramaLayoutFixture } from "../test/productions-layout-fixture.js";
import { __setStateForTest, __setBridgeForTest, __connectionStatusForTest } from "./lib/store.js";
${await clientStyles()}
const params = new URLSearchParams(location.search);
const state = params.get("kind") === "episodic" ? episodicLayoutFixture() : audioDramaLayoutFixture(params.get("source") !== "false");
__setStateForTest(state); window.commands = [];
__setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw) { window.commands.push(JSON.parse(raw)); } });
__connectionStatusForTest("open");
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
createRoot(document.getElementById("root")).render(<MemoryRouter initialEntries={["/w/" + state.world.meta.worldId + "/p/saltlight/" + params.get("route")]}><App /></MemoryRouter>);
`);
const server = await servePage(output);
const browser = await openChrome({ args: ["--touch-events=enabled", "--blink-settings=availableHoverTypes=1,availablePointerTypes=2,primaryHoverType=1,primaryPointerType=2"] });
const report = [];
try {
  const { cdp, evaluate: js } = browser;
  await cdp("Page.enable");
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
  for (const width of [390, 984, 1360]) for (const theme of ["light", "dark"]) {
    for (const [kind, route, source] of [["episodic", "story-structure", "false"], ["drama", "adaptation", "true"], ["drama", "cast", "false"]]) {
      await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
      await cdp("Page.navigate", { url: server.origin + "?" + new URLSearchParams({ kind, route, source, theme }) });
      await until(() => js('!!document.querySelector(".fy-production-app")'));
      await js('document.fonts.ready');
      const result = await js(`(() => {
        const nav = document.querySelector(${JSON.stringify(width < 600 ? '[aria-label="Production pages"]' : '.fy-prodrail')});
        const link = slug => nav.querySelector('a[href$="/'+slug+'"]');
        return { active: !!link(${JSON.stringify(route)})?.className.includes("--active"),
          structure: !!link("story-structure"), cast: !!link("cast"), adaptation: !!link("adaptation"),
          overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      })()`);
      assert.equal(result.overflow, false); assert.ok(result.active);
      if (kind === "episodic") { assert.ok(result.structure); assert.ok(result.cast); }
      else assert.equal(result.adaptation, source === "true");
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      await writeFile(join(output, `${kind}-${source}-${width}-${theme}.png`), Buffer.from(shot.data, "base64"));
      report.push({ kind, source, width, theme, ...result });
    }
    if (width === 984) {
      await cdp("Page.navigate", { url: server.origin + "?" + new URLSearchParams({ kind: "episodic", route: "cut", theme }) });
      await until(() => js('!!document.querySelector(".fy-production-drawer-toggle")'));
      await js('document.querySelector(".fy-production-drawer-toggle").click()');
      await until(() => js('!!document.querySelector(".fy-production-drawer[open]")'));
      for (const slug of ["story-structure", "cast"]) assert.ok(await js(`!!document.querySelector('.fy-production-drawer[open] a[href$="/${slug}"]')`));
      const shot = await cdp("Page.captureScreenshot", { format: "png" });
      await writeFile(join(output, `drawer-${theme}.png`), Buffer.from(shot.data, "base64"));
      await js(`document.querySelector('.fy-production-drawer a[href$="/story-structure"]').click()`);
      await until(() => js(`!document.querySelector(".fy-production-drawer[open]") && !!document.querySelector('.fy-prodrail a[href$="/story-structure"][aria-current="page"]')`));
      report.push({ width, theme, drawerNavigation: true });
    }
  }
  await writeFile(join(output, "checks.json"), JSON.stringify(report, null, 2));
  console.log(`${report.length} native navigation cases passed`);
} finally { await browser.close(); await server.close(); }
