import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compareVersions,
  newestVersion,
  orderReleases,
  parseReleaseCard,
  unreadCount,
  unreadReleases,
  type ReleaseCard,
} from "../src/lib/release-notes.js";
import { dayLabel, shortDate } from "../src/lib/format.js";

/**
 * Release cards (SPEC-016 R-18; design turn 136). The file is front matter and paragraphs; the
 * bundler gathers them, and this is the reading of one.
 */

const RAW = `---
title: A world remembers why it was made
date: 2026-08-23
picture: picture.jpg
---
The world door produced a cast, some places and a few open questions
and threw away the reasoning that produced all three.

Worlds can be renamed. The name is a label and the folder underneath never moves.
`;

const card = (version: string, date = "2026-08-01"): ReleaseCard => ({
  version,
  tag: `v${version}`,
  title: version,
  date,
  paragraphs: ["…"],
  picture: null,
});

describe("a release card is read from its file", () => {
  it("takes the title and date from the front matter and folds each paragraph onto one line", () => {
    const read = parseReleaseCard("v0.5.47", RAW, (file) => (file === "picture.jpg" ? "./picture.jpg" : null));
    assert.ok(read);
    assert.equal(read.version, "0.5.47");
    assert.equal(read.tag, "v0.5.47");
    assert.equal(read.title, "A world remembers why it was made");
    assert.equal(read.date, "2026-08-23");
    assert.equal(read.picture, "./picture.jpg");
    assert.equal(read.paragraphs.length, 2);
    assert.match(read.paragraphs[0]!, /^The world door produced .* all three\.$/);
    assert.equal(read.paragraphs[0]!.includes("\n"), false, "a wrapped source line is one paragraph on screen");
  });

  it("takes the picture the front matter names, and none when the build did not carry it", () => {
    const named = RAW.replace("picture: picture.jpg", "picture: activity-hero.jpg");
    const resolved = parseReleaseCard("v0.5.49", named, (file) => (file === "activity-hero.jpg" ? "./hero.jpg" : null));
    assert.equal(resolved?.picture, "./hero.jpg");
    assert.equal(parseReleaseCard("v0.5.49", named, () => null)?.picture, null, "a name the build lacks is no picture");
    assert.equal(parseReleaseCard("v0.5.49", RAW.replace("picture: picture.jpg\n", ""), () => "./any.jpg")?.picture, null, "no name, no picture");
  });

  it("reads Windows line endings the same way", () => {
    const read = parseReleaseCard("v0.5.47", RAW.replace(/\n/g, "\r\n"), () => null);
    assert.equal(read?.paragraphs.length, 2);
  });

  it("refuses a card with no title, no date, a malformed date, or no paragraph", () => {
    assert.equal(parseReleaseCard("v1", "---\ndate: 2026-08-23\n---\nwords", () => null), null);
    assert.equal(parseReleaseCard("v1", "---\ntitle: T\n---\nwords", () => null), null);
    assert.equal(parseReleaseCard("v1", "---\ntitle: T\ndate: 23 Aug\n---\nwords", () => null), null);
    assert.equal(parseReleaseCard("v1", "---\ntitle: T\ndate: 2026-02-31\n---\nwords", () => null), null, "a day that is not on the calendar");
    assert.ok(parseReleaseCard("v1", "---\ntitle: T\ndate: 2028-02-29\n---\nwords", () => null), "a leap day is");
    assert.equal(parseReleaseCard("v1", "---\ntitle: T\ndate: 2026-08-23\n---\n\n", () => null), null);
    assert.equal(parseReleaseCard("v1", "no front matter", () => null), null);
  });
});

