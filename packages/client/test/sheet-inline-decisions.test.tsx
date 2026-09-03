import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter } from "react-router";
import type { ArkeBridge } from "../src/arke-bridge.js";
import type { ClientMessage, ClientState, StagedProposal } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import {
  __handleFrameForTest,
  __setBridgeForTest,
  __setStateForTest,
} from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }) });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (time: number) => void) => setTimeout(() => cb(0), 0),
});

const WORLD_ID = FIXTURE_STATE.world!.meta.worldId;
const SHEET_PATH = "characters/maren-kest.md";
const PROPOSAL_ID = "pr_01J8H0000000000000000000Z9";

function staged(path: string, kind: "sheet-edit" | "canon-edit"): StagedProposal {
  return {
    proposal: {
      id: PROPOSAL_ID,
      kind,
      summary: kind === "sheet-edit" ? "Studio revises Maren" : "Studio revises the open thread",
      targets: [{ path, baseVersion: 4, baseHash: "sha256:9f2c66a1b0e4d8c2" }],
      baseCanonRevision: 42,
      reservedCanonIds: [],
      source: "chat:studio",
      created: "2026-09-03T12:00:00Z",
      draftRevision: 2,
    },
    ripple: {
      computedAt: "2026-09-03T12:00:01Z",
      governing: false,
      items: [{ kind: "owning-canon-rules", summary: "Two citations may need review", targets: ["CANON-002"] }],
    },
    review: {
      targets: [
        {
          path,
          label: kind === "sheet-edit" ? "Maren Kest" : "CANON-044",
          kind: kind === "sheet-edit" ? "character sheet · v4" : "open thread",
          action: "amend",
          fields: [{ field: kind === "sheet-edit" ? "Essence" : "Statement", before: "Before", proposed: "After" }],
        },
      ],
    },
  };
}

function stateWith(proposals: StagedProposal[]): ClientState {
  return {
    ...FIXTURE_STATE,
    app: {
      ...FIXTURE_STATE.app,
      health: { ...FIXTURE_STATE.app.health, harness: { status: "healthy" } },
    },
    world: { ...FIXTURE_STATE.world!, proposals },
  };
}

function bridge(messages: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json) => messages.push(JSON.parse(json) as ClientMessage),
  };
}

async function mount(path: string, state: ClientState, extras: Parameters<typeof __setStateForTest>[1] = {}) {
  __setStateForTest(state, extras);
  const messages: ClientMessage[] = [];
  __setBridgeForTest(bridge(messages));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
  });
  return { container, root, messages };
}

async function unmount(root: Root, container: HTMLElement): Promise<void> {
  await act(async () => root.unmount());
  container.remove();
  __setBridgeForTest(null);
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(found, `${label} button is rendered`);
  return found;
}

async function typeInto(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    const key = Object.keys(input).find((candidate) => candidate.startsWith("__reactProps$"));
    const props =
      key === undefined
        ? undefined
        : (input as unknown as Record<
            string,
            {
              onChange?: (event: {
                target: HTMLInputElement | HTMLTextAreaElement;
                currentTarget: HTMLInputElement | HTMLTextAreaElement;
              }) => void;
            }
          >)[key];
    props?.onChange?.({ target: input, currentTarget: input });
  });
}

describe("Studio decisions stay in their conversation", () => {
  it("renders the full sheet gate card and uses ordinary proposal actions", async () => {
    const proposal = staged(SHEET_PATH, "sheet-edit");
    const mounted = await mount(`/w/${WORLD_ID}/cast/maren-kest/edit`, stateWith([proposal]), {
      gateNotices: { [PROPOSAL_ID]: { reason: "invalid", detail: "The exact refusal stays here." } },
    });
    try {
      await act(async () => button(mounted.container, "Chat").click());
      const text = mounted.container.textContent ?? "";
      assert.match(text, /Studio revises Maren/);
      assert.match(text, /Essence/);
      assert.match(text, /Before/);
      assert.match(text, /After/);
      assert.match(text, /Two citations may need review/);
      assert.match(text, /The exact refusal stays here/);
      assert.doesNotMatch(text, /accept or discard it on the sheet page/);

      await act(async () => button(mounted.container, "Accept").click());
      assert.ok(
        mounted.messages.some(
          (message) => message.kind === "proposal-accept" && message.proposalId === PROPOSAL_ID,
        ),
        "the card uses the ordinary gate accept",
      );
      await act(async () => button(mounted.container, "Discard").click());
      assert.ok(
        mounted.messages.some(
          (message) => message.kind === "proposal-discard" && message.proposalId === PROPOSAL_ID,
        ),
      );
      const composer = mounted.container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="Keep shaping"]');
      assert.ok(composer);
      await typeInto(composer, "Keep the scar but soften the explanation.");
      await act(async () => button(mounted.container, "Send").click());
      assert.ok(
        mounted.messages.some(
          (message) => message.kind === "draft-with-studio" && message.proposalId === PROPOSAL_ID,
        ),
        "continuing to talk revises the same durable proposal",
      );
    } finally {
      await unmount(mounted.root, mounted.container);
    }
  });

  it("renders the same complete card for a canon Studio draft", async () => {
    const proposal = staged("canon/CANON-044.md", "canon-edit");
    const mounted = await mount(`/w/${WORLD_ID}/canon/CANON-044/thread`, stateWith([proposal]));
    try {
      const text = mounted.container.textContent ?? "";
      assert.match(text, /canon-edit/);
      assert.match(text, /Statement/);
      assert.match(text, /Two citations may need review/);
      assert.ok(button(mounted.container, "Accept"));
      assert.ok(button(mounted.container, "Discard"));
    } finally {
      await unmount(mounted.root, mounted.container);
    }
  });
});

