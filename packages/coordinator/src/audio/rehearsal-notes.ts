import { readFile } from "node:fs/promises";
import { RehearsalSessionSchema, deriveRehearsalLines, type ClientMessage } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import { audioWorldPath } from "./storage.js";
import { sha256 } from "../world/text-files.js";
import { audioHash } from "./qc.js";
export async function saveRehearsalNote(store: WorldStore, request: Extract<ClientMessage, { kind: "save-rehearsal-note" }>) {
  return store.gateOp(async () => {
    const production = store.getBundle().productions.find(p => p.meta.id === request.productionId);
    const scene = production?.scenes.find(s => s.id === request.sceneId);
    if (!production || (!scene && request.body !== null)) throw new Error("The rehearsal scene is unavailable.");
    const path = `productions/${request.productionId}/rehearsals/${request.rehearsalId}.json`;
    const raw = await readFile(await audioWorldPath(store.dir, path, true), "utf8").catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error;
    });
    if ((raw === null ? null : sha256(raw)) !== request.expectedHash) throw new Error("Rehearsal notes changed. Reload before saving.");
    if (!raw && !scene) throw new Error("This orphaned rehearsal no longer exists.");
    const at = store.now();
    const session = raw ? RehearsalSessionSchema.parse(JSON.parse(raw)) : RehearsalSessionSchema.parse({
      id: request.rehearsalId, sceneId: scene!.id, sceneVersionAtStart: scene!.version, notes: {}, createdAt: at, updatedAt: at });
    if (session.id !== request.rehearsalId || session.sceneId !== request.sceneId) throw new Error("Rehearsal identity changed.");
    if (request.body === null) delete session.notes[request.lineId];
    else {
      const line = deriveRehearsalLines(scene!, store.getBundle().sheets).find(l => l.id === request.lineId);
      if (!line || line.reason) throw new Error("This authored line is unavailable.");
      session.notes[request.lineId] = { authoredTextHash: audioHash(Buffer.from(line.text)), body: request.body };
    }
    session.updatedAt = at;
    await store.commitUnserialised({ kind: "save-rehearsal-note", source: "user", requestId: request.requestId,
      files: !scene && Object.keys(session.notes).length === 0 ? [{ path, action: "delete", baseHash: request.expectedHash }] : [{ path, action: raw ? "replace" : "create", baseHash: request.expectedHash, content: JSON.stringify(session, null, 2) + "\n" }] });
  });
}
