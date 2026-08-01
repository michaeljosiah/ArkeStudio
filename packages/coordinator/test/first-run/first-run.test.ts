import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../tmp.js";
import { checkPathBudget } from "../../src/world/paths.js";
import { fileArtifact } from "../../src/artifacts/filing.js";
import { buildDiagnosticsBundle } from "../../src/diagnostics.js";
import { AppLog } from "../../src/app-log.js";
import { SecretRegistry } from "../../src/redact.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { stageCanonEntry } from "../../src/canon/authoring.js";
import { FsWorldProvider } from "../../src/world/provider.js";
import { WorldStore } from "../../src/world/store.js";
import type { ClientState } from "@arke-studio/contracts";

const here = dirname(fileURLToPath(import.meta.url));

describe("the no-credential path (R-3, D1, D2, §3.2) — the scenario that proves the claim", () => {
  it("no key, no adapter, no manifest: create, author by form, link, reopen, all intact", async () => {
    // A clean app root: no cipher, no validators, no dispatch clients, no manifest, no network.
    const root = await tempDir("arke-firstrun-");
    const provider = new FsWorldProvider(root, {});
    await provider.ensureAppRoot();

    // Create a world.
    const { worldId } = await provider.createWorld({ name: "Inkwater", logline: "A river that remembers." });
    let bundle = await provider.loadWorld(worldId);
    assert.equal(bundle.meta.name, "Inkwater");

    // Author a character by form — the form editor is what makes this path real (D2).
    const store = provider.openStore()!;
    const gate = new ProposalManager(store);
    const { createSheetFromSentence } = await import("../../src/sheets/authoring.js");
    const draft = await createSheetFromSentence(store, gate, {
      sheetType: "character",
      name: "Perch",
      sentence: "A ferryman who charges in stories, not coin.",
    });
    const accepted = await gate.accept(draft.proposal.id);
    assert.equal(accepted.status, "accepted");

    // Write a canon entry.
    const canonStaged = await stageCanonEntry(store, gate, {
      entryType: "rule",
      title: "The river keeps what it is told",
      statement: "A story spoken over the water cannot be untold.",
    });
    assert.equal((await gate.accept(canonStaged.id)).status, "accepted");

    // Link an artifact.
    const src = join(root, "ferry-song.txt");
    await writeFile(src, "the ferry song, hummed");
    const filed = await fileArtifact(store, { sourcePath: src, links: ["perch"] });
    assert.equal(filed.outcome, "filed");

    // Reopen the application (close, reopen the provider) and find it all intact.
    await provider.close();
    const again = new FsWorldProvider(root, {});
    bundle = await again.loadWorld(worldId);
    assert.ok(bundle.sheets.some((s) => s.name === "Perch"));
    assert.ok(bundle.canon.some((c) => c.title === "The river keeps what it is told"));
    assert.ok(bundle.artifacts.some((a) => a.file === "ferry-song.txt" && a.links.includes("perch")));
    await again.close();
  });
});

describe("first-run environment checks (R-2, D4, §3.2)", () => {
  it("a deliberately over-deep app root is reported before any world exists", () => {
    const deep = "C:\\" + "a-very-long-directory-name\\".repeat(9) + "ArkeStudio";
    const budget = checkPathBudget(deep);
    assert.equal(budget.tight, true, "the check catches it now, not months later");
    const shallow = checkPathBudget("C:\\Users\\mjosi\\ArkeStudio");
    assert.equal(shallow.tight, false);
  });
});

