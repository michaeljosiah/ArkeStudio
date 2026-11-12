import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AppStorageService } from "../../src/storage/service.js";
import { ImportFileStorage } from "../../src/storage/import-files.js";

const root = process.argv[2]!;
const storage = new AppStorageService({ appRoot: root, native: {
  setRoots() {}, async stop() {}, async probe(rootId) {
    return { state: "measured", source: "host-provided", limitations: [], capacity: { volumeId: "world-volume", mappingRevision: rootId,
      measuredAt: Date.now(), availableBytes: 100 * 1024 ** 3, totalBytes: 200 * 1024 ** 3 } };
  },
} });
const space = new ImportFileStorage(storage);
await space.reserve(join(root, "artifacts"), 1024, new AbortController().signal);
const rootId = storage.reservations.snapshot().records[0]!.demands[0]!.rootId;
const other = await storage.reservations.reserve({ id: "unrelated_import", owner: { kind: "import", id: "unrelated_import" }, demands: [{ rootId, remainingBytes: 1 }] });
if (other.status !== "reserved") throw new Error("Synthetic unrelated import was not reserved.");
await writeFile(join(root, "artifacts", "retained.bin"), "KEEP_AFTER_RESTART");
// Stop the real host process with both planning intents retained. No native worker survives.
await storage.stop();
