import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import type { ClientMessage, ClientState, ManifestModel, Take } from "@arke-studio/contracts";
import { NewLookSheet } from "../src/components/audiobook-new-look.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * Making a look (design turn 193b, SPEC-047 R-112, R-118): the main photo and a clothing line to
 * three full-body candidates, an optional close view of the chosen one, Accept look filing both and
 * choosing the look for the chapter that asked.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1600, innerHeight: 1000 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const GPT: ManifestModel = {
  id: "gpt-image-2",
  provider: "openai",
  capability: "image",
  displayName: "GPT Image 2",
  accepts: { referenceImages: 16, referenceRoles: false, startFrame: false, endFrame: false },
  limits: {},
  pricing: { kind: "perImage", microUsdPerImage: 40_000 },
};
const AT = "2026-10-04T09:00:00.000Z";
const take = (id: string, params: Record<string, unknown>): Take =>
  ({ id: `tk_${id}`, coversShots: [], kind: "look", reference: { sheetId: "maren-kest" }, provider: "openai", model: "gpt-image-2", provenance: { canonRevision: 1, sheets: { "maren-kest": 4 } }, references: [], params, cost: { estimatedMicroUsd: 40_000, actualMicroUsd: null }, dispatchedAt: AT, completedAt: AT, media: "look.png" }) as unknown as Take;
const ids = ["01J8Z3X4Y5Z6A7B8C9D0E1F2G1", "01J8Z3X4Y5Z6A7B8C9D0E1F2G2", "01J8Z3X4Y5Z6A7B8C9D0E1F2G3", "01J8Z3X4Y5Z6A7B8C9D0E1F2G9"];

function ready(takes: Take[] = [], looks: NonNullable<ClientState["world"]>["referenceKits"][number]["looks"] = []): ClientState {
  const world = FIXTURE_STATE.world!;
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      manifest: { ...FIXTURE_STATE.app.manifest!, models: [...FIXTURE_STATE.app.manifest!.models, GPT] },
      routing: { ...FIXTURE_STATE.app.routing, defaults: { ...FIXTURE_STATE.app.routing.defaults, image: GPT.id } },
      providers: [...FIXTURE_STATE.app.providers.filter((p) => p.id !== "openai"), { id: "openai", configured: true, validation: "valid", probes: [{ capability: "image", available: true }], fault: null }],
    },
    world: { ...world, referenceTakes: takes, referenceKits: world.referenceKits.map((kit) => (kit.sheetId === "maren-kest" ? { ...kit, looks } : kit)) },
  };
}

type Mounted = { root: Root; sent: ClientMessage[]; closed: () => boolean; rerender: (state: ClientState) => Promise<void> };
const mounted: Mounted[] = [];
const bodyAll = (selector: string) => [...dom.document.body.querySelectorAll(selector)] as HTMLElement[];
const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();
const WHO = { key: "maren-kest", name: "Maren Kest", sheet: "maren-kest" };
async function mount(state: ClientState, connection: "open" | "closed" = "open"): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest({ appVersion: "test", platform: "test", connect: () => {}, subscribe: () => {}, send: (json: string) => sent.push(JSON.parse(json) as ClientMessage) } as unknown as ArkeBridge);
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  let closed = false;
  const tree = <NewLookSheet open onClose={() => (closed = true)} worldId={FIXTURE_WORLD_ID} productionId="saltlight" chapterFile="07-the-tenth-key" chapterOrder={7} who={WHO} line="Oilskin coat, hood up; two braids." />;
  await act(async () => {
    __setStateForTest(state, { connection });
    root.render(tree);
  });
  const m: Mounted = {
    root,
    sent,
    closed: () => closed,
    rerender: async (next) => {
      await act(async () => {
        __setStateForTest(next, { connection });
        root.render(tree);
      });
    },
  };
  mounted.push(m);
  return m;
}
afterEach(async () => {
  for (const m of mounted.splice(0)) await act(async () => m.root.unmount());
  dom.document.body.innerHTML = "";
  __setBridgeForTest(null);
  __setStateForTest(FIXTURE_STATE);
});
const press = async (el: Element | null | undefined) => {
  assert.ok(el, "the thing to press exists");
  await act(async () => void el.dispatchEvent(new dom.Event("click", { bubbles: true }) as unknown as Event));
};
const sentOf = <K extends ClientMessage["kind"]>(m: Mounted, kind: K) => m.sent.filter((message): message is Extract<ClientMessage, { kind: K }> => message.kind === kind);
type Handlers = { onChange?: (event: { target: unknown; currentTarget: unknown }) => void };
const handlers = (el: Element): Handlers => {
  const key = Object.keys(el).find((candidate) => candidate.startsWith("__reactProps$"));
  return key === undefined ? {} : (el as unknown as Record<string, Handlers>)[key]!;
};

