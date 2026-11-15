import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import {
  characterAudioRoute, masterAudioBinding, orderedShots, PreparedReferenceAudioSchema, resolveCast, shotSingsToSong,
  type FrozenMasterAudio, type ManifestModel, type ProductionBundle, type SceneRecord, type Shot, type Sheet,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { AudioMediaTools } from "./media-tools.js";
import { prepareAudio, audioWorldPath } from "./storage.js";
import { resolveMasterAudioReferences } from "./reference-inputs.js";

/**
 * A singer's shot carries its own slice of the song (issue 3186).
 *
 * In a production cut to a song, a shot whose sound is the song and that has not opted out sends
 * the master track's slice under it as a performance-sync reference, so the singer's mouth follows
 * the track. Nothing is chosen per dispatch (SPEC-044 R-26): the shot's place on the Cut, or on the
 * spine before the Cut is saved, is the window, and `masterAudioBinding` and the master slice's own
 * preparation and clearance are reused whole. A shot whose slice cannot be made is named with a
 * short reason and its clip is made without one; the scene is never refused over it.
 */
export interface SongNotSent { shotId: string; number: number; name: string; reason: string }

/** The singer: the shot's speaker, else the first character it cites. */
export function shotSinger(shot: Shot, sheets: readonly Sheet[]): Sheet | undefined {
  const speaker = shot.audio?.speaker;
  const named = speaker === undefined ? undefined : sheets.find((sheet) => sheet.id === speaker && sheet.type === "character");
  return named ?? resolveCast(shot.description, [...sheets]).cast.find((entry) => entry.sheet.type === "character")?.sheet;
}

/**
 * One slice, one staging id, every time it is asked for (issue 3186). A card is priced and then
 * approved, and a plan's quote is compared with its dispatch byte for byte: a fresh id each time
 * would prepare a second copy, stamp it later, and call the approved card stale.
 */
function sliceOperationId(artifactId: string, range: { inSec: number; outSec: number }): string {
  const hex = createHash("sha256").update(`song-slice\n${artifactId}\n${range.inSec}\n${range.outSec}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function resolveSongSlices(store: WorldStore, tools: AudioMediaTools | undefined, production: ProductionBundle,
  scene: SceneRecord, model: ManifestModel, requestId: string, options: { shotIds?: readonly string[]; acknowledge?: boolean; at?: string } = {}):
  Promise<{ references: FrozenMasterAudio[]; notSent: SongNotSent[] }> {
  const references: FrozenMasterAudio[] = [], notSent: SongNotSent[] = [];
  if (production.spine === null) return { references, notSent };
  const sheets = store.getBundle().sheets;
  const route = characterAudioRoute(model);
  const ids = options.shotIds === undefined ? undefined : new Set(options.shotIds);
  for (const shot of orderedShots(scene)) {
    if (!shotSingsToSong(shot) || (ids !== undefined && !ids.has(shot.id))) continue;
    const singer = shotSinger(shot, sheets);
    const name = singer?.name ?? `shot ${shot.number}`;
    const skip = (reason: string) => notSent.push({ shotId: shot.id, number: shot.number, name, reason });
    if (!route?.supportsPerformanceSync) { skip("model takes no song"); continue; }
    if (!tools) { skip("audio tools unavailable"); continue; }
    let binding;
    try { binding = masterAudioBinding(production, shot.id); }
    catch (error) {
      const message = error instanceof Error ? error.message : "";
      skip(["not on the Cut", "on the Cut twice", "song not on the Cut", "not on the song"].includes(message) ? message : "not on the song");
      continue;
    }
    if (binding.range.outSec - binding.range.inSec > route.maxFileDurationSec) { skip(`longer than ${route.maxFileDurationSec}s`); continue; }
    try {
      const operationId = sliceOperationId(binding.artifactId, binding.range);
      // A slice already accepted is read back, never cut again: the receipt is what was cleared.
      const receiptPath = `productions/${production.meta.id}/audio-inputs/${operationId}.json`;
      const receipt = await readFile(await store.ownedWrite(() => audioWorldPath(store.dir, receiptPath, true)), "utf8")
        .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      const prepared = receipt !== null
        ? PreparedReferenceAudioSchema.parse(JSON.parse(receipt))
        : await prepareAudio(store, tools, { kind: "artifact", artifactId: binding.artifactId, range: binding.range }, { operationId });
      const warningCodes = Object.values(prepared.provenance.qualityReport.checks).filter((check) => check.outcome === "warning").map((check) => check.code);
      /*
       * The basis is the person's own act, not a guess about the file: the song is the master
       * track they put on this production, the shot is one they marked as sung to it, and the plan
       * names every shot that sings before a pass is approved. Choosing a cast read is its QC
       * acknowledgement in the same way (SPEC-044 R-15).
       */
      const [frozen] = await resolveMasterAudioReferences(store, production.meta.id, scene.id, [{ operationId, hash: prepared.provenance.outputHash,
        binding, warningCodes, cloudBasis: "authorized" }], `${requestId}/song-${shot.id}`,
        { ...(options.acknowledge === undefined ? {} : { acknowledge: options.acknowledge }), ...(options.at === undefined ? {} : { at: options.at }) });
      if (frozen) references.push({ ...frozen, characterName: name });
    } catch {
      skip("song not cleared");
    }
  }
  return { references, notSent };
}
