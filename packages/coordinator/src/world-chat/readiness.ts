import {
  CHARACTER_ROLE_MAX,
  SHEET_SHAPES,
  type Sheet,
  type SheetKind,
  type WorldBundle,
  type WorldChangeCandidate,
} from "@arke-studio/contracts";
import { lookHasMoved } from "./look.js";
import { developmentAmendment } from "./materialise.js";

/**
 * What a proposition may become, decided once (#70 §6.2).
 *
 * Readiness is not a state the user maintains. An earlier draft made it one — each proposition
 * carried a status somebody had to move it out of — and that turned a conversation into twelve
 * small approvals held while the ideas were still moving. It is evaluated here instead, at
 * wrap-up, for every live proposition at once.
 *
 * Nothing is silently dropped. A proposition that cannot carry is named on the approvals screen
 * with the reason, because "five of nine points became proposals" invites exactly one question,
 * and the four have to be answerable.
 */

export type NotCarriedReason =
  | "tentative"
  | "undecided"
  | "target-missing"
  | "invalid"
  | "look-moved"
  | "look-already-proposed"
  | "role-too-long"
  | "unknown-section"
  | "changes-nothing";

export interface NotCarried {
  candidateId: string;
  /** The proposition in its own words, so the screen names it rather than counting it (R-27d). */
  summary: string;
  reason: NotCarriedReason;
}

export interface Readiness {
  carried: WorldChangeCandidate[];
  /** Media ideas are retained against their target; they are never proposals (R-37a). */
  mediaIdeas: WorldChangeCandidate[];
  notCarried: NotCarried[];
}

/**
 * Settledness by classification (§6.2).
 *
 * A settled fact must say it is settled and an open question must say it is not. The model may
 * suggest either; this decides. That split is the whole reason the coordinator owns readiness —
 * a model that could mark its own output settled would be deciding what enters the world.
 */
function settlednessHolds(candidate: WorldChangeCandidate): boolean {
  if (candidate.classification === "canon.thread") return candidate.settledness === "unresolved";
  return candidate.settledness === "settled";
}

function targetExists(candidate: WorldChangeCandidate, bundle: WorldBundle): boolean {
  const target = (candidate as unknown as Record<string, unknown>)["target"] as
    | { kind: "canon"; entryId: string }
    | { kind: "sheet"; sheetId: string }
    | { kind: "production"; productionId: string }
    | { kind: "episode"; productionId: string; episodeId?: string }
    | { kind: "scene"; productionId: string; sceneId: string }
    | { kind: "shot"; productionId: string; sceneId: string; shotId?: string }
    | { kind: "series"; seriesId: string }
    | undefined;
  if (!target) return true;

  if (target.kind === "canon") {
    const entry = bundle.canon.find((c) => c.id === target.entryId);
    // A retired entry resolves for old citations but must not be amended into the present.
    return entry !== undefined && entry.retired !== true;
  }
  // The production targets (SPEC-023 R-20): a proposition against a production, episode, scene
  // or series that is not in this world stays in the conversation as target-missing — named,
  // never a crash, and never a proposal against nothing.
  if (target.kind === "production") {
    return bundle.productions.some((p) => p.meta.id === target.productionId);
  }
  if (target.kind === "episode") {
    const production = bundle.productions.find((p) => p.meta.id === target.productionId);
    if (!production) return false;
    return target.episodeId === undefined || production.episodes.some((e) => e.id === target.episodeId);
  }
  if (target.kind === "scene") {
    const production = bundle.productions.find((p) => p.meta.id === target.productionId);
    return production !== undefined && production.scenes.some((s) => s.id === target.sceneId);
  }
  /*
   * A shot's scene must exist, and a shot it names must be in it. `shotId` absent is a shot
   * this proposition would add, so only the scene has to be there — the same shape as an
   * episode target with no episodeId.
   */
  if (target.kind === "shot") {
    const production = bundle.productions.find((p) => p.meta.id === target.productionId);
    const scene = production?.scenes.find((s) => s.id === target.sceneId);
    if (!scene) return false;
    return target.shotId === undefined || scene.shots.some((shot) => shot.id === target.shotId);
  }
  if (target.kind === "series") {
    return bundle.series.some((s) => s.id === target.seriesId);
  }
  const sheet = bundle.sheets.find((s) => s.id === target.sheetId);
  return sheet !== undefined && sheet.retired !== true;
}

