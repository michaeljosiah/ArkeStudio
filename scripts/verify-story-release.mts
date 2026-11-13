import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import path from "node:path";
import { downloadStory } from "../packages/coordinator/src/world/story-download.js";
import { UNDERSONG_RELEASE } from "../packages/coordinator/src/world/undersong-release.js";
import { installSampleWorld } from "../packages/coordinator/src/world/sample-world.js";
import { WorldStore } from "../packages/coordinator/src/world/store.js";

const [scratchArg, localArchive] = process.argv.slice(2);
if (!scratchArg) throw Error("Usage: node --import tsx scripts/verify-story-release.mts NEW_SCRATCH [LOCAL_ARCHIVE]");
const scratch = path.resolve(scratchArg); await fs.mkdir(scratch);
const download = await downloadStory(UNDERSONG_RELEASE, path.join(scratch, "downloads"), {
  signal: new AbortController().signal,
  ...(localArchive ? { fetch: (async () => new Response(Readable.toWeb(createReadStream(localArchive)) as ReadableStream)) as typeof fetch } : {}),
  progress: text => { if (!text.includes("%") || /(?: 0| 25| 50| 75| 100)%/.test(text)) console.log(text); },
});
try {
  const manifest = JSON.parse(await fs.readFile(path.join(download.directory, "story-package.json"), "utf8"));
  for (const file of manifest.files) {
    const full = path.resolve(download.directory, file.path);
    if (!full.startsWith(download.directory + path.sep)) throw Error("Unsafe manifest path");
    const hash = createHash("sha256"); for await (const chunk of createReadStream(full)) hash.update(chunk);
    if ((await fs.stat(full)).size !== file.bytes || hash.digest("hex") !== file.sha256) throw Error("Manifest mismatch: " + file.path);
  }
  const first = await installSampleWorld({ sourceDir: download.directory, appRoot: scratch });
  const second = await installSampleWorld({ sourceDir: download.directory, appRoot: scratch });
  if (first.worldId === second.worldId || first.slug === second.slug) throw Error("Install identity collision");
  const store = await WorldStore.open(path.join(scratch, "worlds", first.slug));
  try {
    const bundle = store.getBundle();
    if (bundle.problems.length) throw Error(JSON.stringify(bundle.problems));
    const references = bundle.props.flatMap(p => p.states).filter(s => s.reference);
    if (references.length < 6) throw Error("Prop references missing");
    console.log(JSON.stringify({ verifiedFiles: manifest.files.length, scanProblems: 0, boundPropStates: references.length, first, second }));
  } finally { await store.close(); }
} finally { await download.dispose(); }
console.log("Verified archive, inventory, native reopen and two independent installations. Scratch copies retained for inspection: " + scratch);
