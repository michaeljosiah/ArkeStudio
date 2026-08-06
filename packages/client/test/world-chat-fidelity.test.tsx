import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import type { ClientState } from "@arke-studio/contracts";
import { App } from "../src/App.js";
import { __setStateForTest } from "../src/lib/store.js";
import { FIXTURE_WORLD_ID } from "../src/screens/registry.js";
import { FIXTURE_STATE } from "./fixture-state.js";

/**
 * World Chat against its design (#70, design turn 41).
 *
 * The design's binding note is specific: "World Chat is the world's Genesis: the same split, the
 * same composer, the same rail. Left column flex:1.2 ... a 470px rail on --muted. The rail's
 * action sits at its foot, full width, size='lg', with a caption beneath, exactly where 'Begin in
 * this world' sits ... The conversation carries no per-point controls."
 *
 * Those are measurements and rules, not impressions, so they are checked rather than eyeballed.
 * The one worth the most is the last: no per-point controls is the whole §0.1 revision. If a
 * button ever appears next to a point, this screen has quietly gone back to asking someone to
 * approve twelve things mid-sentence.
 */

const here = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(here, "../src/screens/fidelity.css"), "utf8");

const CONVERSATION_ID = "cv_01J8F3K2QW9VZX4N7M0RTYB6HC";

function stateWithConversation(): ClientState {
  return {
    ...FIXTURE_STATE,
    world: {
      ...FIXTURE_STATE.world!,
      conversations: [
        {
          id: CONVERSATION_ID as never,
          title: "The bells and the lock",
          status: "open",
          updatedAt: "2026-08-06T10:00:00Z",
          pointCount: 3,
          openProposalCount: 0,
          notCarried: [],
        },
      ],
    },
    worldChat: {
      conversationId: CONVERSATION_ID as never,
      status: "open",
      hasMore: false,
      runStatus: null,
      retrievalUnavailable: false,
      attachments: [],
      seq: 4,
      messages: [
        {
          id: "msg_01J8F3K2QW9VZX4N7M0RTYB6HC" as never,
          role: "user",
          text: "Her aunt taught her the bells, not her mother.",
          receipts: [],
          createdAt: "2026-08-06T10:00:00Z",
        },
        {
          id: "msg_01J8F3K2QW9VZX4N7M0RTYB6HD" as never,
          role: "studio",
          text: "That changes the line of inheritance.",
          receipts: ["read Maren Kest v4", "searched 41 canon entries"],
          createdAt: "2026-08-06T10:00:01Z",
        },
      ],
      points: [
        {
          id: "cand_01J8F3K2QW9VZX4N7M0RTYB6HC" as never,
          kind: "point",
          subject: "Maren Kest",
          subjectKind: "sheet · v4",
          text: "Her aunt taught her the bells, not her mother.",
          settled: true,
        },
        {
          id: "cand_01J8F3K2QW9VZX4N7M0RTYB6HD" as never,
          kind: "point",
          subject: "Maren Kest",
          subjectKind: "sheet · v4",
          text: "She was given them rather than entitled to them.",
          settled: true,
        },
        {
          id: "cand_01J8F3K2QW9VZX4N7M0RTYB6HE" as never,
          kind: "question",
          subject: "Still open",
          subjectKind: "not settled",
          text: "Who objects when the bells pass sideways?",
          settled: false,
        },
      ],
    },
  };
}