/**
 * Whether this proposition would write a character role longer than a role may be.
 *
 * Both ways of writing one. A create takes the kind from its own draft; an edit takes it from the
 * sheet it names, because its draft carries only what is changing. Only a string counts: absent
 * leaves the role alone and null clears it, and neither can be too long.
 *
 * Characters only, and trimmed before measuring, because that is exactly how the gate judges it
 * (`checkAuthoredBounds`). A role on a location is written and never measured, and holding one
 * back here would refuse what the gate would have accepted.
 */
function roleTooLong(candidate: WorldChangeCandidate): boolean {
  const record = candidate as unknown as Record<string, unknown>;
  const draft = record["draft"] as { type?: string; role?: unknown } | undefined;
  if (typeof draft?.role !== "string") return false;
  const kind =
    candidate.classification === "sheet.create"
      ? draft.type
      : candidate.classification === "sheet.edit"
        ? (record["target"] as { sheetKind?: string } | undefined)?.sheetKind
        : undefined;
  if (kind !== "character") return false;
  return draft.role.trim().length > CHARACTER_ROLE_MAX;
}

/**
 * The sections a proposition would write, and the shape they have to fit.
 *
 * A sheet's prose is not free-form: `sheetBody` walks `SHEET_SHAPES[type].sections` and writes
 * those headings and no others, so a section under any other heading is not written anywhere. It
 * is not refused, not logged and not shown — the key is set on the map and then never read.
 */
function draftSections(
  candidate: WorldChangeCandidate,
  bundle: WorldBundle,
): Array<{ heading: string; kind: SheetKind | undefined }> {
  const record = candidate as unknown as Record<string, unknown>;
  const draft = (record["draft"] ?? {}) as Record<string, unknown>;
  const sections = (draft["sections"] as Array<{ heading: string }> | undefined) ?? [];
  if (candidate.classification === "sheet.create") {
    const kind = draft["type"] as SheetKind | undefined;
    return sections.map((s) => ({ heading: s.heading, kind }));
  }
  if (candidate.classification === "sheet.edit") {
    const kind = (record["target"] as { sheetKind?: SheetKind } | undefined)?.sheetKind;
    return sections.map((s) => ({ heading: s.heading, kind }));
  }
  /*
   * The same door, one room over.
   *
   * A relationship change is prose edits to sheets, and materialise writes each one the same way
   * — `sections[edit.sectionHeading] = edit.body`, then through `sheetBody`. So an invented
   * heading vanishes here exactly as it does on a sheet edit, and fixing one without the other
   * would leave the bug reachable by asking for a relationship instead of an edit.
   *
   * The kind comes from the sheet the edit names, which is also how materialise resolves it; a
   * ref to something this wrap-up has not created yet has no sheet to read a shape from, and is
   * left to `MaterialiseError` as before.
   */
  if (candidate.classification === "relationship.change") {
    const edits =
      (draft["proseEdits"] as Array<{ sheet?: { sheetId?: string }; sectionHeading: string }>) ?? [];
    return edits.map((edit) => ({
      heading: edit.sectionHeading,
      kind: bundle.sheets.find((s) => s.id === edit.sheet?.sheetId)?.type,
    }));
  }
  return [];
}

