import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  IDLE_UPDATE_STATE,
  deriveDiagnostics,
  type ClientState,
  type DiagnosticsSources,
} from "@arke-studio/contracts";
import { join } from "node:path";
import { AppLog } from "../../src/app-log.js";
import { buildDiagnosticsBundle } from "../../src/diagnostics.js";
import { SecretRegistry, diagnosticsBoundary, scrubAbsolutePaths } from "../../src/redact.js";
import { tempDir } from "../tmp.js";

/**
 * SPEC-032 §1.8, §2.6 (#556): what a diagnostics record may never carry — a secret, an
 * absolute filesystem path, world content — asserted by a property test over generated
 * application state rather than three examples (R-32, matrix rows 22–26).
 *
 * Seeded, so a failure replays: the seed is in the assertion message, and pinning `SEED_BASE`
 * to it reproduces the exact state that leaked.
 */

/** mulberry32 — a tiny deterministic PRNG; quality is irrelevant, replayability is the point. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED_BASE = 20260828;
const RUNS = 25;

// Distinctive enough that a substring search cannot miss a leak, and free of characters JSON
// escaping would re-spell (a backslash in a path serialises as two, so the assertions search
// for the path's segments rather than the path).
const SECRET = "sk-arke-property-19gkq0-secret";
const PATH_SEGMENT = "prop-leak-dirname";
const WINDOWS_PATH = `C:\\Users\\prop\\AppData\\${PATH_SEGMENT}\\model.safetensors`;
const POSIX_PATH = `/Users/prop/${PATH_SEGMENT}/model.safetensors`;
const UNC_PATH = `\\\\propserver\\share\\${PATH_SEGMENT}\\weights.bin`;
const WORLD_NAME = "The Drowned Bellmaker Of Property Harbour";
const PROMPT = "a heron made of bells over the drowned city at slack water";

const PATHS = [WINDOWS_PATH, POSIX_PATH, UNC_PATH];

/** Free-text fields a subsystem could route hostile text into, chosen per run. */
function generatedSources(random: () => number): DiagnosticsSources {
  const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!;
  const path = pick(PATHS);
  const engineDetail = pick([
    `the child at ${path} exited with code 1`,
    `spawn failed: ${path} rejected the key ${SECRET}`,
    `${path}: ENOENT`,
  ]);
  const componentDetail = pick([
    `needs 17 GB plus room to work; D: has 4 GB free (${path})`,
    `could not remove ${path} — retry with ${SECRET}`,
  ]);
  const queueReason = pick([
    `FAL rejected the key ${SECRET} (HTTP 401)`,
    `offline — last request from ${path} failed`,
  ]);
  const recipeReason = pick([
    `${path} does not match its pinned version`,
    `1 of 1 model files missing from ${path}`,
  ]);
  return {
    version: "0.1.0",
    health: {
      coordinator: { status: "healthy" },
      harness: { status: "healthy" },
      voice: { status: "healthy" },
    },
    env: null,
    runtime: null,
    harness: null,
    harnessInfo: null,
    setup: {
      components: [
        {
          id: "comfyui-weights-prop-recipe",
          displayName: "Property weights",
          purpose: "test",
          sizeMb: 1000,
          state: "blocked",
          bytesDone: 0,
          bytesTotal: 0,
          bytesPerSecond: null,
          detail: componentDetail,
          blockedBy: "disk",
          blockedVolumeRoot: "D:\\",
          blockedNeedMb: 17408,
          blockedFreeMb: 4096,
          blockedAt: "2026-08-28T11:00:00.000Z",
        },
      ],
      running: false,
      diskFreeMb: 4096,
      diskCheckedAt: "2026-08-28T11:00:00.000Z",
    },
    comfyui: {
      engine: {
        source: "user-path",
        state: "failed",
        locality: "local",
        location: null,
        version: null,
        instanceId: "prop1234prop1234",
        detail: engineDetail,
        detected: [],
      },
      recipes: [
        {
          recipeId: "prop-recipe",
          recipeVersion: 1,
          displayName: "Property recipe",
          capability: "video",
          state: "disabled",
          reason: recipeReason,
          reasonKind: random() < 0.5 ? "engine" : "digest",
        },
      ],
      checkedAt: "2026-08-28T11:30:00.000Z",
    },
    voiceRuntime: null,
    queues: [
      { provider: "fal", paused: true, pauseKind: "credential", reason: queueReason, held: 2 },
    ],
    jobs: [],
    providers: [],
    providerTools: [],
    manifest: null,
    routing: { defaults: {}, faults: [] },
    models: { disabled: [] },
    spend: null,
    ledger: [],
    drift: [],
    builds: [],
    update: IDLE_UPDATE_STATE,
  };
}

