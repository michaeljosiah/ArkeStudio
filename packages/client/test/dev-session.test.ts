import assert from "node:assert/strict";
import { it } from "node:test";
import { devSession, devMediaUrl } from "../src/lib/dev-session.js";
import { mediaUrl, genesisMediaUrl } from "../src/lib/media.js";

it("browser development authenticates media without breaking retry query parameters", () => {
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window");
  const token = "e".repeat(64);
  const storage = new Map<string, string>();
  const location = { hash: "#/?arke-session=" + token, pathname: "/", search: "" };
  const history = { state: null, replaceState: (_state: unknown, _title: string, url: string) => { location.hash = url.slice(url.indexOf("#")); } };
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location, history, sessionStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value) },
  } });
  try {
    assert.deepEqual(devSession(), { port: 8791, token });
    assert.equal(location.hash, "#/");
    assert.deepEqual(devSession(), { port: 8791, token }, "reconnect reads the tab credential");
    const url = new URL(mediaUrl("a-world", "artifacts/a note.md", { attempt: "2" }));
    assert.equal(url.searchParams.get("token"), token);
    assert.equal(url.searchParams.get("attempt"), "2");
    assert.equal(url.pathname, "/media/a-world/artifacts/a%20note.md");
    assert.equal(new URL(genesisMediaUrl("draft", "look.png")).searchParams.get("token"), token);
    Object.defineProperty(globalThis, "window", { configurable: true, value: { arke: { coordinatorHttpBase: () => "http://127.0.0.1:43210" } } });
    assert.equal(mediaUrl("a-world", "look.png"), "http://127.0.0.1:43210/media/a-world/look.png");

    assert.equal(devSession(), null);
    assert.equal(devMediaUrl("http://127.0.0.1/media/a"), "http://127.0.0.1/media/a");
  } finally {
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore); else Reflect.deleteProperty(globalThis, "window");
  }
});
