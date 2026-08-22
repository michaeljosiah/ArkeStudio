import type {
  CandidateChecks,
  ModelCandidateDraft,
  WorldChatCheckReceipt,
  WorldChatEntityRef,
  WorldChangeClassification,
} from "@arke-studio/contracts";
import { type CurrentLook, lookHasMoved, lookIdentityOf } from "./look.js";

/**
 * What must be checked before a proposition can be called ready, and what the checks found
 * (#70 §5.7, §8.3.1).
 *
 * The coordinator builds and runs this plan. The model cannot choose the search scope that
 * establishes readiness, and its own exploratory searches never satisfy a required category.
 * The reason is narrow and important: "is this new?" is the one question where a model marking
 * its own homework is indistinguishable from a model doing the work. A search chosen after the
 * fact can be made to miss, and the panel would then say "new" with a receipt behind it.
 *
 * So the queries are derived from the candidate deterministically, they are reproducible in
 * tests, and they are rerun at wrap-up when what they observed has moved.
 */

export type CheckCategory = "canon-search" | "sheet-search" | "target-read" | "related-read";

/** §5.7's classification matrix, as a table rather than prose. */
const REQUIRED_BY_CLASSIFICATION: Record<WorldChangeClassification, readonly CheckCategory[]> = {
  "canon.create": ["canon-search"],
  "canon.amend": ["target-read"],
  "canon.thread": ["canon-search"],
  "sheet.create": ["sheet-search", "canon-search"],
  "sheet.edit": ["target-read", "canon-search"],
  "relationship.change": ["target-read", "related-read"],
  // Nothing to search. There is exactly one world look, so a change to it cannot duplicate
  // anything and has no target to read that is not already in the bundle — the checks exist to
  // answer "does this already exist, and what does it touch?", and here both answers are known.
  "art-direction.change": [],
  "media.image-opportunity": ["target-read"],
  // The production entities are not reachable through the world-query tools — the entry context
  // carries the production, and the coordinator narrates the current overview, season, episode
  // and script into the turn itself. The same reasoning as the world look: both answers the
  // checks exist to give are already in the room (SPEC-023 R-20).
  "development.overview": [],
  "development.season": [],
  "development.episode": [],
  "development.scene-script": [],
  "development.shot": [],
  "development.series": [],
  // Undecided needs whatever each plausible action would need, and stays partial until it is
  // decided — which is why it can never become a proposal.
  undecided: [],
};

/**
 * The lexical floor at which a search result is worth showing somebody as a possible duplicate.
 *
 * Above this, the app says "this may already exist" and lets a person judge. It never blocks on
 * its own reading, because a false duplicate that blocks is worse than one that asks.
 */
export const DUPLICATE_FLOOR = 0.6;

export interface CheckPlan {
  required: CheckCategory[];
  /** Canonical, deterministic query text per category. Empty when the category needs no search. */
  queries: Partial<Record<CheckCategory, string>>;
  /** What a target-read must read. */
  targets: WorldChatEntityRef[];
}

function targetOf(draft: ModelCandidateDraft): WorldChatEntityRef[] {
  const record = draft as unknown as Record<string, unknown>;
  const target = record["target"] as WorldChatEntityRef | undefined;
  if (target) return [target];

  const payload = (record["draft"] ?? {}) as Record<string, unknown>;
  if (draft.classification === "media.image-opportunity") {
    return [payload["target"] as WorldChatEntityRef];
  }
  if (draft.classification === "relationship.change") {
    // Both ends are read: a relationship that names somebody who is not there is not a change,
    // it is a mistake, and reading only one end would miss it half the time.
    return [payload["from"], payload["to"]]
      .filter((r): r is { kind: "sheet"; sheetId: string } => {
        const ref = r as { kind?: string } | undefined;
        return ref?.kind === "sheet";
      })
      .map((r) => ({ kind: "sheet", sheetKind: "character", sheetId: r.sheetId }) as WorldChatEntityRef);
  }
  return [];
}

/**
 * The search text for a candidate, built from its own content.
 *
 * Deterministic on purpose: the same proposition always produces the same query, so a check can
 * be rerun at wrap-up and compared with what it found before.
 */
