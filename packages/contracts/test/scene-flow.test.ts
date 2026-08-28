import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  entryNodeIdFor,
  exitNodeIdFor,
  GraphSceneSchema,
  isGraphScene,
  linearizeSceneFlow,
  migrateLegacyScene,
  projectSceneRecord,
  resolveLegacySceneFlow,
  SceneRecordSchema,
  SceneSchema,
  sceneFlowPorts,
  SceneFlowSchema,
  shotNodeIdFor,
  validateSceneFlow,
  type GraphScene,
  type Scene,
  type SceneFlowFinding,
} from "../src/index.js";

/**
 * SPEC-029 rollout step 1: the canonical scene flow's contracts — strict shapes (T-1), every
 * malformed topology named (T-2), storage-order independence (T-3), and legacy fixtures
 * linearising exactly as their arrays with no write anywhere (T-4's read half). The writer,
 * the schema-3 boundary, and the consumer sweep are later steps and deliberately absent here.
 */

const shot = (n: number) => ({ id: `sh_${n}`, number: n, title: `Shot ${n}`, description: `beat ${n}` });

const legacy = (shots: number[]): Scene =>
  SceneSchema.parse({
    id: "sc_probe",
    number: 1,
    slug: "probe",
    title: "Probe",
    status: "draft",
    version: 1,
    shots: shots.map(shot),
  });

/** A valid graph scene built the way the writer builds one — through the migration itself. */
const graph = (shots: number[]): GraphScene => GraphSceneSchema.parse(migrateLegacyScene(legacy(shots)));

const kinds = (findings: SceneFlowFinding[]) => findings.map((finding) => finding.kind);

const emptyStair = { id: "sh_14", number: 14, title: "The empty stair", description: "Maren stops below the bell room." };
const bellAnswers = { id: "sh_15", number: 15, title: "The bell answers", description: "The drowned bell moves without being touched." };

/** The §2.3 persisted example, verbatim minus the jsonc comments. */
const bellRoom = {
  id: "sc_bell-room",
  number: 4,
  order: 4,
  slug: "bell-room",
  title: "The Bell Room",
  status: "draft",
  version: 8,
  script: { blocks: [] },
  flow: {
    schemaVersion: 1,
    entryNodeId: "sfn_sc-bell-room-entry",
    exitNodeId: "sfn_sc-bell-room-exit",
    nodes: [
      { id: "sfn_sc-bell-room-entry", kind: "entry" },
      { id: "sfn_sh-14", kind: "shot", shot: emptyStair },
      { id: "sfn_sh-15", kind: "shot", shot: bellAnswers },
      { id: "sfn_sc-bell-room-exit", kind: "exit" },
    ],
    edges: [
      {
        id: "sfe_entry-sh-14",
        kind: "sequence",
        from: { nodeId: "sfn_sc-bell-room-entry", port: "out" },
        to: { nodeId: "sfn_sh-14", port: "in" },
      },
      {
        id: "sfe_sh-14-sh-15",
        kind: "sequence",
        from: { nodeId: "sfn_sh-14", port: "out" },
        to: { nodeId: "sfn_sh-15", port: "in" },
      },
      {
        id: "sfe_sh-15-exit",
        kind: "sequence",
        from: { nodeId: "sfn_sh-15", port: "out" },
        to: { nodeId: "sfn_sc-bell-room-exit", port: "in" },
      },
    ],
    storyboardGroups: [{ id: "sbg_the-approach", title: "The approach", shotNodeIds: ["sfn_sh-14", "sfn_sh-15"] }],
  },
};

