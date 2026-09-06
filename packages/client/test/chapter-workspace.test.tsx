import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import type { ChapterSummary, ClientMessage, ClientState, StagedProposal } from "@arke-studio/contracts";
import { ChapterScreen, stagedChapterDraft } from "../src/screens/chapter-workspace.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * The chapter, opened (design turn 126, issue 874).
 *
 * What the screen holds by rule: the body is asked for on open and never read off the summary;
 * the foot says saved, the version and the words; a save names the base it read; and while a
 * draft waits the editor locks and the draft stands in the prose's place with the decision on
 * the card. Mounted through the route so the ids come from the address, as they do in the app.
 */

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(dom.window, { getComputedStyle: () => ({ direction: "ltr" }), innerWidth: 1024, innerHeight: 768 });
Object.assign(dom.HTMLElement.prototype, { focus() {}, scrollIntoView() {} });
Object.assign(Object.getPrototypeOf(dom.document.createElement("video")), {
  pause() {},
  play: () => Promise.resolve(),
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.document,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  IS_REACT_ACT_ENVIRONMENT: true,
  requestAnimationFrame: (cb: (t: number) => void) => setTimeout(() => cb(0), 0),
});

const PATH = "productions/inkbound/chapters/01-neap.md";
const ROUTE = `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/neap`;
const HASH = `sha256:${"a".repeat(64)}`;
// HTML in the body sends the Bible's gate to the source editor, which is the one that mounts
// under linkedom; the rich editor's choice is the Bible's and is tested there.
const BODY = "Maren counted the bells.\n\nSix, and the tide <br> not yet called.";

const CHAPTERS: ChapterSummary[] = [
  { id: "slack-water", file: "01-slack-water", order: 1, title: "Slack water", status: "drafted", version: 4, words: 4490 },
  {
    id: "neap",
    file: "01-neap",
    order: 2,
    title: "The counting of bells",
    status: "drafting",
    version: 4,
    words: 1900,
    draws: { sheets: ["maren-kest"], canon: ["CANON-002"] },
  },
];

const DRAFT: StagedProposal = {
  proposal: {
    id: "pr_01J8H0000000000000000000P7",
    kind: "chapter-draft",
    summary: "Draft the rest",
    targets: [{ path: PATH, baseVersion: 4, baseHash: null }],
    baseCanonRevision: 42,
    reservedCanonIds: [],
    source: "chat:sess_9f2",
    created: "2026-09-06T12:00:00Z",
    draftRevision: 1,
    // Attended, as a draft asked for in the thread is: the card is drawn only for a decision
    // that has a live owner, and an orphaned draft goes to Approvals instead (SPEC-040 R-16).
    decision: { mode: "attended", owner: { kind: "proposal-conversation", surface: "production-chat", targetPath: PATH } },
  },
  ripple: null,
  review: {
    targets: [
      {
        path: PATH,
        label: "The counting of bells",
        kind: "chapter",
        action: "amend",
        fields: [{ field: "Prose", before: BODY, proposed: "Drafted anew.\n\nFrom the seventh bell." }],
      },
    ],
  },
};

function inkbound(proposals: StagedProposal[] = []): ClientState {
  const world = FIXTURE_STATE.world!;
  const salt = world.productions.find((p) => p.meta.id === "saltlight")!;
  return {
    ...FIXTURE_STATE,
    world: {
      ...world,
      proposals: [...world.proposals, ...proposals],
      productions: [
        ...world.productions,
        {
          ...salt,
          meta: { ...salt.meta, id: "inkbound", format: "story" as const, title: "Inkbound" },
          story: { ...(salt.story ?? { version: 1 }), targetLength: "80,000 words" },
          chapters: CHAPTERS,
        },
      ],
    },
  };
}

interface Mounted {
  container: HTMLElement;
  root: Root;
  sent: ClientMessage[];
}

const open: Mounted[] = [];

function capture(sent: ClientMessage[]): ArkeBridge {
  return {
    appVersion: "test",
    platform: "test",
    connect: () => {},
    subscribe: () => {},
    send: (json: string) => sent.push(JSON.parse(json) as ClientMessage),
  } as unknown as ArkeBridge;
}

