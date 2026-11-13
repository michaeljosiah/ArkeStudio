import { WorldStore } from "../src/world/store.js";
import { readStorageInventory } from "../src/storage/inventory.js";
const dir = process.argv[2]!;
const store = await WorldStore.open(dir);
console.log("outside edits", store.getBundle().externalEdits.length, "canWrite", store.canWrite(), "artifacts", store.getBundle().artifacts.length);
await store.close();
const r = await readStorageInventory({ path: dir, kind: "world" }, new AbortController().signal);
console.log(JSON.stringify(Object.fromEntries(Object.entries(r.counts).map(([k, v]) => [k, `${(v!.bytes / 1024 ** 3).toFixed(2)} GiB · ${v!.files}`]))));