describe("the sheet before anything is made", () => {
  it("shows the main photo, the fixed boxes, the clothing line and the price of three pictures and the close view, and makes nothing", async () => {
    const m = await mount(ready());
    assert.ok(bodyAll('[data-testid="new-look-photo"] img')[0], "the main photo");
    const fixed = text(bodyAll('[data-testid="new-look-fixed"]')[0]);
    assert.match(fixed, /Full body/);
    assert.match(fixed, /Plain background/);
    assert.match(fixed, /Art direction · v\d/);
    assert.match(fixed, /Close view · ~\$0\.04/);
    for (const box of bodyAll('[data-testid="new-look-fixed"] input')) {
      if (box.getAttribute("data-testid") !== "new-look-close-box") assert.equal((box as HTMLInputElement).disabled, true, "the fixed boxes can be seen and not removed");
    }
    assert.equal((bodyAll('[data-testid="new-look-clothing"]')[0] as HTMLTextAreaElement).value, "Oilskin coat, hood up; two braids.", "the chapter's line to start from");
    assert.match(text(bodyAll('[data-testid="new-look-price"]')[0]), /3 pictures · ~\$0\.12 · close view ~\$0\.04/);
    assert.equal(text(bodyAll('[data-testid="new-look-make"]')[0]), "Make · ~$0.12");
    assert.equal(m.sent.length, 0, "nothing is made until Make");
    assert.equal((bodyAll('[data-testid="new-look-accept"]')[0] as HTMLButtonElement).disabled, true, "nothing to accept yet");
  });

  it("lists the looks the character already has, the Cast page's too", async () => {
    await mount(ready([], [{ id: "council-coat", file: "looks/c.png", kind: "costume", prompt: "Formal council coat", acceptedAt: AT }, { id: "tk_x", file: "takes/x/x.png", kind: "costume", prompt: "Storm coat.", acceptedAt: "2026-10-01T09:00:00.000Z", framing: "full-body", closeFile: "takes/y/y.png" }] as never));
    const rows = bodyAll('[data-testid="new-look-existing"]').map(text);
    assert.deepEqual(rows, ["Formal council coat · full", "Storm coat · full, close"]);
  });

  it("cannot make without a clothing line, or while the coordinator is away", async () => {
    await mount(ready(), "closed");
    assert.equal((bodyAll('[data-testid="new-look-make"]')[0] as HTMLButtonElement).disabled, true);
  });
});

