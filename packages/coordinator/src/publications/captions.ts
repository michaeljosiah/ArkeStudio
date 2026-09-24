import { PublicationFileError } from "./files.js";

export const PUBLICATION_VTT_BYTES = 8 * 1024 * 1024;

/** A deliberately inert WebVTT subset: cue ids, timing and text; no CSS or regions. */
export function validatePublicationVtt(text: string, duration: number): void {
  if (Buffer.byteLength(text, "utf8") > PUBLICATION_VTT_BYTES) throw new PublicationFileError("limit-exceeded", "Publication captions exceed the supported size.");
  const fail = () => { throw new PublicationFileError("invalid-package", "Unsupported or invalid WebVTT captions."); };
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!/^WEBVTT(?:[ \t][^\n]*)?\n\n/.test(lines) || lines.split("\n", 1)[0]!.includes("-->") || lines.includes("\0") || lines.includes("\r")) fail();
  const blocks = lines.trimEnd().split(/\n\n+/).slice(1);
  let previous = -1;
  const stamp = (value: string): number => {
    const m = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)\.(\d{3})$/.exec(value);
    if (!m) { fail(); return 0; }
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
  };
  for (const block of blocks) {
    const rows = block.split("\n");
    if (/^NOTE(?:[ \t]|$)/.test(rows[0]!)) continue;
    if (/^(?:STYLE|REGION)(?:[ \t]|$)/.test(rows[0]!)) { fail(); continue; }
    if (!rows[0]!.includes("-->")) rows.shift();
    const timing = /^(\S+) --> (\S+)$/.exec(rows.shift() ?? "");
    if (!timing || !rows.join("\n").trim()) { fail(); continue; }
    const start = stamp(timing[1]!); const end = stamp(timing[2]!);
    if (!Number.isFinite(end) || start < previous || end <= start || end > duration + 0.05 || rows.some(row => row.includes("-->"))) fail();
    previous = start;
  }
}
