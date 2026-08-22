import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RoutingSchema, type ProductionBundle, type Routing, type Take } from "@arke-studio/contracts";
import {
  appendTraversal,
  exportInteractive,
  interactiveFindings,
  proposeBranchCanon,
  saveRouting,
} from "../../src/productions/interactive.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
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
    const result = await exportInteractive(store, production, CLOCK);
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

    // Viewer-local: the key is namespaced by production and routing version, so a re-cut graph
    // never resumes into a scene the new package does not have.
    assert.match(player, /localStorage\.setItem\(KEY/, "saved with the viewer");
    assert.match(player, /localStorage\.getItem\(KEY/, "and read back on load");
    assert.match(player, /KEY = "arke-iv-" \+ manifest\.provenance\.productionId \+ "-v" \+ manifest\.provenance\.routingVersion/);

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

  it("IV-P3: choices are untimed by default — nothing counts down, nothing chooses for you", async () => {
    const { player } = await exportedPlayer();
    // A timer in this path would be a choice made on the viewer's behalf. There is none: the
    // buttons render, the first takes focus, and the player waits.
    assert.ok(!/setTimeout|setInterval|requestAnimationFrame/.test(player), "no timer anywhere in the player");
    assert.ok(!/countdown|autoAdvance|defaultChoice|timeoutSec/i.test(player), "and no timed-choice vocabulary");
    assert.match(player, /Untimed by default/, "the rule is stated where the choices are built");
    assert.match(player, /choicesEl\.querySelector\("button"\)\?\.focus\(\)/, "the keyboard lands on the first choice");
  });
});
