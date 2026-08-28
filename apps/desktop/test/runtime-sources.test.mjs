import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shape checks on the pins themselves, offline.
 *
 * The ffmpeg pin died once by being the wrong *kind* of pin rather than a stale one (#581): a
 * mid-month BtbN autobuild, pinned the day it was built and deleted from upstream a fortnight
 * later, which took `npm run package` down on every machine at once. Nothing about that was
 * visible in the file -- one autobuild tag looks exactly like another -- so the rule that makes
 * a pin survive is asserted here instead of only being written down beside it.
 */

const metadata = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "runtime-sources.json"), "utf8"),
);

describe("the pinned ffmpeg build", () => {
  it("is a month-end autobuild, which is the one BtbN keeps for years rather than a fortnight", () => {
    /*
     * BtbN/FFmpeg-Builds util/prunetags.sh deletes every autobuild release outside two windows:
     * KEEP_LATEST=14, the fourteen most recent builds, and KEEP_MONTHLY=24, the newest build of
     * each of the last twenty-four months. Walking the tag list newest-first, the monthly slot
     * goes to the last build of the month -- so a month-end tag is good for about two years and
     * anything else for about two weeks.
     *
     * If this ever fails on a tag that IS a month's final build -- BtbN missing the 31st, say --
     * the pin is fine and this expectation is what needs widening. Check the release list before
     * assuming that: https://github.com/BtbN/FFmpeg-Builds/releases
     */
    const dated = /^autobuild-(\d{4})-(\d{2})-(\d{2})-\d{2}-\d{2}$/.exec(metadata.ffmpeg.release);
    assert.ok(dated, `ffmpeg release "${metadata.ffmpeg.release}" is not a dated BtbN autobuild tag`);
    const [, year, month, day] = dated.map(Number);
    const lastOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    assert.equal(
      day,
      lastOfMonth,
      `ffmpeg is pinned to ${metadata.ffmpeg.release}, a mid-month autobuild BtbN deletes about a fortnight after it is built — pin the last build of a finished month instead`,
    );
  });

  it("is the release both architecture URLs actually point at", () => {
    // The tag is not only documentation: prepare-runtimes writes it into the staged manifest and
    // into the GPL written offer, which then names a release the binaries did not come from.
    for (const arch of ["x64", "arm64"]) {
      assert.ok(
        metadata.ffmpeg[arch].url.includes(`/releases/download/${metadata.ffmpeg.release}/`),
        `the ffmpeg ${arch} URL does not come from ${metadata.ffmpeg.release}`,
      );
    }
  });

  it("points its corresponding-source directions at the same release", () => {
    // WRITTEN-OFFER.ffmpeg.txt gives GPLv3 §6(d) directions to this tree, and §6(d) wants them
    // to lead to the source for *these* binaries. A tag left behind by a pin bump would send
    // people to a different build's components while looking perfectly well-formed.
    assert.ok(
      metadata.ffmpeg.correspondingSourceUrl.endsWith(`/${metadata.ffmpeg.release}`),
      `the corresponding-source URL does not name ${metadata.ffmpeg.release}`,
    );
  });

  it("is a GPL shared build for the architecture it claims", () => {
    // libx264 is GPL-only and the export presets are -crf values an LGPL build ignores, so the
    // flavour in the filename is a functional requirement, not a preference.
    assert.match(metadata.ffmpeg.x64.url, /win64-gpl-shared/);
    assert.match(metadata.ffmpeg.arm64.url, /winarm64-gpl-shared/);
  });
});

describe("every pinned checksum", () => {
  it("is a whole sha256 digest", () => {
    // Cheap insurance against a truncated paste: a short digest fails at the end of a download
    // that has already run, which on a 78MB archive is a slow way to learn about a typo.
    const digests = [];
    const walk = (node, path) => {
      if (node === null || typeof node !== "object") return;
      for (const [key, item] of Object.entries(node)) {
        if (key.toLowerCase().endsWith("sha256") && typeof item === "string") digests.push([`${path}.${key}`, item]);
        else walk(item, `${path}.${key}`);
      }
    };
    walk(metadata, "runtime-sources");
    assert.ok(digests.length > 0, "no checksums were found to check");
    for (const [where, digest] of digests) {
      assert.match(digest, /^[0-9a-fA-F]{64}$/, `${where} is not a 64-character hex digest`);
    }
  });
});
