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
/** The annotated design master, whose `dv-rule` notes are the binding ones (turn 41). */
const DESIGN_MASTER = readFileSync(join(here, "../../../design-system/Arke Studio.dc.html"), "utf8");
/** The width the master binds World Chat's split to — held in one place, so it cannot drift. */
const BINDING_WIDTH = /Below <b>(\d+)px<\/b> the split becomes <b>one column<\/b>/.exec(DESIGN_MASTER)?.[1];

/** The stylesheet's narrow block for World Chat, as written at the master's binding width. */
function narrowBlock(): string | undefined {
  return new RegExp(`@media \\(max-width: ${BINDING_WIDTH}px\\) \\{([^@]*fy-gate[^@]*?)\\n\\}`, "s").exec(
    CSS,
  )?.[1];
}

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
      runStartedAt: null,
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
          revision: 1,
        },
        {
          id: "cand_01J8F3K2QW9VZX4N7M0RTYB6HD" as never,
          kind: "point",
          subject: "Maren Kest",
          subjectKind: "sheet · v4",
          text: "She was given them rather than entitled to them.",
          settled: true,
          revision: 1,
        },
        {
          id: "cand_01J8F3K2QW9VZX4N7M0RTYB6HE" as never,
          kind: "question",
          subject: "Still open",
          subjectKind: "not settled",
          text: "Who objects when the bells pass sideways?",
          settled: false,
          revision: 1,
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
    assert.match(CSS, /\.fy-gate__side\s*\{[^}]*background:\s*var\(--muted\)/s, "the rail sits on --muted");
    /*
     * 470 is World Chat's own number, and it is the whole width here rather than the content
     * width: 41a sets box-sizing:border-box on this rail where the canvas is otherwise content-box,
     * so the shared `fy-gate__side` carries the 534 the other gate screens render and the chat
     * wrap states 470 for itself. Asserting the scoped rule is what keeps rule 2 honest.
     */
    assert.match(
      CSS,
      /\.fy-chat__wrap \.fy-gate__side\s*\{[^}]*width:\s*470px/s,
      "the rail is 470px on World Chat",
    );
  });

  /*
   * The canvas floats its nav absolutely and pads each column 104px to clear it; here the nav is
   * sticky and so takes 53px of the column's own box. 52px is what puts this screen's first line
   * where 41a puts it, and both columns must use the same number or the eyebrow and the rail's
   * heading stop sitting on one line — which is the alignment the head is built around.
   */
  it("clears the floating nav by the same amount in both columns", () => {
    const head = /\.fy-chat__wrap \.fy-gate__head\s*\{[^}]*padding-top:\s*52px/s;
    const side = /\.fy-chat__wrap \.fy-gate__side\s*\{[^}]*padding-top:\s*52px/s;
    assert.match(CSS, head, "the conversation column clears the nav at 52px");
    assert.match(CSS, side, "and the rail clears it by exactly as much");
  });
});

