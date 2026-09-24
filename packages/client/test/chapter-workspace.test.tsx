import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { paragraphSpans, type ChapterContinuity, type ChapterSummary, type ChapterVoices, type ClientMessage, type ClientState, type ProseStyle, type StagedProposal, type WorldChatSummary } from "@arke-studio/contracts";
import { ChapterScreen, __clearHeldAsksForTest, firstPrompt, paragraphAt, passageSubject, stagedChapterDraft } from "../src/screens/chapter-workspace.js";
import type { ArkeBridge } from "../src/arke-bridge.js";
import { __applyEventForTest, __clearWorldChatHoldsForTest, __setBridgeForTest, __setStateForTest } from "../src/lib/store.js";
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
// The composer writes a line handed to it through innerText, which linkedom only reads.
Object.defineProperty(dom.HTMLElement.prototype, "innerText", {
  get(this: HTMLElement) { return this.textContent ?? ""; },
  set(this: HTMLElement, value: string) { this.textContent = value; },
  configurable: true,
});
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
    synopsis: "Maren hears the seventh bell before the tide is called.",
    pov: "maren-kest",
    when: "Neap · third night",
    implies: [
      { id: "if_bells", kind: "canon", what: "The bells can ring uncalled when the drowned city has a debt to collect.", state: "open" },
      { id: "if_ledger", kind: "character", what: "Odile keeps a second ledger the Council does not know about.", state: "open" },
    ],
    draftedAgainst: 2,
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

function inkbound(proposals: StagedProposal[] = [], proseStyle: ProseStyle | null = null): ClientState {
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
          story: { ...(salt.story ?? { version: 1 }), version: 3, targetLength: "80,000 words" },
          proseStyle,
          chapters: CHAPTERS,
        },
      ],
    },
  };
}

/** A revision: one span of the body changed, the rest as it was (turn 128). */
const PASSAGE: StagedProposal = {
  ...DRAFT,
  proposal: {
    ...DRAFT.proposal,
    id: "pr_01J8H0000000000000000000P9",
    summary: "Revise a passage: The counting of bells",
    // The origin's gesture is what says a passage was revised (codex on PR 899).
    origin: { source: "world-chat-action:act_1", surface: "world-chat", gesture: "passage-revision", conversationId: "cv_01J8H0000000000000000000C1" },
  },
  review: {
    targets: [
      {
        path: PATH,
        label: "The counting of bells",
        kind: "chapter",
        action: "amend",
        fields: [{ field: "Prose", before: BODY, proposed: BODY.replace("Maren counted the bells.", "Maren counted the seven bells.") }],
      },
    ],
  },
};

const STYLE: ProseStyle = { version: 2, pov: "close third", tense: "past", voice: "Short declaratives." };

/** The production's thread, already open, so a line said goes straight to the send that carries the subject. */
const THREAD: WorldChatSummary = {
  id: "cv_01J8F3K2QW9VZX4N7M0RTYB6HC",
  title: "The counting of bells",
  status: "open",
  updatedAt: "2026-09-06T09:00:00.000Z",
  entryContext: { kind: "production", productionId: "inkbound" },
  pointCount: 0,
  openProposalCount: 0,
  notCarried: [],
};

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
  __clearHeldAsksForTest();
  __clearWorldChatHoldsForTest();
});

const text = (m: Mounted): string => m.container.textContent ?? "";
const q = (m: Mounted, selector: string): HTMLElement | null => m.container.querySelector(selector) as HTMLElement | null;

async function answerOpen(m: Mounted, body = BODY, hash = HASH): Promise<void> {
  const ask = m.sent.findLast((message) => message.kind === "open-chapter") as Extract<ClientMessage, { kind: "open-chapter" }>;
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
      hash,
      versions: [1, 2, 3],
    });
  });
}

function sourceProps(m: Mounted): { value: string; onChange: (event: { target: { value: string } }) => void } {
  const area = q(m, "textarea.fy-ch__source")!;
  const key = Object.keys(area).find((key) => key.startsWith("__reactProps$"))!;
  return (area as unknown as Record<string, ReturnType<typeof sourceProps>>)[key]!;
}

async function typeProse(m: Mounted, value: string) {
  await act(async () => sourceProps(m).onChange({ target: { value } }));
}

async function answerSave(request: Extract<ClientMessage, { kind: "save-chapter" }>, disposition: "saved" | "refused", hash = HASH) {
  const requestId = request.requestId;
  assert.ok(requestId);
  await act(async () => __applyEventForTest({ type: "chapter.save-result", at: "2026-09-07T12:00:00Z",
    worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterFile: "01-neap", requestId,
    disposition, ...(disposition === "saved" ? { hash, version: 4 } : { reason: "base moved" }) }));
}

async function leave(m: Mounted) {
  await act(async () => m.root.unmount());
  open.splice(open.indexOf(m), 1);
  m.container.remove();
}

