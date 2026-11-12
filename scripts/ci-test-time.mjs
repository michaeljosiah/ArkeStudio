// A second test reporter for the coordinator shard (issue 2825): each test file's wall time, and
// how much of it its tests took. The rest is time outside the tests — starting the process, tsx's
// loader and the import graph, then exit — which is the cost a loader strategy would change. The
// review measured about 1.1s of it a file; a week of these, on both platforms, says what it is
// before anything is chosen.
//
// Why not time to first result, which is what was asked for: a file's own events reach the
// parent's reporters only once the file has finished, replayed in order and without timestamps,
// so the moment its first test began cannot be seen from here. Its total and its tests' durations
// can, and the difference holds the load time with the exit after it.
import { resolve } from "node:path";

export default async function* timeOutsideTests(source) {
  const files = new Map();
  for await (const event of source) {
    const data = event.data;
    const duration = data?.details?.duration_ms;
    if (data?.nesting !== 0 || typeof data.file !== "string" || typeof duration !== "number") continue;
    // The file's own entry is named by its path; its top-level tests and suites by their titles.
    const own = resolve(data.name) === resolve(data.file);
    const entry = files.get(data.file) ?? { file: data.file, wallMs: 0, testsMs: 0 };
    if (own && event.type === "test:complete") entry.wallMs = duration;
    else if (!own && (event.type === "test:pass" || event.type === "test:fail")) entry.testsMs += duration;
    else continue;
    files.set(data.file, entry);
  }
  for (const entry of files.values()) yield `${JSON.stringify(entry)}\n`;
}
