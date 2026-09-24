import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { parseHTML } from "linkedom";
import { App } from "../src/App.js";
import { __setStateForTest, type CanonRefsState } from "../src/lib/store.js";
import { FIXTURE_STATE } from "./fixture-state.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";

const ENTRY = "CANON-002";

function render(canonRefs: Record<string, CanonRefsState>, state = FIXTURE_STATE): string {
  __setStateForTest(state, { canonRefs });
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/canon/${ENTRY}`]}>
      <App />
    </MemoryRouter>,
  );
}

function detail(history: CanonRefsState["history"], historyTruncated: boolean): Record<string, CanonRefsState> {
  return {
    [ENTRY]: {
      citedBy: { sheets: [], entries: [], productions: [] },
      history,
      historyTruncated,
      canonRevision: FIXTURE_STATE.world!.meta.canonRevision,
      ripples: [],
    },
  };
}

const change = (source: string) => ({
  ts: "2026-08-26T11:00:00.000Z",
  entity: `canon/${ENTRY}`,
  source,
  canonRevisionAfter: 4,
});

describe("the entry's History panel", () => {
  it("says nothing about history until the answer arrives", () => {
    // It used to read a tail of the world's changes, which is present the moment the world is —
    // so "no recorded changes yet" was safe to render immediately. Now it is an answer to a
    // question still in flight, and claiming an empty history before it lands is the same
    // untruth this issue is about, just briefer.
    const html = render({});
    assert.ok(!html.includes("no recorded changes yet"), "no verdict before there is an answer");
  });

  it("says an entry has no history only once told so", () => {
    assert.ok(render(detail([], false)).includes("no recorded changes yet"));
  });

  it("says when it is showing a window of a longer history", () => {
    const html = render(detail([change("form")], true));
    assert.ok(html.includes("older changes not shown"), "a bounded list must not read as the whole");
  });

  it("says nothing extra when the history is complete", () => {
    assert.ok(!render(detail([change("form")], false)).includes("older changes not shown"));
  });
});

/*
 * The entry's own controls say what they do (issue 747, after the same fix on Art direction).
 * `Accept amendment` lands on the press — the coordinator runs it as a single act — so a door
 * called "Propose a change", and a note promising the change would be proposed first, both set
 * up a review step nothing here queues.
 */
describe("the entry's amendment vocabulary", () => {
  it("opens the amendment form with a label that matches what committing there does", () => {
    const html = render(detail([change("form")], false));
    assert.ok(html.includes("Amend this entry"), "the door says what pressing it does");
    assert.ok(!html.includes("Propose a change"), "and no longer promises a review that never comes");
  });

  it("describes the ripple check as the single act it is", () => {
    const html = render({
      [ENTRY]: {
        citedBy: { sheets: [], entries: [], productions: [] },
        history: [],
        historyTruncated: false,
        canonRevision: 4,
        ripples: [{ kind: "sheet", summary: "Maren Kest cites this", targets: ["sheets/maren-kest.md"] }],
      },
    });
    assert.ok(html.includes("ripple-checked, then versioned"), "the ripple note is still there");
    assert.ok(!html.includes("a change is proposed"), "but no longer names a step the press skips");
  });
});

describe("readable canon context (issue 1003)", () => {
  it("names ripple targets and keeps production-only citations visible", () => {
    const state = structuredClone(FIXTURE_STATE);
    state.world!.sheets.push({ ...state.world!.sheets[0]!, id: "saltlight", name: "A guest with the production's slug" });
    const html = render({ [ENTRY]: {
      citedBy: { sheets: [], entries: [], productions: ["saltlight"] },
      history: [], historyTruncated: false, canonRevision: state.world!.meta.canonRevision,
      ripples: [
        { kind: "contradiction-candidates", summary: "1 existing entry shares this vocabulary — check for conflict.", targets: ["CANON-044"] },
        { kind: "productions-see-new-revision", summary: "1 production sees the new revision on its next dispatch", targets: ["saltlight"] },
      ],
    } }, state);
    const { document } = parseHTML(html);
    const citedBy = document.querySelector('[aria-label="Cited by"]')!;
    assert.match(citedBy.textContent!, /Saltlight/);
    assert.equal(citedBy.querySelector("a")?.getAttribute("href"), `/w/${FIXTURE_WORLD_ID}/p/saltlight`);
    const ripples = document.querySelector(".fy-entry__side .fy-draftcard")!;
    assert.match(ripples.textContent!, /Who taught the Chorister/);
    assert.match(ripples.textContent!, /Saltlight/);
    assert.doesNotMatch(ripples.textContent!, /contradiction-candidates|productions-see-new-revision/);
    assert.equal(ripples.querySelector("a")?.getAttribute("href"), `/w/${FIXTURE_WORLD_ID}/canon/CANON-044`);
    assert.equal(ripples.querySelectorAll("a")[1]?.getAttribute("href"), `/w/${FIXTURE_WORLD_ID}/p/saltlight`);
    assert.doesNotMatch(html, /A guest with the production/);
  });

  it("does not call citations empty before their answer arrives", () => {
    assert.match(render({}), /Loading citations/);
    assert.doesNotMatch(render({}), /No citations yet/);
    assert.match(render(detail([], false)), /No citations yet/);
    const stale = detail([], false);
    stale[ENTRY]!.canonRevision--;
    assert.match(render(stale), /Loading citations/);
    assert.doesNotMatch(render(stale), /No citations yet/);
  });

  it("shows the whole thread question once on the list, entry, and thread page", () => {
    const question = "Who taught the Chorister the song that the oldest bell repeats when nobody living remembers hearing it before?";
    const state = structuredClone(FIXTURE_STATE);
    const entry = state.world!.canon.find((candidate) => candidate.id === "CANON-044")!;
    entry.title = `${question.slice(0, 77)}…`;
    entry.body = question;
    try {
      for (const path of ["canon", "canon/CANON-044", "canon/CANON-044/thread"]) {
        __setStateForTest(state);
        const html = renderToString(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/${path}`]}><App /></MemoryRouter>);
        const text = parseHTML(html).document.querySelector('[data-screen^="canon"]')!.textContent!;
        assert.equal(text.split(question).length - 1, 1, `${path} shows the whole question once`);
        assert.ok(!text.includes(entry.title), `${path} drops the truncated repeat`);
        assert.doesNotMatch(text, /answers come only from entries/);
      }
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("preserves an authored thread title with a distinct supporting body", () => {
    __setStateForTest(FIXTURE_STATE);
    const html = renderToString(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/canon/CANON-044`]}><App /></MemoryRouter>);
    assert.match(html, /Who taught the Chorister/);
    assert.match(html, /True notes are taught, not overheard/);
  });

  it("deduplicates short refused questions while retaining candidate context", () => {
    const question = "Who taught the Chorister?";
    const context = "Considered when this was asked: CANON-002 — none of them decides it.";
    const state = structuredClone(FIXTURE_STATE);
    const entry = state.world!.canon.find((candidate) => candidate.id === "CANON-044")!;
    entry.title = question;
    entry.body = `${question}\n\n${context}`;
    try {
      for (const path of ["canon", "canon/CANON-044", "canon/CANON-044/thread"]) {
        __setStateForTest(state);
        const html = renderToString(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/${path}`]}><App /></MemoryRouter>);
        const text = parseHTML(html).document.querySelector('[data-screen^="canon"]')!.textContent!;
        assert.equal(text.split(question).length - 1, 1, `${path} shows the question once`);
        assert.equal(text.split(context).length - 1, 1, `${path} retains the considered candidates`);
        const headings = Array.from(parseHTML(html).document.querySelectorAll(".fy-gridcard__title, h1"), (node) => node.textContent);
        assert.ok(headings.includes(question), `${path} keeps the question as its own heading`);
        assert.ok(headings.every((heading) => !heading?.includes(context)), `${path} keeps candidate context in supporting text`);
      }
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });

  it("preserves an authored ellipsis title even when the body starts with the same words", () => {
    const state = structuredClone(FIXTURE_STATE);
    const entry = state.world!.canon.find((candidate) => candidate.id === "CANON-044")!;
    entry.title = "The Bell Song…";
    entry.body = "The Bell Song… was it taught by the Chorister or learned from the oldest bell?";
    __setStateForTest(state);
    try {
      const html = renderToString(<MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/canon/CANON-044`]}><App /></MemoryRouter>);
      const { document } = parseHTML(html);
      assert.equal(document.querySelector(".fy-entry__title")?.textContent, entry.title);
      assert.equal(document.querySelector(".fy-entry__body")?.textContent, entry.body);
    } finally {
      __setStateForTest(FIXTURE_STATE);
    }
  });
});
