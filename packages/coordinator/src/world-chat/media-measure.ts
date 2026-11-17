import { AGENT_SYNC_LIMITS, AgentSyncMeasurementSchema, type AgentMediaInventory, type AgentSyncMeasurement, type MeasureSyncArgs } from "@arke-studio/contracts";
import { withContainedProductionMedia } from "../world/reference-files.js";
import type { AgentMediaTools } from "../media/agent-media-tools.js";
import { measureMouthSync, measureSoundtrackSync } from "../media/measure-sync.js";
import { RetrievalError } from "./retrieval.js";
import type { InspectionSource } from "./media-inspection.js";

/*
 * The measurements of epic #3070 that read a second source. The take is already open as a
 * verified snapshot; the reference gets its own, with the same identity checks, so neither path
 * a decoder sees can be replaced while it reads.
 */

/** 16 kHz mono holds a voice's envelope at 10 ms steps with room to spare. */
const MEASURE_RATE = 16000;
type Stream = AgentMediaInventory["streams"][number];

export const SYNC_LIMITATIONS = {
  common: [
    "Signal measurement: correlation over lags between the take and the reference's loudness. A high correlation says they rise and fall together, not that the words are the same.",
    "The lag is resolved to one step (10 ms for sound, 40 ms for a mouth); a lag outside the searched window is not found.",
    "No speech recognition, listening or judgement of the performance was made.",
  ],
  soundtrack: "Assumes the take's own soundtrack carries the sound it was made to; a take whose sound was replaced or muted says nothing here about its picture.",
  mouth: "Head and camera movement inside the box count as mouth movement, and a mouth that leaves the box is not measured: a coarse proxy for lip sync.",
} as const;

export async function measureSyncInSnapshot(worldDir: string, tools: AgentMediaTools, signal: AbortSignal,
  take: { path: string; stream: Stream; startSec: number; endSec: number }, args: MeasureSyncArgs, reference: InspectionSource): Promise<AgentSyncMeasurement> {
  const monoAudio = tools.monoAudio, grayFrames = tools.grayFrames;
  if (!monoAudio || args.method === "mouth" && !grayFrames) throw new RetrievalError("unavailable", "Local sync measurement is unavailable on this host.");
  const length = take.endSec - take.startSec;
  return withContainedProductionMedia(worldDir, reference.path, reference.expectedHash, signal, async snapshot => {
    const inventory = await tools.probe(snapshot.path, signal);
    const end = reference.endSec ?? inventory.durationSec, startSec = reference.startSec + args.reference.startSec, endSec = startSec + length;
    if (end === null || endSec > end + .000001) throw new RetrievalError("bad-argument", "The reference interval runs past the end of the reference.");
    const candidates = inventory.streams.filter(stream => stream.kind === "audio");
    const selected = args.reference.streamIndex === undefined ? candidates.length === 1 ? candidates[0] : undefined
      : candidates.find(stream => stream.index === args.reference.streamIndex);
    if (!selected) throw new RetrievalError("bad-argument", "Select one explicit audio stream of the reference from inspect_media; ambiguous tracks are never guessed.");
    const referencePcm = await monoAudio(snapshot.path, selected, startSec, endSec, MEASURE_RATE, signal);
    let measured;
    if (args.method === "mouth") {
      const video = await grayFrames!(take.path, take.stream, take.startSec, take.endSec,
        { fps: AGENT_SYNC_LIMITS.mouthFps, edge: AGENT_SYNC_LIMITS.mouthEdge, region: args.region }, signal);
      measured = measureMouthSync(video.frames, video.fps, referencePcm, MEASURE_RATE, args.maxLagSec);
    } else {
      measured = measureSoundtrackSync(await monoAudio(take.path, take.stream, take.startSec, take.endSec, MEASURE_RATE, signal), referencePcm, MEASURE_RATE, args.maxLagSec);
    }
    return AgentSyncMeasurementSchema.parse({ method: args.method, streamIndex: take.stream.index, ...(args.region ? { region: args.region } : {}),
      reference: { source: args.reference.source, sourceHash: snapshot.sourceHash, streamIndex: selected.index,
        startSec: args.reference.startSec, endSec: args.reference.startSec + length },
      maxLagSec: args.maxLagSec, threshold: AGENT_SYNC_LIMITS.follows, ...measured });
  });
}
