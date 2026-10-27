import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { SessionFile } from "@arke-studio/contracts";
import { sameDirectory, type OpenCodeV2Http, type V2Envelope } from "./http.js";

const DIRECTORY = ".arke-private-control";
const ID = "arke.studio.private-control.v1";
const SOURCE = `export default {
  id: "${ID}",
  async setup(api) {
    await api.session.hook("retry", event => { event.decision = { retry: false }; });
  }
};
`;

/** Fixed application control code, never instructions supplied by a model or Settings. */
export const PRIVATE_CONTROL_FILES: readonly SessionFile[] = Object.freeze([
  Object.freeze({ name: `${DIRECTORY}/package.json`, contents: '{"type":"module","main":"index.js","private":true}\n' }),
  Object.freeze({ name: `${DIRECTORY}/index.js`, contents: SOURCE }),
]);

export function privateControlDirectory(directory: string): string {
  if (!isAbsolute(directory)) throw new Error("Private native control requires an absolute session directory.");
  const path = resolve(directory, DIRECTORY).replaceAll("\\", "/");
  // Native resource policies use globs. An unqualified path cannot become a broader allow.
  if (path.length > 4096 || path.includes("\0") || [...path].some(character => "*?[]{}!".includes(character))) throw new Error("The private native control path cannot be pinned to a literal policy.");
  return path;
}

/** Native activation/source evidence for the fixed retry control. This is not an OS sandbox
 * or a proof against arbitrary external modification of the host's owned control files. */
export async function privateControlProof(http: OpenCodeV2Http, directory: string, signal: AbortSignal): Promise<string | null | undefined> {
  const source = `${privateControlDirectory(directory)}/index.js`;
  const envelope = await http.req<V2Envelope<Array<{ id?: string; source?: { type?: string; path?: string }; state?: { status?: string }; features?: { server?: boolean } }>>>(
    "GET", "/api/plugin", undefined, { location: directory, signal, responseBytes: 1024 ** 2 });
  if (!sameDirectory(envelope?.location?.directory, directory) || !Array.isArray(envelope.data) || envelope.data.length > 256) return null;
  if (envelope.data.length === 0) return undefined; // measured native location activation is asynchronous
  const external = envelope.data.filter(row => row?.source?.type !== "builtin");
  if (external.length !== 1) return null;
  const control = external[0]!;
  if (!control || control.id !== ID || control.source?.type !== "local" || typeof control.source.path !== "string" || !sameDirectory(control.source.path, source) || control.state?.status !== "active" || control.features?.server !== true) return null;
  return createHash("sha256").update(JSON.stringify([ID, source, PRIVATE_CONTROL_FILES])).digest("hex");
}
