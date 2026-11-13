import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { clientStyles, buildClientPage, servePage } from "./lib/client-page.mjs";
import { openChrome, until } from "./lib/chrome.mjs";

// Turn 281: actual creation forms and model settings; fixture commands never reach a world.
const output = resolve("output/manual-sketches-native");
await mkdir(output, { recursive: true });
await buildClientPage(output, `
import React from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { App } from "./App.js";
import { AgentsPanel } from "./screens/agents.js";
import { FIXTURE_STATE } from "../test/fixture-state.js";
import { __setStateForTest, __setBridgeForTest, __connectionStatusForTest } from "./lib/store.js";
${await clientStyles()}
const params = new URLSearchParams(location.search), state = structuredClone(FIXTURE_STATE);
state.app.health.harness = { status: "unavailable", reason: "Not running" };
state.app.agents = ["story-writer", "world-builder", "sheet-editor"].map(name => ({ name, description: name, shippedBrief: "Write", brief: "Write", edited: false, ...(name === "story-writer" ? { model: "openai/gpt-5.4" } : {}) }));
window.commands = [];
__setStateForTest(state);
__setBridgeForTest({ connect() {}, subscribe() { return () => {}; }, send(raw) { window.commands.push(JSON.parse(raw)); } });
__connectionStatusForTest("open");
document.documentElement.classList.toggle("dark", params.get("theme") === "dark");
const route = params.get("route") || "locations/new";
createRoot(document.getElementById("root")).render(route === "agents" ? <div style={{ maxWidth: 620, margin: "0 auto", padding: 24 }}><h1>Agent settings</h1><AgentsPanel /></div> : <MemoryRouter initialEntries={["/w/" + state.world.meta.worldId + "/" + route]}><App /></MemoryRouter>);
`);
const server = await servePage(output), browser = await openChrome();
const report = [];
try {
  const { cdp, evaluate: js } = browser;
  await cdp("Page.enable");
  for (const width of [390, 984, 1360]) for (const theme of ["light", "dark"]) for (const route of ["locations/new", "cast/new", "factions/new", "agents"]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false });
    await cdp("Page.navigate", { url: server.origin + "?" + new URLSearchParams({ route, theme }) });
    await until(() => js(route === "agents" ? '!!document.querySelector("select")' : '!!document.querySelector("textarea")'));
    await js('document.fonts.ready');
    await js('Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))');
    const metrics = await js(`({ overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.body.innerText })`);
    assert.equal(metrics.overflow, false, `${route} ${width} overflow`);
    assert.ok(metrics.text.includes(route === "agents" ? "Same as Story writer" : "No AI drafting is needed"));
    if (route !== "agents") {
      await js(`(() => { for (const [selector, value] of [["input", "Bell House"], ["textarea", "A watch house by the harbour."]]) { const el = document.querySelector(selector); Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); } })()`);
      const reachable = await js(`(() => { const b = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Create as sketch"); b.scrollIntoView({block:"center"}); const r=b.getBoundingClientRect(); return { disabled:b.disabled, x:r.x, right:r.right, y:r.y, bottom:r.bottom, width:innerWidth, height:innerHeight }; })()`);
      assert.ok(!reachable.disabled && reachable.x >= 0 && reachable.right <= width + 1 && reachable.y >= 0 && reachable.bottom <= 901, JSON.stringify({route, width, ...reachable}));
    }
    const shot = await cdp("Page.captureScreenshot", { format: "png" });
    await writeFile(join(output, `${route.replace("/", "-")}-${width}-${theme}.png`), Buffer.from(shot.data, "base64"));
    if (route !== "agents") {
      await js('[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Create as sketch").click()');
      const command = await until(() => js('window.commands.find(c => c.kind === "create-sheet-from-sentence")'));
      assert.equal(command.manual, true); assert.equal(command.settle, undefined);
    }
    report.push({ route, width, theme, passed: true });
  }
  await writeFile(join(output, "checks.json"), JSON.stringify(report, null, 2));
  console.log(`${report.length} native UI cases passed`);
} finally { await browser.close(); await server.close(); }
