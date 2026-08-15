import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sheet, WorldBundle, WorldChangeCandidate } from "@arke-studio/contracts";
import { materialiseCandidate, MaterialiseError, type Identities } from "../../src/world-chat/materialise.js";
import { MarkdownFile } from "../../src/world/text-files.js";

/**
 * Turning a proposition into the file a proposal is made of (#70 §11.2).
 *
 * The tests worth their place are about what an edit does NOT touch. Every sheet edit from a
 * conversation used to be rebuilt through `buildSheetContent`, which writes a sheet from nothing —
 * so an edit to one paragraph silently dropped the role, the billing, the region, the assigned
 * voice and the duplication origin, emptied `canonRules` and `links`, restamped `created`, and
 * took away the `production` that made a sheet somebody's guest. Nothing said so: the built file
 * still parsed, so `assertSheetParses` passed and the loss only showed up in the world.
 */

const AT = "2026-08-15T10:00:00Z";
const IDENTITIES: Identities = { canonIds: [], slugBy: new Map(), canonIdBy: new Map() };
/** A character wearing every optional field a sheet may carry, so a drop cannot hide. */
function fullSheet(over: Partial<Sheet> = {}): Sheet {
  return {
    id: "corvin-sabato",
    type: "character",
    name: "Corvin Sabato",
    role: "Blackfeather founder",
    billing: "lead",
    version: 7,
    status: "locked",
    production: "the-long-fall",
    origin: { sheet: "corvin-draft", version: 2 },
    voice: { provider: "eleven", voiceId: "v-101", label: "Corvin", assignedAtVersion: 4 },
    canonRules: ["CANON-004", "CANON-011"],
    links: ["blackfeather-covenant"],
    created: "2026-01-09",
    updated: "2026-02-02",
    sections: [
      { heading: "Essence", body: "An ancient Watcher." },
      { heading: "Appearance", body: "Tall, lean, controlled." },
    ],
    ...over,
  } as Sheet;
}

function bundleWith(sheet: Sheet): WorldBundle {
  return { sheets: [sheet], canon: [] } as unknown as WorldBundle;
}

function editOf(draft: Record<string, unknown>, sheet: Sheet): WorldChangeCandidate {
  return {
    id: "cand_edit",
    classification: "sheet.edit",
    target: { kind: "sheet", sheetKind: sheet.type, sheetId: sheet.id },
    draft,
  } as unknown as WorldChangeCandidate;
}

/** The frontmatter of the single file this proposition would write. */
function frontmatterOf(candidate: WorldChangeCandidate, sheet: Sheet): Record<string, unknown> {
  const built = materialiseCandidate(candidate, IDENTITIES, bundleWith(sheet), AT);
  assert.equal(built.targets.length, 1);
  return MarkdownFile.parse(built.targets[0]!.content).data;
}