function searchTextFor(draft: ModelCandidateDraft): string {
  const payload = ((draft as unknown as Record<string, unknown>)["draft"] ?? {}) as Record<string, unknown>;
  const parts = [
    draft.title,
    payload["title"],
    payload["name"],
    payload["statement"],
    payload["question"],
    payload["role"],
    payload["region"],
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  return [...new Set(parts)].join(" ");
}

export function planFor(draft: ModelCandidateDraft): CheckPlan {
  const required = [...REQUIRED_BY_CLASSIFICATION[draft.classification]];
  const text = searchTextFor(draft);
  const queries: CheckPlan["queries"] = {};
  if (required.includes("canon-search")) queries["canon-search"] = text;
  if (required.includes("sheet-search")) queries["sheet-search"] = text;
  return { required, queries, targets: targetOf(draft) };
}

const CATEGORY_BY_TOOL: Partial<Record<WorldChatCheckReceipt["tool"], CheckCategory>> = {
  "search-canon": "canon-search",
  "search-sheets": "sheet-search",
  "get-entry": "target-read",
  "get-sheet": "target-read",
  related: "related-read",
};

export interface DeriveInput {
  draft: ModelCandidateDraft;
  plan: CheckPlan;
  /** Receipts produced by the coordinator's own plan for this candidate, in this run. */
  receipts: readonly WorldChatCheckReceipt[];
  canonRevision: number;
  /**
   * The world look as it stands, so a draft that replaces it whole is bound to what it read.
   *
   * Both halves of it: a look is identified by its words as well as its number, because a derived
   * one is always v1 however often the world's tone is edited underneath it (see look.ts).
   */
  artDirectionLook?: CurrentLook;
  /** Scored matches from the plan's searches, above and below the duplicate floor. */
  matches?: ReadonlyArray<{ ref: WorldChatEntityRef; score: number }>;
}

/**
 * Turn receipts into the checks a proposition carries (§5.7).
 *
 * `state` is the honest summary. `complete` only when every required category actually ran;
 * `unavailable` when one could not run at all, which is different from running and finding
 * nothing; `stale` when something observed has since moved. The distinction between `unavailable`
 * and a clean `complete` with no matches is the whole reason this is computed rather than
 * asserted: one of them means "this is new", and the other means "nobody knows".
 */
export function deriveChecks(input: DeriveInput): CandidateChecks {
  const completed = new Set<CheckCategory>();
  const unavailable = new Set<CheckCategory>();
  const consulted: CandidateChecks["consulted"] = [];

  for (const receipt of input.receipts) {
    const category = CATEGORY_BY_TOOL[receipt.tool];
    if (!category) continue;
    if (receipt.status === "unavailable" || receipt.status === "failed") {
      unavailable.add(category);
      continue;
    }
    // `empty` is a completed check: it looked and found nothing, which is the answer that lets a
    // proposition be called new.
    completed.add(category);
    for (const c of receipt.consulted) {
      consulted.push({ ...c, checkId: receipt.id });
    }
  }

  const required = input.plan.required;
  const missing = required.filter((c) => !completed.has(c));
  const blocked = missing.filter((c) => unavailable.has(c));

  const matches = input.matches ?? [];
  const above = matches.filter((m) => m.score >= DUPLICATE_FLOOR).map((m) => m.ref);

  // What a match *means* depends on what the proposition is trying to do. For a create, an
  // existing entity is a possible duplicate. For an amendment, it is a possible target.
  const isCreate = draftIsCreate(input.draft);
  const likelyDuplicates = isCreate ? above : [];
  const possibleAmendments = isCreate ? above : [];
  const contradictionCandidates = isCreate ? [] : above;

  const state: CandidateChecks["state"] =
    blocked.length > 0 ? "unavailable" : missing.length > 0 ? "partial" : "complete";

  return {
    state,
    basedOnCanonRevision: input.canonRevision,
    // Only for the classification that replaces the look whole; nothing else is bound to it.
    ...(input.draft.classification === "art-direction.change" && input.artDirectionLook !== undefined
      ? lookIdentityOf(input.artDirectionLook)
      : {}),
    required: [...required],
    completed: [...completed].filter((c) => required.includes(c)),
    consulted,
    likelyDuplicates,
    possibleAmendments,
    contradictionCandidates,
    explanation: explain(state, missing, blocked, above.length),
  };
}

function draftIsCreate(draft: ModelCandidateDraft): boolean {
  return draft.classification === "canon.create" || draft.classification === "sheet.create";
}

/**
 * Plain wording for what was and was not checked.
 *
 * The model may offer its own explanation, but the coordinator replaces it whenever it names
 * entities outside the computed sets (§5.7) — so this is the text that has to stand on its own.
 */
function explain(
  state: CandidateChecks["state"],
  missing: readonly CheckCategory[],
  blocked: readonly CheckCategory[],
  matchCount: number,
): string {
  if (blocked.length > 0) {
    return "Some of the world could not be searched, so this may already exist without it showing here.";
  }
  if (missing.length > 0) {
    return "Not everything needed has been checked yet.";
  }
  if (matchCount > 0) {
    return matchCount === 1
      ? "One existing entry looks close enough to be worth a look."
      : `${matchCount} existing entries look close enough to be worth a look.`;
  }
  return "Nothing in the world looks like this already.";
}

/**
 * Whether observations a check was based on have since moved (§5.7).
 *
 * Stale checks do not erase a proposition; wrap-up revalidates before anything is written.
 */
export function checksAreStale(
  checks: CandidateChecks,
  current: {
    canonRevision: number;
    versionOf: (ref: WorldChatEntityRef) => number | null;
    artDirectionLook?: CurrentLook;
  },
): boolean {
  if (checks.basedOnCanonRevision !== current.canonRevision) return true;
  if (lookHasMoved(checks, current.artDirectionLook)) return true;
  return checks.consulted.some((c) => current.versionOf(c.ref) !== c.observedVersion);
}