describe("the initiating sheet form owns its result", () => {
  it("keeps typed input and shows the coordinator's exact refusal", async () => {
    const mounted = await mount(`/w/${WORLD_ID}/cast/maren-kest/edit`, stateWith([]));
    try {
      const role = mounted.container.querySelector<HTMLInputElement>('input[placeholder="Tide-caller"]');
      assert.ok(role);
      await typeInto(role, "Harbor witness");
      await act(async () => button(mounted.container, "Save edit · the sheet becomes v5").click());
      const message = mounted.messages.find(
        (candidate): candidate is Extract<ClientMessage, { kind: "stage-sheet-edit" }> =>
          candidate.kind === "stage-sheet-edit",
      );
      assert.ok(message);
      assert.deepEqual(message.dirtyHeadings, []);
      assert.equal(message.role, "Harbor witness");

      await act(async () => {
        __handleFrameForTest({
          kind: "event",
          seq: 10,
          event: {
            at: "2026-09-03T12:01:00Z",
            type: "sheet.edit-result",
            requestId: message.requestId,
            worldId: WORLD_ID,
            path: SHEET_PATH,
            action: "edit",
            disposition: "refused",
            reason: "The sheet changed underneath this form.",
          },
        });
      });
      assert.match(mounted.container.textContent ?? "", /The sheet changed underneath this form/);
      assert.equal(role.value, "Harbor witness", "the form input remains recoverable");
    } finally {
      await unmount(mounted.root, mounted.container);
    }
  });

  it("shows authoritative ripple news and a reachable undo after success", async () => {
    const mounted = await mount(`/w/${WORLD_ID}/cast/maren-kest/edit`, stateWith([]));
    try {
      const role = mounted.container.querySelector<HTMLInputElement>('input[placeholder="Tide-caller"]');
      assert.ok(role);
      await typeInto(role, "Harbor witness");
      await act(async () => button(mounted.container, "Save edit · the sheet becomes v5").click());
      const message = mounted.messages.find(
        (candidate): candidate is Extract<ClientMessage, { kind: "stage-sheet-edit" }> =>
          candidate.kind === "stage-sheet-edit",
      );
      assert.ok(message);

      await act(async () => {
        __handleFrameForTest({
          kind: "event",
          seq: 11,
          event: {
            at: "2026-09-03T12:01:00Z",
            type: "sheet.edit-result",
            requestId: message.requestId,
            worldId: WORLD_ID,
            path: SHEET_PATH,
            action: "edit",
            disposition: "accepted",
            undoVersion: 4,
            ripples: [{ kind: "owning-canon-rules", summary: "Two citations now predate this sheet", targets: ["CANON-002"] }],
          },
        });
      });
      assert.match(mounted.container.textContent ?? "", /Two citations now predate this sheet/);
      await act(async () => button(mounted.container, "Undo edit").click());
      assert.ok(
        mounted.messages.some(
          (candidate) =>
            candidate.kind === "restore-sheet-version" && candidate.path === SHEET_PATH && candidate.version === 4,
        ),
        "undo restores the outgoing version from the correlated result",
      );
    } finally {
      await unmount(mounted.root, mounted.container);
    }
  });
});

