import { audioWorldPath } from "./storage.js";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AudioRightsEventSchema, type AudioRightsEvent, type AudioRightsScope } from "@arke-studio/contracts";
import { appendFlushed } from "../flushed-append.js";
import type { WorldStore } from "../world/store.js";

export function effectiveAudioRights(events: readonly AudioRightsEvent[], hash: string, scope: AudioRightsScope) {
  const live = new Map<string, Extract<AudioRightsEvent, { action: "acknowledge" }>>();
  const withdrawn = new Set<string>();
  for (const raw of events) {
    const event = AudioRightsEventSchema.parse(raw);
    if (event.audioHash !== hash) continue;
    if (event.action === "withdraw") {
      withdrawn.add(event.acknowledgementId);
      live.delete(event.acknowledgementId);
    } else if (!withdrawn.has(event.id)) live.set(event.id, event);
  }
  return [...live.values()].filter(event => event.scopes.includes(scope));
}

/** Fail closed on a damaged log. Skipping a malformed withdrawal could restore permission. */
export async function readAudioRights(store: Pick<WorldStore, "dir">): Promise<AudioRightsEvent[]> {
  let text: string;
  try {
    await lstat(join(store.dir, "audio", "rights.jsonl"));
    text = await readFile(await audioWorldPath(store.dir, "audio/rights.jsonl"), "utf8");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw new Error("audio-rights-unavailable"); }
  try {
    if (text.length && !text.endsWith("\n")) throw new Error("torn-rights-log");
    return text.split("\n").filter(line => line.trim()).map(line => AudioRightsEventSchema.parse(JSON.parse(line)));
  } catch { throw new Error("audio-rights-unavailable"); }
}

export async function appendAudioRights(store: WorldStore, input: AudioRightsEvent): Promise<void> {
  const event = AudioRightsEventSchema.parse(input);
  await store.ownedWrite(async () => {
    const events = await readAudioRights(store);
    if (events.some(existing => JSON.stringify(existing) === JSON.stringify(event))) return;
    if (event.action === "acknowledge" && events.some(e => e.action === "acknowledge" && e.id === event.id)) {
      throw new Error("audio-rights-id-conflict");
    }
    if (event.action === "withdraw" && !events.some(e => e.action === "acknowledge" &&
      e.id === event.acknowledgementId && e.audioHash === event.audioHash)) throw new Error("audio-rights-acknowledgement-missing");
    const path = await audioWorldPath(store.dir, "audio/rights.jsonl", true);
    await appendFlushed(path, `${JSON.stringify(event)}\n`);
  });
}