describe("the read union (SPEC-029 R-1; T-1)", () => {
  it("parses the specification's own persisted example as a graph scene", () => {
    const scene = SceneRecordSchema.parse(bellRoom);
    if (!isGraphScene(scene)) assert.fail("expected the graph arm");
    assert.equal(scene.flow.nodes.length, 4);
    assert.equal("shots" in scene, false, "a graph scene carries no shots[]");
  });

  it("parses a legacy scene through the same union, unchanged", () => {
    const scene = SceneRecordSchema.parse({
      id: "sc_1",
      number: 1,
      slug: "old",
      title: "Old",
      status: "accepted",
      version: 1,
      shots: [shot(1)],
    });
    if (isGraphScene(scene)) assert.fail("expected the legacy arm");
    assert.equal(scene.shots.length, 1);
  });

  it("refuses a scene carrying both structural fields, naming them", () => {
    const result = SceneRecordSchema.safeParse({ ...bellRoom, shots: [shot(1)] });
    assert.ok(!result.success);
    assert.match(result.error.issues[0]!.message, /both "shots" and "flow"/);
  });

  it("refuses a scene carrying neither structural field, naming them", () => {
    const { flow: _flow, ...bare } = bellRoom;
    const result = SceneRecordSchema.safeParse(bare);
    assert.ok(!result.success);
    assert.match(result.error.issues[0]!.message, /neither "shots" nor "flow"/);
  });

  it("refuses a record that is not an object at all", () => {
    for (const value of [null, "scene", 4, [bellRoom]]) {
      const result = SceneRecordSchema.safeParse(value);
      assert.ok(!result.success);
      assert.match(result.error.issues[0]!.message, /must be an object/);
    }
  });

  it("carries the arm's own failure through the union — a bad graph scene names its real problem", () => {
    const broken = structuredClone(bellRoom);
    broken.flow.nodes[0]!.id = "node_1";
    const result = SceneRecordSchema.safeParse(broken);
    assert.ok(!result.success);
    assert.ok(result.error.issues.some((issue) => /sfn_/.test(issue.message)));
  });

  it("refuses an unknown node kind — widening is a specification, not an enum edit", () => {
    const broken = structuredClone(bellRoom);
    (broken.flow.nodes[1] as { kind: string }).kind = "choice";
    const result = GraphSceneSchema.safeParse(broken);
    assert.ok(!result.success);
  });

  it("refuses an unknown edge kind", () => {
    const broken = structuredClone(bellRoom);
    (broken.flow.edges[0] as { kind: string }).kind = "choice";
    assert.ok(!GraphSceneSchema.safeParse(broken).success);
  });

  it("refuses unknown keys on flow, node, edge, and group alike", () => {
    for (const poison of [
      (flow: Record<string, unknown>) => (flow["layout"] = {}),
      (flow: { nodes: Record<string, unknown>[] }) => (flow.nodes[0]!["x"] = 12),
      (flow: { edges: Record<string, unknown>[] }) => (flow.edges[0]!["condition"] = "gold > 3"),
      (flow: { storyboardGroups: Record<string, unknown>[] }) => (flow.storyboardGroups[0]!["pass"] = 1),
    ]) {
      const broken = structuredClone(bellRoom);
      poison(broken.flow as never);
      assert.ok(!GraphSceneSchema.safeParse(broken).success, "an unknown key must fail parse");
    }
  });

  it("refuses a port that is not the one the endpoint direction allows", () => {
    const broken = structuredClone(bellRoom);
    (broken.flow.edges[0]!.from as { port: string }).port = "in";
    assert.ok(!GraphSceneSchema.safeParse(broken).success);
  });

  it("refuses an empty storyboard group and a wrong flow schemaVersion", () => {
    const emptied = structuredClone(bellRoom);
    emptied.flow.storyboardGroups[0]!.shotNodeIds = [];
    assert.ok(!GraphSceneSchema.safeParse(emptied).success);
    const versioned = structuredClone(bellRoom);
    (versioned.flow as { schemaVersion: number }).schemaVersion = 2;
    assert.ok(!GraphSceneSchema.safeParse(versioned).success);
  });

  it("types ports by node kind (R-4)", () => {
    assert.deepEqual(sceneFlowPorts("entry"), ["out"]);
    assert.deepEqual(sceneFlowPorts("shot"), ["in", "out"]);
    assert.deepEqual(sceneFlowPorts("exit"), ["in"]);
  });
});

