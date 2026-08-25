import { readFile } from "node:fs/promises";
import { join } from "node:path";

const IDENTITY = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
export const CUSTOM_NODE_IDENTITY_FILE = ".arke-content-id";

/**
 * Read the identity written beside a digest-verified vendored archive. Runtime verification must
 * not depend on Git being installed, and an unmarked user checkout stays unverified.
 */
export async function readCustomNodeRef(nodeDir: string): Promise<string | null> {
  const identity = await readFile(join(nodeDir, CUSTOM_NODE_IDENTITY_FILE), "utf8").catch(() => "");
  const value = identity.trim();
  return IDENTITY.test(value) ? value.toLowerCase() : null;
}
