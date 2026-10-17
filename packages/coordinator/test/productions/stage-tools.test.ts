import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { orderedShots, stageShot, type ClientMessage, type DomainEvent, type HarnessAdapter, type HarnessEvent } from "@arke-studio/contracts";
import { StageConstructor } from "../../src/productions/stage-construction.js";
import { WorldQueryServer, type LeasedTools } from "../../src/harness/world-query.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { encodePng, solidImage } from "../../src/references/png.js";

type Construction = Extract<DomainEvent, { type: "stage.construction" }>;

/** Events pushed as the scripted model works, streamed in order to whoever is listening. */
function channel() {
  const items: HarnessEvent[] = [];
  let notify: (() => void) | null = null;
  return {
    push(event: HarnessEvent) { items.push(event); notify?.(); },
    async *stream(signal?: AbortSignal): AsyncGenerator<HarnessEvent> {
      while (!signal?.aborted) {
        if (items.length > 0) { yield items.shift()!; continue; }
        await new Promise<void>((resolve) => {
          notify = () => { notify = null; resolve(); };
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      }
    },
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * A scripted stage-designer: each turn reads the source images the prompt names, makes its tool
 * calls through the leased surface the run attached, and ends its message.
 */
async function build(input: {
  turns: Array<(call: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; isError: boolean }>) => Promise<void>>;
  preserve?: "blocking" | "camera" | "none";
  staged?: boolean;
  /** Frames the client returns for each render; three by default. */
  frames?: number;
}) {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  const bundle = structuredClone(store.getBundle());
  const scene = bundle.productions.find((p) => p.meta.id === "saltlight")!.scenes.find((s) => s.id === "sc_04")!;
  const shot = orderedShots(scene).find((s) => s.id === "sh_12")!;
  shot.durationSec = 4;
  if (input.staged) shot.staging = structuredClone(stageShot(shot, { cast: ["maren-kest"], sets: [], durationSec: 4 }));
  store.getBundle = () => bundle;
  const events = channel();
  let host: LeasedTools | undefined;
  let turn = 0;
  const results: Array<{ name: string; text: string; isError: boolean }> = [];
  const adapter: HarnessAdapter = {
    id: "test",
    readiness: () => ({ ready: true }),
    capabilities: () => new Set(["events"]),
    createSession: async () => { servedAtCreate = attached !== null; return { sessionId: "stage-tools" }; },
    sendMessage: async () => ({ sessionId: "stage-tools", correlationId: "unused" }),
    streamEvents: (signal) => events.stream(signal),
    dispatchAsync: async (message) => {
      const prompt = message.parts.map((part) => part.text).join(" ");
      const script = input.turns[turn++];
      void (async () => {
        for (const name of new Set(prompt.match(/(?:plate|source-\d+)\.(?:png|jpg|jpeg|webp)/g) ?? []))
          events.push({ type: "tool.activity", sessionId: "stage-tools", tool: "Read", summary: name });
        await tick();
        const call = async (name: string, args: Record<string, unknown> = {}) => {
          const reply = await host!.call(name, args);
          const text = reply.content.filter((part) => part["type"] === "text").map((part) => String(part["text"])).join("\n");
          results.push({ name, text, isError: reply.isError === true });
          return { text, isError: reply.isError === true };
        };
        await script?.(call);
        events.push({ type: "message.completed", sessionId: "stage-tools", text: "Working with the tools." });
      })();
      return { sessionId: "stage-tools", correlationId: String(turn) };
    },
  };
  const constructor = new StageConstructor();
  const emitted: Construction[] = [];
  const request: Extract<ClientMessage, { kind: "stage-construct" }> = {
    kind: "stage-construct", worldId: store.worldId, productionId: "saltlight", sceneId: scene.id, shotId: shot.id,
    baseVersion: scene.version, requestId: randomUUID(), instruction: "Maren at the rail, listening.", preserve: input.preserve ?? "none",
  };
  const png = Buffer.from(encodePng(solidImage(64, 36, [20, 30, 40, 255]))).toString("base64");
  let attached: string | null = null;
  let servedAtCreate = false;
  try {
    await constructor.run(store, request, {
      adapter,
      sessionInput: (session) => session,
      model: "test/vision",
      scratchRoot: join(dir, ".scratch"),
      current: () => true,
      tools: {
        url: (token) => `http://127.0.0.1:1/mcp/${token}`,
        attach: (token, tools) => { attached = token; host = tools; },
        detach: (token) => { if (token === attached) attached = null; },
      },
      emit: (event) => {
        emitted.push(event);
        if (event.status === "inspect")
          constructor.inspect(store.worldId, request.requestId, event.round, input.frames === undefined ? [
            { at: 0, view: "camera", png, observations: ["maren-kest: screen (0.00, 0.10)"] },
            { at: 4, view: "camera", png },
            { at: 0, view: "overview", png },
          ] : Array.from({ length: input.frames }, (_, index) => ({ at: index * 0.5, view: "camera" as const, png })));
      },
    });
  } finally {
    await store.close();
  }
  return { emitted, results, terminal: emitted.at(-1)!, turns: turn, detached: attached === null, original: shot.staging, servedAtCreate };
}

it("builds a blockout as small tool calls on a draft the run owns, looking when it asks to (issue 1823)", async () => {
  const { emitted, results, terminal, detached, servedAtCreate } = await build({ turns: [async (call) => {
    assert.match((await call("stage_get")).text, /"rendersLeft": 8/);
    await call("stage_add", { kind: "set", item: { name: "deck", kit: { kind: "room", open: ["front"] }, x: 0, z: 0, w: 8, h: 4, d: 10 } });
    await call("stage_add", { kind: "figure", item: { sheetId: "maren-kest", x: 0, z: 0, facing: 180 } });
    await call("stage_pose", { sheetId: "maren-kest", key: { t: 0, x: 0, z: 0 } });
    await call("stage_pose", { sheetId: "maren-kest", key: { t: 3, x: 0.6, z: -0.4, pose: "lean-on", hand: { side: "left", on: "deck" } } });
    await call("stage_camera_key", { key: { t: 0, frame: { subject: "maren-kest", size: "wide", angle: "eye", side: "front" } } });
    await call("stage_camera_key", { key: { t: 4, frame: { subject: "maren-kest", size: "medium", angle: "eye", side: "front" } } });
    assert.match((await call("stage_done", { assessment: "Too soon." })).text, /Render the shot at least once/);
    const render = await call("stage_render", { at: [1] });
    assert.equal(render.isError, false);
    assert.match(render.text, /render-1-0-camera\.png/);
    assert.match((await call("stage_measure", { a: "camera", b: "maren-kest", at: 0 })).text, /"distance"/);
    await call("stage_check");
    await call("stage_done", { assessment: "Wide on Maren at the rail, pushing to a medium as she leans.", assumptions: ["The rail is the deck's front edge."] });
  }] });
  assert.equal(terminal.status, "ready", terminal.detail);
  assert.ok(servedAtCreate, "the tools are served before the session opens: Codex lists them while creating it");
  assert.ok(detached, "the run's tools stop answering when it ends");
  const draft = terminal.draft!;
  assert.deepEqual(draft.cast.map((figure) => figure.sheetId), ["maren-kest"]);
  assert.equal(draft.sets[0]?.kit?.kind, "room");
  assert.equal(draft.staging.keys.length, 2);
  assert.ok(draft.staging.keys.every((key) => key.frame !== undefined && key.p.length === 3), "worded keys are solved and keep their words");
  assert.equal(draft.staging.performances?.[0]?.keys[1]?.pose, "lean-on");
  assert.equal(draft.staging.authorship?.inspectedFrames, 3);
  assert.match(draft.assessment, /leans/);
  assert.deepEqual(draft.inspected, ["render-1-0-camera.png", "render-1-1-camera.png", "render-1-2-overview.png"]);
  // Each step is a line of the working log, with the draft as it stands when it is a whole one.
  const steps = emitted.filter((event) => event.step !== undefined);
  assert.ok(steps.some((event) => event.step!.label === "deck · room 8 × 10 × 4"));
  assert.ok(steps.some((event) => /^Maren Kest · lean on$/i.test(event.step!.label)));
  assert.ok(steps.some((event) => event.step!.label === "wide on Maren Kest"));
  assert.ok(steps.some((event) => event.step!.label === "render · 1.0 s" && event.step!.detail === "3 views"));
  assert.equal(steps.at(-1)?.step?.label, "done");
  assert.ok((steps.at(-1)?.calls ?? 0) >= 11);
  assert.ok(results.filter((result) => result.isError).length === 1, "only the early stage_done was refused");
});

it("records at most the frames authorship holds, however many the renders saw (issue 1823)", async () => {
  const { terminal } = await build({ frames: 8, turns: [async (call) => {
    await call("stage_add", { kind: "figure", item: { sheetId: "maren-kest", x: 0, z: 0, facing: 180 } });
    await call("stage_camera_key", { key: { t: 0, frame: { subject: "maren-kest", size: "wide", angle: "eye", side: "front" } } });
    await call("stage_camera_key", { key: { t: 4, frame: { subject: "maren-kest", size: "medium", angle: "eye", side: "front" } } });
    for (let render = 0; render < 4; render++) await call("stage_render", { at: [1] });
    await call("stage_done", { assessment: "Wide on Maren, pushing in." });
  }] });
  assert.equal(terminal.status, "ready", terminal.detail);
  assert.equal(terminal.draft?.staging.authorship?.inspectedFrames, 24, "32 frames seen, 24 recorded: the build is not thrown away");
});

it("refuses a protected field at the tool, whatever the call (issue 1823)", async () => {
  const { results, terminal, original } = await build({ preserve: "blocking", staged: true, turns: [async (call) => {
    assert.match((await call("stage_add", { kind: "figure", item: { sheetId: "maren-kest", x: 4, z: 0 } })).text, /Blocking is protected/);
    assert.match((await call("stage_update", { name: "maren-kest", patch: { x: 3 } })).text, /Blocking is protected/);
    assert.match((await call("stage_pose", { sheetId: "maren-kest", key: { t: 1, x: 2, z: 0 } })).text, /Blocking is protected/);
    assert.match((await call("stage_remove", { name: "maren-kest" })).text, /Blocking is protected/);
    assert.equal((await call("stage_camera_move", { move: "push-in", subject: "maren-kest" })).isError, false, "the camera is this build's to change");
    await call("stage_render");
    await call("stage_done", { assessment: "Pushed in on Maren; her blocking is as kept." });
  }] });
  assert.equal(terminal.status, "ready", terminal.detail);
  assert.deepEqual(terminal.draft!.cast, original!.cast, "the kept figures came through untouched");
  assert.equal(results.filter((result) => result.isError).length, 4);
});

it("refuses the camera when it is the protected half (issue 1823)", async () => {
  const { terminal } = await build({ preserve: "camera", staged: true, turns: [async (call) => {
    assert.match((await call("stage_camera_key", { key: { t: 2, p: [0, 1.5, 3], l: [0, 1, 0] } })).text, /camera is protected/);
    assert.match((await call("stage_camera_move", { move: "orbit-90" })).text, /camera is protected/);
    assert.match((await call("stage_settings", { rig: "handheld" })).text, /camera is protected/);
    assert.equal((await call("stage_settings", { atmosphere: { time: "night", haze: 0.05 } })).isError, false);
    await call("stage_render");
    await call("stage_done", { assessment: "Night on the deck; the camera is as kept." });
  }] });
  assert.equal(terminal.status, "ready", terminal.detail);
  assert.equal(terminal.draft!.atmosphere?.time, "night");
});

it("asks twice for a build that stops short, then hands it over as unfinished (issue 1823)", async () => {
  const { terminal, turns } = await build({ turns: [
    async (call) => { await call("stage_add", { kind: "figure", item: { sheetId: "maren-kest", x: 0, z: 0 } }); },
    async () => {},
    async () => {},
  ] });
  assert.equal(turns, 3);
  assert.equal(terminal.status, "ready", terminal.detail);
  assert.match(terminal.draft!.assessment, /^Unfinished/);
  assert.equal(terminal.draft!.staging.authorship?.inspectedFrames, 0);
});

it("serves a run's tool set under its lease, and nothing once it detaches (issue 1823)", async () => {
  const server = new WorldQueryServer(() => null);
  await server.start();
  try {
    const token = "a".repeat(64);
    const calls: string[] = [];
    server.attachTools(token, {
      tools: [{ name: "stage_get", description: "the draft", inputSchema: { type: "object" } }],
      call: async (name) => { calls.push(name); return { content: [{ type: "text", text: "draft" }] }; },
    });
    const post = (body: unknown) => fetch(server.leasedUrl(token)!, { method: "POST", body: JSON.stringify(body) });
    const listed = await (await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json() as { result: { tools: Array<{ name: string }> } };
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ["stage_get"], "the lease lists its own tools, not the world's");
    const called = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "stage_get", arguments: {} } })).json() as { result: { content: Array<{ text: string }> } };
    assert.equal(called.result.content[0]?.text, "draft");
    assert.deepEqual(calls, ["stage_get"]);
    server.detachTools(token);
    assert.equal((await post({ jsonrpc: "2.0", id: 3, method: "tools/list" })).status, 404);
  } finally {
    await server.stop();
  }
});
