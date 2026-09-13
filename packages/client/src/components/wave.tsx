import { type ReactNode } from "react";

/** Deterministic decorative waveform — seeded by the label, no randomness. */
export function Wave({ seed, width = 290, height = 16 }: { seed: string; width?: number; height?: number }) {
  const bars: ReactNode[] = [];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  for (let x = 0; x + 3 <= width; x += 8) {
    h = (h * 1103515245 + 12345) >>> 0;
    const t = (h % 1000) / 1000;
    const bar = 3 + t * (height - 4);
    bars.push(<rect key={x} x={x} y={(height - bar) / 2} width={3} height={bar} rx={1.5} />);
  }
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <g fill="currentColor">{bars}</g>
    </svg>
  );
}
