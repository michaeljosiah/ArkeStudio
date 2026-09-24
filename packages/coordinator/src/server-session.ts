import { randomUUID } from "node:crypto";
import { mkdir, open, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { lockDownAcl } from "./credentials/store.js";
import { renameWithRetry } from "./world/atomic.js";

/** The same private handoff consumed by Vite; no token is put in logs or served by HTTP. */
export async function writeServerSession(path: string, session: { port: number; token: string }) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await lockDownAcl(temporary);
    await file.writeFile(JSON.stringify(session) + "\n");
    await file.sync();
    await file.close();
    await renameWithRetry(temporary, path);
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  // Leave the expired handoff on shutdown. Deleting by pathname could remove a new server's
  // replacement after it acquired the same port; the next successful bind replaces this file.
}