/** A fault record as the operational log would hold it, poison included. */
function generatedTail(random: () => number): Array<Record<string, unknown>> {
  const path = PATHS[Math.floor(random() * PATHS.length)]!;
  return [1, 2, 3].map((n) => ({
    at: `2026-08-28T11:5${n}:00.000Z`,
    kind: "provider.fault",
    provider: "fal",
    message: `request ${n} with key ${SECRET} failed reading ${path}`,
  }));
}

/** THE composition the coordinator wires — imported, so this test exercises what ships. */
const boundary = diagnosticsBoundary;

function assertCarriesNone(serialised: string, seed: number, artifact: string): void {
  const label = (what: string) => `${what} leaked into ${artifact} (seed ${seed})`;
  assert.ok(!serialised.includes(SECRET), label("a registered secret"));
  assert.ok(!serialised.includes(PATH_SEGMENT), label("an absolute path"));
  assert.ok(!serialised.includes("\\\\Users\\\\prop"), label("a Windows path"));
  assert.ok(!serialised.includes(WORLD_NAME), label("a world name"));
  assert.ok(!serialised.includes(PROMPT), label("authored text"));
}

describe("what a diagnostics record may never carry (R-28..R-32)", () => {
  it("row 25: generated state with a secret, a path and world content — none of the three is in the serialised snapshot", () => {
    for (let run = 0; run < RUNS; run++) {
      const seed = SEED_BASE + run;
      const random = prng(seed);
      const registry = new SecretRegistry();
      registry.register(SECRET);
      const snapshot = deriveDiagnostics({
        sources: generatedSources(random),
        tails: { appLog: generatedTail(random) },
        previous: null,
        now: "2026-08-28T12:00:00.000Z",
        boundary: boundary(registry),
      });
      assert.ok(snapshot.findings.length > 0, `the generated state produced findings (seed ${seed})`);
      assertCarriesNone(JSON.stringify(snapshot), seed, "the findings snapshot");
      // Row 20 / R-13: redaction altered a carried reason, and the finding says so.
      const carried = snapshot.findings.find((f) => f.cause.redacted === true);
      assert.ok(carried, `a scrubbed cause records that redaction altered it (seed ${seed})`);
    }
  });

  it("the volume root survives the path rule — a disk finding has to name the drive (R-28)", () => {
    const registry = new SecretRegistry();
    const snapshot = deriveDiagnostics({
      sources: generatedSources(prng(SEED_BASE)),
      tails: { appLog: [] },
      previous: null,
      now: "2026-08-28T12:00:00.000Z",
      boundary: boundary(registry),
    });
    const disk = snapshot.findings.find((f) => f.kind === "component-disk-short");
    assert.ok(disk);
    assert.equal(disk.facts.find((f) => f.name === "volume")?.value, "D:\\");
  });

  it("row 25: the same three never reach the serialised bundle", async () => {
    for (let run = 0; run < RUNS; run++) {
      const seed = SEED_BASE + 1000 + run;
      const random = prng(seed);
      const registry = new SecretRegistry();
      registry.register(SECRET);
      const app = {
        ...generatedSources(random),
        vendorAuth: { available: false },
        backgroundNotifications: "issues-only",
        research: { web: false },
        appearance: { theme: "system" },
        narrator: null,
        presets: [],
        agents: [
          {
            name: "author",
            description: "writes",
            shippedBrief: PROMPT,
            brief: PROMPT,
            edited: false,
          },
        ],
        harnessModels: [],
        sampleWorld: { available: false, installing: false, note: null },
      };
      const state = {
        app,
        worlds: [{ name: WORLD_NAME, logline: PROMPT }],
        world: { meta: { name: WORLD_NAME } },
        worldChat: null,
        bench: null,
        authoringRuns: [],
        worldOpenFailure: null,
      } as unknown as ClientState;
      // The findings ride the bundle since SPEC-032 R-38, so the poisoned derivation goes in
      // with the state: the guarantee must hold over the union, not the halves.
      const snapshot = deriveDiagnostics({
        sources: generatedSources(prng(seed)),
        tails: { appLog: generatedTail(prng(seed)) },
        previous: null,
        now: "2026-08-28T12:00:00.000Z",
        boundary: boundary(registry),
      });
      const bundle = await buildDiagnosticsBundle(state, null, registry, snapshot);
      // Not vacuous: the findings must actually be riding, or this case shrinks back to the
      // halves the moment the fourth argument is dropped.
      const carried = bundle["findings"] as { findings: unknown[] };
      assert.ok(carried.findings.length > 0, `the poisoned findings ride the bundle (seed ${seed})`);
      assertCarriesNone(JSON.stringify(bundle), seed, "the bundle");
    }
  });

  it("row 25: a poisoned log tail is the bundle's one leak channel, and the scrub holds it", async () => {
    // The other bundle case plants poison in fields the enumeration drops, which a builder with
    // no scrubbing at all would also pass. This one routes it through `recentLog` — the one
    // enumerated field carrying free text — via a real AppLog: write-time redaction removes the
    // secret it knows, and the PATH survives to the tail, so the bundle-level path rule is the
    // only thing standing between it and the export.
    const dir = await tempDir("arke-nevercarry-");
    const registry = new SecretRegistry();
    registry.register(SECRET);
    const log = new AppLog(join(dir, "app.jsonl"), registry);
    for (const record of generatedTail(prng(SEED_BASE + 2000))) await log.append(record);
    await log.append({ kind: "world.open-failed", message: `could not read ${WINDOWS_PATH}` });
    await log.drain();
    const state = { app: generatedSources(prng(SEED_BASE + 2000)), worlds: [], world: null } as unknown as ClientState;
    const bundle = await buildDiagnosticsBundle(state, log, registry);
    assertCarriesNone(JSON.stringify(bundle), SEED_BASE + 2000, "the bundle's log tail");
    // The tail itself is present — the channel was exercised, not emptied.
    assert.ok((bundle["recentLog"] as string[]).length >= 4);
    assert.match((bundle["recentLog"] as string[]).join("\n"), /\[path\]/);
  });

  it("row 26: a field outside the enumeration never reaches the export, whatever it carries", async () => {
    const registry = new SecretRegistry();
    const random = prng(SEED_BASE);
    const app = {
      ...generatedSources(random),
      // The poison sits in fields the bundle does not name. Absence is the enumeration working.
      vendorAuth: { available: true, note: `signed in at ${WINDOWS_PATH} with ${SECRET}` },
      agents: [{ name: "author", brief: PROMPT }],
      unenumeratedFutureField: SECRET,
    };
    const state = { app, worlds: [], world: null } as unknown as ClientState;
    const bundle = await buildDiagnosticsBundle(state, null, registry);
    const text = JSON.stringify(bundle);
    assert.ok(!text.includes("unenumeratedFutureField"));
    assert.ok(!text.includes("vendorAuth"));
    assert.ok(!text.includes(PROMPT));
  });

  it("row 22: a registered secret in a provider fault is absent from finding and export alike", async () => {
    const registry = new SecretRegistry();
    registry.register(SECRET);
    const tail = generatedTail(prng(SEED_BASE));
    const snapshot = deriveDiagnostics({
      sources: generatedSources(prng(SEED_BASE)),
      tails: { appLog: tail },
      previous: null,
      now: "2026-08-28T12:00:00.000Z",
      boundary: boundary(registry),
    });
    const faults = snapshot.findings.find((f) => f.kind === "provider-repeated-faults");
    assert.ok(faults);
    assert.ok(!JSON.stringify(faults).includes(SECRET));
  });

  it("the path rule leaves product strings alone — routes, URLs and bare volume roots", () => {
    for (const untouched of [
      "route /settings/engines?engine=comfyui",
      "probing http://127.0.0.1:8188/system_stats",
      "https://example.com/home/models answered 404",
      "D: has 4 GB free",
      "needs 17 GB plus room to work; this disk has 4 GB free",
    ]) {
      assert.equal(scrubAbsolutePaths(untouched), untouched);
    }
    assert.equal(
      scrubAbsolutePaths(`weights at ${WINDOWS_PATH} rejected`),
      "weights at [path] rejected",
    );
    assert.equal(scrubAbsolutePaths(`read ${POSIX_PATH}`), "read [path]");
    assert.equal(scrubAbsolutePaths(`share ${UNC_PATH} offline`), "share [path] offline");
    // A spaced segment is the account name the rule exists for; the remainder must not leak.
    assert.equal(
      scrubAbsolutePaths("spawn C:\\Program Files\\Arke\\arke.exe failed"),
      "spawn [path] failed",
    );
    assert.equal(
      scrubAbsolutePaths("wrote C:\\Users\\Michael Josiah\\AppData\\arke.log today"),
      "wrote [path] today",
    );
    // Trailing prose after a path is prose, not path.
    assert.equal(scrubAbsolutePaths("C:\\weights\\x.bin is missing"), "[path] is missing");
    // file: URLs are filesystem locations however many slashes they carry.
    assert.equal(scrubAbsolutePaths("import file:///C:/apps/arke/main.mjs died"), "import [path] died");
    assert.equal(scrubAbsolutePaths("at file:/Users/mjosi/x.txt line 3"), "at [path] line 3");
  });
});