describe("graph validation names every malformed topology (R-6, R-58; T-2)", () => {
  it("accepts the linear shapes: many shots, one shot, and the empty Entry→Exit scene", () => {
    assert.deepEqual(validateSceneFlow(graph([1, 2, 3]).flow), []);
    assert.deepEqual(validateSceneFlow(graph([1]).flow), []);
    assert.deepEqual(validateSceneFlow(graph([]).flow), []);
  });

  it("names a branch in §2.7's words, and the reconvergence it lands on", () => {
    const flow = graph([1, 2]).flow;
    flow.edges.push({
      id: "sfe_extra",
      kind: "sequence",
      from: { nodeId: shotNodeIdFor("sh_1"), port: "out" },
      to: { nodeId: exitNodeIdFor("sc_probe"), port: "in" },
    });
    const findings = validateSceneFlow(flow);
    const branch = findings.find((finding) => finding.kind === "branch");
    assert.equal(branch?.about, shotNodeIdFor("sh_1"));
    assert.equal(branch?.message, "Shot 1 has two next shots. Choices belong between scenes.");
    assert.ok(kinds(findings).includes("reconvergence"));
  });

  it("names a disjoint cycle as both the skipped shots and the loop that skips them", () => {
    const flow = graph([1]).flow;
    const loop = resolveLegacySceneFlow(legacy([2, 3])).nodes.filter((node) => node.kind === "shot");
    flow.nodes.push(...loop);
    flow.edges.push(
      {
        id: "sfe_sh-2-sh-3",
        kind: "sequence",
        from: { nodeId: shotNodeIdFor("sh_2"), port: "out" },
        to: { nodeId: shotNodeIdFor("sh_3"), port: "in" },
      },
      {
        id: "sfe_sh-3-sh-2",
        kind: "sequence",
        from: { nodeId: shotNodeIdFor("sh_3"), port: "out" },
        to: { nodeId: shotNodeIdFor("sh_2"), port: "in" },
      },
    );
    const findings = validateSceneFlow(flow);
    const skipped = findings.find((finding) => finding.kind === "skipped-shot");
    assert.equal(skipped?.message, "Shot 2 and Shot 3 are never reached between Scene start and end.");
    const cycle = findings.find((finding) => finding.kind === "cycle");
    assert.equal(cycle?.message, "Shot 3 leads back to Shot 2. A scene needs one forward path.");
    assert.deepEqual(cycle?.evidence, [shotNodeIdFor("sh_2"), shotNodeIdFor("sh_3")]);
  });

  it("names a self-edge before any degree conclusion is drawn from it", () => {
    const flow = graph([1, 2]).flow;
    flow.edges.push({
      id: "sfe_selfish",
      kind: "sequence",
      from: { nodeId: shotNodeIdFor("sh_2"), port: "out" },
      to: { nodeId: shotNodeIdFor("sh_2"), port: "in" },
    });
    const findings = validateSceneFlow(flow);
    assert.deepEqual(kinds(findings), ["self-edge"], "referential findings return alone — no phantom branch");
    assert.match(findings[0]!.message, /connects Shot 2 to itself/);
  });

  it("names parallel edges with both connection ids as evidence", () => {
    const flow = graph([1, 2]).flow;
    const twin = structuredClone(flow.edges[1]!);
    twin.id = "sfe_twin";
    flow.edges.push(twin);
    const findings = validateSceneFlow(flow);
    assert.equal(findings[0]!.kind, "parallel-edges");
    assert.deepEqual(findings[0]!.evidence, [flow.edges[1]!.id, "sfe_twin"]);
  });

  it("names a dangling endpoint by connection and missing node", () => {
    const flow = graph([1]).flow;
    flow.edges[1]!.to.nodeId = "sfn_ghost";
    const findings = validateSceneFlow(flow);
    assert.equal(findings[0]!.kind, "dangling-endpoint");
    assert.match(findings[0]!.message, /points to a node that is missing \(sfn_ghost\)/);
  });

  it("names an edge into Entry and an edge out of Exit as the ports they do not have", () => {
    const intoEntry = graph([1]).flow;
    intoEntry.edges.push({
      id: "sfe_backwards",
      kind: "sequence",
      from: { nodeId: shotNodeIdFor("sh_1"), port: "out" },
      to: { nodeId: entryNodeIdFor("sc_probe"), port: "in" },
    });
    assert.match(validateSceneFlow(intoEntry).find((f) => f.kind === "incompatible-port")!.message, /into Scene start, which has no input/);

    const outOfExit = graph([1]).flow;
    outOfExit.edges.push({
      id: "sfe_onwards",
      kind: "sequence",
      from: { nodeId: exitNodeIdFor("sc_probe"), port: "out" },
      to: { nodeId: shotNodeIdFor("sh_1"), port: "in" },
    });
    assert.match(validateSceneFlow(outOfExit).find((f) => f.kind === "incompatible-port")!.message, /out of Scene end, which has no output/);
  });

  it("names a shot connected on neither side, in §2.7's words", () => {
    const flow = graph([1]).flow;
    flow.nodes.push({ id: shotNodeIdFor("sh_9"), kind: "shot", shot: shot(9) });
    const findings = validateSceneFlow(flow);
    assert.deepEqual(kinds(findings), ["disconnected"]);
    assert.equal(findings[0]!.message, "Shot 9 is not connected between Scene start and end.");
  });

  it("names duplicate node, edge, and group ids", () => {
    const nodes = graph([1]).flow;
    nodes.nodes.push({ id: shotNodeIdFor("sh_1"), kind: "shot", shot: shot(1) });
    assert.ok(kinds(validateSceneFlow(nodes)).includes("duplicate-node-id"));

    const edges = graph([1, 2]).flow;
    edges.edges[2]!.id = edges.edges[0]!.id;
    assert.ok(kinds(validateSceneFlow(edges)).includes("duplicate-edge-id"));

    const groups = graph([1, 2]).flow;
    groups.storyboardGroups = [
      { id: "sbg_twice", title: "Once", shotNodeIds: [shotNodeIdFor("sh_1")] },
      { id: "sbg_twice", title: "Again", shotNodeIds: [shotNodeIdFor("sh_2")] },
    ];
    assert.ok(kinds(validateSceneFlow(groups)).includes("duplicate-group-id"));
  });

  it("names a wrong Entry or Exit: absent, mistyped, or duplicated", () => {
    const absent = graph([1]).flow;
    absent.entryNodeId = "sfn_elsewhere";
    assert.match(validateSceneFlow(absent)[0]!.message, /is not a node in this scene/);

    const mistyped = graph([1]).flow;
    mistyped.entryNodeId = shotNodeIdFor("sh_1");
    assert.ok(
      validateSceneFlow(mistyped).some((finding) => finding.kind === "entry-mismatch" && / is a shot node\./.test(finding.message)),
    );

    const doubled = graph([1]).flow;
    doubled.nodes.push({ id: "sfn_second-exit", kind: "exit" });
    assert.ok(
      validateSceneFlow(doubled).some(
        (finding) => finding.kind === "exit-mismatch" && /exactly one end; found 2 exit nodes/.test(finding.message),
      ),
    );
  });

  it("names an Exit nothing reaches", () => {
    const flow = graph([1]).flow;
    flow.edges.pop();
    const findings = validateSceneFlow(flow);
    assert.ok(kinds(findings).includes("unreachable-exit"));
    assert.ok(kinds(findings).includes("disconnected"), "the shot lost its out side too");
  });

  it("holds storyboard groups to R-31: contiguous, exclusive, shots only, no ghosts", () => {
    const contiguous = graph([1, 2, 3]).flow;
    contiguous.storyboardGroups = [{ id: "sbg_run", title: "The run", shotNodeIds: [shotNodeIdFor("sh_3"), shotNodeIdFor("sh_2")] }];
    assert.deepEqual(validateSceneFlow(contiguous), [], "membership is a set — storage order carries no meaning");

    const gapped = graph([1, 2, 3]).flow;
    gapped.storyboardGroups = [{ id: "sbg_gap", title: "The approach", shotNodeIds: [shotNodeIdFor("sh_1"), shotNodeIdFor("sh_3")] }];
    const finding = validateSceneFlow(gapped)[0]!;
    assert.equal(finding.kind, "group-not-contiguous");
    assert.equal(finding.message, "“The approach” skips Shot 2. A storyboard group must stay together.");

    const overlapping = graph([1, 2]).flow;
    overlapping.storyboardGroups = [
      { id: "sbg_a", title: "A", shotNodeIds: [shotNodeIdFor("sh_1"), shotNodeIdFor("sh_2")] },
      { id: "sbg_b", title: "B", shotNodeIds: [shotNodeIdFor("sh_2")] },
    ];
    assert.equal(validateSceneFlow(overlapping)[0]!.kind, "group-overlap");

    const ghostly = graph([1]).flow;
    ghostly.storyboardGroups = [{ id: "sbg_ghost", title: "Ghost", shotNodeIds: ["sfn_ghost"] }];
    assert.equal(validateSceneFlow(ghostly)[0]!.kind, "group-member-missing");

    const terminal = graph([1]).flow;
    terminal.storyboardGroups = [{ id: "sbg_start", title: "Start", shotNodeIds: [entryNodeIdFor("sc_probe")] }];
    assert.equal(validateSceneFlow(terminal)[0]!.kind, "group-member-not-shot");

    const doubled = graph([1]).flow;
    doubled.storyboardGroups = [{ id: "sbg_twin", title: "Twin", shotNodeIds: [shotNodeIdFor("sh_1"), shotNodeIdFor("sh_1")] }];
    assert.equal(validateSceneFlow(doubled)[0]!.kind, "group-member-duplicated");
  });
});

