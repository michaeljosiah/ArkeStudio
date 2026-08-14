import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { computeNeedsYou, type ClientState } from "@arke-studio/contracts";
import { tempDir } from "../tmp.js";
import { candidateHash, resolveCandidate, storeBatch, verifyCandidates } from "../../src/artifacts/extraction.js";
import { addLinks, ATTACHABLE_EXTENSIONS, fileArtifact, importFolder, kindForFile, pickable } from "../../src/artifacts/filing.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  return { dir, store, gate: new ProposalManager(store) };
}

async function sourceFile(name: string, content: string | Buffer): Promise<string> {
  const dir = await tempDir("arke-src-");
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe("filing (R-1, R-4, D8, D9, §3.2)", () => {
  it("offers in the picker exactly what it can file", async () => {
    // The attach dialog's filter is derived from the kind map, not written a second time — so
    // it cannot come to offer something that files as "other", or hide something it can hold.
    assert.ok(ATTACHABLE_EXTENSIONS.length > 0);
    for (const ext of ATTACHABLE_EXTENSIONS) {
      assert.ok(!ext.startsWith("."), `${ext} is bare, as a dialog filter wants`);
      assert.notEqual(kindForFile(`whatever.${ext}`), "other", `.${ext} files as a real kind`);
    }
    // The three kinds this app was asked to take are all in there.
    const kinds = new Set(ATTACHABLE_EXTENSIONS.map((e) => kindForFile(`x.${e}`)));
    for (const kind of ["image", "document", "audio"]) assert.ok(kinds.has(kind as never), `${kind} can be attached`);
  });

  it("records the measurement of audio and video as they are filed", async () => {
    // The field existed and nothing wrote it, so every reader probed the file again later —
    // export on the export click, and the Cut screen not at all, having no ffprobe to reach for.
    const { store } = await open();
    try {
    const probed: string[] = [];
    const mediaProbe = {
      durationSec: async () => 12,
      info: async (path: string) => {
        probed.push(path);
        return { durationSec: 12.5, hasAudio: true };
      },
    };
    const song = await sourceFile("the-undersong.mp3", "not really an mp3");
    assert.equal((await fileArtifact(store, { sourcePath: song, mediaProbe })).outcome, "filed");
    const track = store.getBundle().artifacts.find((a) => a.file === "the-undersong.mp3");
    assert.deepEqual(track?.mediaInfo, { durationSec: 12.5, hasAudio: true });
    // Measured from the copy, so it describes the bytes the world holds rather than the source.
    assert.ok(probed[0]?.includes("artifacts"), `measured ${probed[0]} rather than the world's copy`);

    // A document is not media; probing it would be a tool call for nothing.
    const notes = await sourceFile("notes.txt", "words");
    await fileArtifact(store, { sourcePath: notes, mediaProbe });
    assert.equal(probed.length, 1);
    assert.equal(store.getBundle().artifacts.find((a) => a.file === "notes.txt")?.mediaInfo, undefined);
    } finally {
      // open() in this file does not close, and a live watcher holds the runner's event loop
      // open long after the last assertion — two more leaked stores hung the whole sweep.
      await store.close();
    }
  });

  it("files media unmeasured rather than failing when nothing can read it", async () => {
    // Absent already means "not measured" to every reader. Filing must not depend on a media
    // tool being installed, and a probe that throws is not a reason to refuse somebody's file.
    const { store } = await open();
    try {
    const song = await sourceFile("second-song.mp3", "also not an mp3");
    const outcome = await fileArtifact(store, {
      sourcePath: song,
      mediaProbe: { durationSec: async () => null, info: async () => { throw new Error("ffprobe is not here"); } },
    });
    assert.equal(outcome.outcome, "filed");
    assert.equal(store.getBundle().artifacts.find((a) => a.file === "second-song.mp3")?.mediaInfo, undefined);
    } finally {
      await store.close();
    }
  });

  it("refuses a gate operation once the world has begun closing", async () => {
    // The window every identity guard misses: the provider keeps returning this store until
    // close() resolves, so "is this still the open store" is true while the lock is already gone.
    // A closed world is not writable, and that is the store's own fact rather than each caller's.
    const { store } = await open();
    await store.close();
    await assert.rejects(() => store.gateOp(async () => "written"), /closed/);
  });

  it("refuses to rewrite a sidecar it cannot read as one", async () => {
    // Every writer here rebuilds a whole record from what it reads. A file hand-edited to
    // {"links":[]} was spread into a replacement and committed, erasing id, hash and origin —
    // a rewrite triggered by somebody adding a link.
    const { dir, store } = await open();
    try {
      const doc = await sourceFile("fragile.txt", "a document with a sidecar somebody edited");
      const filed = await fileArtifact(store, { sourcePath: doc, links: ["the-vigil"] });
      assert.equal(filed.outcome, "filed");
      const sidecarPath = join(dir, "artifacts", "fragile.txt.json");
      await writeFile(sidecarPath, JSON.stringify({ links: [] }));

      const artifact = filed.outcome === "filed" ? filed.artifact : null;
      assert.ok(artifact);
      const after = await addLinks(store, artifact, ["maren-kest"]);
      // The caller gets its own copy back, and the malformed file is left for the scan to report.
      assert.equal(after.id, artifact.id);
      assert.deepEqual(JSON.parse(await readFile(sidecarPath, "utf8")), { links: [] });
    } finally {
      await store.close();
    }
  });

  it("does not commit a measurement to a world that closed while it was probing", async () => {
    // The case five rounds kept finding one guard at a time: the probe outlives the gate, and
    // gateOp does not refuse work on a closed store — it commits without the world's lock.
    // Written as a test rather than a sixth guard, so the next path to forget it fails here.
    const { store } = await open();
    try {
      const song = await sourceFile("switched-away.mp3", "the world moved on mid-probe");
      let closedDuringProbe = false;
      await fileArtifact(store, {
        sourcePath: song,
        mediaProbe: {
          durationSec: async () => 3,
          info: async () => {
            // The world switch happens *during* the probe, which is the whole point.
            closedDuringProbe = true;
            return { durationSec: 3, hasAudio: true };
          },
        },
        abandoned: () => closedDuringProbe,
      });
      assert.ok(closedDuringProbe, "the probe ran");
      const filed = store.getBundle().artifacts.find((a) => a.file === "switched-away.mp3");
      assert.ok(filed, "the artifact is still filed — only the measurement is abandoned");
      assert.equal(filed?.mediaInfo, undefined, "no measurement committed after the world moved on");
    } finally {
      await store.close();
    }
  });

  it("records nothing from a probe that cannot say whether there is audio", async () => {
    // measureMediaInfo answers a duration-only probe with hasAudio:false — the right conservative
    // reading in the moment, and the wrong thing to write down. Stored, it is indistinguishable
    // from a measured silence, the artifact is never revisited, and spine export would refuse a
    // real audio track on a machine that could have measured it properly.
    const { store } = await open();
    try {
      const song = await sourceFile("duration-only.mp3", "measured the shallow way");
      await fileArtifact(store, { sourcePath: song, mediaProbe: { durationSec: async () => 41 } });
      assert.equal(store.getBundle().artifacts.find((a) => a.file === "duration-only.mp3")?.mediaInfo, undefined);
    } finally {
      await store.close();
    }
  });

  it("copies in — the artifact survives its source being deleted", async () => {
    const { dir, store } = await open();
    const source = await sourceFile("tide-tables.txt", "the tides, tabulated");
    const outcome = await fileArtifact(store, { sourcePath: source, links: ["the-vigil"] });
    assert.equal(outcome.outcome, "filed");
    await rm(source);
    const onDisk = await readFile(join(dir, "artifacts", "tide-tables.txt"), "utf8");
    assert.equal(onDisk, "the tides, tabulated", "unaffected by the source vanishing (R-1)");
    const sidecar = store.getBundle().artifacts.find((a) => a.file === "tide-tables.txt");
    assert.ok(sidecar);
    assert.deepEqual(sidecar.links, ["the-vigil"]);
    await store.close();
  });

  it("the same content filed twice is one artifact with merged links (R-4)", async () => {
    const { store } = await open();
    const first = await sourceFile("notes-a.txt", "identical bytes");
    const second = await sourceFile("notes-b.txt", "identical bytes");
    const a = await fileArtifact(store, { sourcePath: first, links: ["maren-kest"] });
    const b = await fileArtifact(store, { sourcePath: second, links: ["bray-half-hitch"] });
    assert.equal(a.outcome, "filed");
    assert.equal(b.outcome, "deduplicated");
    const artifact = store.getBundle().artifacts.find((x) => x.file === "notes-a.txt")!;
    assert.deepEqual(artifact.links.sort(), ["bray-half-hitch", "maren-kest"]);
    assert.equal(
      store.getBundle().artifacts.filter((x) => x.hash === artifact.hash).length,
      1,
      "one copy; what it is used for is the links",
    );
    await store.close();
  });

  it("a large file states its size before anything is copied (R-6)", async () => {
    const { dir, store } = await open();
    const big = await sourceFile("big.bin", Buffer.alloc(101 * 1024 * 1024));
    const refused = await fileArtifact(store, { sourcePath: big });
    assert.equal(refused.outcome, "needs-consent");
    assert.ok(refused.outcome === "needs-consent" && refused.sizeBytes > 100 * 1024 * 1024);
    await assert.rejects(() => readFile(join(dir, "artifacts", "big.bin")), "nothing copied before consent");
    const consented = await fileArtifact(store, { sourcePath: big, allowLarge: true });
    assert.equal(consented.outcome, "filed");
    await store.close();
  });
});

describe("supersession (R-5, D10, §3.2)", () => {
  it("existing links keep pointing at the old artifact; pickers exclude it", async () => {
    const { store } = await open();
    const oldSrc = await sourceFile("bells-take1.wav", "RIFFxxxxWAVEold-recording");
    const filedOld = await fileArtifact(store, { sourcePath: oldSrc, links: ["the-vigil"] });
    assert.equal(filedOld.outcome, "filed");
    const oldArtifact = (filedOld as { artifact: { id: string } }).artifact;

    const newSrc = await sourceFile("bells-take2.wav", "RIFFxxxxWAVEbetter-recording");
    const filedNew = await fileArtifact(store, { sourcePath: newSrc, supersedes: oldArtifact.id });
    assert.equal(filedNew.outcome, "filed");

    const bundle = store.getBundle();
    const oldNow = bundle.artifacts.find((a) => a.id === oldArtifact.id)!;
    assert.deepEqual(oldNow.links, ["the-vigil"], "what a take actually used still resolves (D10)");
    const pickers = pickable(bundle.artifacts);
    assert.ok(!pickers.some((a) => a.id === oldArtifact.id), "superseded drops out of pickers");
    assert.ok(pickers.some((a) => a.file === "bells-take2.wav"));
    await store.close();
  });
});

describe("import stage one (R-9..R-11, D1, D11, §3.2)", () => {
  it("files unknown types, excludes system files, and reports all of it", async () => {
    const { store } = await open();
    const src = await tempDir("arke-import-");
    await writeFile(join(src, "chapter-one.md"), "# The First Tide\nMaren counts the bells.");
    await writeFile(join(src, "notes.xyz"), "unknown extension, real notes");
    await writeFile(join(src, ".DS_Store"), "junk");
    await writeFile(join(src, "Thumbs.db"), "junk");
    await mkdir(join(src, "research"));
    await writeFile(join(src, "research", "harbour.txt"), "the harbour, researched");

    const report = await importFolder(store, src);
    assert.equal(report.filed.length, 3);
    assert.ok(report.filed.some((f) => f.name === "notes.xyz" && f.kind === "other"), "filed and reported, not dropped (R-10)");
    assert.ok(report.filed.some((f) => f.name === "research/harbour.txt"));
    assert.equal(report.excluded.length, 2);
    assert.ok(report.excluded.every((e) => e.reason === "system or hidden file"));
    const filed = store.getBundle().artifacts.map((a) => a.file);
    assert.ok(filed.includes("chapter-one.md"));
    assert.ok(filed.includes("notes.xyz"));
    await store.close();
  });
});

describe("extraction grounding — the adversarial suite (R-13, R-14, D2..D4, §3.2)", () => {
  const SOURCE = [
    "Maren Kest keeps the dusk watch alone.",
    "Her coat is salt-stained oilskin, patched at the left shoulder.",
    "The Vigil's lamps burn green-white when the verse is close.",
  ].join("\n");

  it("a fabricated quote is dropped and counted; a verbatim one passes", () => {
    const batch = verifyCandidates(
      [
        { kind: "canon", name: "Lamps and the verse", body: "The Vigil's lamps signal the verse.", quote: "The Vigil's lamps burn green-white when the verse is close." },
        { kind: "canon", name: "The invented rule", body: "Tides answer names.", quote: "tides answer to their true names" },
      ],
      SOURCE,
      [],
    );
    assert.equal(batch.verified.length, 1);
    assert.equal(batch.droppedCount, 1, "dropped AND counted — reporting eight of twelve is honest (D3)");
    assert.match(batch.droppedReasons[0]!, /quote not found/);
  });

  it("a paraphrase fails the mechanical check", () => {
    const batch = verifyCandidates(
      [{ kind: "character", name: "Maren Kest", body: "Watches at dusk.", section: "Essence", quote: "Maren watches every dusk by herself" }],
      SOURCE,
      [],
    );
    assert.equal(batch.verified.length, 0);
    assert.equal(batch.droppedCount, 1);
  });

  it("a document about a coat authorises no relationships (R-14, D4)", () => {
    const batch = verifyCandidates(
      [
        { kind: "character", name: "Maren Kest", body: "Salt-stained oilskin coat.", section: "Appearance", quote: "Her coat is salt-stained oilskin, patched at the left shoulder." },
        { kind: "character", name: "Maren Kest", body: "Trusts the harbourmaster.", section: "Relationships", quote: "Her coat is salt-stained oilskin, patched at the left shoulder." },
      ],
      SOURCE,
      [],
    );
    assert.equal(batch.verified.length, 1);
    assert.equal(batch.verified[0]!.section, "Appearance");
    assert.match(batch.droppedReasons[0]!, /not evidenceable/);
  });

  it("a document yielding nothing produces an empty batch, not an error; decided are never re-offered (R-17, D12)", () => {
    const empty = verifyCandidates([], SOURCE, []);
    assert.deepEqual(empty, { verified: [], droppedCount: 0, droppedReasons: [] });

    const candidate = {
      kind: "canon" as const,
      name: "Lamps",
      body: "Lamps signal.",
      quote: "The Vigil's lamps burn green-white when the verse is close.",
    };
    const decidedHash = candidateHash(candidate.kind, candidate.name, candidate.quote, undefined);
    const rerun = verifyCandidates([candidate], SOURCE, [decidedHash]);
    assert.equal(rerun.verified.length, 0, "worked through once — never worked through again");
    assert.equal(rerun.droppedCount, 0, "a decided candidate is not a fabrication");
  });
});

describe("the batch review (R-15, R-16, D5, §3.2)", () => {
  it("thirty candidates are ONE needs-you entry; accepts commit individually; rejects leave no trace", async () => {
    const { store, gate } = await open();
    const src = await sourceFile("corpus.txt", "Sella Ninefinger sells rope on the west quay.\nThe quay floods at spring tide.");
    const filed = await fileArtifact(store, { sourcePath: src });
    assert.equal(filed.outcome, "filed");
    let artifact = (filed as { artifact: (typeof store extends never ? never : import("@arke-studio/contracts").ArtifactSidecar) }).artifact;

    const text = "Sella Ninefinger sells rope on the west quay.\nThe quay floods at spring tide.";
    const raw = Array.from({ length: 30 }, (_, i) =>
      i === 0
        ? { kind: "character" as const, name: "Sella Ninefinger", body: "Sells rope on the west quay.", section: "Essence", quote: "Sella Ninefinger sells rope on the west quay." }
        : i === 1
          ? { kind: "canon" as const, name: "Spring flood", body: "The quay floods at spring tide.", quote: "The quay floods at spring tide." }
          : { kind: "canon" as const, name: `Fact ${i}`, body: `Reading ${i} of the flood line.`, quote: "The quay floods at spring tide." },
    );
    const batch = verifyCandidates(raw, text, []);
    assert.equal(batch.verified.length, 30);
    await storeBatch(store, artifact, batch);

    artifact = store.getBundle().artifacts.find((a) => a.id === artifact.id)!;
    assert.equal(artifact.extraction!.pending.length, 30);

    // One needs-you entry for the whole batch (R-15, D5).
    const state = {
      app: { jobs: [], queues: [], ledger: [] },
      worlds: [],
      world: store.getBundle(),
    } as unknown as ClientState;
    const queue = computeNeedsYou(state).filter((e) => e.kind === "extraction-batch");
    assert.equal(queue.length, 1);
    assert.match(queue[0]!.title, /30 extracted facts/);

    // Accept two: each commits on its own, carrying the source link.
    const sheetsBefore = store.getBundle().sheets.length;
    const canonBefore = store.getBundle().canon.length;
    await resolveCandidate(store, gate, artifact, batch.verified[0]!.hash, "accept");
    artifact = store.getBundle().artifacts.find((a) => a.id === artifact.id)!;
    await resolveCandidate(store, gate, artifact, batch.verified[1]!.hash, "accept");

    let bundle = store.getBundle();
    assert.equal(bundle.sheets.length, sheetsBefore + 1);
    const sella = bundle.sheets.find((s) => s.name === "Sella Ninefinger")!;
    assert.equal(sella.status, "sketch");
    assert.ok(sella.sections.some((s) => s.heading === "Essence" && s.body.includes("west quay")));
    assert.ok(!sella.sections.some((s) => s.body.length > 0 && s.heading === "Relationships"), "unevidenced stays empty");
    assert.equal(bundle.canon.length, canonBefore + 1);
    const flood = bundle.canon.find((c) => c.title === "Spring flood")!;
    assert.match(flood.body, /Source: corpus\.txt/);
    artifact = bundle.artifacts.find((a) => a.id === artifact.id)!;
    assert.ok(artifact.links.includes(sella.id), "the accepted sheet links back to its source");

    // Reject the remaining twenty-eight: no world trace, all recorded decided.
    for (const candidate of artifact.extraction!.pending) {
      await resolveCandidate(store, gate, store.getBundle().artifacts.find((a) => a.id === artifact.id)!, candidate.hash, "reject");
    }
    bundle = store.getBundle();
    artifact = bundle.artifacts.find((a) => a.id === artifact.id)!;
    assert.equal(artifact.extraction!.pending.length, 0);
    assert.equal(artifact.extraction!.decided.length, 30);
    assert.equal(bundle.sheets.length, sheetsBefore + 1, "the twenty-eight left no trace");
    assert.equal(bundle.canon.length, canonBefore + 1);

    // Re-running with the same raw candidates re-offers nothing (R-17).
    const rerun = verifyCandidates(raw, text, artifact.extraction!.decided);
    assert.equal(rerun.verified.length, 0);
    await store.close();
  });
});