async function mount(state: ClientState, route = ROUTE): Promise<Mounted> {
  const sent: ClientMessage[] = [];
  __setBridgeForTest(capture(sent));
  const container = dom.document.createElement("div") as unknown as HTMLElement;
  dom.document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    __setStateForTest(state, { connection: "open" });
    root.render(
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/w/:worldId/p/:prodId/story/chapters/:chapterId" element={<ChapterScreen />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  const mounted = { container, root, sent };
  open.push(mounted);
  return mounted;
}

afterEach(async () => {
  for (const mounted of open.splice(0)) {
    await act(async () => mounted.root.unmount());
    mounted.container.remove();
  }
});

const text = (m: Mounted): string => m.container.textContent ?? "";
const q = (m: Mounted, selector: string): HTMLElement | null => m.container.querySelector(selector) as HTMLElement | null;

async function answerOpen(m: Mounted, body = BODY): Promise<void> {
  const ask = m.sent.find((message) => message.kind === "open-chapter") as Extract<ClientMessage, { kind: "open-chapter" }>;
  assert.ok(ask, "opening asks for the body");
  await act(async () => {
    __applyEventForTest({
      at: "2026-09-06T12:00:01Z",
      type: "chapter.open-result",
      requestId: ask.requestId,
      worldId: FIXTURE_WORLD_ID,
      productionId: "inkbound",
      chapterId: "neap",
      disposition: "opened",
      body,
      version: 4,
      hash: HASH,
      versions: [1, 2, 3],
    });
  });
}

describe("the chapter, opened (turn 126)", () => {
  it("asks for the body on open, never reads it off the summary, and then shows it", async () => {
    const m = await mount(inkbound());
    const ask = m.sent.find((message) => message.kind === "open-chapter") as Extract<ClientMessage, { kind: "open-chapter" }>;
    assert.equal(ask.productionId, "inkbound");
    assert.equal(ask.chapterId, "neap");
    assert.match(text(m), /Opening…/, "nothing stands in for the prose until it arrives");
    assert.match(text(m), /CHAPTER 02 OF 2/);
    assert.match(text(m), /The counting of bells/);

    await answerOpen(m);
    // linkedom does not mirror a controlled value back through `.value`; the foot's count is
    // computed from the same text the editor holds, so it is what proves the body arrived.
    assert.ok(q(m, "textarea.fy-ch__source"), "the body is in the editor");
    assert.match(text(m), /Saved · v4 · 12 words/, "the foot says saved, the version and the words of the body it read");
    assert.match(text(m), /6,390 of 80,000 words/, "the book's count against the target the overview names");
    assert.match(text(m), /maren-kest|Maren Kest/, "Draws on lists the sheet");
    assert.match(text(m), /CANON-002/, "and the canon");
    assert.match(text(m), /v1|v2|v3/, "earlier versions are listed for a v4 chapter");
    assert.match(text(m), /Arke · Chapter 02/, "Arke is docked about this chapter");
    assert.match(text(m), /talking changes nothing here · a draft waits for your yes/);
  });

  it("a draft waiting locks the editor and stands in the prose's place; the decision is on the card", async () => {
    const m = await mount(inkbound([DRAFT]));
    await answerOpen(m);
    assert.equal(q(m, "textarea.fy-ch__source"), null, "the editor is put away while the draft waits");
    assert.match(text(m), /Arke’s draft/);
    assert.match(text(m), /decide in the thread/);
    assert.match(text(m), /Drafted anew\./, "the draft's own prose is what stands in the manuscript");
    assert.match(text(m), /Locked while a draft waits · v4/);
    assert.match(text(m), /draft waiting/);
    assert.match(text(m), /Accept/, "the card holds Accept");
  });

  it("a chapter the bundle does not hold is said to be missing, with the way back (codex, PR 879)", async () => {
    const m = await mount(inkbound(), `/w/${FIXTURE_WORLD_ID}/p/inkbound/story/chapters/no-such-chapter`);
    assert.match(text(m), /No such chapter/);
    assert.match(text(m), /Chapters/, "the way back is offered");
    assert.equal(m.sent.some((message) => message.kind === "open-chapter"), false, "nothing is asked for a chapter that is not there");
  });

  it("picks the newest draft for the file and reads its prose off the review projection", () => {
    const older: StagedProposal = {
      ...DRAFT,
      proposal: { ...DRAFT.proposal, id: "pr_01J8H0000000000000000000P6", created: "2026-09-06T11:00:00Z" },
    };
    const elsewhere: StagedProposal = {
      ...DRAFT,
      proposal: { ...DRAFT.proposal, id: "pr_01J8H0000000000000000000P8", targets: [{ path: "productions/inkbound/chapters/02-x.md", baseVersion: 1, baseHash: null }] },
    };
    const found = stagedChapterDraft([elsewhere, older, DRAFT], PATH);
    assert.equal(found?.staged.proposal.id, DRAFT.proposal.id);
    assert.equal(found?.body, "Drafted anew.\n\nFrom the seventh bell.");
    assert.equal(stagedChapterDraft([elsewhere], PATH), undefined);
  });
});
