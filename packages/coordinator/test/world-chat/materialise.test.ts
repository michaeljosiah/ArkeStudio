import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Sheet, WorldBundle, WorldChangeCandidate } from "@arke-studio/contracts";
import { materialiseCandidate, type Identities } from "../../src/world-chat/materialise.js";
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
const IDENTITIES: Identities = { canonIds: [], slugBy: new Map() };
const NO_CANON = () => {
  throw new Error("no canon id should be needed here");
};

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
  const built = materialiseCandidate(candidate, IDENTITIES, bundleWith(sheet), AT, NO_CANON);
  assert.equal(built.targets.length, 1);
  return MarkdownFile.parse(built.targets[0]!.content).data;
}

describe("a sheet edit changes what it names and nothing else", () => {
  const sheet = fullSheet();
  const touchOneSection = editOf({ sections: [{ heading: "Essence", body: "Rewritten." }] }, sheet);

  it("writes the section it was given", () => {
    const built = materialiseCandidate(touchOneSection, IDENTITIES, bundleWith(sheet), AT, NO_CANON);
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
