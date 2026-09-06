import assert from "node:assert/strict";
import { it } from "node:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  orderedShots,
  stageShot,
  type HarnessAdapter,
  type HarnessEvent,
  type StageConstructionDraft,
  type ClientMessage,
  type DomainEvent,
} from "@arke-studio/contracts";
import { StageConstructor } from "../../src/productions/stage-construction.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld } from "../world/helpers.js";
import { encodePng, solidImage } from "../../src/references/png.js";

it("constructs, inspects, revises and returns an editable draft without writing the scene", async () => {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  try {
    const production = store.getBundle().productions.find((p) => p.meta.id === "saltlight")!;
    const scene = production.scenes.find((s) => s.id === "sc_04")!;
    const shot = orderedShots(scene).find((s) => s.id === "sh_12")!;
    const fresh = stageShot(shot, { cast: ["maren-kest"], sets: [], durationSec: 4 });
    const { version: _v, cast, sets, ...staging } = fresh;
    const draft: StageConstructionDraft = {
      staging,
      cast,
      sets,
      assumptions: ["Camera is at eye height."],
      assessment: "Initial composition.",
      inspected: [],
    };
    let deliver: ((events: HarnessEvent[]) => void) | undefined;
    let calls = 0;
    const prompts: string[] = [];
    const adapter: HarnessAdapter = {
      id: "test",
      readiness: () => ({ ready: true }),
      capabilities: () => new Set(["events"]),
      createSession: async () => ({ sessionId: "stage-test" }),
      sendMessage: async () => ({ sessionId: "stage-test", correlationId: "unused" }),
      async *streamEvents(signal) {
        const events = await new Promise<HarnessEvent[]>((resolve, reject) => {
          deliver = resolve;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        for (const event of events) yield event;
      },
      dispatchAsync: async (input) => {
        calls++;
        const prompt = input.parts.map((p) => p.text).join(" ");
        prompts.push(prompt);
        const names = [
          ...new Set(
            prompt.match(/(?:round-\d-\d-(?:camera|overview)|source-\d+)\.(?:png|jpg|jpeg|webp)/g) ?? [],
          ),
        ];
        if (calls === 2)
          draft.staging.keys = draft.staging.keys.map((key) => ({
            ...key,
            p: [key.p[0], key.p[1] + 0.2, key.p[2]],
          }));
        draft.inspected = names;
        draft.assessment = calls === 1 ? "Initial" : "Reviewed the camera framing and corrected height.";
        deliver!([
          ...names.map((name) => ({
            type: "tool.activity" as const,
            sessionId: "stage-test",
            tool: "read",
            summary: name,
          })),
          { type: "message.completed", sessionId: "stage-test", text: JSON.stringify(draft) },
        ]);
        return { sessionId: "stage-test", correlationId: String(calls) };
      },
    };
    const constructor = new StageConstructor();
    const events: Array<Extract<DomainEvent, { type: "stage.construction" }>> = [];
    const request: Extract<ClientMessage, { kind: "stage-construct" }> = {
      kind: "stage-construct",
      worldId: store.worldId,
      productionId: "saltlight",
      sceneId: scene.id,
      shotId: shot.id,
      baseVersion: scene.version,
      requestId: randomUUID(),
      instruction: "Hold the rail composition; inspect it.",
      preserve: "none",
    };
    const png = Buffer.from(encodePng(solidImage(64, 36, [20, 30, 40, 255]))).toString("base64");
    await constructor.run(store, request, {
      adapter,
      sessionInput: (input) => input,
      model: "test/vision",
      scratchRoot: join(dir, ".scratch"),
      current: () => true,
      emit: (event) => {
        events.push(event);
        if (event.status === "inspect")
          constructor.inspect(store.worldId, request.requestId, event.round, [
            { at: 0, view: "camera", png },
            { at: 3.99, view: "camera", png },
            { at: 0, view: "overview", png },
          ]);
      },
    });
    assert.equal(calls, 3);
    assert.equal(events.at(-1)?.status, "ready", events.at(-1)?.detail);
    assert.equal(events.at(-1)?.draft?.staging.authorship?.model, "test/vision");
    assert.equal(events.at(-1)?.draft?.staging.authorship?.inspectedFrames, 6);
    assert.match(prompts[0]!, /head tilted/);
    assert.match(prompts[0]!, /verse, under the water/);
    assert.match(prompts[1]!, /round-1-0-camera.png/);
    assert.equal(
      store
        .getBundle()
        .productions.find((p) => p.meta.id === "saltlight")!
        .scenes.find((s) => s.id === scene.id)!.version,
      scene.version,
    );
    assert.equal(orderedShots(scene).find((s) => s.id === shot.id)!.staging, undefined);
  } finally {
    await store.close();
  }
});

it("cancellation while awaiting inspection preserves the partial draft and never writes", async () => {
  const dir = await makeTempWorld();
  const store = await WorldStore.open(dir);
  try {
    const scene = store
      .getBundle()
      .productions.find((p) => p.meta.id === "saltlight")!
      .scenes.find((s) => s.id === "sc_04")!;
    const original = store.getBundle.bind(store);
    store.getBundle = () => ({ ...original(), referenceKits: [] });
    const shot = orderedShots(scene)[0]!;
    const fresh = stageShot(shot, { cast: [], sets: [], durationSec: 4 });
    let deliver: ((text: string) => void) | undefined;
    const adapter: HarnessAdapter = {
      id: "test",
      readiness: () => ({ ready: true }),
      capabilities: () => new Set(["events"]),
      createSession: async () => ({ sessionId: "test" }),
      sendMessage: async () => ({ sessionId: "test", correlationId: "1" }),
      dispatchAsync: async () => {
        deliver!(
          JSON.stringify({
            staging: { keys: fresh.keys },
            cast: [],
            sets: [],
            assumptions: [],
            assessment: "Draft",
            inspected: [],
          }),
        );
        return { sessionId: "test", correlationId: "1" };
      },
      async *streamEvents() {
        const text = await new Promise<string>((r) => (deliver = r));
        yield { type: "message.completed", sessionId: "test", text };
      },
    };
    const constructor = new StageConstructor();
    let terminal: Extract<DomainEvent, { type: "stage.construction" }> | undefined;
    await constructor.run(
      store,
      {
        kind: "stage-construct",
        worldId: store.worldId,
        productionId: "saltlight",
        sceneId: scene.id,
        shotId: shot.id,
        baseVersion: scene.version,
        requestId: randomUUID(),
        instruction: "",
        preserve: "none",
      },
      {
        adapter,
        sessionInput: (i) => i,
        model: "test/vision",
        scratchRoot: join(dir, ".scratch"),
        current: () => true,
        emit: (event) => {
          if (event.status === "inspect") constructor.cancel();
          if (event.status === "failed") terminal = event;
        },
      },
    );
    assert.match(terminal?.detail ?? "", /stopped/);
    assert.ok(terminal?.draft);
    assert.equal(shot.staging, undefined);
  } finally {
    await store.close();
  }
});

for (const mode of ["protected-blocking", "source-changed", "unread-images"] as const)
  it(`refuses ${mode} without applying a model draft`, async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir);
    try {
      const bundle = structuredClone(store.getBundle());
      bundle.referenceKits = [];
      const scene = bundle.productions
        .find((p) => p.meta.id === "saltlight")!
        .scenes.find((s) => s.id === "sc_04")!;
      const shot = orderedShots(scene)[0]!;
      shot.durationSec = 4;
      const fresh = stageShot(shot, { cast: ["maren-kest"], sets: [], durationSec: 4 });
      shot.staging = structuredClone(fresh);
      store.getBundle = () => bundle;
      const { version: _version, cast, sets, ...staging } = fresh;
      const draft: StageConstructionDraft = {
        staging,
        cast,
        sets,
        assumptions: [],
        assessment: "Draft",
        inspected: [],
      };
      if (mode === "protected-blocking") draft.cast[0]!.x += 5;
      let deliver: ((events: HarnessEvent[]) => void) | undefined;
      const adapter: HarnessAdapter = {
        id: "test",
        readiness: () => ({ ready: true }),
        capabilities: () => new Set(["events"]),
        createSession: async () => ({ sessionId: "test" }),
        sendMessage: async () => ({ sessionId: "test", correlationId: "1" }),
        async *streamEvents() {
          for (const event of await new Promise<HarnessEvent[]>((resolve) => (deliver = resolve)))
            yield event;
        },
        dispatchAsync: async (input) => {
          draft.inspected = input.parts.flatMap(
            (p) => p.text?.match(/round-\d-\d-(?:camera|overview)\.png/g) ?? [],
          );
          deliver!([{ type: "message.completed", sessionId: "test", text: JSON.stringify(draft) }]);
          return { sessionId: "test", correlationId: "1" };
        },
      };
      const constructor = new StageConstructor();
      const request: Extract<ClientMessage, { kind: "stage-construct" }> = {
        kind: "stage-construct",
        worldId: store.worldId,
        productionId: "saltlight",
        sceneId: scene.id,
        shotId: shot.id,
        baseVersion: scene.version,
        requestId: randomUUID(),
        instruction: "Improve framing",
        preserve: "blocking",
      };
      const original = JSON.stringify(shot.staging);
      const png = Buffer.from(encodePng(solidImage(64, 36, [20, 30, 40, 255]))).toString("base64");
      let terminal: Extract<DomainEvent, { type: "stage.construction" }> | undefined;
      await constructor.run(store, request, {
        adapter,
        sessionInput: (i) => i,
        model: "test/vision",
        scratchRoot: join(dir, ".scratch"),
        current: () => true,
        emit: (event) => {
          if (event.status === "inspect") {
            if (mode === "source-changed") scene.version++;
            constructor.inspect(store.worldId, request.requestId, event.round, [
              { at: 0, view: "camera", png },
              { at: 4, view: "camera", png },
              { at: 0, view: "overview", png },
            ]);
          }
          if (event.status === "failed" || event.status === "ready") terminal = event;
        },
      });
      assert.equal(terminal?.status, "failed");
      assert.match(
        terminal?.detail ?? "",
        mode === "protected-blocking"
          ? /protected blocking/
          : mode === "source-changed"
            ? /source scene changed/
            : /without reading/,
      );
      assert.equal(JSON.stringify(shot.staging), original);
    } finally {
      await store.close();
    }
  });