describe("a sheet edit changes what it names and nothing else", () => {
  const sheet = fullSheet();
  const touchOneSection = editOf({ sections: [{ heading: "Essence", body: "Rewritten." }] }, sheet);

  it("writes the section it was given", () => {
    const built = materialiseCandidate(touchOneSection, IDENTITIES, bundleWith(sheet), AT);
    const doc = MarkdownFile.parse(built.targets[0]!.content);
    assert.match(doc.body, /Rewritten\./);
    assert.match(doc.body, /Tall, lean, controlled\./, "and leaves the sections it was not given");
  });

  it("carries the role through, which is what a role edit used to erase", () => {
    assert.equal(frontmatterOf(touchOneSection, sheet)["role"], "Blackfeather founder");
  });

  it("carries billing and region", () => {
    assert.equal(frontmatterOf(touchOneSection, sheet)["billing"], "lead");
    const place = fullSheet({ type: "location", id: "slackwater", region: "The drowned coast" });
    const edit = editOf({ sections: [{ heading: "Essence", body: "Bells." }] }, place);
    assert.equal(frontmatterOf(edit, place)["region"], "The drowned coast");
  });

  /*
   * The one that mattered most. `canonRules` is how a sheet references the rules that govern it,
   * and rebuilding reset it to []: an edit to a paragraph unbound the character from canon, with
   * nothing anywhere recording that it had happened.
   */
  it("keeps the canon references and the links", () => {
    const data = frontmatterOf(touchOneSection, sheet);
    assert.deepEqual(data["canonRules"], ["CANON-004", "CANON-011"]);
    assert.deepEqual(data["links"], ["blackfeather-covenant"]);
  });

  it("keeps the assigned voice and the duplication origin", () => {
    const data = frontmatterOf(touchOneSection, sheet);
    assert.deepEqual(data["voice"], {
      provider: "eleven",
      voiceId: "v-101",
      label: "Corvin",
      assignedAtVersion: 4,
    });
    assert.deepEqual(data["origin"], { sheet: "corvin-draft", version: 2 });
  });

  /*
   * A guest belongs to a production, and ownership has its own flow — promotion is a deliberate
   * human act with its own proposal. An edit that dropped the field promoted somebody's guest into
   * the world as a side effect of rewriting a sentence.
   */
  it("leaves a guest a guest", () => {
    assert.equal(frontmatterOf(touchOneSection, sheet)["production"], "the-long-fall");
  });

  it("keeps the status, so an edit cannot quietly unlock a locked sheet", () => {
    assert.equal(frontmatterOf(touchOneSection, sheet)["status"], "locked");
  });

  it("moves updated and never created", () => {
    const data = frontmatterOf(touchOneSection, sheet);
    assert.equal(data["created"], "2026-01-09", "created belongs to the create");
    assert.equal(data["updated"], "2026-08-15");
  });
});

describe("what a sheet edit may change", () => {
  const sheet = fullSheet();

  it("sets a new role when the draft gives one", () => {
    assert.equal(frontmatterOf(editOf({ role: "Tide-caller" }, sheet), sheet)["role"], "Tide-caller");
  });

  /*
   * Absent and null are different instructions, and the draft schema makes both expressible:
   * saying nothing about the role leaves it, and null is "he has no role any more".
   */
  it("clears the role when the draft gives null", () => {
    const data = frontmatterOf(editOf({ role: null }, sheet), sheet);
    assert.equal("role" in data, false, "cleared means absent, not an empty string");
  });

  it("renames without touching the id, so every citation still resolves", () => {
    const data = frontmatterOf(editOf({ name: "Corvin the Raven" }, sheet), sheet);
    assert.equal(data["name"], "Corvin the Raven");
    assert.equal(data["id"], "corvin-sabato");
  });
});

describe("a relationship change touches one section of one sheet", () => {
  const sheet = fullSheet();

  it("carries the rest of the sheet exactly as an edit does", () => {
    const candidate = {
      id: "cand_rel",
      classification: "relationship.change",
      draft: {
        proseEdits: [
          { sheet: { sheetId: "corvin-sabato" }, sectionHeading: "Essence", body: "Bound to the Covenant." },
        ],
      },
    } as unknown as WorldChangeCandidate;

    const data = frontmatterOf(candidate, sheet);
    assert.deepEqual(data["canonRules"], ["CANON-004", "CANON-011"]);
    assert.equal(data["role"], "Blackfeather founder");
    assert.equal(data["production"], "the-long-fall");
  });
});

/**
 * What a sheet is bound by (§2.3.2).
 *
 * Every sheet a conversation wrote used to come out with `canonRules: []` and `links: []`,
 * whatever had been said: the draft carried the references and materialise dropped them, so "he is
 * bound by the maintenance-hand rule" was heard, answered, and written down nowhere.
 */
