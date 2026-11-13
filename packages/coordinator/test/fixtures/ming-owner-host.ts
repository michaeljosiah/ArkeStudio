import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MingProcess } from "../../src/local-ai/ming.js";

const [root, worker] = process.argv.slice(2);
if (!root || !worker) throw new Error("Missing native Ming fixture inputs.");
const owner = new MingProcess(undefined, {prepareCommand: (command, args) => ({command, args: args.slice(1)})});
if (!owner.storageOwner) throw new Error("Native Ming storage owner unavailable.");
await writeFile(join(root, "owner"), owner.storageOwner);
await owner.run({python: process.execPath, worker, args: [], cacheRoot: join(root, "cache")}, new AbortController().signal);