describe("the transcript", () => {
  /*
   * Each bubble squares the one corner facing its own speaker. It is the only thing distinguishing
   * the two columns once a reply is short enough to sit level with the message above it, so it is
   * pinned rather than left to whichever radius a later edit reaches for.
   */
  it("gives each speaker its own tail and its own measure (41a)", () => {
    assert.match(
      CSS,
      /\.fy-chat__turn--user \.fy-chat__bubble\s*\{[^}]*border-radius:\s*14px 14px 4px 14px/s,
      "the user's bubble squares its bottom-right",
    );
    assert.match(
      CSS,
      /\.fy-chat__turn--studio \.fy-chat__bubble\s*\{[^}]*border-radius:\s*14px 14px 14px 4px/s,
      "the studio's squares its bottom-left",
    );
    assert.match(CSS, /\.fy-chat__turn--user\s*\{[^}]*max-width:\s*380px/s, "the user's measure is 380px");
    assert.match(CSS, /\.fy-chat__turn--studio\s*\{[^}]*max-width:\s*440px/s, "the studio's is 440px");
  });

  /* A receipt explains the answer it sits in; loose beneath the bubble it read as its own turn. */
  it("keeps receipts inside the reply that earned them", () => {
    const html = renderConversation();
    const bubble = html.indexOf('class="fy-chat__bubble"');
    const receipts = html.indexOf('class="fy-chat__receipts"');
    if (receipts > 0) {
      assert.ok(receipts > bubble, "the receipts render within a bubble, not after it");
      assert.ok(
        !/<\/div><div class="fy-chat__receipts"/.test(html),
        "and are not a sibling of the bubble",
      );
    }
  });

  it("collapses at the width the design system says it collapses at", () => {
    // The binding width is the one number that lived only in the stylesheet, where nothing would
    // have noticed it moving away from the drawn frame. Read it out of the master's own rule so
    // the two cannot drift: change either side alone and this fails.
    assert.ok(BINDING_WIDTH, "the master records World Chat's narrow binding width as a dv-rule");
    assert.match(
      CSS,
      new RegExp(`@media \\(max-width: ${BINDING_WIDTH}px\\) \\{[^@]*\\.fy-chat__wrap \\.fy-gate\\b`),
      `the stylesheet collapses World Chat at the master's ${BINDING_WIDTH}px`,
    );
  });

  it("moves the rail beneath the conversation rather than over it", () => {
    // 41c: one sheet, never a layer on a layer. A drawer would be the easy implementation and the
    // wrong one — it hides the conversation behind the thing that describes it.
    const narrow = narrowBlock();
    assert.ok(narrow, "the narrow block exists");
    assert.match(narrow, /\.fy-chat__wrap \.fy-gate \{[^}]*flex-direction:\s*column/, "one column");
    assert.match(narrow, /\.fy-gate__side \{[^}]*width:\s*auto/, "the rail gives up its fixed width");
    assert.ok(
      !/position:\s*(fixed|absolute)/.test(narrow) && !/transform:/.test(narrow),
      "and is laid out in flow — a drawer or overlay would be a layer on a layer",
    );
  });

  it("heads the conversation with an eyebrow and an h1, as Genesis does", () => {
    const html = renderConversation();
    assert.ok(html.includes("fy-eyebrow-sm"));
    assert.ok(html.includes("fy-story__h1"));
    assert.ok(html.includes("The bells and the lock"), "the conversation's own title is the h1");
  });
});