describe("making, choosing and accepting", () => {
  it("asks for three full-body candidates from the clothing line as edited, then waits for them", async () => {
    const m = await mount(ready());
    const field = bodyAll('[data-testid="new-look-clothing"]')[0] as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
      setter?.call(field, "Coat open over a dark jumper; two braids.");
      handlers(field).onChange?.({ target: field, currentTarget: field });
    });
    await press(bodyAll('[data-testid="new-look-make"]')[0]);
    const asked = sentOf(m, "generate-character-looks");
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0]!.sheetId, asked[0]!.framing, asked[0]!.count, asked[0]!.lookKind, asked[0]!.prompt], ["maren-kest", "full-body", 3, "costume", "Coat open over a dark jumper; two braids."]);
    const waiting = bodyAll('[data-testid="new-look-candidate"]');
    assert.equal(waiting.length, 3);
    assert.ok(waiting.every((cell) => cell.getAttribute("data-state") === "making"), "three places held while they are made");
    assert.equal(bodyAll('[data-testid="new-look-make"]').length, 0, "Make gives way to Make again");
    assert.match(text(bodyAll('[data-testid="new-look-again"]')[0]), /^Make again · ~\$0\.16$/, "three more and the close view again, and the price says so");
  });

  it("draws the candidates that arrive for this request, never another's, and asks for the close view of the one chosen", async () => {
    const m = await mount(ready());
    await press(bodyAll('[data-testid="new-look-make"]')[0]);
    const batch = sentOf(m, "generate-character-looks")[0]!.requestId;
    const base = { lookKind: "costume", lookPrompt: "x", lookFraming: "full-body", lookBatch: batch };
    await m.rerender(ready([take(ids[0]!, base), take(ids[1]!, base), take(ids[2]!, base), take(ids[3]!, { ...base, lookBatch: "someone-elses-request" })]));
    const cells = bodyAll('[data-testid="new-look-candidate"]');
    assert.equal(cells.length, 3, "another request's picture is not offered here");
    assert.ok(cells.every((cell) => cell.getAttribute("data-state") === "made"));
    await press(cells[1]);
    const closeAsk = sentOf(m, "generate-character-looks")[1]!;
    assert.deepEqual([closeAsk.framing, closeAsk.count, closeAsk.closeOf], ["close", 1, { takeId: `tk_${ids[1]}` }]);
    assert.equal(bodyAll('[data-testid="new-look-candidate"]')[1]!.getAttribute("data-state"), "chosen");
    assert.equal(bodyAll('[data-testid="new-look-close"]')[0]!.getAttribute("data-state"), "making");
    assert.equal((bodyAll('[data-testid="new-look-accept"]')[0] as HTMLButtonElement).disabled, true, "Accept files both, so it waits for the close view");
    await press(cells[1]);
    assert.equal(sentOf(m, "generate-character-looks").length, 2, "the close view is asked for once");
  });

  it("files both pictures and chooses the look for the chapter on Accept look", async () => {
    const m = await mount(ready());
    await press(bodyAll('[data-testid="new-look-make"]')[0]);
    const batch = sentOf(m, "generate-character-looks")[0]!.requestId;
    const base = { lookKind: "costume", lookPrompt: "x", lookFraming: "full-body", lookBatch: batch };
    const fulls = ids.slice(0, 3).map((id) => take(id, base));
    await m.rerender(ready(fulls));
    await press(bodyAll('[data-testid="new-look-candidate"]')[1]);
    await m.rerender(ready([...fulls, take("01J8Z3X4Y5Z6A7B8C9D0E1F2H1", { lookKind: "costume", lookPrompt: "x", lookFraming: "close", lookOfTake: `tk_${ids[1]}` })]));
    assert.equal(bodyAll('[data-testid="new-look-close"]')[0]!.getAttribute("data-state"), "made");
    await press(bodyAll('[data-testid="new-look-accept"]')[0]);
    const accept = sentOf(m, "accept-character-look")[0]!;
    assert.deepEqual([accept.sheetId, accept.takeId, accept.closeTakeId], ["maren-kest", `tk_${ids[1]}`, "tk_01J8Z3X4Y5Z6A7B8C9D0E1F2H1"]);
    assert.deepEqual(accept.choose, { productionId: "saltlight", chapterFile: "07-the-tenth-key", key: "maren-kest", name: "Maren Kest", sheet: "maren-kest" }, "chosen for the chapter, on by default");
    assert.equal(m.closed(), true);
  });

  it("files the look alone when the close view is turned off, and does not choose it for the chapter when that box is off", async () => {
    const m = await mount(ready());
    // linkedom raises no change event React listens for: the props React holds are called, as the other sheets' fields are.
    await act(async () => {
      const closeBox = bodyAll('[data-testid="new-look-close-box"]')[0] as HTMLInputElement;
      handlers(closeBox).onChange?.({ target: { checked: false }, currentTarget: closeBox });
    });
    assert.doesNotMatch(text(bodyAll('[data-testid="new-look-price"]')[0]), /close view/);
    await act(async () => {
      const box = bodyAll('[data-testid="new-look-choose"]')[0] as HTMLInputElement;
      handlers(box).onChange?.({ target: { checked: false }, currentTarget: box });
    });
    await press(bodyAll('[data-testid="new-look-make"]')[0]);
    const batch = sentOf(m, "generate-character-looks")[0]!.requestId;
    const base = { lookKind: "costume", lookPrompt: "x", lookFraming: "full-body", lookBatch: batch };
    await m.rerender(ready(ids.slice(0, 3).map((id) => take(id, base))));
    await press(bodyAll('[data-testid="new-look-candidate"]')[0]);
    assert.equal(sentOf(m, "generate-character-looks").length, 1, "no close view asked for");
    await press(bodyAll('[data-testid="new-look-accept"]')[0]);
    const accept = sentOf(m, "accept-character-look")[0]!;
    assert.equal(accept.closeTakeId, undefined);
    assert.equal(accept.choose, undefined);
  });
});

