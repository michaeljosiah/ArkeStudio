import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { saveMedia, type SaveMediaDeps } from "../src/save-media.js";

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
