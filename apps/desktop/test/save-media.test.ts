import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saveMedia, saveMediaHandler, type SaveMediaDeps, type SaveMediaHost } from "../src/save-media.js";

/**
 * The host side of saving a world image (issue 478).
 *
 * What is worth pinning here is the boundary, not the copy: the renderer names a picture by the
 * identity it displayed it with, the host resolves that pair through its own confined lookup, and
 * the bytes written are the resolved ones — never a path that was asked for. Nothing that comes
 * back names a place on this disk.
 */

function deps(over: Partial<SaveMediaDeps> = {}): SaveMediaDeps & { asked: unknown[]; copied: [string, string][] } {
  const asked: unknown[] = [];
  const copied: [string, string][] = [];
  return {
    asked,
    copied,
    resolve: async (slug, path) =>
      slug === "the-undersong" && !path.includes("..") ? { path: `C:/worlds/the-undersong/${path}` } : null,
    ask: async (input) => {
      asked.push(input);
      return "D:/Pictures/chosen.png";
    },
    copy: async (from, to) => {
      copied.push([from, to]);
    },
    ...over,
  };
}

describe("saving a world image from the host", () => {
  it("copies the bytes the confined lookup resolved, not a path it was handed", async () => {
    const d = deps();
    const result = await saveMedia(d, {
      worldSlug: "the-undersong",
      path: "artifacts/key-art.png",
      name: "Key art",
    });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(d.copied, [["C:/worlds/the-undersong/artifacts/key-art.png", "D:/Pictures/chosen.png"]]);
  });

  it("offers the sanitised name and the file's real extension to the dialog", async () => {
    const d = deps();
    await saveMedia(d, { worldSlug: "the-undersong", path: "artifacts/mp_7.webp", name: "../Maren: photo" });
    assert.deepEqual(d.asked, [{ defaultName: "Maren photo.webp", extension: "webp" }]);
  });

  it("refuses what the lookup refuses, and says no more than that", async () => {
    const d = deps();
    const result = await saveMedia(d, { worldSlug: "the-undersong", path: "../../secrets.png" });
    assert.deepEqual(result, { ok: false, reason: "that image is no longer there" });
    assert.equal(d.asked.length, 0, "nothing is asked for a picture that does not resolve");
    assert.equal(d.copied.length, 0);
  });

  it("refuses a request with no identity at all", async () => {
    for (const input of [{}, { worldSlug: "the-undersong" }, { worldSlug: 7, path: "a.png" }]) {
      const result = await saveMedia(deps(), input as Record<string, unknown>);
      assert.deepEqual(result, { ok: false, reason: "there is no image here to save" });
    }
  });

  it("treats a lookup that threw as a picture that is not there", async () => {
    const result = await saveMedia(
      deps({
        resolve: async () => {
          throw new Error("C:/worlds/the-undersong is locked");
        },
      }),
      { worldSlug: "the-undersong", path: "artifacts/a.png" },
    );
    assert.deepEqual(result, { ok: false, reason: "that image is no longer there" });
  });

  it("reports a closed dialog as cancelled, with nothing written", async () => {
    const d = deps({ ask: async () => null });
    const result = await saveMedia(d, { worldSlug: "the-undersong", path: "artifacts/a.png" });
    assert.deepEqual(result, { ok: false, cancelled: true });
    assert.equal(d.copied.length, 0);
  });

  it("reports a failed write without naming a place on this disk", async () => {
    const result = await saveMedia(
      deps({
        copy: async () => {
          throw new Error("EACCES: permission denied, open 'D:/Pictures/chosen.png'");
        },
      }),
      { worldSlug: "the-undersong", path: "artifacts/a.png" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && "reason" in result ? result.reason : "", "that image could not be written there");
    assert.ok(
      !JSON.stringify(result).includes("D:/") && !JSON.stringify(result).includes("C:/"),
      "no absolute path crosses back to the renderer",
    );
  });

  it("leaves the destination and any collision to the platform's own dialog", async () => {
    // Nothing here inspects, renames or overwrites: what comes back from `ask` is written to,
    // and the confirmation a person saw belongs to the dialog that asked.
    const d = deps({ ask: async () => "D:/Pictures/already there.png" });
    const result = await saveMedia(d, { worldSlug: "the-undersong", path: "artifacts/a.png" });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(d.copied[0]?.[1], "D:/Pictures/already there.png");
  });
});

/**
 * The handler around it — which sender may ask, and which provider answers (issue 503).
 *
 * `saveMedia` was right from the day it was written; the save still refused every single time
 * anyone pressed it in the packaged app, because one line above it read a provider reference that
 * startup drops as soon as the coordinator takes ownership — and a window to press anything in
 * only exists after that. Nothing here reached a test, so the whole handler now assembles where
 * it can be asked, and what is pinned is the wiring: the provider is read when the save is asked
 * for, from whoever is holding it then.
 */
interface Provider {
  serveMedia(worldSlug: string, path: string): Promise<{ path: string } | null>;
  asked: string[][];
}

function provider(): Provider {
  const asked: string[][] = [];
  return {
    asked,
    async serveMedia(worldSlug, path) {
      // A method rather than an arrow: a lookup torn off its provider loses `this` and throws.
      this.asked.push([worldSlug, path]);
      return { path: `C:/worlds/${worldSlug}/${path}` };
    },
  };
}

const sender = { id: "the window" };

describe("the save-a-picture handler", () => {

  function host(over: Partial<SaveMediaHost> = {}): SaveMediaHost & { copied: [string, string][] } {
    const copied: [string, string][] = [];
    return {
      copied,
      allowedSender: () => sender,
      providers: () => ({ starting: null, live: null }),
      ask: async () => "D:/Pictures/chosen.png",
      copy: async (from, to) => {
        copied.push([from, to]);
      },
      ...over,
    };
  }

  const picture = { worldSlug: "the-undersong", path: "artifacts/board-v2.png", name: "Board v2" };

  it("saves once the coordinator has taken the provider over", async () => {
    // The state every real click happens in: the window is up, and startup let go of the provider
    // when it handed it on. This is the case that has never once worked.
    const live = provider();
    const h = host({ providers: () => ({ starting: null, live }) });
    assert.deepEqual(await saveMediaHandler(h)(sender, picture), { ok: true });
    assert.deepEqual(live.asked, [["the-undersong", "artifacts/board-v2.png"]]);
    assert.deepEqual(h.copied, [
      ["C:/worlds/the-undersong/artifacts/board-v2.png", "D:/Pictures/chosen.png"],
    ]);
  });

  it("reads the provider when asked, not when it was registered", async () => {
    // Registration happens before `initialize()` has built anything at all, so a handler that
    // captured a provider would capture nothing and keep it.
    let starting: Provider | null = null;
    let live: Provider | null = null;
    const handle = saveMediaHandler(host({ providers: () => ({ starting, live }) }));
    assert.deepEqual(await handle(sender, picture), { ok: false, reason: "the library is not open yet" });
    starting = provider();
    assert.deepEqual(await handle(sender, picture), { ok: true });
    live = starting;
    starting = null;
    assert.deepEqual(await handle(sender, picture), { ok: true });
    assert.equal(live!.asked.length, 2, "the same provider answered on both sides of the handover");
  });

  it("resolves through the provider the host still holds before the handover", async () => {
    const starting = provider();
    await saveMediaHandler(host({ providers: () => ({ starting, live: null }) }))(sender, picture);
    assert.deepEqual(starting.asked, [["the-undersong", "artifacts/board-v2.png"]]);
  });

  it("prefers the owner when both references are in hand", async () => {
    const starting = provider();
    const live = provider();
    await saveMediaHandler(host({ providers: () => ({ starting, live }) }))(sender, picture);
    assert.equal(starting.asked.length, 0);
    assert.equal(live.asked.length, 1);
  });

  it("says the library is not open when no provider can answer", async () => {
    for (const providers of [
      () => ({ starting: null, live: null }),
      // A provider that serves no media is no lookup — the interface allows one.
      () => ({ starting: {}, live: null }),
    ]) {
      const h = host({ providers });
      assert.deepEqual(await saveMediaHandler(h)(sender, picture), {
        ok: false,
        reason: "the library is not open yet",
      });
      assert.equal(h.copied.length, 0);
    }
  });

  it("answers no one but the window's own contents", async () => {
    const live = provider();
    const h = host({ providers: () => ({ starting: null, live }) });
    const handle = saveMediaHandler(h);
    for (const other of [{ id: "some other frame" }, null, undefined]) {
      assert.deepEqual(await handle(other, picture), { ok: false, reason: "that window cannot save" });
    }
    assert.equal(live.asked.length, 0, "a stranger's request never reaches the provider");
  });

  it("refuses before there is a window at all", async () => {
    const handle = saveMediaHandler(host({ allowedSender: () => null }));
    assert.deepEqual(await handle(null, picture), { ok: false, reason: "that window cannot save" });
  });
});