function renderConversation(): string {
  __setStateForTest(stateWithConversation());
  return renderToString(
    <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat/${CONVERSATION_ID}`]}>
      <App />
    </MemoryRouter>,
  );
}

/** The markup between the rail's opening tag and the end of the document. */
function railHtml(html: string): string {
  const start = html.indexOf('class="fy-gate__side"');
  assert.ok(start > 0, "the rail is rendered");
  return html.slice(start);
}

describe("World Chat is built on the Genesis split", () => {
  it("uses Genesis's own layout classes rather than a second nearly-identical split", () => {
    const html = renderConversation();
    for (const cls of ["fy-gate", "fy-gate__main", "fy-gate__head", "fy-gate__body", "fy-gate__side"]) {
      assert.ok(html.includes(`class="${cls}"`), `expected the conversation to use ${cls}`);
    }
  });

  it("inherits the design's binding measurements from that split", () => {
    // Asserted against the CSS the screen actually uses, so a change to either side fails here.
    assert.match(CSS, /\.fy-gate__main\s*\{[^}]*flex:\s*1\.2/, "left column is flex 1.2");
    assert.match(CSS, /\.fy-gate__side\s*\{[^}]*width:\s*470px/s, "the rail is 470px");
    assert.match(CSS, /\.fy-gate__side\s*\{[^}]*background:\s*var\(--muted\)/s, "the rail sits on --muted");
  });

  it("heads the conversation with an eyebrow and an h1, as Genesis does", () => {
    const html = renderConversation();
    assert.ok(html.includes("fy-eyebrow-sm"));
    assert.ok(html.includes("fy-story__h1"));
    assert.ok(html.includes("The bells and the lock"), "the conversation's own title is the h1");
  });
});

describe("the understanding panel", () => {
  it("carries no control on a point — a point is corrected by talking", () => {
    const rail = railHtml(renderConversation());
    const buttons = rail.split("<button").length - 1;
    assert.equal(
      buttons,
      1,
      "the rail holds exactly one action, the wrap-up; anything else is asking for approval mid-conversation",
    );
  });

  it("says out loud that nothing here is a decision", () => {
    const html = renderConversation();
    assert.ok(html.includes("nothing decided"));
    assert.ok(html.includes("There is nothing to approve here."));
  });

  it("groups points under the thing they are about, with what that thing is", () => {
    const rail = railHtml(renderConversation());
    assert.ok(rail.includes("Maren Kest"));
    assert.ok(rail.includes("sheet · v4"));
    const subjects = rail.split('class="fy-panel__subject"').length - 1;
    assert.equal(subjects, 2, "two Maren points share one heading, and open threads get their own");
  });

  it("keeps open questions in their own group rather than mixed among statements", () => {
    const rail = railHtml(renderConversation());
    assert.ok(rail.includes("Still open"));
    assert.ok(rail.includes("not settled"));
    assert.ok(rail.includes("Who objects when the bells pass sideways?"));
  });
});

describe("the wrap-up action", () => {
  it("sits at the rail's foot as a large primary button with a caption beneath", () => {
    const rail = railHtml(renderConversation());
    assert.match(rail, /ui-btn--primary[^"]*ui-btn--lg|ui-btn--lg[^"]*ui-btn--primary/);
    assert.ok(rail.includes("Turn this into proposals"));
    const caption = rail.indexOf("fy-panel__caption");
    const button = rail.indexOf("Turn this into proposals");
    assert.ok(caption > button, "the caption sits beneath the action, as it does in Genesis");
  });

  it("says what pressing it would actually do", () => {
    const rail = railHtml(renderConversation());
    assert.ok(rail.includes("Closes the conversation"), "wrap-up ends the conversation, and says so");
    assert.ok(
      rail.includes("nothing is written to the world until you accept"),
      "and that the world is still untouched afterwards",
    );
  });
});

describe("the transcript", () => {
  it("shows what was read beneath the reply that used it", () => {
    const html = renderConversation();
    assert.ok(html.includes("read Maren Kest v4"));
    assert.ok(html.includes("searched 41 canon entries"));
    const receipts = html.indexOf("read Maren Kest v4");
    const reply = html.indexOf("That changes the line of inheritance.");
    assert.ok(receipts > reply, "receipts sit under the reply, not above it");
  });

  it("announces new replies to assistive technology", () => {
    assert.ok(renderConversation().includes('aria-live="polite"'));
  });
});