/**
 * A heading this kind of sheet does not have — so writing it would write nothing.
 *
 * Held back here rather than dropped in materialise, for the reason the whole module exists:
 * silence is the failure. A proposition naming "Habits" on a character was materialised into a
 * file whose body never gained a word of it, staged, accepted, versioned and change-logged, and
 * the sheet afterwards said exactly what it had said before (driven 2026-08-23, `king-s-daughter`
 * / `adaeze-working-name`). Every surface reported success; none of them was in a position to
 * notice, because by the time the file existed the sentence was already gone.
 *
 * The remedy is a sentence in the conversation, which is why the point stays on the rail: the
 * headings are a fixed, small set, and "put it under Essence" is the whole repair. Any unknown
 * heading counts, not only an edit made entirely of them — a draft naming one real section and
 * one invented one would otherwise half-land, which is the same silence in a smaller place.
 */
function unknownSections(candidate: WorldChangeCandidate, bundle: WorldBundle): string[] {
  const unknown: string[] = [];
  for (const { heading, kind } of draftSections(candidate, bundle)) {
    if (kind === undefined) continue; // a shape nothing can name is `target-missing`'s business
    const shape = SHEET_SHAPES[kind];
    if (!shape) continue;
    if (!shape.sections.some((s) => s.heading === heading)) unknown.push(heading);
  }
  return unknown;
}

/**
 * Value equality that does not care what order the keys arrived in.
 *
 * A draft's nested objects come from the model's JSON in whatever order it wrote them; the live
 * record's come from a Zod parse, in schema order. `JSON.stringify` alone would call those two
 * different and carry a proposition that changes nothing — safe, but it would leave exactly the
 * gap this is here to close.
 */
function sameValue(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string | undefined =>
    JSON.stringify(value, (_key, inner: unknown) =>
      inner !== null && typeof inner === "object" && !Array.isArray(inner)
        ? Object.fromEntries(
            Object.entries(inner as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : 1)),
          )
        : inner,
    );
  return canonical(a) === canonical(b);
}

/**
 * Whether a Development amendment would write anything the record does not already say.
 *
 * The Episode Chat half of the same silence. These records are written as the draft merged onto
 * what is live, so a draft restating what the season, episode, scene or series already says
 * merges to exactly itself — and the file still differs, because the committer stamps `version`.
 * Accepted, that is a version cut over a record nobody changed.
 *
 * Judged by performing the merge rather than by describing it: `developmentAmendment` is the same
 * function materialise builds the file from, so this cannot drift from what would actually be
 * written — which matters most for the arcs rule, where a check that merged wholesale would call
 * a real change empty and hold back work somebody asked for. A creation, or a target this world
 * does not hold, returns null and is nothing to judge: the first always writes, and the second is
 * `target-missing`'s business.
 */
function developmentChangesNothing(candidate: WorldChangeCandidate, bundle: WorldBundle): boolean {
  const amendment = developmentAmendment(candidate, bundle);
  return amendment !== null && sameValue(amendment.live, amendment.next);
}

/**
 * Whether this edit would write anything the sheet does not already say.
 *
 * The other half of the same silence. A conversation that re-states what is already on the sheet
 * produces a draft that merges onto the live sections and changes none of them — and the file
 * still differs in bytes, because `updated` is stamped with today and the frontmatter is
 * re-serialised in its canonical order. So it is not a no-op to the gate, which compares bytes;
 * it commits, cuts a version, writes a history snapshot, and changes nothing anybody can read.
 *
 * Judged the way `editSheetContent` writes: absent leaves a field alone, null clears it, and the
 * sections are compared as `sheetBody` consumes them — trimmed, per heading of the shape. A draft
 * that names `canonRules` or `links` is never held back, because resolving those needs identities
 * this pass has not planned yet: carrying a proposition that turns out to change nothing is a far
 * cheaper mistake than holding back one that does, and the gate refuses the empty commit either
 * way.
 */