/** A look job as the queue holds it: what a slot reads to say it ended without a picture. */
const job = (id: string, params: Record<string, unknown>, status: "queued" | "running" | "succeeded" | "failed", error: string | null = null) =>
  ({ id: `jb_${id}`, target: { kind: "character-look", id: "maren-kest/x/1" }, params, status, error, createdAt: AT, updatedAt: AT }) as never;
const SAFETY = "openai: the safety system refused the prompt (moderation blocked) — recompose the prompt away from what it flagged and try again";
const withJobs = (state: ClientState, jobs: unknown[]): ClientState => ({ ...state, app: { ...state.app, jobs: jobs as ClientState["app"]["jobs"] } });

describe("a picture the provider refuses (2026-10-04)", () => {
  it("says so in the candidate's slot, with the reason in plain words, and never leaves it making", async () => {
    const m = await mount(ready());
    await press(bodyAll('[data-testid="new-look-make"]')[0]);
    const batch = sentOf(m, "generate-character-looks")[0]!.requestId;
    const params = { lookKind: "costume", lookPrompt: "x", lookFraming: "full-body", lookBatch: batch };
    await m.rerender(withJobs(ready([take(ids[0]!, params)]), [job(ids[0]!, params, "succeeded"), job(ids[1]!, params, "failed", SAFETY), job(ids[2]!, params, "running")]));
    const cells = bodyAll('[data-testid="new-look-candidate"]');
    assert.deepEqual(cells.map((cell) => cell.getAttribute("data-state")), ["made", "making", "failed"]);
    assert.equal(text(bodyAll('[data-testid="new-look-candidate-reason"]')[0]), "refused by the image safety check");
    assert.ok(bodyAll('[data-testid="new-look-again"]')[0], "Make again is there to try again");
  });

  it("says so on the close view, offers Try again, and lets the look be accepted without it", async () => {
    const m = await mount(ready());
    await press(bodyAll('[data-testid="new-look-make"]')[0]);
    const batch = sentOf(m, "generate-character-looks")[0]!.requestId;
    const base = { lookKind: "costume", lookPrompt: "x", lookFraming: "full-body", lookBatch: batch };
    const fulls = ids.slice(0, 3).map((id) => take(id, base));
    await m.rerender(ready(fulls));
    await press(bodyAll('[data-testid="new-look-candidate"]')[1]);
    const closeAsk = sentOf(m, "generate-character-looks")[1]!;
    await m.rerender(withJobs(ready(fulls), [job("01J8Z3X4Y5Z6A7B8C9D0E1F2H5", { lookFraming: "close", lookOfTake: `tk_${ids[1]}`, lookBatch: closeAsk.requestId }, "failed", SAFETY)]));
    assert.equal(bodyAll('[data-testid="new-look-close"]')[0]!.getAttribute("data-state"), "failed", "not making");
    assert.equal(text(bodyAll('[data-testid="new-look-close-reason"]')[0]), "refused by the image safety check");
    assert.equal((bodyAll('[data-testid="new-look-accept"]')[0] as HTMLButtonElement).disabled, false, "the look can be accepted without its close view");
    await press(bodyAll('[data-testid="new-look-close-retry"]')[0]);
    assert.equal(sentOf(m, "generate-character-looks").length, 3, "Try again asks once more");
    assert.equal(bodyAll('[data-testid="new-look-close"]')[0]!.getAttribute("data-state"), "making");
  });
});

describe("the close view's price (2026-10-04)", () => {
  // GPT Image 2 as the manifest prices it: per picture, and per reference picture.
  const REAL: ManifestModel = { ...GPT, pricing: { kind: "perImage", microUsdPerImage: 53_000, microUsdPerReferenceImage: 100_000 } };
  const real = (): ClientState => {
    const state = ready();
    return { ...state, app: { ...state.app, manifest: { ...state.app.manifest!, models: [...state.app.manifest!.models.filter((model) => model.id !== GPT.id), REAL] } } };
  };

  it("states the real price on the box, on by default: one picture from the main photo and the full body", async () => {
    await mount(real());
    const box = bodyAll('[data-testid="new-look-close-box"]')[0] as HTMLInputElement;
    assert.equal(box.checked, true, "on by default");
    assert.match(text(bodyAll('[data-testid="new-look-fixed"]')[0]), /Close view · ~\$0\.26/, "53,000 for the picture and 100,000 for each of its two references");
    assert.match(text(bodyAll('[data-testid="new-look-price"]')[0]), /3 pictures · ~\$0\.46 · close view ~\$0\.26/);
  });
});