describe("remaining single-act controls own their result", () => {
  it("reports a sheet lifecycle refusal, then exposes authoritative ripples and its inverse", async () => {
    const mounted = await mount(`/w/${WORLD_ID}/cast/maren-kest`, stateWith([]));
    try {
      await act(async () => button(mounted.container, "Unlock").click());
      const first = mounted.messages.find(
        (candidate): candidate is Extract<ClientMessage, { kind: "set-sheet-status" }> =>
          candidate.kind === "set-sheet-status",
      );
      assert.ok(first);
      await act(async () => {
        __handleFrameForTest({
          kind: "event",
          seq: 12,
          event: {
            at: "2026-09-03T12:01:00Z",
            type: "single-act.result",
            requestId: first.requestId,
            worldId: WORLD_ID,
            operation: "sheet-status",
            path: SHEET_PATH,
            disposition: "refused",
            reason: "The sheet changed underneath this press.",
          },
        });
      });
      assert.match(mounted.container.textContent ?? "", /The sheet changed underneath this press/);
      await act(async () => button(mounted.container, "Dismiss").click());
      assert.doesNotMatch(mounted.container.textContent ?? "", /The sheet changed underneath this press/);

      await act(async () => button(mounted.container, "Unlock").click());
      const second = mounted.messages.filter(
        (candidate): candidate is Extract<ClientMessage, { kind: "set-sheet-status" }> =>
          candidate.kind === "set-sheet-status",
      )[1];
      assert.ok(second);
      await act(async () => {
        __handleFrameForTest({
          kind: "event",
          seq: 13,
          event: {
            at: "2026-09-03T12:02:00Z",
            type: "single-act.result",
            requestId: second.requestId,
            worldId: WORLD_ID,
            operation: "sheet-status",
            path: SHEET_PATH,
            disposition: "accepted",
            ripples: [{ kind: "owning-canon-rules", summary: "Two citations now predate this lock", targets: ["CANON-002"] }],
            undo: { kind: "set-sheet-status", path: SHEET_PATH, status: "locked" },
          },
        });
      });
      assert.match(mounted.container.textContent ?? "", /Two citations now predate this lock/);
      await act(async () => button(mounted.container, "Undo").click());
      assert.ok(
        mounted.messages.some(
          (candidate) =>
            candidate.kind === "undo-single-act" &&
            candidate.operation === "sheet-status" &&
            candidate.undo.kind === "set-sheet-status" &&
            candidate.undo.status === "locked",
        ),
      );
    } finally {
      await unmount(mounted.root, mounted.container);
    }
  });

  it("shows canon contradiction candidates before a non-blocking submit and preserves refused input", async () => {
    const mounted = await mount(`/w/${WORLD_ID}/canon/new`, stateWith([]));
    try {
      const title = mounted.container.querySelector<HTMLInputElement>('input[placeholder="Tide-calling"]');
      const statement = mounted.container.querySelector<HTMLTextAreaElement>('textarea[placeholder^="A caller cannot"]');
      assert.ok(title);
      assert.ok(statement);
      await typeInto(title, "The answering bell");
      await typeInto(statement, "The bell answers only at slack water.");

      const submit = button(mounted.container, "Add to canon · CANON-045");
      assert.equal(submit.disabled, false, "the advisory lookup never blocks acceptance");
      await act(async () => new Promise((resolve) => setTimeout(resolve, 175)));
      const query = mounted.messages.find(
        (candidate): candidate is Extract<ClientMessage, { kind: "canon-contradictions" }> =>
          candidate.kind === "canon-contradictions",
      );
      assert.ok(query);
      await act(async () => {
        __handleFrameForTest({
          kind: "event",
          seq: 14,
          event: {
            at: "2026-09-03T12:03:00Z",
            type: "canon.contradictions",
            requestId: query.requestId,
            worldId: WORLD_ID,
            candidates: [{ entryId: "CANON-002", title: "Tide-calling", statement: "A caller must stand in the tide." }],
          },
        });
      });
      assert.match(mounted.container.textContent ?? "", /CANON-002/);
      assert.match(mounted.container.textContent ?? "", /A caller must stand in the tide/);

      await act(async () => submit.click());
      const command = mounted.messages.find(
        (candidate): candidate is Extract<ClientMessage, { kind: "stage-canon-entry" }> =>
          candidate.kind === "stage-canon-entry",
      );
      assert.ok(command);
      await act(async () => {
        __handleFrameForTest({
          kind: "event",
          seq: 15,
          event: {
            at: "2026-09-03T12:04:00Z",
            type: "single-act.result",
            requestId: command.requestId,
            worldId: WORLD_ID,
            operation: "canon-create",
            path: "canon/CANON-045.md",
            disposition: "refused",
            reason: "CANON-045 was reserved by another press.",
          },
        });
      });
      assert.match(mounted.container.textContent ?? "", /CANON-045 was reserved by another press/);
      assert.equal(title.value, "The answering bell");
      assert.equal(statement.value, "The bell answers only at slack water.");
    } finally {
      await unmount(mounted.root, mounted.container);
    }
  });
});
