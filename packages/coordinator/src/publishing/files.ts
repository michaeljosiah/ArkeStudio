import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { renameWithRetry } from "../world/atomic.js";
import { lockDownAcl } from "../credentials/store.js";
import { toExtendedLength } from "../world/paths.js";

/** Host-private operational state: acknowledge only after the file has been flushed. */
export async function savePublishingFile(file: string, text: string, secure = true): Promise<void> {
  await mkdir(toExtendedLength(dirname(file)), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(toExtendedLength(temporary), "wx", 0o600);
    try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    if (secure) await lockDownAcl(temporary);
    await renameWithRetry(temporary, file);
  } finally { await rm(toExtendedLength(temporary), { force: true }); }
}

export class PublishingSerial {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => {});
    return result;
  }
  async drain(): Promise<void> { await this.tail; }
}
