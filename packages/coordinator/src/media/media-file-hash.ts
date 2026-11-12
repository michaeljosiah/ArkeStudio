import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

export function hashMediaFile(path: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error("media hashing cancelled")); return; }
    const hash = createHash("sha256"), stream = createReadStream(path);
    const abort = () => stream.destroy(new Error("media hashing cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    stream.on("data", bytes => hash.update(bytes)); stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex"))); stream.on("close", () => signal.removeEventListener("abort", abort));
  });
}

