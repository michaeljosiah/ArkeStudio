import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppSettingsFile } from "../../src/app-settings.js";
import { makeTempRoot } from "../world/helpers.js";

/**
 * The two facts Activity's panel remembers (SPEC-014 R-25, design turn 136): when the Inbox was
 * last opened and the last release read. They live in the app settings file beside the theme,
 * each set alone, and a malformed pair costs two dots rather than the settings file.
 */
describe("what Activity's panel remembers", () => {
  it("starts empty, keeps each fact alone, and survives a reload", async () => {
    const { root } = await makeTempRoot();
    const file = new AppSettingsFile(join(root, "settings.json"));
    assert.deepEqual((await file.load()).activity, { inboxSeenAt: null, whatsNewSeenVersion: null });

    const looked = await file.setActivitySeen({ inboxSeenAt: "2026-09-10T12:00:00.000Z" });
    assert.deepEqual(looked.activity, { inboxSeenAt: "2026-09-10T12:00:00.000Z", whatsNewSeenVersion: null });

    const read = await file.setActivitySeen({ whatsNewSeenVersion: "0.5.49" });
    assert.deepEqual(read.activity, { inboxSeenAt: "2026-09-10T12:00:00.000Z", whatsNewSeenVersion: "0.5.49" }, "the other fact is untouched");

    const reloaded = await new AppSettingsFile(join(root, "settings.json")).load();
    assert.deepEqual(reloaded.activity, read.activity);
  });

  it("reads a malformed pair as nothing seen rather than failing the settings file", async () => {
    const { root } = await makeTempRoot();
    const path = join(root, "settings.json");
    const file = new AppSettingsFile(path);
    await file.setActivitySeen({ whatsNewSeenVersion: "0.5.49" });
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    raw["activity"] = { inboxSeenAt: 12, whatsNewSeenVersion: ["no"] };
    raw["spend"] = { thresholdMicroUsd: 7_000_000, periodDays: 3 };
    await writeFile(path, JSON.stringify(raw), "utf8");
    const loaded = await new AppSettingsFile(path).load();
    assert.deepEqual(loaded.activity, { inboxSeenAt: null, whatsNewSeenVersion: null });
    assert.deepEqual(loaded.spend, { thresholdMicroUsd: 7_000_000, periodDays: 3 }, "the rest of the file is kept");
  });

  it("treats a string that is not an instant as nothing seen — it would outsort every job stamp forever", async () => {
    const { root } = await makeTempRoot();
    const path = join(root, "settings.json");
    await writeFile(path, JSON.stringify({ activity: { inboxSeenAt: "not-a-date", whatsNewSeenVersion: "0.5.49" } }), "utf8");
    const loaded = await new AppSettingsFile(path).load();
    assert.deepEqual(loaded.activity, { inboxSeenAt: null, whatsNewSeenVersion: null }, "codex, PR 1087");
    await writeFile(path, JSON.stringify({ activity: { inboxSeenAt: "2026-09-10T12:00:00.000Z", whatsNewSeenVersion: "yesterday" } }), "utf8");
    assert.deepEqual((await new AppSettingsFile(path).load()).activity, { inboxSeenAt: null, whatsNewSeenVersion: null }, "a version that is not one");
  });
});