describe("chapter autosave recovery (#954)", () => {
  it("retries a refused save when the refreshed record only changed the plan", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const value = `${BODY}\n\nKeep this paragraph.`;
    await typeProse(m, value);
    const read = Array.from(m.container.querySelectorAll("button")).find((b) => b.textContent === "Read the chapter")!;
    await act(async () => read.click());
    const save = m.sent.findLast((m) => m.kind === "save-chapter")!;
    await answerSave(save, "refused");
    const nextHash = `sha256:${"e".repeat(64)}`;
    await answerOpen(m, BODY, nextHash);
    const retry = m.sent.findLast((m) => m.kind === "save-chapter")!;
    assert.notEqual(retry.requestId, save.requestId);
    assert.equal(retry.baseHash, nextHash);
    assert.equal(retry.body, value);
    await answerSave(retry, "saved", nextHash);
  });
  it("refreshes a plan-only hash change and saves current typing against the new base", async () => {
    const state = inkbound();
    const m = await mount(state);
    await answerOpen(m);
    const value = `${BODY}\n\nMy new paragraph.`;
    await typeProse(m, value);
    const nextHash = `sha256:${"b".repeat(64)}`;
    const updated = structuredClone(state);
    updated.world!.productions.find((p) => p.meta.id === "inkbound")!.chapters[1]!.hash = nextHash;
    await act(async () => __setStateForTest(updated, { connection: "open" }));
    assert.equal(m.sent.filter((m) => m.kind === "open-chapter").length, 2);
    await answerOpen(m, BODY, nextHash);
    const save = m.sent.findLast((m) => m.kind === "save-chapter")!;
    assert.equal(save.baseHash, nextHash);
    assert.equal(save.body, value);
    assert.equal(sourceProps(m).value, value);
    await answerSave(save, "saved", nextHash);
  });

  it("keeps a refused draft through navigation and requires a choice before overwriting saved prose", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const value = `${BODY}\n\nRecover this paragraph.`;
    await typeProse(m, value);
    // The save is sent by the unmount flush; its refusal arrives with no editor mounted.
    await leave(m);
    const save = m.sent.findLast((m) => m.kind === "save-chapter")!;
    assert.ok(save);
    await answerSave(save, "refused");
    const returned = await mount(inkbound());
    const disk = `${BODY}\n\nSomeone else's paragraph.`;
    const nextHash = `sha256:${"c".repeat(64)}`;
    await answerOpen(returned, disk, nextHash);
    assert.equal(sourceProps(returned).value, value);
    assert.match(text(returned), /Not saved · your draft is kept/);
    assert.equal(returned.sent.some((m) => m.kind === "save-chapter"), false);
    const keep = Array.from(returned.container.querySelectorAll("button")).find((b) => b.textContent === "Save my draft")!;
    await act(async () => keep.click());
    const retry = returned.sent.findLast((m) => m.kind === "save-chapter")!;
    assert.equal(retry.baseHash, nextHash);
    assert.equal(retry.body, value);
    await answerSave(retry, "saved", nextHash);
  });

  it("retains newer typing when an in-flight save is refused and the user leaves", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    await typeProse(m, `${BODY}\n\nFirst edit.`);
    const read = Array.from(m.container.querySelectorAll("button")).find((b) => b.textContent === "Read the chapter")!;
    await act(async () => read.click());
    const save = m.sent.findLast((m) => m.kind === "save-chapter")!;
    assert.ok(save);
    const newest = `${BODY}\n\nFirst edit. More words while saving.`;
    await typeProse(m, newest);
    await answerSave(save, "refused");
    await answerOpen(m, `${BODY}\n\nCompeting prose.`, `sha256:${"d".repeat(64)}`);
    assert.equal(sourceProps(m).value, newest);
    assert.match(text(m), /Not saved/);
    assert.equal(m.sent.filter((m) => m.kind === "save-chapter").length, 1, "a refusal is not retried automatically");
    await leave(m);
    const returned = await mount(inkbound());
    await answerOpen(returned);
    assert.equal(sourceProps(returned).value, newest);
    const useSaved = Array.from(returned.container.querySelectorAll("button")).find((b) => b.textContent === "Use saved chapter")!;
    await act(async () => useSaved.click());
    assert.equal(sourceProps(returned).value, BODY);
    assert.equal(returned.sent.some((m) => m.kind === "save-chapter"), false);
  });
});

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
    // The dock's line is what is waiting, not a promise about what talking does not do
    // (issue 1008): the promise is the rule the dock is built to, and it is in the rule.
    assert.doesNotMatch(text(m), /talking changes nothing/, "the standing promise is off the screen");
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

  it("carries the plan: the synopsis under the title, the marks, and the overview having moved (turn 127)", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    assert.match(text(m), /Maren hears the seventh bell before the tide is called\./, "the synopsis is under the title");
    assert.match(text(m), /Neap · third night/);
    assert.match(text(m), /overview moved · v2 → v3/);
    assert.ok(q(m, "select.fy-ch__pick"), "point of view is picked from the world's characters");
    assert.match(text(m), /Draft the rest/, "a chapter with prose is continued, not drafted from the synopsis");
    assert.match(text(m), /Implies 2/, "the implied facts are listed with their count");
    assert.match(text(m), /The bells can ring uncalled/);
  });

  it("a chapter with a synopsis and no prose is drafted from the synopsis (turn 127)", () => {
    // Decided as a function: an empty body puts the rich editor up, which linkedom cannot mount.
    assert.equal(firstPrompt("", "Maren hears the seventh bell."), "Draft from the synopsis");
    assert.equal(firstPrompt("  \n ", "Maren hears the seventh bell."), "Draft from the synopsis");
    assert.equal(firstPrompt("", undefined), "Draft the rest", "no synopsis, nothing to draft from");
    assert.equal(firstPrompt("", "   "), "Draft the rest");
    assert.equal(firstPrompt("Maren counted the bells.", "Maren hears the seventh bell."), "Draft the rest", "prose is continued");
  });

  it("Propose says the fact into the thread in the author's name, and Dismiss edits the plan (turn 127)", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    const propose = Array.from(m.container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Propose") as HTMLElement | undefined;
    assert.ok(propose, "each implied fact has a press");
    await act(async () => propose!.click());
    const stated = m.sent.find((message) => message.kind === "edit-chapter-plan") as Extract<ClientMessage, { kind: "edit-chapter-plan" }> | undefined;
    assert.ok(stated, "the state is written on the item first");
    assert.equal(stated.changes.implies?.[0]?.state, "proposed");
    assert.equal(stated.changes.implies?.[0]?.id, "if_bells", "the id is kept through the write");
    assert.equal(stated.changes.implies?.[1]?.state, "open", "the other fact is untouched");
    const said = m.sent.find((message) => JSON.stringify(message).includes("Propose as canon: The bells can ring uncalled"));
    assert.ok(said, "then the fact is said into the thread rather than written into the world by this screen");

    // Without a snapshot the items stay open here, so both still offer Dismiss; a proposed item would not.
    const dismissers = Array.from(m.container.querySelectorAll("button.fy-ch__dismiss"));
    assert.equal(dismissers.length, 2, "both facts are still open in this state, so both can be dismissed");
    await act(async () => (dismissers[1] as HTMLElement).click());
    const edited = m.sent.filter((message) => message.kind === "edit-chapter-plan").at(-1) as Extract<ClientMessage, { kind: "edit-chapter-plan" }> | undefined;
    assert.ok(edited, "dismissing is a plan edit");
    assert.equal(edited.changes.implies?.length, 1, "the dismissed fact is gone and the other stays");
    assert.equal(edited.changes.implies?.[0]?.kind, "canon");
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

/**
 * The craft loop (design turn 128, issue 896): the selection is the subject, a revision is a
 * passage that stands in place with the rest untouched, and the side says the style in a line.
 */
describe("the craft loop (turn 128)", () => {
  const keyup = async (area: HTMLTextAreaElement, start: number, end: number) => {
    Object.assign(area, { selectionStart: start, selectionEnd: end });
    // The mouse's release rather than a key's: under linkedom React polyfills input events off
    // keyup through the focused element, and nothing here is focused.
    await act(async () => {
      area.dispatchEvent(new dom.Event("mouseup", { bubbles: true }));
    });
  };

  it("a selection of three words or more is the subject: the press beside it, the prompts a revision's, the passage said before what is asked", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    assert.match(text(m), /close third · past · v2/, "the side says the style in one line");
    assert.match(text(m), /settled in Develop/);
    assert.match(text(m), /Hold this against the style/, "with a style settled, holding the chapter against it is offered");
    assert.doesNotMatch(text(m), /Ask Arke · /, "nothing is offered before anything is selected");

    const area = q(m, "textarea.fy-ch__source") as HTMLTextAreaElement;
    await keyup(area, 0, 5);
    assert.doesNotMatch(text(m), /Ask Arke · /, "one word is not a passage, and no reason is written");
    await keyup(area, 0, 24);
    assert.match(text(m), /Ask Arke · 4 words/, "the press beside the selection counts it");
    assert.match(text(m), /about this passage · 4 words/, "the dock says what the subject is");
    assert.match(text(m), /Tighten this/, "the prompts are a revision's");
    assert.doesNotMatch(text(m), /Draft the rest/);

    // What the thread hears: the prompt is said with the passage before it, as a typed line is.
    const prompt = [...m.container.querySelectorAll("button.fy-arke__prompt")].find((b) => b.textContent === "Tighten this") as HTMLElement;
    await act(async () => {
      prompt.click();
    });
    // The chapter and the paragraph ride with the words (codex on turn 128), so the passage can
    // be looked for where it was and nowhere else.
    assert.match(JSON.stringify(m.sent), /About this passage in chapter 02, paragraph 1: «Maren counted the bells.» Tighten this/);
    // And beside the words, as a structured subject the coordinator holds the revision to.
    const said = m.sent.find((message) => message.kind === "world-chat-send" || message.kind === "world-chat-create") as { subject?: unknown } | undefined;
    assert.deepEqual(
      (m.sent.map((message) => (message as { subject?: unknown }).subject).find((subject) => subject !== undefined)),
      { kind: "passage", chapterId: "neap", paragraph: 1, text: "Maren counted the bells." },
      `the selection travels as a subject (${said?.subject === undefined ? "none sent" : "sent"})`,
    );

    // Taken, and the thread shows it, before the next can go (codex on PR 1232).
    const first = m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string };
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: first.requestId, admitted: true }));
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 5 } } as ClientState, { connection: "open" }));
    // The style check asks for a reply and nothing else, and the send says so.
    const hold = [...m.container.querySelectorAll("button.fy-arke__prompt")].find((b) => b.textContent === "Hold this against the style") as HTMLElement;
    await act(async () => {
      hold.click();
    });
    const sends = m.sent.filter((message) => message.kind === "world-chat-send") as Array<{ text: string; replyOnly?: boolean }>;
    assert.equal(sends.find((message) => message.text.endsWith("Tighten this"))?.replyOnly, undefined, "a revision may stage");
    assert.equal(sends.find((message) => message.text.endsWith("Hold this against the style"))?.replyOnly, true, "a check may not");

    await keyup(area, 3, 3);
    assert.doesNotMatch(text(m), /Ask Arke · /, "the selection collapsed, the press goes");
    assert.doesNotMatch(text(m), /about this passage/);
    assert.match(text(m), /Draft the rest/, "and the prompts are the chapter's again");
  });

  it("the press beside a selection opens what can be asked of it, each said with the passage as the dock's own asks are", async () => {
    const styled = inkbound([], STYLE);
    // The thread open and idle, so what is said goes straight to it.
    const workspaceAt = (seq: number) => ({
      conversationId: THREAD.id as never,
      status: "open" as const,
      initiative: "collaborate" as const,
      hasMore: false,
      runStatus: null,
      runStartedAt: null,
      retrievalUnavailable: false,
      attachments: [],
      seq,
      actions: [],
      messages: [],
      points: [],
    });
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspaceAt(4) } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    const area = q(m, "textarea.fy-ch__source") as HTMLTextAreaElement;
    await keyup(area, 0, 24);
    assert.equal(q(m, "[role=menu]"), null, "closed until pressed");
    await act(async () => {
      (q(m, "button.fy-ch__ask") as HTMLElement).click();
    });
    const labels = [...m.container.querySelectorAll("[role=menuitem]")].map((b) => b.textContent);
    assert.deepEqual(labels, ["Tighten", "Expand", "Simplify", "Make it vivid", "Change tone…", "Check against style", "Critique", "Ask something else…"]);

    const item = (label: string) => [...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === label) as HTMLElement;
    await act(async () => {
      item("Expand").click();
    });
    assert.equal(q(m, "[role=menu]"), null, "an ask closes the menu");
    const sends = () => m.sent.filter((message) => message.kind === "world-chat-send") as Array<{ text: string; replyOnly?: boolean; subject?: unknown }>;
    const expand = sends().find((message) => message.text.includes("Expand this"));
    assert.match(expand?.text ?? "", /^About this passage in chapter 02, paragraph 1: «Maren counted the bells.» Expand this/);
    assert.deepEqual(expand?.subject, { kind: "passage", chapterId: "neap", paragraph: 1, text: "Maren counted the bells." });
    assert.equal(expand?.replyOnly, undefined, "a rewrite may stage");

    // One ask at a time (codex on PR 1232): the press waits for the first to be answered.
    assert.equal((q(m, "button.fy-ch__ask") as HTMLButtonElement).disabled, true, "held while the first is being taken");
    const answered = async (requestId: string, seq: number) => {
      await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId, admitted: true }));
      await act(async () => __setStateForTest({ ...state, worldChat: workspaceAt(seq) }, { connection: "open" }));
    };
    await answered((expand as unknown as { requestId: string }).requestId, 5);
    await act(async () => {
      (q(m, "button.fy-ch__ask") as HTMLElement).click();
    });
    await act(async () => {
      item("Critique").click();
    });
    const critique = sends().find((message) => message.text.includes("What works here"));
    assert.equal(critique?.replyOnly, true, "a critique is a reply and nothing else");
    await answered((critique as unknown as { requestId: string }).requestId, 6);

    // A line that only starts the ask goes into the composer, said by nobody yet.
    const before = sends().length;
    await act(async () => {
      (q(m, "button.fy-ch__ask") as HTMLElement).click();
    });
    await act(async () => {
      item("Change tone…").click();
    });
    assert.equal(sends().length, before, "nothing is said for a line the author finishes");
    const composer = q(m, ".fy-arke .fy-cx__editor");
    assert.equal(composer?.textContent, "Make this ");
  });

  it("a second press waits for the first ask, which is opening the thread, and nothing lands in the composer (codex on PR 1232)", async () => {
    // No thread yet: the first ask opens one, and the dock is busy until it arrives.
    const m = await mount(inkbound([], STYLE));
    await answerOpen(m);
    const area = q(m, "textarea.fy-ch__source") as HTMLTextAreaElement;
    const item = (label: string) => [...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === label) as HTMLElement;
    await keyup(area, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => item("Expand").click());
    assert.equal(m.sent.filter((message) => message.kind === "world-chat-create").length, 1, "the first ask opens the thread");
    const pill = q(m, "button.fy-ch__ask") as HTMLButtonElement;
    assert.equal(pill.disabled, true, "the press waits: a second would replace the first while it opens the thread");
    assert.match(pill.textContent ?? "", /asking…/);
    assert.equal(m.sent.filter((message) => message.kind === "world-chat-create" || message.kind === "world-chat-send").length, 1);
    assert.equal(q(m, ".fy-arke .fy-cx__editor")?.textContent ?? "", "", "and nothing is left in the composer to be said about whatever is selected next");
  });

  it("an ask pressed with the connection down waits and goes when it comes back (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const tightened = () => m.sent.filter((message) => message.kind === "world-chat-send" && (message as { text: string }).text.endsWith("Tighten this"));
    assert.equal(tightened().length, 0, "nothing can go while the connection is down");
    await act(async () => __setStateForTest(state, { connection: "open" }));
    assert.equal(tightened().length, 1, "and it is not lost: it goes when the connection is back");
    assert.deepEqual((tightened()[0] as { subject?: unknown }).subject, { kind: "passage", chapterId: "neap", paragraph: 1, text: "Maren counted the bells." });
  });

  it("an ask is done with when the coordinator takes it, and shown to be tried again when it does not (PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    const press = async (label: string) => {
      await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
      await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === label) as HTMLElement).click());
    };
    const sendsOf = (line: string) => m.sent.filter((message) => message.kind === "world-chat-send" && (message as { text: string }).text.endsWith(line)) as Array<{ requestId: string }>;
    const answer = async (requestId: string, admitted: boolean) =>
      act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId, admitted }));

    await press("Tighten");
    assert.equal(sendsOf("Tighten this").length, 1);
    // Another window's turn moving the thread is not an answer for this request.
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 5 } } as ClientState, { connection: "open" }));
    await answer("someone-else", false);
    assert.doesNotMatch(text(m), /Not sent ·/, "only this request's answer counts");
    await answer(sendsOf("Tighten this")[0]!.requestId, false);
    assert.match(text(m), /Not sent · Tighten this/, "declined, it is shown rather than lost");
    assert.equal(q(m, ".fy-arke .fy-cx__editor")?.textContent ?? "", "", "and never written over the composer");

    await act(async () => ([...m.container.querySelectorAll(".fy-arke__declined button")].find((b) => b.textContent === "Try again") as HTMLElement).click());
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 6 } } as ClientState, { connection: "open" }));
    assert.equal(sendsOf("Tighten this").length, 2, "tried again at the author's word");
    await answer(sendsOf("Tighten this")[1]!.requestId, true);
    assert.doesNotMatch(text(m), /Not sent ·/, "taken, it is done with");
  });

  it("an ask waits for its answer however long it takes, and only a lost connection loses it (codex on PR 1232)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const first = (m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string }).requestId;
    const asked = () => m.sent.filter((message) => message.kind === "world-chat-send-status" && (message as { requestId: string }).requestId === first).length;
    const answer = async (admitted: boolean) =>
      act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: first, admitted }));
    // A slow admission with the socket open is still coming: calling it lost would offer a
    // second paid turn.
    await act(async () => t.mock.timers.tick(60_000));
    t.mock.timers.reset();
    assert.doesNotMatch(text(m), /Not sent ·/, "no clock calls it lost");
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => __setStateForTest(state, { connection: "open", rejoins: 1 }));
    assert.ok(asked() >= 1, "rejoined, the coordinator is asked where the line stands");
    assert.doesNotMatch(text(m), /Not sent ·/, "and nothing is called lost before it answers (codex on PR 1232)");
    await answer(false);
    assert.match(text(m), /Not sent · Tighten this/, "not taken, it is shown to be tried again");
  });

  it("the menu waits for the selected words to be saved (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    await typeProse(m, `${BODY} More.`);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    const pill = q(m, "button.fy-ch__ask") as HTMLButtonElement;
    assert.match(pill.textContent ?? "", /saving…/, "the press says why it waits");
    assert.equal(pill.disabled, true);
    // Saved, the press is the author's again (and nothing is left parked for the next screen).
    const save = m.sent.findLast((message) => message.kind === "save-chapter") as Extract<ClientMessage, { kind: "save-chapter" }>;
    await answerSave(save, "saved", `sha256:${"b".repeat(64)}`);
    assert.equal((q(m, "button.fy-ch__ask") as HTMLButtonElement).disabled, false);
    assert.match(q(m, "button.fy-ch__ask")?.textContent ?? "", /Ask Arke · 4 words/);
  });

  it("a line a press started stays about the passage it was pressed on (codex on PR 1232)", async () => {
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    // The thread is loaded: nothing is said into one still loading (codex on PR 1232).
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] }, worldChat: workspace } as ClientState);
    await answerOpen(m);
    const area = q(m, "textarea.fy-ch__source") as HTMLTextAreaElement;
    await keyup(area, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Change tone…") as HTMLElement).click());
    // The author moves the selection away, then finishes the line and sends it.
    await keyup(area, 3, 3);
    assert.match(text(m), /about this passage · 4 words/, "the dock still says which passage the line is about (codex on PR 1232)");
    const composer = q(m, ".fy-arke .fy-cx__editor")!;
    composer.textContent = "Make this colder";
    await act(async () => {
      composer.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    const sendButton = [...m.container.querySelectorAll(".fy-arke button")].find((b) => /send/i.test(b.getAttribute("aria-label") ?? b.textContent ?? "")) as HTMLElement;
    await act(async () => sendButton.click());
    const sent = m.sent.find((message) => message.kind === "world-chat-send" && (message as { text: string }).text.endsWith("Make this colder")) as { text: string; subject?: unknown } | undefined;
    assert.match(sent?.text ?? "", /^About this passage in chapter 02, paragraph 1: «Maren counted the bells.» Make this colder$/);
    assert.deepEqual(sent?.subject, { kind: "passage", chapterId: "neap", paragraph: 1, text: "Maren counted the bells." });
  });

  it("an ask survives the dock being put away and brought back (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    assert.equal(q(m, ".fy-arke"), null, "the dock is put away with the ask still waiting");
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    await act(async () => __setStateForTest(state, { connection: "open" }));
    const sends = m.sent.filter((message) => message.kind === "world-chat-send" && (message as { text: string }).text.endsWith("Tighten this"));
    assert.equal(sends.length, 1, "brought back, the dock says it");
    assert.deepEqual((sends[0] as { subject?: unknown }).subject, { kind: "passage", chapterId: "neap", paragraph: 1, text: "Maren counted the bells." });
  });

  it("an answer that arrives while the dock is put away is found when it comes back (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const m = await mount({ ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sent = m.sent.find((message) => message.kind === "world-chat-send" && (message as { text: string }).text.endsWith("Tighten this")) as { requestId: string };
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: sent.requestId, admitted: false }));
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.match(text(m), /Not sent · Tighten this/, "the answer given while away is the one shown");
  });

  it("a line a press started survives the dock being put away (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    const area = q(m, "textarea.fy-ch__source") as HTMLTextAreaElement;
    await keyup(area, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Change tone…") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await keyup(area, 3, 3);
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.equal(q(m, ".fy-arke .fy-cx__editor")?.textContent, "Make this ", "the line is back in the composer");
    assert.match(text(m), /about this passage · 4 words/, "still about the passage it was pressed on");
  });

  it("an ask whose answer was lost is not called not sent on the thread's word (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [] as unknown[], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sent = m.sent.find((message) => message.kind === "world-chat-send") as { text: string };
    // The connection dropped after the turn was written: no answer, but the thread holds it.
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    const said = { id: "msg_01J8F3K2QW9VZX4N7M0RTYB6H2" as never, role: "user" as const, text: sent.text, receipts: [], refusals: [], createdAt: new Date().toISOString() };
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 5, messages: [said] } } as ClientState, { connection: "open", rejoins: 1 }));
    assert.doesNotMatch(text(m), /Not sent ·/, "taken, as the thread shows, so never offered again");
    assert.equal(m.sent.filter((message) => message.kind === "world-chat-send").length, 1, "and not said again");
  });

  it("an ask waits for a thread that is still loading (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] } } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sends = () => m.sent.filter((message) => message.kind === "world-chat-send");
    assert.equal(sends().length, 0, "with no sequence to watch, it could not be held as just sent");
    await act(async () => __setStateForTest({ ...state, worldChat: workspace } as ClientState, { connection: "open" }));
    assert.equal(sends().length, 1, "loaded, it goes");
    const prompts = [...m.container.querySelectorAll("button.fy-arke__prompt")] as HTMLButtonElement[];
    assert.ok(prompts.length > 0 && prompts.every((b) => b.disabled), "and the dock holds until the thread shows it");
  });

  it("the dock holds for a slow admission until that request is answered (codex on PR 1232)", async (t) => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const m = await mount({ ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sent = m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string };
    const prompts = () => [...m.container.querySelectorAll("button.fy-arke__prompt")] as HTMLButtonElement[];
    await act(async () => t.mock.timers.tick(60_000));
    t.mock.timers.reset();
    assert.ok(prompts().length > 0 && prompts().every((b) => b.disabled), "no clock lets a line out over an admission still coming");
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: sent.requestId, admitted: false }));
    assert.ok(prompts().every((b) => !b.disabled), "refused, the dock is free again");
  });

  it("an ask sent before the dock was put away is settled on its return after a lost connection (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const first = (m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string }).requestId;
    const asked = () => m.sent.filter((message) => message.kind === "world-chat-send-status" && (message as { requestId: string }).requestId === first).length;
    const answer = async (admitted: boolean) =>
      act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: first, admitted }));
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    // Dropped and rejoined with nothing mounted to watch it.
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => __setStateForTest(state, { connection: "open", rejoins: 1 }));
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.ok(asked() >= 1, "brought back, the ask knows it went before the rejoin and asks after it");
    await answer(true);
    assert.doesNotMatch(text(m), /Not sent ·/, "taken, it is done with");
  });

  it("an ask shown as not sent survives the dock being put away (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sends = () => m.sent.filter((message) => message.kind === "world-chat-send") as Array<{ requestId: string; text: string }>;
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: sends()[0]!.requestId, admitted: false }));
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 5 } } as ClientState, { connection: "open" }));
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.match(text(m), /Not sent · Tighten this/, "still offered once the dock is back");
    await act(async () => ([...m.container.querySelectorAll(".fy-arke__declined button")].find((b) => b.textContent === "Try again") as HTMLElement).click());
    assert.equal(sends().length, 2, "and tried again from there");
    assert.equal(sends()[1]!.text, sends()[0]!.text);
  });

  it("a finished line refused by the coordinator is kept, not lost (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Change tone…") as HTMLElement).click());
    const composer = q(m, ".fy-arke .fy-cx__editor")!;
    composer.textContent = "Make this colder";
    await act(async () => {
      composer.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    const sendButton = [...m.container.querySelectorAll(".fy-arke button")].find((b) => /send/i.test(b.getAttribute("aria-label") ?? b.textContent ?? "")) as HTMLElement;
    await act(async () => sendButton.click());
    const sends = () => m.sent.filter((message) => message.kind === "world-chat-send") as Array<{ requestId: string; text: string }>;
    assert.equal(sends().length, 1);
    // Another window's turn started after this one's last snapshot: the runner refuses it.
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: sends()[0]!.requestId, admitted: false }));
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 5 } } as ClientState, { connection: "open" }));
    assert.match(text(m), /Not sent · Make this colder/, "what the author wrote is still there to send");
    await act(async () => ([...m.container.querySelectorAll(".fy-arke__declined button")].find((b) => b.textContent === "Try again") as HTMLElement).click());
    assert.match(sends()[1]?.text ?? "", /«Maren counted the bells\.» Make this colder$/, "and goes about the same passage");
  });

  it("a line the coordinator did not take is tried again as a new request (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const first = (m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string }).requestId;
    const asked = () => m.sent.filter((message) => message.kind === "world-chat-send-status" && (message as { requestId: string }).requestId === first).length;
    const answer = async (admitted: boolean) =>
      act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: first, admitted }));
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => __setStateForTest(state, { connection: "open", rejoins: 1 }));
    assert.ok(asked() >= 1);
    await answer(false);
    assert.match(text(m), /Not sent · Tighten this/);
    await act(async () => ([...m.container.querySelectorAll(".fy-arke__declined button")].find((b) => b.textContent === "Try again") as HTMLElement).click());
    const sends = m.sent.filter((message) => message.kind === "world-chat-send") as Array<{ requestId: string; text: string }>;
    assert.equal(sends.length, 2, "tried again at the author's word");
    assert.equal(sends[1]!.text, sends[0]!.text);
  });

  it("a line whose answer a rejoin lost is settled by asking the coordinator (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const first = (m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string }).requestId;
    const prompts = () => [...m.container.querySelectorAll("button.fy-arke__prompt")] as HTMLButtonElement[];
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => __setStateForTest(state, { connection: "open", rejoins: 1 }));
    assert.ok(prompts().every((b) => b.disabled), "the rejoin's snapshot may predate the turn: the dock still waits");
    // Taken after all: the ask is done with, and the dock waits for the thread to show it.
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: first, admitted: true }));
    assert.doesNotMatch(text(m), /Not sent ·/, "never offered again");
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 5, runStatus: "running" as never } } as ClientState, { connection: "open", rejoins: 1 }));
    assert.ok(prompts().every((b) => b.disabled), "running: a turn is on");
  });

  it("words already in the composer stay with a line a press starts (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    const composer = q(m, ".fy-arke .fy-cx__editor")!;
    composer.textContent = "half a thought";
    await act(async () => {
      composer.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Change tone…") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.equal(q(m, ".fy-arke .fy-cx__editor")?.textContent, "half a thought", "put away at once, the dock still comes back with them");
  });

  it("the menu opened from the keyboard takes the caret, so its arrows can be reached (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    // linkedom keeps no focus, so the focus calls are what is watched.
    const focused: string[] = [];
    const was = dom.HTMLElement.prototype.focus;
    Object.assign(dom.HTMLElement.prototype, {
      focus(this: HTMLElement) {
        focused.push(this.textContent ?? "");
      },
    });
    try {
      const pill = q(m, "button.fy-ch__ask") as HTMLElement;
      await act(async () => {
        const event = new dom.window.Event("keydown", { bubbles: true });
        Object.assign(event, { key: "ArrowDown" });
        pill.dispatchEvent(event);
      });
      assert.ok(m.container.querySelector("[role=menuitem]"), "the menu is open");
      assert.equal(focused.at(-1), "Tighten", "and the caret is on its first ask");
    } finally {
      Object.assign(dom.HTMLElement.prototype, { focus: was });
    }
  });


  it("a waiting ask names the passage it was pressed on, and holds the menu (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    const area = q(m, "textarea.fy-ch__source") as HTMLTextAreaElement;
    await keyup(area, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const pill = q(m, "button.fy-ch__ask") as HTMLButtonElement;
    assert.equal(pill.disabled, true, "a second press would replace the first before its answer");
    assert.match(pill.textContent ?? "", /asking…/);
    await keyup(area, 3, 3);
    assert.match(text(m), /about this passage · 4 words/, "the dock names the passage the ask is about, not what is selected now");
  });

  it("an ask waiting survives moving to another chapter and back (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const first = await mount(state);
    await answerOpen(first);
    await keyup(q(first, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => (q(first, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...first.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    // The screen goes, as it does when the author opens another chapter.
    await act(async () => first.root.unmount());
    const back = await mount(state);
    await answerOpen(back);
    await act(async () => __setStateForTest(state, { connection: "open" }));
    const sends = back.sent.filter((message) => message.kind === "world-chat-send" && (message as { text: string }).text.endsWith("Tighten this"));
    assert.equal(sends.length, 1, "back on the chapter, the ask goes");
  });

  it("an ask waiting does not outlive its world's session (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const first = await mount(state);
    await answerOpen(first);
    await keyup(q(first, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => __setStateForTest(state, { connection: "closed" }));
    await act(async () => (q(first, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...first.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    await act(async () => first.root.unmount());
    // The world is closed, then opened again later.
    await act(async () => __setStateForTest({ ...state, world: null, worldChat: null } as ClientState, { connection: "open" }));
    const back = await mount(state);
    await answerOpen(back);
    await act(async () => __setStateForTest(state, { connection: "open" }));
    const sends = back.sent.filter((message) => message.kind === "world-chat-send");
    assert.equal(sends.length, 0, "nothing pressed in the last session goes by itself");
  });

  it("a selection begun on the blank line before a paragraph is about that paragraph (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const m = await mount({ ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState);
    await answerOpen(m);
    // From the first newline after paragraph one to "tide" in paragraph two.
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, BODY.indexOf("\n"), BODY.indexOf("tide") + 4);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sent = m.sent.find((message) => message.kind === "world-chat-send") as { subject?: { paragraph?: number; text?: string } } | undefined;
    assert.equal(sent?.subject?.text, "Six, and the tide");
    assert.equal(sent?.subject?.paragraph, 2, "anchored at its first word, not where the drag began");
  });

  it("a dock put away while its first ask opens the thread does not open a second (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const m = await mount(styled);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Expand") as HTMLElement).click());
    const creates = () => m.sent.filter((message) => message.kind === "world-chat-create");
    assert.equal(creates().length, 1);
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.equal(creates().length, 1, "brought back, it waits for the thread already being opened");
    // The thread arrives: the ask is said into it, once.
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 1, actions: [], messages: [], points: [],
    };
    await act(async () => __setStateForTest({ ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState, { connection: "open" }));
    const sends = m.sent.filter((message) => message.kind === "world-chat-send" && (message as { text: string }).text.includes("Expand this"));
    assert.equal(sends.length, 1);
  });

  it("a first ask said after a rejoin is not taken for lost (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const m = await mount(styled);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Expand") as HTMLElement).click());
    // The connection drops and rejoins while the thread is being opened.
    await act(async () => __setStateForTest(styled, { connection: "closed" }));
    await act(async () => __setStateForTest(styled, { connection: "open", rejoins: 1 }));
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 1, actions: [], messages: [], points: [],
    };
    await act(async () => __setStateForTest({ ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState, { connection: "open", rejoins: 1 }));
    assert.equal(m.sent.filter((message) => message.kind === "world-chat-send").length, 1, "said into the thread it opened");
    assert.doesNotMatch(text(m), /Not sent ·/, "sent after the rejoin, so its answer is still coming");
  });

  it("the hold on a line just sent waits for its own answer, not any movement in the thread (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sent = m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string };
    const prompts = () => [...m.container.querySelectorAll("button.fy-arke__prompt")] as HTMLButtonElement[];
    // Another window moves the thread while this line is still being taken.
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 5 } } as ClientState, { connection: "open" }));
    assert.ok(prompts().every((b) => b.disabled), "the thread moving is not this line's answer");
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: sent.requestId, admitted: true }));
    assert.ok(prompts().every((b) => b.disabled), "taken, it waits for the thread to show its turn");
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 6 } } as ClientState, { connection: "open" }));
    assert.ok(prompts().every((b) => !b.disabled), "shown, the dock is free");
  });

  it("a thread's create lost with the connection is made again (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const m = await mount(styled);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Expand") as HTMLElement).click());
    const creates = () => m.sent.filter((message) => message.kind === "world-chat-create");
    assert.equal(creates().length, 1);
    await act(async () => __setStateForTest(styled, { connection: "closed" }));
    await act(async () => __setStateForTest(styled, { connection: "open", rejoins: 1 }));
    assert.equal(creates().length, 2, "rejoined with no thread, nothing would open one: the ask goes again");
    const ids = creates().map((message) => (message as { requestId: string }).requestId);
    assert.equal(ids[1], ids[0], "under the same create, which the coordinator makes at most once");
  });

  it("an answer for an ask put away is kept however much is said meanwhile (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const m = await mount({ ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sent = m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string };
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: sent.requestId, admitted: false }));
    // Enough other answers to push this one out of the store's own record.
    await act(async () => {
      for (let i = 0; i < 80; i += 1) __applyEventForTest({ at: "2026-09-06T12:00:06Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: `other-${i}`, admitted: true });
    });
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.match(text(m), /Not sent · Tighten this/, "the ask kept its own answer");
  });

  it("the hold on a line just taken outlasts the dock being put away (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const state = { ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState;
    const m = await mount(state);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const sent = m.sent.find((message) => message.kind === "world-chat-send") as { requestId: string };
    await act(async () => __applyEventForTest({ at: "2026-09-06T12:00:05Z", type: "world-chat.send-result", conversationId: THREAD.id, requestId: sent.requestId, admitted: true }));
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    const prompts = () => [...m.container.querySelectorAll("button.fy-arke__prompt")] as HTMLButtonElement[];
    assert.ok(prompts().length > 0 && prompts().every((b) => b.disabled), "brought back before the thread shows the turn, it still waits");
    await act(async () => __setStateForTest({ ...state, worldChat: { ...workspace, seq: 5 } } as ClientState, { connection: "open" }));
    assert.ok(prompts().every((b) => !b.disabled));
  });

  it("the same line pressed again keeps what the author had written (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    const area = q(m, "textarea.fy-ch__source") as HTMLTextAreaElement;
    const tone = async () => {
      await keyup(area, 0, 24);
      await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
      await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Change tone…") as HTMLElement).click());
    };
    await tone();
    const composer = q(m, ".fy-arke .fy-cx__editor")!;
    composer.textContent = "Make this colder";
    await act(async () => {
      composer.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await tone();
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.equal(q(m, ".fy-arke .fy-cx__editor")?.textContent, "Make this colder", "a new press, the same words: what was written is kept");
  });

  it("closing the menu from the keyboard puts the caret back on the press (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    const focused: string[] = [];
    const was = dom.HTMLElement.prototype.focus;
    Object.assign(dom.HTMLElement.prototype, {
      focus(this: HTMLElement) {
        focused.push(this.textContent ?? "");
      },
    });
    try {
      const key = (target: Element, name: string) => {
        const event = new dom.window.Event("keydown", { bubbles: true });
        Object.assign(event, { key: name });
        target.dispatchEvent(event);
      };
      await act(async () => key(q(m, "button.fy-ch__ask")!, "ArrowDown"));
      await act(async () => key(m.container.querySelector("[role=menuitem]")!, "Escape"));
      assert.equal(m.container.querySelector("[role=menu]"), null, "closed");
      assert.match(focused.at(-1) ?? "", /Ask Arke/, "and the caret is back on the press");
    } finally {
      Object.assign(dom.HTMLElement.prototype, { focus: was });
    }
  });

  it("with no prose style, the dock offers no holding against one (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([]), world: { ...inkbound([]).world!, conversations: [THREAD] } });
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    const labels = [...m.container.querySelectorAll("button.fy-arke__prompt")].map((b) => b.textContent);
    assert.equal(labels.some((label) => /against the style/.test(label ?? "")), false);
  });

  it("a line typed while the last one is still being taken stays in the composer (codex on PR 1232)", async () => {
    const styled = inkbound([], STYLE);
    const workspace = {
      conversationId: THREAD.id as never, status: "open" as const, initiative: "collaborate" as const, hasMore: false,
      runStatus: null, runStartedAt: null, retrievalUnavailable: false, attachments: [], seq: 4, actions: [], messages: [], points: [],
    };
    const m = await mount({ ...styled, world: { ...styled.world!, conversations: [THREAD] }, worldChat: workspace } as ClientState);
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Tighten") as HTMLElement).click());
    const prompts = [...m.container.querySelectorAll("button.fy-arke__prompt")] as HTMLButtonElement[];
    assert.ok(prompts.length > 0 && prompts.every((b) => b.disabled), "the quick asks wait for the thread too");
  });

  it("what the author types to finish a line survives the dock being put away (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Change tone…") as HTMLElement).click());
    const composer = q(m, ".fy-arke .fy-cx__editor")!;
    composer.textContent = "Make this colder and slower";
    await act(async () => {
      composer.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await act(async () => (q(m, "button.fy-arke__pin") as HTMLElement).click());
    await act(async () => (q(m, "button.fy-sw__rail") as HTMLElement).click());
    assert.equal(q(m, ".fy-arke .fy-cx__editor")?.textContent, "Make this colder and slower");
  });

  it("a line to finish never replaces what the author has typed (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    const composer = q(m, ".fy-arke .fy-cx__editor")!;
    composer.textContent = "My own question about the tide";
    await act(async () => {
      composer.dispatchEvent(new dom.Event("input", { bubbles: true }));
    });
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Change tone…") as HTMLElement).click());
    assert.equal(q(m, ".fy-arke .fy-cx__editor")?.textContent, "My own question about the tide");
  });

  it("Ask something else… puts the caret in the composer (codex on PR 1232)", async () => {
    const m = await mount({ ...inkbound([], STYLE), world: { ...inkbound([], STYLE).world!, conversations: [THREAD] } });
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    const composer = q(m, ".fy-arke .fy-cx__editor")!;
    let focused = 0;
    Object.assign(composer, { focus: () => { focused++; } });
    await act(async () => (q(m, "button.fy-ch__ask") as HTMLElement).click());
    await act(async () => ([...m.container.querySelectorAll("[role=menuitem]")].find((b) => b.textContent === "Ask something else…") as HTMLElement).click());
    assert.equal(focused, 1, "the author is handed the box, not left with a menu that closed on nothing");
  });

  it("without a prose style the menu does not offer to hold the passage against one", async () => {
    const m = await mount({ ...inkbound(), world: { ...inkbound().world!, conversations: [THREAD] } });
    await answerOpen(m);
    await keyup(q(m, "textarea.fy-ch__source") as HTMLTextAreaElement, 0, 24);
    await act(async () => {
      (q(m, "button.fy-ch__ask") as HTMLElement).click();
    });
    const labels = [...m.container.querySelectorAll("[role=menuitem]")].map((b) => b.textContent);
    assert.equal(labels.includes("Check against style"), false);
    assert.equal(labels.includes("Critique"), true);
  });

  it("a passage waiting stands in place with the rest untouched; the band, the chip, the foot and the card say the span", async () => {
    const m = await mount(inkbound([PASSAGE]));
    await answerOpen(m);
    assert.equal(q(m, "textarea.fy-ch__source"), null, "the editor is put away while the passage waits");
    // Spans, so the text runs together without the spaces the screen draws between them.
    assert.match(text(m), /Arke’s passage ?· 1 → 2 words ?· against v4/);
    assert.match(text(m), /decide in the thread/);
    assert.match(text(m), /Maren counted the seven bells\./, "the replacement stands in the passage's place");
    assert.match(text(m), /Six, and the tide/, "and the rest of the chapter is untouched");
    assert.match(text(m), /passage waiting/);
    assert.doesNotMatch(text(m), /draft waiting/);
    assert.match(text(m), /Locked while a passage waits · v4/);
    assert.match(text(m), /chapter 02 · passage/, "the card names the passage");
    assert.doesNotMatch(text(m), /the rest of the chapter is untouched/, "no caption under the gate (turn 137)");
    assert.doesNotMatch(text(m), /waits for your yes/, "no caption under the composer (turn 137)");
    const marked = [...m.container.querySelectorAll("p.fy-ch__passage")].map((p) => p.textContent);
    assert.deepEqual(marked, ["Maren counted the seven bells."], "only the paragraph the span falls in is marked");
    assert.doesNotMatch(text(m), /Ask Arke · /, "nothing is offered on a locked manuscript");
  });

  describe("keeping part of a passage", () => {
    const TWO: StagedProposal = {
      ...PASSAGE,
      proposal: { ...PASSAGE.proposal, id: "pr_01J8H0000000000000000000PB" },
      review: {
        targets: [
          {
            path: PATH,
            label: "The counting of bells",
            kind: "chapter",
            action: "amend",
            fields: [{ field: "Prose", before: BODY, proposed: BODY.replace("Maren counted the bells.", "Ines counted the seven bells.") }],
          },
        ],
      },
    };
    const edits = (m: Mounted) => [...m.container.querySelectorAll("button.fy-ch__edit")] as HTMLElement[];
    const acceptButton = (m: Mounted) =>
      [...m.container.querySelectorAll("button")].find((b) => /^Accept( \d+ of \d+)?$/.test(b.textContent ?? "")) as HTMLButtonElement;

    it("draws each edit to keep or refuse, and Accept says how much it accepts", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      assert.equal(edits(m).length, 2, "Maren→Ines and the seven are two edits");
      assert.match(text(m), /2 of 2 changes kept/);
      assert.equal(acceptButton(m).textContent, "Accept");
      assert.match(text(m), /Six, and the tide/, "the rest of the chapter stands as it was");

      await act(async () => edits(m)[0]!.click());
      assert.match(text(m), /1 of 2 changes kept/);
      assert.equal(edits(m)[0]!.getAttribute("aria-pressed"), "false");
      assert.equal(acceptButton(m).textContent, "Accept 1 of 2");

      await act(async () => edits(m)[1]!.click());
      assert.equal(acceptButton(m).disabled, true, "nothing kept is a discard, not an accept");
    });

    it("keeps the part through the gate first, then accepts the revision it lands as", async () => {
      const state = inkbound([TWO]);
      const m = await mount(state);
      await answerOpen(m);
      await act(async () => edits(m)[0]!.click());
      await act(async () => acceptButton(m).click());
      const keep = m.sent.find((message) => message.kind === "proposal-update-passage") as Extract<ClientMessage, { kind: "proposal-update-passage" }> | undefined;
      assert.ok(keep, "the part kept is sent");
      assert.equal(keep.proposalId, TWO.proposal.id);
      assert.equal(keep.path, PATH);
      assert.equal(keep.before, "Maren counted the");
      assert.equal(keep.after, "Ines counted the seven");
      assert.deepEqual(keep.kept, [1], "the refused name stays, the kept word lands: edits named, never words");
      assert.equal(keep.expectedDraftRevision, 1);
      assert.equal(m.sent.some((message) => message.kind === "proposal-accept"), false, "nothing is accepted before the part lands");

      // The part lands: the draft moves on a revision, now holding only what was kept.
      const landed: StagedProposal = {
        ...TWO,
        proposal: { ...TWO.proposal, draftRevision: 2 },
        review: {
          targets: [{ ...TWO.review!.targets[0]!, fields: [{ field: "Prose", before: BODY, proposed: BODY.replace("Maren counted the bells.", "Maren counted the seven bells.") }] }],
        },
      };
      await act(async () => __setStateForTest(inkbound([landed]), { connection: "open" }));
      const accepted = m.sent.filter((message) => message.kind === "proposal-accept");
      assert.equal(accepted.length, 1, "then the revision it landed as is accepted, once");
      assert.equal((accepted[0] as { proposalId: string }).proposalId, TWO.proposal.id);
      assert.equal((accepted[0] as { expectedDraftRevision?: number }).expectedDraftRevision, 2, "fenced to the revision seen (codex on PR 1232)");
      const discard = [...m.container.querySelectorAll("button")].find((b) => b.textContent === "Discard") as HTMLButtonElement;
      assert.equal(discard.disabled, true, "the accept that follows the keep holds the other decisions too (codex on PR 1232)");
    });

    it("a partial accept left mid-way is finished by the next screen to see the keep land (codex on PR 1232)", async () => {
      const first = await mount(inkbound([TWO]));
      await answerOpen(first);
      await act(async () => edits(first)[0]!.click());
      await act(async () => acceptButton(first).click());
      assert.ok(first.sent.some((message) => message.kind === "proposal-update-passage"));
      // The author opens another chapter before the keep lands.
      await act(async () => first.root.unmount());
      const landed: StagedProposal = {
        ...TWO,
        proposal: { ...TWO.proposal, draftRevision: 2 },
        review: {
          targets: [{ ...TWO.review!.targets[0]!, fields: [{ field: "Prose", before: BODY, proposed: BODY.replace("Maren counted the bells.", "Maren counted the seven bells.") }] }],
        },
      };
      const back = await mount(inkbound([landed]));
      await answerOpen(back);
      const accepted = back.sent.filter((message) => message.kind === "proposal-accept");
      assert.equal(accepted.length, 1, "the accept the press promised is sent");
      assert.equal((accepted[0] as { expectedDraftRevision?: number }).expectedDraftRevision, 2);
    });

    it("holds the choices while a keep is in flight, and lets go when the connection drops (codex on PR 1232)", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      await act(async () => edits(m)[0]!.click());
      await act(async () => acceptButton(m).click());
      assert.ok(edits(m).every((edit) => (edit as HTMLButtonElement).disabled), "what lands is what was pressed");
      assert.equal(acceptButton(m).disabled, true, "Keeping…");
      await act(async () => __setStateForTest(inkbound([TWO]), { connection: "closed" }));
      await act(async () => __setStateForTest(inkbound([TWO]), { connection: "open" }));
      assert.equal(acceptButton(m).disabled, false, "no answer is coming for a keep the connection lost");
      assert.ok(edits(m).every((edit) => !(edit as HTMLButtonElement).disabled));
      assert.equal(m.sent.some((message) => message.kind === "proposal-accept"), false);
    });

    it("a whole accept in flight holds the choices too (codex on PR 1232)", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      await act(async () => acceptButton(m).click());
      const accepted = m.sent.filter((message) => message.kind === "proposal-accept");
      assert.equal(accepted.length, 1);
      assert.equal((accepted[0] as { expectedDraftRevision?: number }).expectedDraftRevision, 1, "fenced to the revision on screen");
      assert.ok(edits(m).every((edit) => (edit as HTMLButtonElement).disabled), "no count can change under an accept already sent");
      await act(async () => __setStateForTest(inkbound([TWO]), { connection: "closed" }));
      await act(async () => __setStateForTest(inkbound([TWO]), { connection: "open" }));
      assert.ok(edits(m).every((edit) => !(edit as HTMLButtonElement).disabled), "the connection lost it, so the choice is the author's again");
    });

    it("a newer revision that is not the passage kept is somebody else's, and is not accepted (codex on PR 1232)", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      await act(async () => edits(m)[0]!.click());
      await act(async () => acceptButton(m).click());
      // Another window moved the draft on: a revision past the press, holding other words.
      const theirs: StagedProposal = {
        ...TWO,
        proposal: { ...TWO.proposal, draftRevision: 2 },
        review: {
          targets: [{ ...TWO.review!.targets[0]!, fields: [{ field: "Prose", before: BODY, proposed: BODY.replace("Maren counted the bells.", "Odile counted the nine bells.") }] }],
        },
      };
      await act(async () => __setStateForTest(inkbound([theirs]), { connection: "open" }));
      assert.equal(m.sent.some((message) => message.kind === "proposal-accept"), false, "a revision the author never saw is never accepted");
      assert.equal(acceptButton(m).disabled, false, "and the press is theirs again");
    });

    it("accepts only the keep's own revision, never a later one with the same prose (codex on PR 1232)", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      await act(async () => edits(m)[0]!.click());
      await act(async () => acceptButton(m).click());
      // The keep's words, but two revisions on: something else moved the draft as well.
      const later: StagedProposal = {
        ...TWO,
        proposal: { ...TWO.proposal, draftRevision: 3 },
        review: {
          targets: [{ ...TWO.review!.targets[0]!, fields: [{ field: "Prose", before: BODY, proposed: BODY.replace("Maren counted the bells.", "Maren counted the seven bells.") }] }],
        },
      };
      await act(async () => __setStateForTest(inkbound([later]), { connection: "open" }));
      assert.equal(m.sent.some((message) => message.kind === "proposal-accept"), false, "revision 3 carries more than the keep");
    });

    it("a keep that could not be sent leaves the press the author's (codex on PR 1232)", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      await act(async () => edits(m)[0]!.click());
      await act(async () => __setStateForTest(inkbound([TWO]), { connection: "closed" }));
      await act(async () => acceptButton(m).click());
      assert.equal(m.sent.some((message) => message.kind === "proposal-update-passage"), false);
      assert.equal(acceptButton(m).textContent, "Accept 1 of 2");
      assert.equal(acceptButton(m).disabled, false, "not stuck on Keeping…");
    });

    it("a passage rewritten under the same revision starts every edit kept again (codex on PR 1232)", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      await act(async () => edits(m)[0]!.click());
      assert.match(text(m), /1 of 2 changes kept/);
      const rewritten: StagedProposal = {
        ...TWO,
        review: {
          targets: [{ ...TWO.review!.targets[0]!, fields: [{ field: "Prose", before: BODY, proposed: BODY.replace("Maren counted the bells.", "Odile counted the nine bells.") }] }],
        },
      };
      await act(async () => __setStateForTest(inkbound([rewritten]), { connection: "open" }));
      assert.match(text(m), /2 of 2 changes kept/, "a refusal chosen against other edits does not carry over");
    });

    it("a blank line holding spaces is still a paragraph boundary: nothing after the passage is drawn twice (codex on PR 1232)", async () => {
      const SPACED = BODY.replace("\n\n", "\n  \n");
      const spaced: StagedProposal = {
        ...TWO,
        review: {
          targets: [{ ...TWO.review!.targets[0]!, fields: [{ field: "Prose", before: SPACED, proposed: SPACED.replace("Maren counted the bells.", "Ines counted the seven bells.") }] }],
        },
      };
      const m = await mount(inkbound([spaced]));
      await answerOpen(m, SPACED);
      assert.equal(edits(m).length, 2);
      const drawn = q(m, ".fy-ch__draft-passage")?.textContent ?? "";
      assert.equal(drawn.split("Six, and the tide").length - 1, 1, "the paragraph after the passage appears once");
    });

    it("a refused keep accepts nothing", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      await act(async () => edits(m)[0]!.click());
      await act(async () => acceptButton(m).click());
      await act(async () => {
        __applyEventForTest({
          at: "2026-09-06T12:00:03Z",
          type: "proposal.blocked",
          worldId: FIXTURE_WORLD_ID,
          proposalId: TWO.proposal.id,
          reason: "invalid",
          detail: "This passage is not the one on screen. Reload it and choose again.",
        });
      });
      assert.equal(acceptButton(m).disabled, false, "the press is the author's again");
      assert.equal(m.sent.some((message) => message.kind === "proposal-accept"), false);
    });

    it("an accept refused because the draft moved on asks for a read, not a rebase (codex on PR 1232)", async () => {
      const m = await mount(inkbound([TWO]));
      await answerOpen(m);
      await act(async () => {
        __applyEventForTest({
          at: "2026-09-06T12:00:03Z",
          type: "proposal.blocked",
          worldId: FIXTURE_WORLD_ID,
          proposalId: TWO.proposal.id,
          reason: "draft-changed",
          detail: "another change to this draft arrived first; read the draft as it stands now",
        });
      });
      assert.match(text(m), /The draft changed since you read it/);
      assert.doesNotMatch(text(m), /Rebase onto current/, "only the draft moved, so there is nothing to rebase");
    });

    it("a revision of one edit is accepted or discarded whole, as before", async () => {
      const m = await mount(inkbound([PASSAGE]));
      await answerOpen(m);
      assert.equal(edits(m).length, 0);
      assert.equal(acceptButton(m).textContent, "Accept");
      await act(async () => acceptButton(m).click());
      assert.equal(m.sent.some((message) => message.kind === "proposal-update-passage"), false);
      const accepted = m.sent.find((message) => message.kind === "proposal-accept") as { expectedDraftRevision?: number } | undefined;
      assert.equal(accepted?.expectedDraftRevision, PASSAGE.proposal.draftRevision, "fenced to the revision on screen, one edit or many (codex on PR 1232)");
      // The decision on its way holds the others (codex on PR 1232).
      const discard = [...m.container.querySelectorAll("button")].find((b) => b.textContent === "Discard") as HTMLButtonElement;
      assert.equal(discard.disabled, true, "a Discard racing the accept could land after it");
    });
  });

  it("a deletion at a paragraph's first word still marks the paragraph it touches (codex on PR 899)", async () => {
    const deletion: StagedProposal = {
      ...PASSAGE,
      proposal: { ...PASSAGE.proposal, id: "pr_01J8H0000000000000000000PA" },
      review: {
        targets: [
          {
            path: PATH,
            label: "The counting of bells",
            kind: "chapter",
            action: "amend",
            // The word goes and its space stays, which is what leaves a zero-width replacement at
            // the paragraph's first character.
            fields: [{ field: "Prose", before: BODY, proposed: BODY.replace("Maren counted", " counted") }],
          },
        ],
      },
    };
    const m = await mount(inkbound([deletion]));
    await answerOpen(m);
    assert.match(text(m), /Arke’s passage ?· 1 → 0 words/, "a zero-width replacement is still a passage");
    const marked = [...m.container.querySelectorAll("p.fy-ch__passage")].map((p) => p.textContent);
    assert.deepEqual(marked, ["counted the bells."], "the paragraph the deletion sat in is the one marked");
  });

  it("the selection and the span are decided by two small rules", () => {
    assert.equal(passageSubject(null), null);
    assert.equal(passageSubject("one two"), null, "under three words");
    assert.equal(passageSubject("  one two three  "), "one two three");
    assert.equal(passageSubject(`one two ${"x".repeat(1_200)}`), null, "over 1,200 characters");
    assert.equal(passageSubject("one two\n\nthree four"), null, "across a paragraph: it could never be found where it will be looked for");
    assert.equal(passageSubject("one two\nthree four"), "one two\nthree four", "a line break inside a paragraph is still one paragraph");
    assert.deepEqual(paragraphSpans("A b.\n\nC d."), [
      { text: "A b.", start: 0, end: 4 },
      { text: "C d.", start: 6, end: 10 },
    ]);
    assert.deepEqual(paragraphSpans(""), []);
    assert.equal(paragraphAt("A b.\n\nC d.", 0), 1, "the paragraph is counted from one");
    assert.equal(paragraphAt("A b.\n\nC d.", 7), 2);
    assert.equal(paragraphAt("", 0), null, "no paragraph in nothing");
    assert.equal(stagedChapterDraft([PASSAGE], PATH)?.before, BODY, "the review's before rides with the proposed");
  });
});

