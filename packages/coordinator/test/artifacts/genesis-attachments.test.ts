import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "../tmp.js";
import {
  attachToSandbox,
  GENESIS_ATTACHMENTS_DIR,
  sandboxAttachments,
} from "../../src/artifacts/genesis-attachments.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-02T09:00:00.000Z";

/** A file somewhere else on the machine, of the kind someone would hand to a conversation. */
async function source(name: string, content: Buffer | string): Promise<string> {
  const dir = await tempDir("gen-src");
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe("attaching before the world exists", () => {
  it("holds the file in the sandbox the agent works in, under a name it can be told", async () => {
    const sandbox = await tempDir("gen-box");
    const outcome = await attachToSandbox(sandbox, await source("Series Bible.md", "# The Undersong\n"));
    assert.ok(!("reason" in outcome));
    assert.equal(outcome.name, "series-bible.md");
    assert.equal(outcome.kind, "document");
    assert.equal(
      await readFile(join(sandbox, GENESIS_ATTACHMENTS_DIR, "series-bible.md"), "utf8"),
      "# The Undersong\n",
      "the agent can read it from its own working directory",
    );
  });

  it("keeps both when two files arrive under the same name", async () => {
    const sandbox = await tempDir("gen-box");
    const first = await attachToSandbox(sandbox, await source("notes.md", "the first"));
    const second = await attachToSandbox(sandbox, await source("notes.md", "the second"));
    assert.ok(!("reason" in first) && !("reason" in second));
    assert.equal(first.name, "notes.md");
    assert.equal(second.name, "notes-2.md", "the second is not the first");
    assert.deepEqual((await readdir(join(sandbox, GENESIS_ATTACHMENTS_DIR))).sort(), ["notes-2.md", "notes.md"]);
  });

  it("turns away what it cannot weigh, and says where it can be weighed", async () => {
    // There is no ledger, no disk report and no consent screen before a world exists. Rather
    // than copy 101 MB into a sandbox that may be swept in a minute, say so.
    const sandbox = await tempDir("gen-box");
    const outcome = await attachToSandbox(sandbox, await source("big.bin", Buffer.alloc(101 * 1024 * 1024)));
    assert.ok("reason" in outcome);
    assert.match(outcome.reason, /once the world exists/);
    assert.deepEqual(await readdir(join(sandbox, GENESIS_ATTACHMENTS_DIR)).catch(() => []), [], "nothing was copied");
  });

  it("says plainly when the file is not there to be read", async () => {
    const sandbox = await tempDir("gen-box");
    const outcome = await attachToSandbox(sandbox, join(sandbox, "no-such-file.md"));
    assert.ok("reason" in outcome && outcome.reason.includes("not readable"));
  });

  it("follows the conversation into the world at Begin", async () => {
    // The journey that matters: handed over with no world in sight, and afterwards ordinary
    // artifacts — sidecar, hash, name and kind — indistinguishable from files picked later.
    const sandbox = await tempDir("gen-box");
    await attachToSandbox(sandbox, await source("Series Bible.md", "# The Undersong\n"));
    await attachToSandbox(sandbox, await source("harbour.png", "PNG-ish bytes"));

    const store = await WorldStore.open(await makeTempWorld(), { clock: CLOCK });
    try {
      const waiting = await sandboxAttachments(sandbox);
      assert.equal(waiting.length, 2);
      for (const path of waiting) {
        const filed = await fileArtifact(store, { sourcePath: path });
        assert.equal(filed.outcome, "filed");
      }

      // The world was not empty to begin with — these two joined what was already there.
      const arrived = store
        .getBundle()
        .artifacts.filter((a) => ["harbour.png", "series-bible.md"].includes(a.file))
        .map((a) => [a.file, a.kind] as const)
        .sort();
      assert.deepEqual(
        arrived,
        [
          ["harbour.png", "image"],
          ["series-bible.md", "document"],
        ],
        "both arrived, still recognisable, with their kinds read from their names",
      );
    } finally {
      // Closed even when an assertion fails: an open world holds the runner open for good.
      await store.close();
    }
  });

  it("lists nothing for a conversation nobody attached anything to", async () => {
    assert.deepEqual(await sandboxAttachments(await tempDir("gen-box")), []);
  });
});