describe("the understanding panel", () => {
  /*
   * The design's original rule was that a point carried no control at all: deciding happened
   * twice, and both times about everything at once. In practice a conversation produces a dozen
   * points of which two are wrong, and the only way to say so was to carry all twelve to another
   * screen and reject two there. The rule now is that a decision belongs where the point is —
   * every point offers one, and the rail's own action accepts what is left.
   */
  it("offers a decision on every point, and one for the rest", () => {
    const rail = railHtml(renderConversation());
    const saves = rail.split(">Save<").length - 1;
    const rejects = rail.split(">Reject<").length - 1;
    assert.equal(saves, 2, "both settled points can be written from here");
    assert.equal(rejects, 3, "and every point, settled or not, can be dropped");
    assert.match(rail, /Accept all/, "with one action for everything still standing");
  });

  /*
   * A point that is not ready shows why, in the space its Save would have taken. Offering a Save
   * the coordinator would refuse is the promise this whole change exists to stop making.
   */
  it("says why a point cannot be written instead of offering to write it", () => {
    const rail = railHtml(renderConversation());
    assert.match(rail, /still open/, "the open question says what it is");
    assert.ok(rail.includes("fy-panel__pointwhy"), "and it reads as a reason, not as a disabled control");
  });

  /*
   * A subject is a card on the canvas, not a bare group. The rail sits on --muted, so it is the
   * card's own --background that separates one reading from the next; without it two subjects
   * each holding a single line ran together into one list.
   */
  it("gives each subject a card of its own (41a)", () => {
    assert.match(
      CSS,
      /\.fy-panel__group\s*\{[^}]*background:\s*var\(--background\)/s,
      "the card lifts off the muted rail",
    );
    assert.match(CSS, /\.fy-panel__group\s*\{[^}]*border:\s*1px solid var\(--border\)/s);
    assert.match(CSS, /\.fy-panel__group\s*\{[^}]*border-radius:\s*12px/s);
    assert.match(CSS, /\.fy-panel__group\s*\{[^}]*box-shadow:\s*var\(--shadow-xs\)/s);
  });

  /* Title and tally on one baseline: the count qualifies the title rather than following it. */
  it("sets the tally beside the panel's title, in the colour of an undecided thing", () => {
    const rail = railHtml(renderConversation());
    assert.ok(rail.includes('class="fy-panel__headline"'), "the two share a row");
    assert.match(CSS, /\.fy-panel__count\s*\{[^}]*color:\s*var\(--warning\)/s, "nothing here is settled yet");
  });

  /*
   * The panel used to say "nothing decided" and "there is nothing to approve here", which was the
   * truth when it was. It now writes to the world, and saying otherwise over a Save button would
   * be the screen contradicting the button on it.
   */
  it("says what the rail now does, rather than that it decides nothing", () => {
    const html = renderConversation();
    assert.ok(html.includes("Save writes a line to the world"), "the rail says what saving does");
    assert.ok(!html.includes("There is nothing to approve here."), "and no longer claims otherwise");
    assert.ok(html.includes("talking changes nothing until you save"), "talking is still safe, and says so");
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
    assert.ok(rail.includes("Accept all"));
    const caption = rail.indexOf("fy-panel__caption");
    const button = rail.indexOf("Accept all");
    assert.ok(caption > button, "the caption sits beneath the action, as it does in Genesis");
  });

  it("says what pressing it would actually do", () => {
    const rail = railHtml(renderConversation());
    assert.ok(rail.includes("closes this conversation"), "accept-all ends the conversation, and says so");
    assert.ok(
      rail.includes("Writes the 2 ready to the world"),
      "and that this one writes, rather than staging for a screen that no longer stands between",
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

/**
 * The conversation list's row, once it gained controls (R-50, §15.1).
 *
 * The row was a bare link and is now a link with two buttons beside it, which is the shape most
 * likely to break the thing it grew out of. Two properties are worth pinning rather than
 * eyeballing: the link still takes the width the buttons do not, so a long title does not shove
 * them off the row; and the controls are never revealed by hover alone, which would put deleting
 * out of reach of touch and out of sight of anyone not already pointing at it.
 */
describe("the conversation row's controls", () => {
  const rowBlock = /\.fy-chatlist__row \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
  const itemBlock = /\.fy-chatlist__row \.fy-chatlist__item \{([^}]*)\}/.exec(CSS)?.[1] ?? "";

  it("lays the row out with the link taking the width the controls do not", () => {
    assert.match(rowBlock, /display:\s*flex/);
    assert.match(itemBlock, /flex:\s*1/);
    assert.match(itemBlock, /min-width:\s*0/, "or a long title refuses to shrink and pushes them out");
  });

  it("keeps the controls visible without hover", () => {
    const quiet = /\.fy-chatlist__acts \.ui-btn \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
    const opacity = /opacity:\s*([\d.]+)/.exec(quiet)?.[1];
    assert.ok(opacity !== undefined, "the resting state is stated rather than left to the default");
    assert.ok(
      Number(opacity) > 0,
      "quiet until wanted is fine; invisible until hovered is not — this is where deleting lives",
    );
  });

  it("says the refusal in text, so it does not depend on a tooltip or on colour", () => {
    assert.match(CSS, /\.fy-chatlist__blocked \{/);
    const html = renderList();
    assert.match(html, /Cannot delete/);
  });

  function renderList(): string {
    __setStateForTest({
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
            openProposalCount: 2,
            deletionBlock: "unresolved-proposals",
            notCarried: [],
          },
        ],
      },
    });
    return renderToString(
      <MemoryRouter initialEntries={[`/w/${FIXTURE_WORLD_ID}/chat`]}>
        <App />
      </MemoryRouter>,
    ).replaceAll("<!-- -->", "");
  }
});