function changesNothing(candidate: WorldChangeCandidate, bundle: WorldBundle): boolean {
  if (candidate.classification.startsWith("development."))
    return developmentChangesNothing(candidate, bundle);
  if (candidate.classification !== "sheet.edit") return false;
  const record = candidate as unknown as Record<string, unknown>;
  const target = record["target"] as { sheetId: string } | undefined;
  const sheet: Sheet | undefined = bundle.sheets.find((s) => s.id === target?.sheetId);
  if (!sheet) return false; // `target-missing` has already spoken
  // A sheet this cannot read is one whose sections it cannot compare, and "I could not tell"
  // has to mean "carry it": the gate refuses an empty commit either way, and holding back a real
  // change over a shape this does not recognise would be the worse of the two mistakes.
  const shape = SHEET_SHAPES[sheet.type];
  if (!shape || !Array.isArray(sheet.sections)) return false;

  const draft = (record["draft"] ?? {}) as Record<string, unknown>;
  if (draft["canonRules"] !== undefined || draft["links"] !== undefined) return false;

  const settled = (next: unknown, current: string | undefined) =>
    next === undefined ? current : next === null ? undefined : String(next);
  if (draft["name"] !== undefined && String(draft["name"]) !== sheet.name) return false;
  if (settled(draft["role"], sheet.role) !== sheet.role) return false;
  if (settled(draft["billing"], sheet.billing) !== sheet.billing) return false;
  if (settled(draft["region"], sheet.region) !== sheet.region) return false;

  const before: Record<string, string> = {};
  for (const section of sheet.sections) before[section.heading] = section.body;
  const after = { ...before };
  for (const section of (draft["sections"] as Array<{ heading: string; body: string }> | undefined) ?? []) {
    after[section.heading] = section.body;
  }
  return shape.sections.every((s) => (before[s.heading] ?? "").trim() === (after[s.heading] ?? "").trim());
}

/** Intent has to be verified, not asserted: a proposition with no evidence is a claim about a claim. */
function hasIntentEvidence(candidate: WorldChangeCandidate): boolean {
  return candidate.evidence.some((e) => e.kind === "message" && e.purpose === "intent");
}

/**
 * Whether the checks are good enough to write against.
 *
 * `unavailable` does not block. When the index is down the user is shown the limitation and may
 * still choose to create — refusing outright would make a broken cache into a broken app, and the
 * choice is durable and visible in final review (§9.4).
 */
function checksAllow(candidate: WorldChangeCandidate): boolean {
  return candidate.checks.state !== "partial" || candidate.checks.userOverride !== undefined;
}

