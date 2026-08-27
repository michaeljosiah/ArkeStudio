import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { BIBLE_PATH } from "@arke-studio/contracts";
import { FsWorldProvider } from "../../src/world/provider.js";
import { readBible, saveBible } from "../../src/world/bible.js";
import { WorldStore } from "../../src/world/store.js";
import { closeOnCleanup, tempDir } from "../tmp.js";

/**
 * A world born from a conversation keeps what the conversation was about (master §4.5).
 *
 * Everything else the world door produced had somewhere to live — the cast became sheets, the
 * places became sheets, the open questions became canon. The reasoning that produced all three
 * had nowhere, so it stayed in a genesis sandbox that is deleted the moment the world opens. The
 * bible is where it goes, and it goes there at v1, ungated, editable on arrival.
 */

const CLOCK = () => "2026-08-22T09:30:00.000Z";

const THROUGH_LINE = [
  "## What this is",
  "",
  "A Cinderella told in Lagos, where the fairy godmother is a company registry.",
  "",
  "## The turn",
  "",
  "The man buying out the boy's family is the girl's father, and he has been looking for her",
  "since before either of them was born into money.",
].join("\n");

describe("the bible a world is born with", () => {
  it("writes bible.md at v1 with the conversation's prose, and records the change", async () => {
    const root = await tempDir("arke-genesis-bible-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    closeOnCleanup(() => provider.close());
    const { worldId, slug } = await provider.createWorld({
      name: "Third Mainland",
      logline: "A hard-working girl, a costume party, a hostile takeover.",
      bible: THROUGH_LINE,
    });

    const bible = await readBible(join(root, "worlds", slug));
    assert.equal(bible.present, true, "the world has a bible on the day it is made");
    assert.equal(bible.version, 1, "born at v1, like any other first version");
    assert.match(bible.text, /fairy godmother is a company registry/);
    assert.match(bible.text, /## The turn/, "the headings survive — it is Markdown, not a blob");

    // Frontmatter, so the first save has a version to move off rather than a bare file to guess at.
    const raw = await readFile(join(root, "worlds", slug, BIBLE_PATH), "utf8");
    assert.match(raw, /^---\n/, "written with frontmatter the editor and the committer both read");

    const bundle = await provider.loadWorld(worldId);
    const line = bundle.changes.find((c) => c.entity === "bible");
    assert.ok(line, "the history screen can say where the bible came from");
    assert.equal(line.toVersion, 1);
    assert.equal(line.source, "genesis");
  });

  it("leaves no bible when the door had nothing to write", async () => {
    const root = await tempDir("arke-genesis-nobible-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    closeOnCleanup(() => provider.close());
    // Typing a name and pressing Begin. There was no conversation, so there is nothing of the
    // author's to keep, and an empty document with a heading in it would be worse than none.
    const { worldId, slug } = await provider.createWorld({ name: "Third Mainland" });

    await assert.rejects(
      () => stat(join(root, "worlds", slug, BIBLE_PATH)),
      "absent, not empty",
    );
    assert.equal((await readBible(join(root, "worlds", slug))).present, false);
    const bundle = await provider.loadWorld(worldId);
    assert.equal(
      bundle.changes.filter((c) => c.entity === "bible").length,
      0,
      "and the log does not claim a bible was written",
    );
  });

  it("is an ordinary v1: the first edit moves it to v2 and keeps v1 in history", async () => {
    const root = await tempDir("arke-genesis-bible-edit-");
    const provider = new FsWorldProvider(root, { clock: CLOCK });
    closeOnCleanup(() => provider.close());
    const { slug } = await provider.createWorld({ name: "Third Mainland", bible: THROUGH_LINE });
    await provider.close();

    const dir = join(root, "worlds", slug);
    const store = await WorldStore.open(dir, { clock: CLOCK });
    closeOnCleanup(() => store.close());
    // No accept step, and none is wanted: the bible is the one file the author rewrites without
    // asking anyone, which is the whole reason genesis may write it unasked.
    const record = await saveBible(store, "## What this is\n\nRewritten on arrival.", {
      source: "editor",
      baseVersion: 1,
    });
    assert.equal(record.fromVersion, 1);
    assert.equal(record.toVersion, 2);

    assert.equal((await readBible(dir)).version, 2);
    const kept = await readFile(join(dir, ".history", "bible", "v1.md"), "utf8");
    assert.match(kept, /company registry/, "what genesis wrote is a restore away, not gone");
  });
});
