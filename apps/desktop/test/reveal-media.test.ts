import assert from "node:assert/strict";
import { it } from "node:test";
import { revealMediaHandler, type RevealMediaHost } from "../src/save-media.js";

function setup(over: Partial<RevealMediaHost> = {}) {
  const sender = {}, revealed: string[] = [], lookups: string[] = [];
  const host: RevealMediaHost = { allowedSender: () => sender, worldSlug: () => "bell-watch",
    providers: () => ({ starting: null, live: { async serveMedia(_slug, path) { lookups.push(path); return { path: "C:/worlds/bell-watch/exports/resolved.mp4" }; } } }),
    reveal: path => { revealed.push(path); }, ...over };
  return { host, sender, revealed, lookups, open: revealMediaHandler(host) };
}
const input = { worldSlug: "bell-watch", path: "exports/review.mp4" };

it("reveals only the confined provider's path and returns no host address", async () => {
  const t = setup();
  assert.deepEqual(await t.open(t.sender, input), { ok: true });
  assert.deepEqual(t.revealed, ["C:/worlds/bell-watch/exports/resolved.mp4"]);
});
it("rejects other senders, worlds, host paths and traversal before lookup", async () => {
  const t = setup();
  assert.equal((await t.open({}, input)).ok, false);
  assert.equal((await t.open(t.sender, { ...input, worldSlug: "other" })).ok, false);
  for (const path of ["C:/exports/a.mp4", "exports/../../a.mp4", "exports/./a.mp4", "exports\\a.mp4", "exports//a.mp4", "https://example.com/a.mp4", "artifacts/a.mp4", "exports/"]) {
    assert.equal((await t.open(t.sender, { ...input, path })).ok, false, path);
  }
  assert.equal((await t.open(t.sender, null)).ok, false);
  assert.deepEqual(t.lookups, []); assert.deepEqual(t.revealed, []);
});
it("refuses missing or escaped media and hides lookup and shell errors", async () => {
  for (const serveMedia of [async () => null, async () => { throw new Error("C:/private/secret"); }]) {
    const t = setup({ providers: () => ({ starting: null, live: { serveMedia } }) });
    assert.deepEqual(await t.open(t.sender, input), { ok: false, reason: "That export is unavailable." });
    assert.deepEqual(t.revealed, []);
  }
  const t = setup({ reveal: () => { throw new Error("C:/private/secret"); } });
  assert.deepEqual(await t.open(t.sender, input), { ok: false, reason: "That export is unavailable." });
});
it("rechecks the world and window after an asynchronous lookup", async () => {
  for (const change of ["world", "window"] as const) {
    let slug = "bell-watch", sender: unknown, release!: (value: { path: string }) => void;
    const t = setup({ allowedSender: () => sender, worldSlug: () => slug,
      providers: () => ({ starting: null, live: { serveMedia: () => new Promise(resolve => { release = resolve; }) } }) });
    sender = t.sender;
    const work = t.open(t.sender, input);
    if (change === "world") slug = "other"; else sender = {};
    release({ path: "C:/worlds/bell-watch/exports/review.mp4" });
    assert.equal((await work).ok, false); assert.deepEqual(t.revealed, []);
  }
});