describe("storage order is not playback order (R-18; T-3)", () => {
  it("permuting nodes[] and edges[] changes nothing the walk answers", () => {
    const scene = graph([1, 2, 3, 4]);
    const canonical = linearizeSceneFlow(scene);
    assert.equal(canonical.kind, "linear");

    const reversed = structuredClone(scene);
    reversed.flow.nodes.reverse();
    reversed.flow.edges.reverse();
    const interleaved = structuredClone(scene);
    interleaved.flow.nodes = [3, 0, 4, 1, 5, 2].map((i) => interleaved.flow.nodes[i]!);
    interleaved.flow.edges = [2, 4, 0, 3, 1].map((i) => interleaved.flow.edges[i]!);

    for (const permuted of [reversed, interleaved]) {
      assert.deepEqual(validateSceneFlow(permuted.flow), []);
      const sequence = linearizeSceneFlow(permuted);
      assert.deepEqual(sequence, canonical, "same edges, same sequence — bytes moved, meaning did not");
    }
  });
});

describe("one linearisation boundary (R-7, R-16)", () => {
  it("walks the example graph Entry to Exit", () => {
    const sequence = linearizeSceneFlow(SceneRecordSchema.parse(bellRoom));
    assert.ok(sequence.kind === "linear");
    assert.deepEqual(
      sequence.shots.map((pair) => [pair.nodeId, pair.shot.id]),
      [
        ["sfn_sh-14", "sh_14"],
        ["sfn_sh-15", "sh_15"],
      ],
    );
    assert.equal(sequence.entryNodeId, "sfn_sc-bell-room-entry");
    assert.equal(sequence.exitNodeId, "sfn_sc-bell-room-exit");
  });

  it("answers a legacy scene as its array order, without mutating it", () => {
    const scene = legacy([3, 1, 2]);
    const sequence = linearizeSceneFlow(scene);
    assert.ok(sequence.kind === "linear");
    assert.deepEqual(
      sequence.shots.map((pair) => pair.shot.id),
      ["sh_3", "sh_1", "sh_2"],
      "array order, not number order — the array is the legacy authority",
    );
    assert.deepEqual(
      sequence.shots.map((pair) => pair.nodeId),
      [shotNodeIdFor("sh_3"), shotNodeIdFor("sh_1"), shotNodeIdFor("sh_2")],
    );
    sequence.shots.pop();
    assert.equal(scene.shots.length, 3, "the returned array is fresh");
  });

  it("refuses to partially linearise a malformed graph", () => {
    const scene = graph([1, 2]);
    scene.flow.edges[1]!.to.nodeId = "sfn_ghost";
    const sequence = linearizeSceneFlow(scene);
    assert.ok(sequence.kind === "invalid");
    assert.equal(sequence.findings[0]!.kind, "dangling-endpoint");
  });
});

