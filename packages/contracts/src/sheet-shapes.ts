import type { SheetKind } from "./world.js";

/**
 * The three shapes of the one sheet entity (SPEC-007 §2.2, D1, D2).
 *
 * Characters, locations and factions differ in which prose sections they hold and one or two
 * frontmatter fields; they are identical in everything that carries risk. The difference is
 * this table — the parser, the form editor, drafting and serialisation all read it, so adding
 * a section is a data change, not four code changes.
 */

export interface SectionShape {
  heading: string;
  required: boolean;
  /** A hint for editors and drafting agents about what belongs here. */
  hint: string;
}

export interface SheetShape {
  type: SheetKind;
  /** Extra frontmatter fields this shape carries beyond the shared set. */
  extraFields: readonly string[];
  sections: readonly SectionShape[];
  /** Image extraction may only evidence these sections (SPEC-007 R-11, D7). */
  imageEvidenceSections: readonly string[];
}

export const SHEET_SHAPES: Record<SheetKind, SheetShape> = {
  character: {
    type: "character",
    extraFields: ["role", "billing", "voice"],
    sections: [
      { heading: "Essence", required: true, hint: "Who they are in two or three sentences." },
      { heading: "Appearance", required: true, hint: "What a camera would see." },
      { heading: "Relationships", required: false, hint: "Who they trust, owe, fear." },
      { heading: "Voice · written", required: false, hint: "How they speak on the page." },
    ],
    imageEvidenceSections: ["Appearance"],
  },
  location: {
    type: "location",
    extraFields: ["region"],
    sections: [
      { heading: "Look", required: true, hint: "What the place looks like." },
      { heading: "Sound", required: false, hint: "What it sounds like." },
      { heading: "Customs", required: false, hint: "How people behave there." },
    ],
    imageEvidenceSections: ["Look"],
  },
  faction: {
    type: "faction",
    extraFields: [],
    sections: [
      { heading: "Essence", required: false, hint: "What the group is." },
      { heading: "Wants", required: true, hint: "What it is trying to get." },
      { heading: "Fears", required: false, hint: "What it cannot afford." },
    ],
    imageEvidenceSections: [],
  },
};

/** The collection directory for a sheet type. */
export function sheetDir(type: SheetKind): "characters" | "locations" | "factions" {
  return type === "character" ? "characters" : type === "location" ? "locations" : "factions";
}
