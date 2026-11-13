/**
 * FFmpeg 7 introduced option values loaded with -/option; FFmpeg 9 removed the old
 * filter_complex_script spelling. Keep graphs in files on either generation, because an
 * inline graph can exceed Windows' process argument limit long before the graph byte budget.
 * Release builds identify themselves directly; git/nightly builds expose their libavutil ABI
 * (59 began with FFmpeg 7). The supplied text must come from this executable's -version call.
 */
export function ffmpegGraphFileOption(versionOutput: string | Uint8Array): "-/filter_complex" | "-filter_complex_script" {
  const text = typeof versionOutput === "string" ? versionOutput : new TextDecoder().decode(versionOutput);
  const release = /^ffmpeg version n?(\d+)(?:[.\s-]|$)/m.exec(text);
  if (release) return Number(release[1]) >= 7 ? "-/filter_complex" : "-filter_complex_script";
  const library = /^libavutil\s+(\d+)\./m.exec(text);
  if (library) return Number(library[1]) >= 59 ? "-/filter_complex" : "-filter_complex_script";
  throw new Error("The FFmpeg version could not be identified for file-based filter graphs");
}