describe("the legacy projection is the future migration, byte for byte (R-10, R-12)", () => {
  it("projects the bell room exactly as the specification's example writes it", () => {
    const scene = SceneSchema.parse({
      id: "sc_bell-room",
      number: 4,
      order: 4,
      slug: "bell-room",
      title: "The Bell Room",
      status: "draft",
      version: 8,
      script: { blocks: [] },
      shots: [emptyStair, bellAnswers],
    });
    const flow = resolveLegacySceneFlow(scene);
    assert.deepEqual(flow.nodes, bellRoom.flow.nodes);
    assert.deepEqual(flow.edges, bellRoom.flow.edges);
    assert.equal(flow.entryNodeId, bellRoom.flow.entryNodeId);
    assert.equal(flow.exitNodeId, bellRoom.flow.exitNodeId);
    assert.deepEqual(flow.storyboardGroups, [], "migration authors no groups — people do");
  });

  it("is deterministic to the byte, twice over (R-12)", () => {
    const scene = legacy([1, 2, 3]);
    assert.equal(JSON.stringify(resolveLegacySceneFlow(scene)), JSON.stringify(resolveLegacySceneFlow(scene)));
  });

  it("projects an empty legacy scene as Entry connected straight to Exit (R-6)", () => {
    const flow = resolveLegacySceneFlow(legacy([]));
    assert.equal(flow.edges.length, 1);
    assert.equal(flow.edges[0]!.id, "sfe_entry-exit");
    assert.deepEqual(validateSceneFlow(flow), []);
  });

  it("always satisfies the strict schema and the graph invariants it will be written under", () => {
    const flow = SceneFlowSchema.parse(resolveLegacySceneFlow(legacy([5, 6, 7])));
    assert.deepEqual(validateSceneFlow(flow), []);
  });

  it("holds a 200-shot scene without losing order or validity (R-69's contracts slice)", () => {
    const numbers = Array.from({ length: 200 }, (_, i) => i + 1);
    const scene = graph(numbers);
    assert.deepEqual(validateSceneFlow(scene.flow), []);
    const sequence = linearizeSceneFlow(scene);
    assert.ok(sequence.kind === "linear");
    assert.deepEqual(
      sequence.shots.map((pair) => pair.shot.number),
      numbers,
    );
  });
});