describe("newer-schema refusal (R-14, D8, §3.2)", () => {
  it("a world written by a newer build is refused, byte-unmodified", async () => {
    const { makeTempWorld } = await import("../world/helpers.js");
    const dir = await makeTempWorld();
    const worldJsonPath = join(dir, "world.json");
    const meta = JSON.parse(await readFile(worldJsonPath, "utf8")) as { schemaVersion: number };
    meta.schemaVersion = 99;
    await writeFile(worldJsonPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
    const before = createHash("sha256").update(await readFile(worldJsonPath)).digest("hex");

    await assert.rejects(() => WorldStore.open(dir, {}), /schema/i, "declined rather than helpfully damaged");

    const after = createHash("sha256").update(await readFile(worldJsonPath)).digest("hex");
    assert.equal(after, before, "refused UNMODIFIED — hashed before and after (D8)");
  });
});

describe("diagnostics are safe to paste publicly (R-15, D9, §3.2)", () => {
  it("sentinels planted in world content, keys and prompts never surface", async () => {
    const KEY_SENTINEL = "sk-SENTINEL-KEY-1234567890";
    const WORLD_SENTINEL = "The Undersong";
    const PROMPT_SENTINEL = "a-prompt-nobody-should-see";
    const registry = new SecretRegistry();
    registry.register(KEY_SENTINEL);
    const dir = await tempDir("arke-diag16-");
    const log = new AppLog(join(dir, "app.jsonl"), registry);
    // A registered secret in free text, and a prompt in a prompt-named field — the two leak
    // shapes the boundary mechanically closes (call sites keep prompts out of message strings).
    await log.append({ kind: "test", message: `dispatched with ${KEY_SENTINEL}`, prompt: PROMPT_SENTINEL });
    await log.drain();

    const state = {
      app: {
        version: "0.1.0-test",
        health: { coordinator: { status: "healthy" }, harness: { status: "unavailable", reason: "x" }, voice: { status: "unavailable", reason: "x" } },
        jobs: [],
        ledger: [],
        providers: [{ id: "fal", configured: true, validation: "valid", probes: [], fault: null }],
        manifest: null,
        routing: { defaults: {}, faults: [] },
        spend: null,
        runtime: null,
        drift: [],
        queues: [],
      },
      worlds: [
        {
          worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
          slug: "the-undersong",
          name: WORLD_SENTINEL,
          counts: { characters: 3, locations: 2, factions: 1, canonEntries: 6, productions: 1 },
          updated: "2026-07-30T18:22:00Z",
        },
      ],
      world: null,
    } as unknown as ClientState;

    const bundle = JSON.stringify(await buildDiagnosticsBundle(state, log, registry));
    assert.ok(!bundle.includes(KEY_SENTINEL), "no credential material");
    assert.ok(!bundle.includes(WORLD_SENTINEL), "no world content");
    assert.ok(!bundle.includes(PROMPT_SENTINEL), "no prompts");
    assert.ok(bundle.includes("0.1.0-test"), "still useful");
  });
});

describe("the licence gate (R-9, D5, §3.2)", () => {
  it("passes with recorded obligations and fails when a staged component has none", async () => {
    const script = resolve(here, "../../../../apps/desktop/scripts/verify-licenses.mjs");
    // Passes as shipped.
    execFileSync("node", [script], { encoding: "utf8" });

    // A staged-but-unrecorded component fails the gate: simulate by pointing the script at a
    // copy whose notices file lacks the row.
    const fakeRepo = await tempDir("arke-lic-");
    const { mkdir, cp } = await import("node:fs/promises");
    await mkdir(join(fakeRepo, "apps", "desktop", "scripts"), { recursive: true });
    await mkdir(join(fakeRepo, "apps", "desktop", "build-resources", "ffmpeg"), { recursive: true });
    await writeFile(join(fakeRepo, "apps", "desktop", "build-resources", "ffmpeg", "ffmpeg.exe"), "");
    await cp(script, join(fakeRepo, "apps", "desktop", "scripts", "verify-licenses.mjs"));
    await writeFile(
      join(fakeRepo, "THIRD-PARTY-NOTICES.md"),
      "# notices\nbetter-sqlite3 Electron SQLite Geist\n", // ffmpeg row deliberately absent
    );
    assert.throws(
      () => execFileSync("node", [join(fakeRepo, "apps", "desktop", "scripts", "verify-licenses.mjs")], { encoding: "utf8" }),
      /Command failed|licence gate/i,
      "a component with no recorded obligation cannot ship (D5)",
    );
  });
});

describe("updates never interrupt (R-13, D7)", () => {
  it("the update seam has no install surface at all — only check and download", async () => {
    // The deferral is structural: the coordinator's seam types expose check() and download();
    // installation belongs to app-quit alone. Asserted against the source, like the
    // no-polling rule: no quitAndInstall call exists anywhere in the coordinator.
    const source = await readFile(resolve(here, "../../src/coordinator.ts"), "utf8");
    assert.ok(!source.includes("quitAndInstall"), "nothing in the domain layer can install an update");
    assert.match(source, /download only \(R-13, D7\)|installation waits for application exit|installs when you quit/i);
  });
});
