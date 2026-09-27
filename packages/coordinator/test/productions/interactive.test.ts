import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { INTERACTIVE_PLAYER_SOURCE, migrateLegacyScene, RoutingSchema, type ProductionBundle, type Routing, type Take } from "@arke-studio/contracts";
import {
  appendTraversal,
  exportInteractive,
  interactiveExportCompleted,
  interactiveFindings,
  proposeBranchCanon,
  saveRouting,
} from "../../src/productions/interactive.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";
import { closeOnCleanup } from "../tmp.js";

/**
 * Interactive video through the coordinator (epic 401): the routing record on the gate's own
 * version machinery, durable evidence, canon promotion with route provenance, and the export
 * package behind the findings gate. Test names carry the brief's IV-K/IV-E numbers.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

async function open() {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir, { clock: CLOCK });
  closeOnCleanup(() => store.close());
  return { dir, store, bundle: store.getBundle() };
}

const ROUTING: Routing = {
  version: 1,
  start: "sc_i1",
  choices: [{ id: "ch_on", from: "sc_i1", label: "Go on", to: "sc_i2" }],
  endings: [{ sceneId: "sc_i2", title: "The end" }],
  excluded: [],
  groups: [],
};

function interactiveScene(id: string, number: number, shotId: string) {
  return {
    id,
    number,
    slug: id.replace(/^sc_/, ""),
    title: id,
    status: "accepted" as const,
    version: 1,
    shots: [{ id: shotId, number: 1, title: shotId, description: "a shot", durationSec: 5 }],
  };
}

function take(id: string, shotId: string): Take {
  return {
    id,
    coversShots: [shotId],
    kind: "clip",
    provider: "fal",
    model: "seedance-2.0",
    provenance: { canonRevision: 1, sheets: {} },
    references: [],
    params: {},
    cost: { estimatedMicroUsd: 1000, actualMicroUsd: null },
    dispatchedAt: CLOCK(),
    media: "clip.mp4",
  };
}

/** An interactive production over the fixture store: scenes, accepted footage, routing. */
async function interactiveProduction(
  dir: string,
  base: ProductionBundle,
  routing: Routing | null,
): Promise<ProductionBundle> {
  const takes = [take("tk_01J8E0000000000000000000I1", "sh_i1"), take("tk_01J8E0000000000000000000I2", "sh_i2")];
  for (const t of takes) {
    const takeDir = join(dir, "productions", base.meta.id, "takes", t.id);
    await mkdir(takeDir, { recursive: true });
    await writeFile(join(takeDir, "clip.mp4"), Buffer.from(`footage-of-${t.id}`));
  }
  return {
    ...base,
    meta: { ...base.meta, medium: "interactive-video", kind: "interactive" },
    scenes: [interactiveScene("sc_i1", 1, "sh_i1"), interactiveScene("sc_i2", 2, "sh_i2")],
    routing,
    takes,
    selections: {
      sh_i1: { acceptedTakeId: takes[0]!.id, trimInSec: 0 },
      sh_i2: { acceptedTakeId: takes[1]!.id, trimInSec: 0 },
    },
  };
}