export function evaluateReadiness(
  candidates: readonly WorldChangeCandidate[],
  bundle: WorldBundle,
): Readiness {
  const carried: WorldChangeCandidate[] = [];
  const mediaIdeas: WorldChangeCandidate[] = [];
  const notCarried: NotCarried[] = [];
  /**
   * One look change per wrap-up as well as per world.
   *
   * `bundle.proposals` cannot see what this same pass is about to stage, so without this two
   * look propositions in one conversation would both carry and produce the pair of proposals the
   * check below exists to prevent.
   */
  let carriedALook = false;

  for (const candidate of candidates) {
    if (candidate.status !== "live") continue;

    if (candidate.classification === "media.image-opportunity") {
      mediaIdeas.push(candidate);
      continue;
    }

    const fail = (reason: NotCarriedReason) =>
      notCarried.push({ candidateId: candidate.id, summary: candidate.title, reason });

    if (candidate.classification === "undecided") {
      fail("undecided");
      continue;
    }
    if (!targetExists(candidate, bundle)) {
      fail("target-missing");
      continue;
    }
    /*
     * A look drafted against a look that has since changed.
     *
     * This classification carries the whole description, so writing it now would replace an edit
     * made in between with words chosen before it existed — and nothing downstream would call
     * that stale, because the proposal is staged against whatever is current at this moment. The
     * proposition is not wrong, only out of date: it stays in the conversation, and saying so is
     * what lets somebody ask for it again against the look that is actually there.
     *
     * Against the words as well as the version, because a world with no art-direction file
     * derives its look from world.json and derives it at v1 every time — see look.ts.
     */
    if (
      candidate.classification === "art-direction.change" &&
      lookHasMoved(candidate.checks, bundle.artDirection)
    ) {
      fail("look-moved");
      continue;
    }
    if (!hasIntentEvidence(candidate) || !checksAllow(candidate)) {
      fail("invalid");
      continue;
    }
    if (!settlednessHolds(candidate)) {
      // The commonest one, and the one worth wording carefully on the screen: "you said maybe,
      // so it cannot become a fact" is the difference between a bug and a design.
      fail("tentative");
      continue;
    }
    /*
     * A role that is a sentence, held back here rather than refused at the gate.
     *
     * `CHARACTER_ROLE_MAX` is an authoring bound, and nothing between a model's answer and the
     * accept gate used to measure it: the read schema is deliberately permissive, the wire schema
     * allows a paragraph, and materialise copies the draft's role into the frontmatter untouched.
     * So a character with a sentence for a role was built, staged, and only then refused by
     * `checkAuthoredBounds` — the last possible step, and the one place where saying no costs the
     * most. Saving such a point left a proposal nobody could accept standing on the approvals
     * screen with the proposition already off the rail.
     *
     * Named here instead, where a proposition that cannot carry is named rather than dropped. The
     * point stays in the conversation, so asking for a shorter role is the whole repair — and its
     * siblings are unaffected, which refusing in materialise could not manage: that path is all
     * or nothing, so one long label would have held back everything said beside it.
     */
    if (roleTooLong(candidate)) {
      fail("role-too-long");
      continue;
    }
    /*
     * A section nothing would write, and an edit that would write nothing.
     *
     * Both are the same failure — a proposition that reports success and leaves the world saying
     * what it said before — and both are caught here for the reason the role bound is: the point
     * stays in the conversation, where naming a real heading or saying what is actually different
     * is the entire repair, and its siblings are untouched. Refusing in materialise could manage
     * neither; that path is all or nothing, so one invented heading would hold back everything
     * said beside it, including the changes that were perfectly good.
     *
     * The named heading first, because it is the one the person can act on: "there is no section
     * called Habits" is a fact about the sheet, where "this changes nothing" is only a symptom.
     */
    if (unknownSections(candidate, bundle).length > 0) {
      fail("unknown-section");
      continue;
    }
    if (changesNothing(candidate, bundle)) {
      fail("changes-nothing");
      continue;
    }
    /*
     * One look change waiting at a time.
     *
     * There is a single world look, and the screen that reviews a proposed one finds it by kind
     * rather than by id — so a second would be reviewed, accepted or discarded in place of the
     * first, arbitrarily. Held back rather than staged: the conversation keeps the proposition,
     * and it can be asked for again once the one already waiting has been dealt with.
     *
     * Last, and only over candidates that have earned a place: claiming the slot any earlier let
     * a tentative look — one that was never going to carry — spend it, and the settled look
     * behind it was refused for a proposal that never existed.
     */
    if (candidate.classification === "art-direction.change") {
      if (carriedALook || bundle.proposals.some((staged) => staged.proposal.kind === "art-direction")) {
        fail("look-already-proposed");
        continue;
      }
      carriedALook = true;
    }
    carried.push(candidate);
  }

  return { carried, mediaIdeas, notCarried };
}

/**
 * Why a proposition did not carry, in the user's terms.
 *
 * The approvals screen shows this beside the proposals that did land, so it has to read as an
 * explanation rather than an error code.
 */
export function explainNotCarried(reason: NotCarriedReason): string {
  switch (reason) {
    case "tentative":
      return "still a maybe, so it cannot become a fact yet";
    case "look-moved":
      return "the world look changed after this was written, so it would undo that change";
    case "look-already-proposed":
      return "a change to the world look is already waiting to be decided";
    case "undecided":
      return "it is not clear yet what kind of change this is";
    case "target-missing":
      return "what it would change is no longer in the world";
    case "invalid":
      return "there is not enough behind it to write it down";
    case "role-too-long":
      return `it gives a role of more than ${CHARACTER_ROLE_MAX} characters, and a role is a label rather than a sentence`;
    case "unknown-section":
      return "it writes under a heading this kind of sheet does not have, so none of it would reach the page";
    case "changes-nothing":
      return "everything in it is already what the world says";
  }
}
