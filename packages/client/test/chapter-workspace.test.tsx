import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseHTML } from "linkedom";
import { MemoryRouter, Route, Routes } from "react-router";
import { paragraphSpans, type ChapterContinuity, type ChapterSummary, type ClientMessage, type ClientState, type ProseStyle, type StagedProposal, type WorldChatSummary } from "@arke-studio/contracts";
import { ChapterScreen, firstPrompt, paragraphAt, passageSubject, stagedChapterDraft } from "../src/screens/chapter-workspace.js";
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
    const m = await mount({ ...styled, world: { ...styled.world!, conversations: [THREAD] } });
    await answerOpen(m);
    assert.match(text(m), /close third · past · v2/, "the side says the style in one line");
    assert.match(text(m), /settled in Develop · read by every draft/);
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
    assert.match(text(m), /Replaces one passage · the rest of the chapter is untouched/);
    assert.match(text(m), /a passage waits for your yes/);
    const marked = [...m.container.querySelectorAll("p.fy-ch__passage")].map((p) => p.textContent);
    assert.deepEqual(marked, ["Maren counted the seven bells."], "only the paragraph the span falls in is marked");
    assert.doesNotMatch(text(m), /Ask Arke · /, "nothing is offered on a locked manuscript");
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