describe("the writer's record and the reader's projection (R-11, R-12; rollout step 2)", () => {
  it("migration is the projection plus dropping the array it came from", () => {
    const scene = legacy([1, 2, 3]);
    const migrated = migrateLegacyScene(scene);
    assert.ok(!("shots" in migrated), "a graph scene has no shots[] beside its flow (R-1)");
    assert.deepEqual(migrated.flow, resolveLegacySceneFlow(scene), "and the flow is the projection, unchanged");
    const { shots: _shots, ...base } = scene;
    const { flow: _flow, ...carried } = migrated;
    assert.deepEqual(carried, base, "every other field keeps its identity, owner, and value");
    assert.deepEqual(GraphSceneSchema.parse(migrated), migrated, "and the result is strictly a graph scene");
  });

  it("is byte-identical however many times it is repeated (R-12)", () => {
    const scene = legacy([7, 8]);
    const once = JSON.stringify(migrateLegacyScene(scene));
    assert.equal(once, JSON.stringify(migrateLegacyScene(scene)));
    // And migrating what a migration produced, by way of its own projection, lands the same file.
    const projected = projectSceneRecord(migrateLegacyScene(scene));
    assert.ok(projected.kind === "scene");
    assert.equal(JSON.stringify(migrateLegacyScene(projected.scene)), once);
  });

  it("migrates an empty scene into Entry straight to Exit, and back again", () => {
    const migrated = migrateLegacyScene(legacy([]));
    assert.deepEqual(validateSceneFlow(migrated.flow), []);
    const projected = projectSceneRecord(migrated);
    assert.ok(projected.kind === "scene");
    assert.deepEqual(projected.scene.shots, []);
  });

  it("projects a graph scene back to the shape every consumer still reads", () => {
    const scene = graph([4, 5, 6]);
    const projected = projectSceneRecord(scene);
    assert.ok(projected.kind === "scene");
    assert.ok(!("flow" in projected.scene), "the projection is the legacy shape, not both at once");
    assert.deepEqual(
      projected.scene.shots.map((shot) => shot.id),
      ["sh_4", "sh_5", "sh_6"],
      "in canonical order, whatever order the nodes were stored in",
    );
    assert.deepEqual(projected.scene, legacy([4, 5, 6]), "and is the legacy scene it was migrated from");
  });

  it("hands a legacy scene straight back, without copying or reordering anything", () => {
    const scene = legacy([1, 2]);
    const projected = projectSceneRecord(scene);
    assert.ok(projected.kind === "scene");
    assert.equal(projected.scene, scene, "there is nothing to project");
  });

  it("projects a malformed graph to nothing at all, with the findings named (R-7, R-60)", () => {
    const scene = graph([1, 2]);
    scene.flow.edges[1]!.to.nodeId = "sfn_ghost";
    const projected = projectSceneRecord(scene);
    assert.ok(projected.kind === "invalid", "a broken graph never becomes a guessed array");
    assert.deepEqual(kinds(projected.findings), ["dangling-endpoint"]);
  });

  it("does not care what order the nodes and edges were stored in (R-18)", () => {
    const scene = graph([1, 2, 3]);
    scene.flow.nodes.reverse();
    scene.flow.edges.reverse();
    const projected = projectSceneRecord(scene);
    assert.ok(projected.kind === "scene");
    assert.deepEqual(
      projected.scene.shots.map((shot) => shot.id),
      ["sh_1", "sh_2", "sh_3"],
    );
  });
});

