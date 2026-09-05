import { open } from "node:fs/promises";
import { toExtendedLength } from "./world/paths.js";

interface AppendHandle {
  writeFile(data: string, encoding: "utf8"): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface FlushedAppendDeps {
  open?: (path: string, flags: "a") => Promise<AppendHandle>;
}

/** Append a complete serialized row and flush its file before acknowledging it (SPEC-009
 * §2.2.1). The caller owns directory creation and its WriteQueue; a flush is not a mutex.
 * Never retry here: a failed write or sync leaves an uncertain outcome, not proof of absence. */
export async function appendFlushed(path: string, line: string, deps: FlushedAppendDeps = {}): Promise<void> {
  const handle = await (deps.open ?? open)(toExtendedLength(path), "a");
  try {
    await handle.writeFile(line, "utf8");
    await handle.sync();
  } catch (error) {
    // Preserve the failure that made the append uncertain even if closing also fails.
    await handle.close().catch(() => {});
    throw error;
  }
  await handle.close();
}
