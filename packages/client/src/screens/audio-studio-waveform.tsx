import { useEffect, useRef, useState } from "react";
import type { AudioWaveform, ResolvedAudioClip } from "@arke-studio/contracts";
import type { WaveformRequest } from "../lib/audio-studio-waveform.js";

export function AudioStudioWaveform({ entry, request }: { entry: ResolvedAudioClip; request: WaveformRequest }) {
  const element = useRef<SVGSVGElement>(null), [waveform, setWaveform] = useState<AudioWaveform | null>(null);
  const source = entry.clip.source;
  useEffect(() => {
    setWaveform(null);
    if (!source || !element.current) return;
    let cancel: (() => void) | undefined;
    const load = () => { cancel ??= request(source, setWaveform); };
    if (typeof IntersectionObserver === "undefined") { load(); return () => cancel?.(); }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { load(); observer.disconnect(); } });
    observer.observe(element.current);
    return () => { observer.disconnect(); cancel?.(); };
  }, [source?.file, source?.hash, request]);
  const paths = (peaks: number[], centre: number) => {
    const { clip } = entry, length = clip.sourceOut - clip.sourceIn, period = length - clip.loopFade;
    return Array.from({ length: 100 }, (_, i) => {
      const local = Math.floor(i / 100 * entry.samples) + (clip.loopOffset ?? 0);
      const inWindow = clip.loop ? local < length ? local : clip.loopFade + (local - length) % period : local;
      const index = Math.floor((clip.sourceIn + inWindow) / waveform!.samples * peaks.length);
      const peak = inWindow < length ? peaks[index] ?? 0 : 0;
      return `M${i} ${centre - peak * 8}V${centre + peak * 8}`;
    }).join("");
  };
  return <svg ref={element} className="fy-audio-waveform" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
    {waveform && <><path d={paths(waveform.left, 10)} /><path d={paths(waveform.right, 30)} /></>}
  </svg>;
}
