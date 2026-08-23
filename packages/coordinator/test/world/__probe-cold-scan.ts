/* Throwaway measurement probe for the §2.13 cold-scan budget. Not part of the suite. */
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { scanWorld } from "../../src/world/scan.js";

const SHEETS = Number(process.env.PROBE_SHEETS ?? 50);
const ENTRIES = Number(process.env.PROBE_ENTRIES ?? 200);
const TAKES = Number(process.env.PROBE_TAKES ?? 500);
const REPS = Number(process.env.PROBE_REPS ?? 5);
const SCANS = Number(process.env.PROBE_SCANS ?? 3);

async function buildCorpus(dir: string): Promise<number> {
  await mkdir(join(dir, "characters"), { recursive: true });
  await mkdir(join(dir, "canon"), { recursive: true });
  const takeDirBase = join(dir, "productions", "bench", "takes");
  await writeFile(
    join(dir, "world.json"),
    JSON.stringify({
      worldId: "01J8F3K2QW9VZX4N7M0RTYB6ZZ",
      slug: "benchmark",
      schemaVersion: 1,
      name: "Benchmark",
      canonRevision: 1,
      nextCanonId: ENTRIES + 1,
      created: "2026-08-01T00:00:00Z",
      updated: "2026-08-01T00:00:00Z",
    }),
    "utf8",
  );
  await mkdir(join(dir, "productions", "bench", "scenes"), { recursive: true });
  await writeFile(
    join(dir, "productions", "bench", "production.json"),
    JSON.stringify({
      id: "bench",
      format: "video",
      title: "Bench",
      status: "in-progress",
      created: "2026-08-01T00:00:00Z",
      updated: "2026-08-01T00:00:00Z",
    }),
    "utf8",
  );
  const corpusStarted = performance.now();
  const writes: Promise<void>[] = [];
  for (let i = 0; i < SHEETS; i++) {
    writes.push(
      writeFile(
        join(dir, "characters", `char-${i}.md`),
        `---\nid: char-${i}\ntype: character\nname: Character ${i}\nversion: 1\nstatus: locked\ncanonRules: []\nlinks: []\ncreated: "2026-08-01"\nupdated: "2026-08-01"\n---\n\n## Essence\nCharacter number ${i}.\n`,
        "utf8",
      ),
    );
  }
  for (let i = 1; i <= ENTRIES; i++) {
    writes.push(
      writeFile(
        join(dir, "canon", `CANON-${String(i).padStart(3, "0")}.md`),
        `---\nid: CANON-${String(i).padStart(3, "0")}\ntype: lore\ntitle: Entry ${i}\nstatus: settled\nintroducedAt: 1\nsettledAt: 1\nlinks: []\n---\n\nStatement ${i}.\n`,
        "utf8",
      ),
    );
  }
  await Promise.all(writes);
  const takeWrites: Promise<void>[] = [];
  for (let i = 0; i < TAKES; i++) {
    const id = `tk_01J8A${String(i).padStart(21, "0")}`;
    takeWrites.push(
      mkdir(join(takeDirBase, id), { recursive: true }).then(() =>
        writeFile(
          join(takeDirBase, id, "take.json"),
          JSON.stringify({
            id,
            jobId: "jb_01J8E0000000000000000000J1",
            coversShots: ["sh_1"],
            kind: "clip",
            provider: "fal",
            model: "bench",
            provenance: { canonRevision: 1, sheets: {} },
            references: [],
            params: {},
            cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
            dispatchedAt: "2026-08-01T00:00:00Z",
          }),
          "utf8",
        ),
      ),
    );
  }
  await Promise.all(takeWrites);
  return performance.now() - corpusStarted;
}

const label = process.env.PROBE_LABEL ?? "local";
for (let rep = 1; rep <= REPS; rep++) {
  const root = await mkdtemp(join(tmpdir(), "arke-probe-"));
  const dir = join(root, "benchmark");
  const wrote = await buildCorpus(dir);
  const scans: number[] = [];
  for (let s = 0; s < SCANS; s++) {
    const started = performance.now();
    const { bundle, problems } = await scanWorld(dir);
    scans.push(performance.now() - started);
    if (s === 0 && (problems.length !== 0 || bundle.sheets.length !== SHEETS)) {
      console.log(`PROBE-BAD problems=${problems.length} sheets=${bundle.sheets.length}`);
    }
  }
  const best = Math.min(...scans);
  console.log(
    `PROBE ${label} rep=${rep} corpus=${SHEETS}/${ENTRIES}/${TAKES} write=${wrote.toFixed(0)}ms scans=[${scans.map((n) => n.toFixed(0)).join(",")}]ms best=${best.toFixed(0)}ms bestRatio=${(best / wrote).toFixed(2)} firstRatio=${(scans[0]! / wrote).toFixed(2)}`,
  );
  await rm(root, { recursive: true, force: true });
}