describe("versions order numerically, newest first", () => {
  it("compares dotted numbers by number, not by string", () => {
    assert.ok(compareVersions("0.5.10", "0.5.9") > 0);
    assert.ok(compareVersions("0.5.9", "0.5.10") < 0);
    assert.equal(compareVersions("v0.5.9", "0.5.9"), 0);
    assert.ok(compareVersions("1.0.0", "1.0.0-beta.1") > 0, "a pre-release sorts below its release");
  });

  it("compares pre-release identifiers the way SemVer does", () => {
    assert.ok(compareVersions("1.0.0-beta.10", "1.0.0-beta.2") > 0, "numeric identifiers by number");
    assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0, "a shorter matching set sorts lower");
    assert.ok(compareVersions("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0, "numeric below alphanumeric");
    assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-alpha.10") > 0, "alphanumeric identifiers lexically");
    assert.equal(compareVersions("1.0.0-rc.1", "v1.0.0-rc.1"), 0);
    assert.deepEqual(unreadReleases([card("1.0.0-beta.2"), card("1.0.0-beta.10")], "1.0.0-beta.2").map((c) => c.version), ["1.0.0-beta.10"]);
  });

  it("orders cards newest first", () => {
    const ordered = orderReleases([card("0.5.9"), card("0.5.47"), card("0.5.10")]);
    assert.deepEqual(ordered.map((c) => c.version), ["0.5.47", "0.5.10", "0.5.9"]);
  });
});

describe("what has not been read (SPEC-014 R-24, R-25)", () => {
  const cards = [card("0.5.41"), card("0.5.47"), card("0.5.20")];

  it("a version never recorded counts only the newest card — a fresh install announces one release", () => {
    assert.deepEqual(unreadReleases(cards, null).map((c) => c.version), ["0.5.47"]);
  });

  it("counts every card newer than the one last read, and nothing once the newest is read", () => {
    assert.deepEqual(unreadReleases(cards, "0.5.20").map((c) => c.version), ["0.5.47", "0.5.41"]);
    assert.deepEqual(unreadReleases(cards, "0.5.47"), []);
    assert.deepEqual(unreadReleases(cards, "0.6.0"), [], "a version newer than any card is not unread");
  });

  it("has nothing to say with no cards", () => {
    assert.deepEqual(unreadReleases([], null), []);
  });

  it("counts an update the updater has found as unread until it is read (codex, PR 1087)", () => {
    assert.equal(unreadCount(cards, "0.5.47", "0.5.50"), 1, "newer than anything read");
    assert.equal(unreadCount(cards, "0.5.50", "0.5.50"), 0, "read, though not yet installed");
    assert.equal(unreadCount(cards, "0.5.20", "0.5.50"), 3, "two cards and the update");
    assert.equal(unreadCount(cards, null, null), 1);
    assert.equal(unreadCount([], null, "0.5.50"), 1, "an update with no cards at all is still news");
    assert.equal(newestVersion(cards, "0.5.50"), "0.5.50", "reading What's new marks the update");
    assert.equal(newestVersion(cards, "0.5.45"), "0.5.47", "or the newest card when that is newer");
    assert.equal(newestVersion([], null), null);
  });
});

describe("the day a stamp falls on, as a feed labels it", () => {
  const now = new Date(2026, 8, 10, 15, 30); // 10 Sep 2026, local

  it("says today, yesterday, then counts", () => {
    assert.equal(dayLabel(new Date(2026, 8, 10, 1, 0).toISOString(), now), "today");
    assert.equal(dayLabel(new Date(2026, 8, 9, 23, 59).toISOString(), now), "yesterday");
    assert.equal(dayLabel(new Date(2026, 8, 8, 12, 0).toISOString(), now), "2 days ago");
    assert.equal(dayLabel(new Date(2026, 8, 1, 12, 0).toISOString(), now), "last week");
    assert.equal(dayLabel(new Date(2026, 7, 20, 12, 0).toISOString(), now), "3 weeks ago");
  });

  it("reads a date alone as a local day, so an evening release keeps its date west of Greenwich", () => {
    assert.equal(dayLabel("2026-09-10", now), "today");
    assert.equal(dayLabel("2026-09-08", now), "2 days ago");
  });

  it("formats a date alone as that local day, so the card's date agrees with its group", () => {
    assert.equal(shortDate("2026-09-10"), new Date(2026, 8, 10).toLocaleDateString(undefined, { month: "short", day: "numeric" }));
  });

  it("names a stamp it cannot read rather than inventing a day", () => {
    assert.equal(dayLabel("not a date", now), "earlier");
  });
});