/**
 * After this chapter (design turn 129, issue 901, SPEC-012 §2.4.1): the record beside the
 * chapter, read with it and never off the summary; the press that derives; the states the
 * panel can be in; and the prompts the record answers.
 */
describe("after this chapter (turn 129)", () => {
  const RECORD: ChapterContinuity = {
    version: 4,
    hash: HASH,
    derivedAt: "2026-09-06T12:00:00.000Z",
    passes: 1,
    dropped: 0,
    omitted: 0,
    cut: 0,
    characters: [
      {
        character: "Maren Kest",
        sheet: "maren-kest",
        present: true,
        where: "the-vigil",
        placed: "Maren counted the bells.",
        knows: ["Maren counted the bells.", "Six, and the tide", "not yet called", "a fourth line the panel counts"],
      },
      { character: "Odile Sarn", present: false, placed: "Odile had left the Vigil.", knows: [] },
    ],
  };
  // The summary's body hash is what the record's hash is compared with (R-39).
  const withHash = (state: ClientState, bodyHash: string): ClientState => ({
    ...state,
    world: {
      ...state.world!,
      productions: state.world!.productions.map((p) =>
        p.meta.id === "inkbound" ? { ...p, chapters: p.chapters.map((c) => (c.id === "neap" ? { ...c, bodyHash } : c)) } : p,
      ),
    },
  });
  async function answerOpenWith(m: Mounted, extra: { continuity?: ChapterContinuity; continuityUnreadable?: true }): Promise<void> {
    const ask = m.sent.find((message) => message.kind === "open-chapter") as Extract<ClientMessage, { kind: "open-chapter" }>;
    await act(async () => {
      __applyEventForTest({
        at: "2026-09-06T12:00:01Z",
        type: "chapter.open-result",
        requestId: ask.requestId,
        worldId: FIXTURE_WORLD_ID,
        productionId: "inkbound",
        chapterId: "neap",
        disposition: "opened",
        body: BODY,
        version: 4,
        hash: HASH,
        versions: [1, 2, 3],
        ...extra,
      });
    });
  }
  const finished = (extra: { outcome: "derived" | "stopped" | "unavailable" | "failed"; placed?: number; reason?: string; record?: ChapterContinuity }) => ({
    at: "2026-09-06T12:00:02Z",
    type: "continuity.finished" as const,
    worldId: FIXTURE_WORLD_ID,
    productionId: "inkbound",
    chapterId: "neap",
    placed: 0,
    dropped: 0,
    omitted: 0,
    cut: 0,
    ...extra,
  });

  it("not derived yet: the panel says so, and the press asks for a derivation by the chapter's file", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    assert.match(text(m), /After this chapter/);
    assert.match(text(m), /where they end up · what they learn here/);
    assert.match(text(m), /Not derived yet\./);
    const press = q(m, ".fy-ch__derive")!;
    assert.match(press.textContent ?? "", /Derive$/);
    await act(async () => {
      press.click();
    });
    const derive = m.sent.find((message) => message.kind === "derive-continuity") as Extract<ClientMessage, { kind: "derive-continuity" }>;
    assert.ok(derive, "the press derives");
    assert.equal(derive.productionId, "inkbound");
    assert.equal(derive.chapterFile, "01-neap");
  });

  it("derived: each placed character, where as a mark, the lines as the chapter's own words with three shown, the stamp, and prompts the record answers", async () => {
    const m = await mount(withHash(inkbound(), HASH));
    await answerOpenWith(m, { continuity: RECORD });
    assert.match(text(m), /Maren Kest/);
    assert.match(text(m), /The Vigil|the-vigil/);
    assert.match(text(m), /“Maren counted the bells\.”/);
    assert.match(text(m), /and 1 more/, "three lines shown, the rest counted");
    assert.doesNotMatch(text(m), /a fourth line the panel counts/);
    assert.match(text(m), /derived · v4 · every line is the chapter’s own words/);
    assert.match(text(m), /Derive again/);
    assert.match(text(m), /What does Maren Kest learn here\?/);
    assert.match(text(m), /Where is Odile Sarn now\?/, "a name the cast does not know is shown as the chapter gave it");
    assert.match(text(m), /Odile Sarn\s*gone/, "said to have gone, and drawn so");
    assert.doesNotMatch(text(m), /chapter moved/);
  });

  it("stale: the summary's hash has moved past the record's, the lines stay, and the prompt that reads again is a press, not a line", async () => {
    const m = await mount(withHash(inkbound(), `sha256:${"b".repeat(64)}`));
    await answerOpenWith(m, { continuity: RECORD });
    assert.match(text(m), /chapter moved · derived against v4/);
    assert.match(text(m), /“Maren counted the bells\.”/, "a stale record is still a record");
    assert.match(text(m), /Who is in this chapter\?/);
    const prompts = [...m.container.querySelectorAll(".fy-arke__prompt")] as HTMLElement[];
    const again = prompts.find((prompt) => prompt.textContent === "Derive again");
    assert.ok(again, "Derive again is under the dock");
    await act(async () => {
      again!.click();
    });
    assert.ok(m.sent.some((message) => message.kind === "derive-continuity"), "the press derives");
    assert.ok(!m.sent.some((message) => message.kind === "world-chat-send"), "and says nothing");
  });

  it("deriving puts the press away; finishing brings the record; a rerun that fails says why and leaves the last record standing", async () => {
    const m = await mount(withHash(inkbound(), HASH));
    await answerOpen(m);
    // Another world's run, with the same production and chapter slugs, is not this chapter's
    // (codex on PR 907): the panel does not stir.
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:02Z", type: "continuity.started", worldId: "01J8H0000000000000000000W2", productionId: "inkbound", chapterId: "neap" });
    });
    assert.doesNotMatch(text(m), /deriving…/);
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:02Z", type: "continuity.started", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" });
    });
    assert.match(text(m), /deriving…/);
    const stop = q(m, ".fy-ch__derive")!;
    assert.equal(stop.textContent, "Stop", "Stop stands where the press stood");
    await act(async () => {
      stop.click();
    });
    const stopped = m.sent.find((message) => message.kind === "stop-continuity") as Extract<ClientMessage, { kind: "stop-continuity" }>;
    assert.ok(stopped, "the stop is sent");
    assert.equal(stopped.chapterFile, "01-neap");
    await act(async () => {
      __applyEventForTest(finished({ outcome: "derived", placed: 2, record: RECORD }));
    });
    assert.match(text(m), /“Maren counted the bells\.”/, "the lines are here without a second read");
    assert.ok(q(m, ".fy-ch__derive"), "the press is back");
    await act(async () => {
      __applyEventForTest(finished({ outcome: "failed", reason: "the model did not answer with a continuity record" }));
    });
    assert.match(text(m), /could not derive · the model did not answer with a continuity record/);
    assert.match(text(m), /“Maren counted the bells\.”/, "the last record stands");
    await act(async () => {
      __applyEventForTest(finished({ outcome: "unavailable", reason: "the writing service is not running" }));
    });
    assert.match(text(m), /could not derive · the writing service is not running/);
    await act(async () => {
      __applyEventForTest(finished({ outcome: "stopped" }));
    });
    assert.match(text(m), /stopped · the last record stands/, "a stop is said too (codex on PR 907)");
  });

  it("while a draft waits the press is disabled, and a name the cast knows now is marked (codex on PR 907, turn 129 round six)", async () => {
    const locked = await mount(inkbound([DRAFT]));
    await answerOpen(locked);
    assert.equal((q(locked, ".fy-ch__derive") as HTMLButtonElement).disabled, true, "a record is derived from the saved chapter, never from a draft");

    const m = await mount(withHash(inkbound(), HASH));
    await answerOpenWith(m, { continuity: { ...RECORD, characters: [{ character: "Maren Kest", present: true, knows: [] }] } });
    assert.match(text(m), /has a sheet now/, "the cast knows the name now; Derive again makes it a column");
  });

  it("a fresh open replaces the record a derivation finished with (codex on PR 907)", async () => {
    const m = await mount(withHash(inkbound(), HASH));
    await answerOpen(m);
    await act(async () => {
      __applyEventForTest(finished({ outcome: "derived", placed: 2, record: RECORD }));
    });
    assert.match(text(m), /“Maren counted the bells\.”/);
    // The chapter is opened again — a reconnect, say — and the disk holds no record now.
    m.sent.length = 0;
    await act(async () => {
      __setStateForTest(withHash(inkbound(), HASH), { connection: "closed" as never });
    });
    await act(async () => {
      __setStateForTest(withHash(inkbound(), HASH), { connection: "open" });
    });
    await answerOpen(m);
    assert.match(text(m), /Not derived yet\./, "what the disk holds now is the record");
    assert.doesNotMatch(text(m), /“Maren counted the bells\.”/);
  });

  it("a record that is there but cannot be read is said so, never offered as a first run (codex, round four)", async () => {
    const m = await mount(inkbound());
    await answerOpenWith(m, { continuityUnreadable: true });
    assert.match(text(m), /record unreadable · Derive again replaces it/);
    assert.doesNotMatch(text(m), /Not derived yet/);
    assert.match(q(m, ".fy-ch__derive")?.textContent ?? "", /Derive again/);
  });
});

