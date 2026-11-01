import { useEffect, useId, useRef, useState } from "react";
import type { ArtifactSidecar, MediaInfo, MediaMeasurementResult, MediaMeasurementSource, ProductionBundle } from "@arke-studio/contracts";
import { requestMediaMeasurement, useStore } from "../lib/store.js";
import { Button } from "../components/ui.js";

/** Resolve segments to the same physical source the coordinator measures, without inventing metadata. */
export function measurementSubject(production: ProductionBundle, artifacts: readonly ArtifactSidecar[], source: MediaMeasurementSource) {
  if (source.kind === "artifact") {
    const artifact = artifacts.find(item => item.id === source.artifactId);
    return artifact && (artifact.kind === "audio" || artifact.kind === "video")
      ? { source, expectedHash: artifact.hash, info: artifact.mediaInfo } : null;
  }
  const take = production.takes.find(item => item.id === source.takeId);
  const physical = take?.segment ? production.takes.find(item => item.id === take.segment!.passTakeId) : take;
  if (!physical || (physical.kind !== "clip" && physical.kind !== "voice")) return null;
  const record = production.takeMediaInfo[physical.id];
  const info = record && (!physical.mediaHash || record.sourceHash.startsWith(physical.mediaHash)) ? record.mediaInfo : undefined;
  return { source, expectedHash: physical.mediaHash, info, segment: take?.segment };
}

const failures: Record<Extract<MediaMeasurementResult, { status: "failed" }>["reason"], [string, string]> = {
  "not-configured": ["Media tools unavailable", "Measurement needs Studio’s local media tools. The saved clip is still available."],
  "probe-failed": ["Could not measure this source", "The saved clip is still available. Try the local measurement again."],
  "source-changed": ["Source changed", "The file changed while it was being read. Choose a valid saved source before measuring again."],
  unavailable: ["Source unavailable", "Choose an available saved source before measuring again."],
  busy: ["Media tools busy", "Other local measurements are running. Try again shortly."],
  cancelled: ["Measurement stopped", "The saved clip is still available. Try the local measurement again."],
  "save-failed": ["Measurement could not be saved", "The saved clip is still available. Try the local measurement again."],
};

export function SourceMeasurement({ worldId, production, artifacts, source, disabled, onChooseTake }: {
  worldId: string; production: ProductionBundle; artifacts: readonly ArtifactSidecar[]; source: MediaMeasurementSource;
  disabled: boolean; onChooseTake?: () => void;
}) {
  const subject = measurementSubject(production, artifacts, source);
  if (!subject) return null;
  return <Measurement key={JSON.stringify([worldId, production.meta.id, source, subject.expectedHash, subject.segment])}
    worldId={worldId} productionId={production.meta.id} subject={subject} disabled={disabled} onChooseTake={onChooseTake} />;
}

function Measurement({ worldId, productionId, subject, disabled, onChooseTake }: {
  worldId: string; productionId: string; subject: NonNullable<ReturnType<typeof measurementSubject>>;
  disabled: boolean; onChooseTake?: () => void;
}) {
  const { state, connection } = useStore(), descriptionId = useId();
  const [result, setResult] = useState<MediaMeasurementResult | null>(null), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), pending = useRef<AbortController | null>(null);
  const currentWorld = state?.world?.meta.worldId;
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, [currentWorld, connection]);
  const measure = async () => {
    if (pending.current || disabled || connection !== "open" || currentWorld !== worldId) return;
    const request = new AbortController(); pending.current = request;
    setBusy(true); setError(""); setResult(null);
    try {
      const answer = await requestMediaMeasurement({ worldId, productionId, source: subject.source,
        ...(subject.expectedHash ? { expectedHash: subject.expectedHash } : {}) }, request.signal);
      if (!request.signal.aborted) setResult(answer);
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : "Could not measure this source."); }
    finally { if (!request.signal.aborted) { pending.current = null; setBusy(false); } }
  };
  useEffect(() => { setBusy(false); setResult(null); setError(""); }, [currentWorld, connection]);
  const known = subject.info && Number.isFinite(subject.info.durationSec);
  if (currentWorld !== worldId || (known && !busy && !result && !error)) return null;
  const measured: MediaInfo | undefined = result?.status === "measured" ? result.info : undefined;
  const failure = result?.status === "failed" ? result.reason : undefined;
  const blocked = failure === "source-changed" || failure === "unavailable";
  const duration = measured && subject.segment
    ? Math.max(0, Math.min(subject.segment.outSec, measured.durationSec) - subject.segment.inSec) : measured?.durationSec;
  const [title, body] = busy ? ["Measuring source…", "Reading the saved file locally. No generation or upload is running."]
    : measured ? ["Source measured", `${duration!.toFixed(1)} seconds · ${measured.hasAudio ? "audio present" : "no audio"}`]
    : failure ? failures[failure] : error ? ["Could not measure this source", error]
    : ["Source duration unavailable", "Measure the saved file to check its duration and audio. The clip stays unchanged."];
  return <section className="fy-source-measurement" aria-label="Source measurement" aria-busy={busy}>
    <div role="status"><strong>{title}</strong><p id={descriptionId}>{body}</p></div>
    {!measured && (blocked ? onChooseTake && <Button variant="outline" disabled={disabled} onClick={onChooseTake}>Choose another take</Button>
      : <Button disabled={disabled || busy || connection !== "open"} aria-describedby={descriptionId} onClick={() => void measure()}>
        {busy ? "Measuring…" : failure || error ? "Try again" : "Measure media"}
      </Button>)}
  </section>;
}