describe("legacy fixtures linearise exactly as their arrays (T-4's read half)", () => {
  it("every scene fixture on disk agrees with itself through every read path", async () => {
    const worlds = fileURLToPath(new URL("../../../fixtures/worlds/", import.meta.url));
    const sceneFiles: string[] = [];
    for (const world of await readdir(worlds)) {
      const productions = join(worlds, world, "productions");
      for (const production of await readdir(productions).catch(() => [] as string[])) {
        const scenes = join(productions, production, "scenes");
        for (const file of await readdir(scenes).catch(() => [] as string[])) {
          if (file.endsWith(".json")) sceneFiles.push(join(scenes, file));
        }
      }
    }
    assert.ok(sceneFiles.length >= 3, `expected the fixture worlds to hold scenes; found ${sceneFiles.length}`);

    for (const file of sceneFiles) {
      const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
      const scene = SceneSchema.parse(raw);
      const viaUnion = SceneRecordSchema.parse(raw);
      assert.ok(!isGraphScene(viaUnion), `${file} is a legacy fixture`);

      const sequence = linearizeSceneFlow(scene);
      assert.ok(sequence.kind === "linear");
      assert.deepEqual(
        sequence.shots.map((pair) => pair.shot),
        scene.shots,
        `${file} must linearise exactly as its shots[]`,
      );

      // The record this fixture would migrate into is valid, strict, and walks identically.
      const flow = resolveLegacySceneFlow(scene);
      assert.deepEqual(validateSceneFlow(flow), [], `${file} projects to a valid linear graph`);
      const migrated = GraphSceneSchema.parse(migrateLegacyScene(scene));
      const graphSequence = linearizeSceneFlow(migrated);
      assert.ok(graphSequence.kind === "linear");
      assert.deepEqual(
        graphSequence.shots.map((pair) => pair.shot.id),
        scene.shots.map((s) => s.id),
        `${file} must walk its graph in the order its array held`,
      );
    }
  });
});