/**
 * The voiced read (design turn 130, issue 912): the cast of lines beside the chapter, read with
 * it; the press that casts; the Voices panel's states; and the Voiced press, a page read the
 * frame names once.
 */
describe("the voiced read (turn 130)", () => {
  const CAST: ChapterVoices = {
    version: 4,
    hash: HASH,
    derivedAt: "2026-09-06T12:00:00.000Z",
    passes: 1,
    dropped: 0,
    omitted: 0,
    lines: [
      { speaker: "Maren Kest", sheet: "maren-kest", paragraph: 0, occurrence: 0, quote: "counted the bells" },
      { speaker: "Odile Sarn", paragraph: 1, occurrence: 0, quote: "not yet called" },
    ],
  };
  const withBodyHash = (state: ClientState, bodyHash: string): ClientState => ({
    ...state,
    world: {
      ...state.world!,
      productions: state.world!.productions.map((p) =>
        p.meta.id === "inkbound" ? { ...p, chapters: p.chapters.map((c) => (c.id === "neap" ? { ...c, bodyHash } : c)) } : p,
      ),
    },
  });
  async function answerOpenCast(m: Mounted, extra: { voices?: ChapterVoices; voicesUnreadable?: true }): Promise<void> {
    const ask = m.sent.find((message) => message.kind === "open-chapter") as Extract<ClientMessage, { kind: "open-chapter" }>;
    await act(async () => {
      __applyEventForTest({
        at: "2026-09-06T12:00:01Z",
        type: "chapter.open-result",
        requestId: ask.requestId,
        worldId: FIXTURE_WORLD_ID,
        productionId: "inkbound",
        chapterId: "neap",
        disposition: "opened",
        body: BODY,
        version: 4,
        hash: HASH,
        versions: [1, 2, 3],
        ...extra,
      });
    });
  }

  it("not cast yet: the panel says so, the press casts by the chapter's file, and there is no Voiced press without a cast", async () => {
    const m = await mount(inkbound());
    await answerOpen(m);
    assert.match(text(m), /Voices/);
    assert.match(text(m), /who speaks · in whose voice/);
    assert.match(text(m), /Not cast yet\./);
    const press = [...m.container.querySelectorAll(".fy-ch__derive")].find((button) => button.textContent?.includes("Cast the lines")) as HTMLElement;
    assert.ok(press, "Cast the lines is the press");
    await act(async () => {
      press.click();
    });
    const cast = m.sent.find((message) => message.kind === "cast-voices") as Extract<ClientMessage, { kind: "cast-voices" }>;
    assert.ok(cast, "the press casts");
    assert.equal(cast.chapterFile, "01-neap");
    assert.doesNotMatch(text(m), />Voiced</);
  });

  it("cast: the narration and each speaker with the voice that will read them and their count, the stamp, and Voiced names the chapter once", async () => {
    const m = await mount(withBodyHash(inkbound(), HASH));
    await answerOpenCast(m, { voices: CAST });
    assert.match(text(m), /Narration/);
    assert.match(text(m), /Maren Kest/);
    assert.match(text(m), /George · narrator/, "the narration in the narrator's voice");
    assert.match(text(m), /Low tide · elevenlabs/, "a sheet's assigned voice, by its label and provider");
    assert.match(text(m), /no sheet · narrator/, "a name the cast does not know reads in the narrator's");
    assert.match(text(m), /1 line/);
    assert.match(text(m), /cast · v4 · 2 lines · 2 speakers · every line is the chapter’s own words/);
    assert.match(text(m), /Cast again/);
    assert.match(text(m), /Who speaks in this chapter\?/);
    assert.match(text(m), /Which lines are Maren Kest’s\?/);
    const voiced = [...m.container.querySelectorAll("button")].find((button) => button.textContent === "Voiced") as HTMLElement;
    assert.ok(voiced, "Voiced stands beside Read the chapter");
    await act(async () => {
      voiced.click();
    });
    const read = m.sent.find((message) => message.kind === "read-prose-page") as Extract<ClientMessage, { kind: "read-prose-page" }>;
    assert.ok(read, "a page read");
    assert.deepEqual(read.sources, [{ of: "chapter-voiced", productionId: "inkbound", chapterId: "neap" }], "the chapter named once; the coordinator expands it");
  });

  it("a voice the catalogue cannot speak now reads in the narrator's, and the row says so (codex on PR 914)", async () => {
    const m = await mount(withBodyHash(inkbound(), HASH));
    await answerOpenCast(m, { voices: CAST });
    assert.ok(m.sent.some((message) => message.kind === "voice-catalogue"), "the catalogue is asked for once a cast is shown");
    assert.match(text(m), /Low tide · elevenlabs/, "the assignment stands until the catalogue answers");
    await act(async () => {
      __applyEventForTest({
        at: "2026-09-06T12:00:05Z",
        type: "voice.catalogue",
        worldId: FIXTURE_WORLD_ID,
        voices: [
          { provider: "elevenlabs", model: "eleven_multilingual_v2", voiceId: "v_8Kq2", label: "Low tide", attributes: [], local: false, canClone: false, unavailableReason: "the key was refused", usedBy: [] },
        ],
      });
    });
    assert.match(text(m), /voice unavailable · narrator/);
    assert.doesNotMatch(text(m), /Low tide · elevenlabs/);
  });

  it("stale: the cast was read against an earlier body, the rows stay, and Cast again is a press under the dock", async () => {
    const m = await mount(withBodyHash(inkbound(), `sha256:${"b".repeat(64)}`));
    await answerOpenCast(m, { voices: CAST });
    assert.match(text(m), /chapter moved · cast against v4/);
    assert.match(text(m), /Maren Kest/);
    const prompts = [...m.container.querySelectorAll(".fy-arke__prompt")] as HTMLElement[];
    const again = prompts.find((prompt) => prompt.textContent === "Cast again");
    assert.ok(again, "Cast again is under the dock");
    await act(async () => {
      again!.click();
    });
    assert.ok(m.sent.some((message) => message.kind === "cast-voices"), "the press casts");
    assert.ok(!m.sent.some((message) => message.kind === "world-chat-send"), "and says nothing");
  });

  it("casting puts Stop in the press's place; finishing brings the cast; a record that cannot be read is said so", async () => {
    const m = await mount(withBodyHash(inkbound(), HASH));
    await answerOpen(m);
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:02Z", type: "voices.started", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap" });
    });
    assert.match(text(m), /casting…/);
    const stop = [...m.container.querySelectorAll(".fy-ch__derive")].find((button) => button.textContent === "Stop") as HTMLElement;
    assert.ok(stop);
    await act(async () => {
      stop.click();
    });
    assert.ok(m.sent.some((message) => message.kind === "stop-voices"));
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:03Z", type: "voices.finished", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", outcome: "cast", lines: 2, dropped: 0, omitted: 0, record: CAST });
    });
    assert.match(text(m), /cast · v4 · 2 lines/);
    await act(async () => {
      __applyEventForTest({ at: "2026-09-06T12:00:04Z", type: "voices.finished", worldId: FIXTURE_WORLD_ID, productionId: "inkbound", chapterId: "neap", outcome: "stopped", lines: 0, dropped: 0, omitted: 0 });
    });
    assert.match(text(m), /stopped · the last cast stands/);

    const unreadable = await mount(inkbound());
    await answerOpenCast(unreadable, { voicesUnreadable: true });
    assert.match(text(unreadable), /record unreadable · Cast again replaces it/);
  });
});
