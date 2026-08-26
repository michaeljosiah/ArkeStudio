/** Escape a host path for a single-quoted ffmpeg filter option, including Windows drive letters. */
export function ffmpegFilterPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}
