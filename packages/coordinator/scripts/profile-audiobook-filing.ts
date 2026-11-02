import { cp, mkdir, mkdtemp, readFile, writeFile, rm, statfs } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { newId, type ArtifactSidecar } from "@arke-studio/contracts";
import { WorldStore } from "../src/world/store.js";
import { fileGeneratedArtifact } from "../src/artifacts/filing.js";
import { updateAudiobook } from "../src/productions/audiobook.js";
import { writeSpeechWav } from "../src/audio/speech-wav.js";
const label = process.argv[2] ?? "optimized",
  counts = (process.argv[3] ?? "0,500,3750").split(",").map(Number),
  productionId = "the-ledger-of-nights";
if (
  !["baseline", "optimized"].includes(label) ||
  counts.some((n) => !Number.isInteger(n) || n < 0 || n > 10000)
)
  throw Error(
    "Use baseline|optimized and comma-separated artifact counts 0..10000. Run from the repository root.",
  );
const root = await mkdtemp(join(tmpdir(), "arke-filing-profile-"));
const cleanupPath = resolve(root);
if (relative(resolve(tmpdir()), cleanupPath).startsWith("..") || !cleanupPath.includes("arke-filing-profile-"))
  throw Error("Unsafe cleanup");

try {
  const disk = await statfs(root);
  console.log(
    JSON.stringify({
      label,
      node: process.version,
      freeGiB: (disk.bavail * disk.bsize) / 2 ** 30,
      backgroundLoad: "not controlled; local synthetic workload",
      cuts: 30,
    }),
  );
  const sourcePath = join(root, "cut.wav");
  await writeFile(sourcePath, writeSpeechWav({ rate: 24000, samples: new Float32Array(2400) }));
  for (const artifacts of counts)
    for (const readers of [1, 3]) {
      const dir = join(root, `${artifacts}-${readers}`);
      await cp(resolve("fixtures/worlds/the-undersong"), dir, { recursive: true });
      const artifactDir = join(dir, "artifacts");
      await mkdir(artifactDir, { recursive: true });
      for (let first = 0; first < artifacts; first += 32)
        await Promise.all(
          Array.from({ length: Math.min(32, artifacts - first) }, async (_, offset) => {
            const n = first + offset,
              file = `profile-${n}.wav`;
            await writeFile(join(artifactDir, file), "fixture");
            const sidecar: ArtifactSidecar = {
              id: newId("ar"),
              kind: "audio",
              file,
              hash: "sha256:0000000000000000",
              origin: { by: "system", producedBy: "profile" },
              links: [],
              created: "2026-11-02T00:00:00Z",
            };
            await writeFile(join(artifactDir, file + ".json"), JSON.stringify(sidecar));
          }),
        );
      const chapterDir = join(dir, "productions", productionId, "chapters"),
        chapterText = await readFile(join(chapterDir, "01-neap.md"), "utf8");
      for (let n = 1; n <= 3; n++)
        await writeFile(
          join(chapterDir, `profile-${n}.md`),
          chapterText.replace("id: neap", `id: profile-${n}`),
        );
      const store = await WorldStore.open(dir);
      let scans = 0,
        scanMs = 0,
        filingMs = 0,
        recordMs = 0,
        probeMs = 0;
      if (store.getBundle().artifacts.length < artifacts)
        throw Error("Synthetic artifacts did not validate.");
      const gate = store.gateOp.bind(store);
      if (label === "baseline") store.gateOp = (work, precondition) => gate(work, precondition); // retain the original final rescan
      const live = store as unknown as { rescan(paths?: string[]): Promise<void> };
      const actual = live.rescan.bind(store);
      live.rescan = async (...args: [string[]?]) => {
        const t = performance.now();
        scans++;
        try {
          return await actual(...args);
        } finally {
          scanMs += performance.now() - t;
        }
      };
      const start = performance.now();
      try {
        await Promise.all(
          Array.from({ length: readers }, async (_, reader) => {
            const chapterId = `profile-${reader + 1}`,
              chapter = { file: chapterId, version: 4, hash: "sha256:0000000000000000" };
            for (let cut = reader; cut < 30; cut += readers) {
              const block = `p${cut}.0`,
                generation = {
                  source: "audiobook" as const,
                  productionId,
                  chapterId,
                  chapterVersion: 4,
                  block,
                  paragraph: cut,
                  textHash: "sha256:0000000000000000",
                  provider: "test",
                  model: "test",
                  voiceId: "test",
                  parts: 1,
                  characters: 20,
                  estimatedMicroUsd: 0,
                  costMicroUsd: 0,
                };
              let t = performance.now();
              const artifact = await fileGeneratedArtifact(store, {
                sourcePath,
                generation,
                production: productionId,
                mediaProbe: {
                  durationSec: async () => 0.1,
                  info: async () => {
                    const p = performance.now();
                    probeMs += performance.now() - p;
                    return { durationSec: 0.1, hasAudio: true };
                  },
                },
              });
              filingMs += performance.now() - t;
              t = performance.now();
              await updateAudiobook(store, productionId, chapter, (current) => ({
                ...current,
                takes: {
                  ...current.takes,
                  [block]: {
                    artifactId: artifact.id,
                    textHash: generation.textHash,
                    reader: { provider: "test", model: "test", voiceId: "test" },
                    assigned: { provider: "test", model: "test", voiceId: "test" },
                    format: "wav",
                    characters: 20,
                    parts: 1,
                    estimatedMicroUsd: 0,
                    costMicroUsd: 0,
                    madeAt: new Date().toISOString(),
                  },
                },
              }));
              recordMs += performance.now() - t;
            }
          }),
        );
        const row = {
          label,
          artifacts,
          readers,
          cuts: 30,
          elapsedMs: Math.round(performance.now() - start),
          scans,
          scanMs: Math.round(scanMs),
          filingMs: Math.round(filingMs),
          recordMs: Math.round(recordMs),
          providerMs: 0,
          transcriptionMs: 0,
          probeMs: Math.round(probeMs),
        };
        console.log(JSON.stringify(row));
      } finally {
        await store.close();
      }
    }
} finally {
  await rm(cleanupPath, { recursive: true, force: true, maxRetries: 5 });
}