describe("references a conversation asks for", () => {
  const RULE = "CANON-004";
  const OTHER = "maren-kest";

  function worldWith(sheet?: Sheet): WorldBundle {
    return {
      sheets: [...(sheet ? [sheet] : []), { id: OTHER, type: "character", name: "Maren" }],
      canon: [{ id: RULE, title: "The maintenance hand", body: "Only deacons read it." }],
    } as unknown as WorldBundle;
  }

  function creating(draft: Record<string, unknown>, id = "cand_new"): WorldChangeCandidate {
    return {
      id,
      classification: "sheet.create",
      draft: { type: "character", name: "Colm Venn", canonRules: [], links: [], sections: [], ...draft },
    } as unknown as WorldChangeCandidate;
  }

  const plan = (over: Partial<Identities> = {}): Identities => ({
    canonIds: [],
    slugBy: new Map([["cand_new", "colm-venn"]]),
    canonIdBy: new Map(),
    ...over,
  });

  const fm = (c: WorldChangeCandidate, ids: Identities, b: WorldBundle) =>
    MarkdownFile.parse(materialiseCandidate(c, ids, b, AT).targets[0]!.content).data;

  it("writes the canon rules the draft names", () => {
    assert.deepEqual(fm(creating({ canonRules: [RULE] }), plan(), worldWith())["canonRules"], [RULE]);
  });

  it("writes a link to a sheet that exists", () => {
    const data = fm(creating({ links: [{ kind: "sheet", sheetId: OTHER }] }), plan(), worldWith());
    assert.deepEqual(data["links"], [OTHER]);
  });

  /*
   * A sheet holds canon in one field, and `links` is not it — that field takes slugs. The link
   * union admits a canon ref, so it is a shape the model is invited to produce and it has to land
   * somewhere rather than vanish.
   */
  it("folds a canon reference arriving as a link into canonRules", () => {
    const data = fm(creating({ links: [{ kind: "canon", entryId: RULE }] }), plan(), worldWith());
    assert.deepEqual(data["canonRules"], [RULE]);
    assert.deepEqual(data["links"], []);
  });

  it("resolves a link to a sheet being created in the same breath", () => {
    const ids = plan({ slugBy: new Map([["cand_new", "colm-venn"], ["cand_sister", "ottoline-pike"]]) });
    const c = creating({ links: [{ kind: "pending-entity", ref: { candidateId: "cand_sister", revision: 1 } }] });
    assert.deepEqual(fm(c, ids, worldWith())["links"], ["ottoline-pike"]);
  });

  /*
   * The reason canon ids are planned per candidate rather than handed out as materialise walks the
   * set: a character bound by a rule written in the same turn has to be able to name it.
   */
  it("resolves a rule being created in the same breath", () => {
    const ids = plan({ canonIdBy: new Map([["cand_rule", "CANON-050"]]) });
    const c = creating({ links: [{ kind: "pending-entity", ref: { candidateId: "cand_rule", revision: 1 } }] });
    assert.deepEqual(fm(c, ids, worldWith())["canonRules"], ["CANON-050"]);
  });

  it("refuses a rule the world does not have, rather than writing a dangling reference", () => {
    assert.throws(
      () => materialiseCandidate(creating({ canonRules: ["CANON-999"] }), plan(), worldWith(), AT),
      (err: unknown) => err instanceof MaterialiseError && err.detail.includes("CANON-999"),
    );
  });

  it("never links a sheet to itself", () => {
    const ids = plan();
    const c = creating({ links: [{ kind: "pending-entity", ref: { candidateId: "cand_new", revision: 1 } }] });
    assert.deepEqual(fm(c, ids, worldWith())["links"], []);
  });

  it("carries a sheet's references through an edit that says nothing about them", () => {
    const sheet = fullSheet({ canonRules: [RULE], links: [OTHER] });
    const edit = editOf({ sections: [{ heading: "Essence", body: "Changed." }] }, sheet);
    const data = frontmatterOf(edit, sheet);
    assert.deepEqual(data["canonRules"], [RULE]);
    assert.deepEqual(data["links"], [OTHER]);
  });

  it("replaces them when an edit does name them", () => {
    const sheet = fullSheet({ canonRules: [], links: [] });
    const edit = editOf({ canonRules: [RULE] }, sheet);
    const data = materialiseCandidate(edit, plan(), worldWith(sheet), AT);
    assert.deepEqual(MarkdownFile.parse(data.targets[0]!.content).data["canonRules"], [RULE]);
  });
});