describe("interactive video through the coordinator (epic 401)", () => {
  it("IV-K1: the routing record rides the gate's version machinery, and a condition never lands", async () => {
    const { dir, store, bundle } = await open();
    const production = bundle.productions[0]!;
    await saveRouting(store, production.meta.id, ROUTING);
    const raw = JSON.parse(
      await readFile(join(dir, "productions", production.meta.id, "routing.json"), "utf8"),
    ) as Routing;
    assert.equal(RoutingSchema.parse(raw).version, 1, "created at v1, stamped by the committer");
    await saveRouting(store, production.meta.id, {
      ...ROUTING,
      choices: [...ROUTING.choices, { id: "ch_back", from: "sc_i2", to: "sc_i1", label: "Back" }],
    });
    const bumped = JSON.parse(
      await readFile(join(dir, "productions", production.meta.id, "routing.json"), "utf8"),
    ) as Routing;
    assert.equal(bumped.version, 2, "every edit is a version, so history is addressable");

    await assert.rejects(
      () =>
        saveRouting(store, production.meta.id, {
          ...ROUTING,
          choices: [{ id: "ch_x", from: "sc_i1", to: "sc_i2", label: "x", condition: "gold > 3" }],
        }),
      /condition/,
      "the import boundary refuses state by name (IV-C1's rule, enforced here too)",
    );
  });

  it("IV-K2: evidence appends durably and sheds when the edge it names is retargeted", async () => {
    const { dir, store, bundle } = await open();
    const production = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    await appendTraversal(store, production.meta.id, {
      ts: CLOCK(),
      routingVersion: 1,
      choiceId: "ch_on",
      from: "sc_i1",
      to: "sc_i2",
      route: ["sc_i1"],
    });
    const before = await interactiveFindings(store, production);
    assert.ok(!before.some((finding) => finding.kind === "untraversed-edge"), "the walked edge counts");

    const retargeted = await interactiveProduction(dir, bundle.productions[0]!, {
      ...ROUTING,
      version: 2,
      start: "sc_i1",
      choices: [{ id: "ch_on", from: "sc_i1", label: "Go on", to: "sc_i1" }],
      endings: [],
    });
    const after = await interactiveFindings(store, retargeted);
    assert.ok(
      after.some((finding) => finding.kind === "untraversed-edge" && finding.choiceIds.includes("ch_on")),
      "the old traversal no longer describes the retargeted edge",
    );
  });

  it("IV-K3: canon promotion is explicit, gated, and names the route it came from", async () => {
    const { dir, store, bundle } = await open();
    const gate = new ProposalManager(store);
    const production = bundle.productions[0]!;
    const { proposalId, canonId } = await proposeBranchCanon(store, gate, {
      productionId: production.meta.id,
      sceneId: "sc_i2",
      route: ["sc_i1", "sc_i2"],
      title: "The bell answered once",
      body: "On this route, the bell answered — and the harbour heard it.",
    });
    const staged = store.getBundle().proposals.find((entry) => entry.proposal.id === proposalId)?.proposal;
    assert.ok(staged !== undefined, "the promotion is a staged proposal like any other");
    assert.equal(staged.kind, "new-canon");
    assert.match(staged.summary, /sc_i2/, "the outcome scene is named where a reviewer reads");
    const draft = await readFile(join(dir, ".proposals", proposalId, "canon", `${canonId}.md`), "utf8");
    assert.match(draft, /sc_i1 → sc_i2/, "the route that reached the outcome is provenance");
    assert.match(draft, new RegExp(`Promoted from ${production.meta.id}`));
  });

  it("IV-E1: export refuses while a blocking finding stands, in the findings' own words", async () => {
    const { dir, store, bundle } = await open();
    const production = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    // No traversal evidence yet: the untraversed edge blocks publication (brief §4).
    const refused = await exportInteractive(store, production, CLOCK);
    assert.ok(!refused.ok);
    assert.ok(refused.blockers.some((blocker) => /ch_on.*never been traversed/.test(blocker)));
  });

  it("IV-E2/IV-E3: the package ships hashed media, an embedded player, and verifies itself", async () => {
    const { dir, store, bundle } = await open();
    const production = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    await appendTraversal(store, production.meta.id, {
      ts: CLOCK(),
      routingVersion: 1,
      choiceId: "ch_on",
      from: "sc_i1",
      to: "sc_i2",
      route: ["sc_i1"],
    });
    const exportId = "iv_01J8F3K2QW9VZX4N7M0RTYB6HC";
    const result = await exportInteractive(store, production, CLOCK, { exportId });
    assert.ok(result.ok, `expected export, got ${result.ok ? "" : result.blockers.join("; ")}`);
    const manifest = JSON.parse(await readFile(join(dir, result.dir, "manifest.json"), "utf8")) as {
      routing: Routing;
      media: Array<{ sceneId: string; file: string; hash: string }>;
      provenance: { productionId: string; routingVersion: number };
    };
    assert.equal(manifest.media.length, 2, "every routed scene ships footage");
    for (const entry of manifest.media) {
      assert.match(entry.hash, /^sha256:/);
      assert.ok(!entry.file.startsWith("/"), "relative paths only — the package is portable");
      await readFile(join(dir, result.dir, entry.file)); // the bytes exist where the manifest says
    }
    const player = await readFile(join(dir, result.dir, "player.html"), "utf8");
    assert.ok(player.includes('"start":"sc_i1"') || player.includes('"start": "sc_i1"'), "the manifest is embedded, so file:// playback works offline");
    assert.ok(!/https?:\/\//.test(player), "self-contained: the player calls no network");
    assert.ok(player.includes("localStorage"), "playback state stays with the viewer");
    assert.equal(await interactiveExportCompleted(store, production.meta.id, exportId), true);
    await rm(join(dir, result.dir, "player.html"));
    assert.equal(await interactiveExportCompleted(store, production.meta.id, exportId), false, "a partial package is not recovered as completed");
  });

  it("the package plays each scene's cut window, not its whole file: a trim's in-point, the slot's end", async () => {
    const { dir, store, bundle } = await open();
    const base = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    const production = { ...base, selections: { ...base.selections, sh_i1: { ...base.selections["sh_i1"]!, trimInSec: 1.5 } } };
    await appendTraversal(store, production.meta.id, { ts: CLOCK(), routingVersion: 1, choiceId: "ch_on", from: "sc_i1", to: "sc_i2", route: ["sc_i1"] });
    const result = await exportInteractive(store, production, CLOCK, { exportId: "iv_01J8F3K2QW9VZX4N7M0RTYB6HD" });
    assert.ok(result.ok, result.ok ? "" : result.blockers.join("; "));
    const manifest = JSON.parse(await readFile(join(dir, result.dir, "manifest.json"), "utf8")) as {
      media: Array<{ sceneId: string; windows?: Array<{ from: number; to?: number }> }>;
    };
    const windows = Object.fromEntries(manifest.media.map((entry) => [entry.sceneId, entry.windows]));
    assert.deepEqual(windows["sc_i1"], [{ from: 1.5, to: 6.5 }], "trimmed 1.5s in, and the 5s slot after it");
    assert.deepEqual(windows["sc_i2"], [{ from: 0, to: 5 }], "untrimmed, still ended at its slot");
    const player = await readFile(join(dir, result.dir, "player.html"), "utf8");
    assert.match(player, /m\.windows\.map\(\(w\) => \(\{ src: m\.file, from: w\.from, to: w\.to \}\)\)/, "the page hands the windows to the player");
  });

  it("refuses a scene whose cut leaves nothing to play, rather than shipping the whole pass", async () => {
    const { dir, store, bundle } = await open();
    const base = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    // sc_i1 accepts a 2s segment of a pass, trimmed 3s in: past the segment's end, nothing plays.
    const pass = { ...take("tk_01J8E0000000000000000000P1", "sh_i1"), media: "pass.mp4" };
    const segment: Take = { ...take("tk_01J8E0000000000000000000S1", "sh_i1"), segment: { passTakeId: pass.id, inSec: 0, outSec: 2 } };
    delete (segment as { media?: string }).media;
    await mkdir(join(dir, "productions", base.meta.id, "takes", pass.id), { recursive: true });
    await writeFile(join(dir, "productions", base.meta.id, "takes", pass.id, "pass.mp4"), Buffer.from("the-pass"));
    const production = {
      ...base,
      takes: [...base.takes, pass, segment],
      selections: { ...base.selections, sh_i1: { acceptedTakeId: segment.id, trimInSec: 3 } },
    };
    const result = await exportInteractive(store, production, CLOCK);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.blockers.some((line) => /sc_i1's cut leaves nothing to play/.test(line)), !result.ok ? result.blockers.join("; ") : "");
  });

  it("refuses a scene where only some shots have something to play", async () => {
    const { dir, store, bundle } = await open();
    const base = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    // sc_i1 becomes two shots over one pass: the first accepts a segment of it, the second the
    // pass itself — which the cut plays nothing of, so its shot would silently go missing.
    const one = interactiveScene("sc_i1", 1, "sh_i1");
    const scene = { ...one, shots: [...one.shots, { id: "sh_i1b", number: 2, title: "sh_i1b", description: "a shot", durationSec: 5 }] };
    const pass = { ...take("tk_01J8E0000000000000000000P2", "sh_i1"), coversShots: ["sh_i1", "sh_i1b"], media: "pass.mp4" };
    const segment: Take = { ...take("tk_01J8E0000000000000000000S2", "sh_i1"), segment: { passTakeId: pass.id, inSec: 0, outSec: 5 } };
    delete (segment as { media?: string }).media;
    await mkdir(join(dir, "productions", base.meta.id, "takes", pass.id), { recursive: true });
    await writeFile(join(dir, "productions", base.meta.id, "takes", pass.id, "pass.mp4"), Buffer.from("the-pass"));
    const production = {
      ...base,
      scenes: [scene, base.scenes[1]!],
      takes: [...base.takes, pass, segment],
      selections: { ...base.selections, sh_i1: { acceptedTakeId: segment.id, trimInSec: 0 }, sh_i1b: { acceptedTakeId: pass.id, trimInSec: 0 } },
    };
    const result = await exportInteractive(store, production, CLOCK);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.blockers.some((line) => /sc_i1's cut has nothing to play for sh_i1b/.test(line)), !result.ok ? result.blockers.join("; ") : "");
  });

  it("refuses a take whose media names a file outside its own folder, and copies nothing", async () => {
    const { dir, store, bundle } = await open();
    const base = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    const production = { ...base, takes: base.takes.map((t, i) => (i === 0 ? { ...t, media: "../../../../outside.txt" } : t)) };
    const result = await exportInteractive(store, production, CLOCK);
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.blockers.some((line) => /sc_i1's accepted take names media outside its own folder/.test(line)));
  });

  it("gives two exports in the same second folders of their own", async () => {
    const { dir, store, bundle } = await open();
    const production = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    await appendTraversal(store, production.meta.id, { ts: CLOCK(), routingVersion: 1, choiceId: "ch_on", from: "sc_i1", to: "sc_i2", route: ["sc_i1"] });
    const first = await exportInteractive(store, production, CLOCK);
    const second = await exportInteractive(store, production, CLOCK);
    assert.ok(first.ok && second.ok);
    assert.notEqual(first.dir, second.dir, "the second does not write over the first");
    assert.equal(await interactiveExportCompleted(store, production.meta.id, first.id), true, "and the first is still whole");
  });

  it("T-13: Interactive export ships equivalent media for legacy and permuted migrated scenes", async () => {
    const { dir, store, bundle } = await open();
    const legacy = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    await appendTraversal(store, legacy.meta.id, {
      ts: CLOCK(),
      routingVersion: 1,
      choiceId: "ch_on",
      from: "sc_i1",
      to: "sc_i2",
      route: ["sc_i1"],
    });
    const migrated = {
      ...legacy,
      scenes: legacy.scenes.map((scene) => {
        if ("flow" in scene) throw new Error("the parity fixture must begin as a legacy scene");
        const graph = migrateLegacyScene(scene);
        return {
          ...graph,
          flow: {
            ...graph.flow,
            nodes: [...graph.flow.nodes].reverse(),
            edges: [...graph.flow.edges].reverse(),
          },
        };
      }),
    };
    const shippedMedia = async (production: ProductionBundle, clock: () => string) => {
      const result = await exportInteractive(store, production, clock);
      assert.ok(result.ok, `expected export, got ${result.ok ? "" : result.blockers.join("; ")}`);
      const manifest = JSON.parse(await readFile(join(dir, result.dir, "manifest.json"), "utf8")) as {
        media: Array<{ sceneId: string; file: string; hash: string }>;
      };
      return Promise.all(
        manifest.media
          .sort((left, right) => left.sceneId.localeCompare(right.sceneId))
          .map(async (entry) => ({ ...entry, bytes: await readFile(join(dir, result.dir, entry.file)) })),
      );
    };

    assert.deepEqual(
      await shippedMedia(migrated, () => "2026-08-01T12:00:01.000Z"),
      await shippedMedia(legacy, CLOCK),
      "graph storage order changes neither manifest media nor the files it names",
    );
  });

  /**
   * What the viewer's own copy remembers, and what it must never remember (issue #411, brief §5).
   *
   * The rule the brief is strict about: playback state is exactly scene, position, route and a
   * timestamp; it lives with the viewer; and it never reaches the world folder — a preview is
   * somebody watching, not an edit to the production.
   */
  async function exportedPlayer(): Promise<{ dir: string; player: string }> {
    const { dir, store, bundle } = await open();
    const production = await interactiveProduction(dir, bundle.productions[0]!, ROUTING);
    await appendTraversal(store, production.meta.id, {
      ts: CLOCK(),
      routingVersion: 1,
      choiceId: "ch_on",
      from: "sc_i1",
      to: "sc_i2",
      route: ["sc_i1"],
    });
    const result = await exportInteractive(store, production, CLOCK);
    assert.ok(result.ok, `expected export, got ${result.ok ? "" : result.blockers.join("; ")}`);
    return { dir: join(dir, result.dir), player: await readFile(join(dir, result.dir, "player.html"), "utf8") };
  }

  it("IV-P2: resume restores playback state, and playback state is all it is", async () => {
    const { player } = await exportedPlayer();

    // The shape, written once and never widened. Anything else in this object would be an
    // authoring decision the viewer made by watching.
    const initial = /let state = \{([^}]*)\}/.exec(player);
    assert.ok(initial, "the player declares its state literally");
    const keys = [...initial[1]!.matchAll(/(\w+)\s*:/g)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), ["positionSec", "route", "sceneId", "updatedAt"], "exactly the four");

    // Viewer-local: the key is namespaced by world, production and routing version, so a re-cut
    // graph never resumes into a scene the new package does not have, and another world's
    // production with the same slug, served from the same origin, never shares a viewer's place.
    assert.match(player, /localStorage\.setItem\(KEY/, "saved with the viewer");
    assert.match(player, /localStorage\.getItem\(KEY/, "and read back on load");
    assert.match(player, new RegExp(`KEY = "arke-iv-" \\+ "${WORLD_ID}" \\+ "-" \\+ manifest\\.provenance\\.productionId \\+ "-v" \\+ manifest\\.provenance\\.routingVersion`));

    // Resume: the last scene and the last position, not the start.
    assert.match(player, /play\(state\.sceneId, state\.positionSec\)/, "the player opens where it was left");
    assert.match(
      player,
      /if \(saved && media\[saved\.sceneId\]\) state = saved/,
      "a saved scene this package does not contain is ignored rather than played blind",
    );

    // And nothing about the viewer's watching is written back to the world.
    assert.ok(!/fetch\(|XMLHttpRequest|navigator\.sendBeacon/.test(player), "no route back to the studio");
  });

  it("IV-P2: a preview writes evidence, and the export writes no playback state into the world", async () => {
    const { dir } = await exportedPlayer();
    const { readdir } = await import("node:fs/promises");
    const shipped = await readdir(dir);
    for (const name of shipped) {
      assert.ok(
        !/playback|position|resume/i.test(name),
        `the package ships no playback state of its own (${name})`,
      );
    }
    assert.ok(shipped.includes("player.html") && shipped.includes("manifest.json"));
  });

  it("the package plays the same player the branch map's preview mounts (design turn 156)", async () => {
    const { player } = await exportedPlayer();
    // One player, two homes: the module's own text, inlined whole — not a second player kept
    // alike by hand, which is how the package and the preview drifted apart before.
    assert.ok(
      player.includes(INTERACTIVE_PLAYER_SOURCE.replace("export function mountInteractivePlayer", "function mountInteractivePlayer")),
      "the module's text is in the page, verbatim",
    );
    assert.equal(player.match(/mountInteractivePlayer\(document\.getElementById\("app"\)/g)?.length, 1, "and the page mounts it once");
    assert.match(player, /storageKey: KEY/, "the viewer's place is kept under the namespaced key");
    assert.doesNotMatch(player, /author:/, "the package has no author strip and records no evidence");
  });

  it("IV-P3: choices are untimed by default — nothing counts down, nothing chooses for you", async () => {
    const { player } = await exportedPlayer();
    // A timer in this path would be a choice made on the viewer's behalf. There is none: the
    // buttons render, the first takes focus, and the player waits.
    assert.ok(!/setTimeout|setInterval|requestAnimationFrame/.test(player), "no timer anywhere in the player");
    assert.ok(!/countdown|autoAdvance|defaultChoice|timeoutSec/i.test(player), "and no timed-choice vocabulary");
    assert.match(player, /choicesEl\.querySelector\("button"\)\?\.focus\(\)/, "the keyboard lands on the first choice");
  });
});

/**
 * A visual novel's package (turn 172): the same player, reading each scene as beats. Pictures are
 * the accepted stills, copied once however many beats show them; voices are the table read's,
 * where there are any; the text travels as text. A missing picture blocks; a missing voice does not.
 */
describe("a visual novel's package (turn 172)", () => {
  const cover = (blockId: string) => ({ blockId, textDigest: "sha256:12345678" });
  function still(id: string, shotId: string): Take {
    return { ...take(id, shotId), kind: "frame", model: "flux-pro-1.1", media: "frame.png" };
  }
  async function novel(dir: string, base: ProductionBundle, options: { withoutPicture?: boolean } = {}): Promise<ProductionBundle> {
    const takes = [still("tk_01J8E0000000000000000000V1", "sh_v1"), still("tk_01J8E0000000000000000000V2", "sh_v3")];
    for (const t of takes) {
      const takeDir = join(dir, "productions", base.meta.id, "takes", t.id);
      await mkdir(takeDir, { recursive: true });
      await writeFile(join(takeDir, "frame.png"), Buffer.from(`picture-of-${t.id}`));
    }
    const first = {
      id: "sc_i1", number: 1, slug: "i1", title: "The drowned quarter", status: "accepted" as const, version: 1,
      script: { blocks: [
        { id: "blk_wash", kind: "action" as const, text: "They hung the washing out the morning the water came." },
        { id: "blk_window", kind: "dialogue" as const, speaker: "maren-kest", text: "Somebody lit a window down there." },
      ] },
      shots: [
        { id: "sh_v1", number: 1, title: "Quarter", description: "The quarter", covers: [cover("blk_wash"), cover("blk_window")], beat: { advance: "voice" as const } },
        { id: "sh_v2", number: 2, title: "Held", description: "", beat: { samePicture: true } },
      ],
    };
    const second = {
      id: "sc_i2", number: 2, slug: "i2", title: "The pier", status: "accepted" as const, version: 1,
      script: { blocks: [{ id: "blk_level", kind: "action" as const, text: "Level." }] },
      shots: [{ id: "sh_v3", number: 1, title: "Pier", description: "The pier", covers: [cover("blk_level")] }],
    };
    return {
      ...base,
      meta: { ...base.meta, medium: "video", kind: "visual-novel" },
      scenes: [first, second],
      routing: ROUTING,
      takes,
      selections: {
        sh_v1: { acceptedTakeId: takes[0]!.id, trimInSec: 0 },
        ...(options.withoutPicture ? {} : { sh_v3: { acceptedTakeId: takes[1]!.id, trimInSec: 0 } }),
      },
    } as ProductionBundle;
  }
  const walked = { ts: CLOCK(), routingVersion: 1, choiceId: "ch_on", from: "sc_i1", to: "sc_i2", route: ["sc_i1"] };

  it("ships each scene as beats: pictures once, the prepared voice, the text as text, and verifies itself", async () => {
    const { dir, store, bundle } = await open();
    const production = await novel(dir, bundle.productions[0]!);
    await appendTraversal(store, production.meta.id, walked);
    await mkdir(join(dir, ".cache", "voice-previews"), { recursive: true });
    await writeFile(join(dir, ".cache", "voice-previews", "wash.mp3"), Buffer.from("the narrator reads"));
    const voices = async (sceneId: string) => new Map(sceneId === "sc_i1" ? [["sc_i1/sh_v1/blk_wash", ".cache/voice-previews/wash.mp3"]] : []);
    const exportId = "iv_01J8F3K2QW9VZX4N7M0RTYB6HD";
    const result = await exportInteractive(store, production, CLOCK, { exportId, voices });
    assert.ok(result.ok, `expected export, got ${result.ok ? "" : result.blockers.join("; ")}`);
    const manifest = JSON.parse(await readFile(join(dir, result.dir, "manifest.json"), "utf8")) as {
      media: unknown[];
      beats: Array<{ sceneId: string; beats: Array<Record<string, unknown>> }>;
      files: Array<{ file: string; hash: string }>;
    };
    assert.deepEqual(manifest.media, [], "no footage");
    const first = manifest.beats.find((scene) => scene.sceneId === "sc_i1")!.beats;
    assert.deepEqual(first.map((beat) => [beat.text ?? null, beat.speaker ?? null, beat.audio ?? null, beat.picture]), [
      ["They hung the washing out the morning the water came.", null, "media/voice-sc_i1_sh_v1_blk_wash.mp3", "media/picture-sh_v1.png"],
      ["Somebody lit a window down there.", "Maren Kest", null, "media/picture-sh_v1.png"],
      [null, null, null, "media/picture-sh_v1.png"],
    ], "narration voiced, Maren's line as text, and the held beat keeps sh_v1's picture");
    assert.equal(first[0]!.advance, "voice");
    assert.deepEqual(manifest.files.map((entry) => entry.file).sort(), ["media/picture-sh_v1.png", "media/picture-sh_v3.png", "media/voice-sc_i1_sh_v1_blk_wash.mp3"], "each file once");
    assert.equal(await readFile(join(dir, result.dir, "media", "voice-sc_i1_sh_v1_blk_wash.mp3"), "utf8"), "the narrator reads");
    const player = await readFile(join(dir, result.file), "utf8");
    assert.match(player, /manifest\.beats/, "the page reads the beats");
    assert.ok(player.includes(INTERACTIVE_PLAYER_SOURCE.replace("export function mountInteractivePlayer", "function mountInteractivePlayer").slice(0, 200)), "the one player");
    assert.equal(await interactiveExportCompleted(store, production.meta.id, exportId), true, "it verifies as complete");
  });

  it("refuses a beat with no picture by name, and never a line with no voice", async () => {
    const { dir, store, bundle } = await open();
    const production = await novel(dir, bundle.productions[0]!, { withoutPicture: true });
    await appendTraversal(store, production.meta.id, walked);
    const result = await exportInteractive(store, production, CLOCK);
    assert.ok(!result.ok);
    assert.deepEqual(result.blockers, ["sc_i2, beat 1 needs a picture"], "only the picture; no voices were given and none is asked for");
  });

  it("a voice path the plan names outside the world never reaches the package", async () => {
    const { dir, store, bundle } = await open();
    const production = await novel(dir, bundle.productions[0]!);
    await appendTraversal(store, production.meta.id, walked);
    const voices = async () => new Map([["sc_i1/sh_v1/blk_wash", "../outside.mp3"]]);
    const result = await exportInteractive(store, production, CLOCK, { voices });
    assert.ok(result.ok, `expected export, got ${result.ok ? "" : result.blockers.join("; ")}`);
    const manifest = JSON.parse(await readFile(join(dir, result.dir, "manifest.json"), "utf8")) as { files: Array<{ file: string }> };
    assert.equal(manifest.files.some((entry) => entry.file.startsWith("media/voice-")), false, "read as text instead");
  });
});
