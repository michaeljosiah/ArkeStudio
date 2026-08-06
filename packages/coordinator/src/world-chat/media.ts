import type { Proposal, WorldBundle, WorldChangeCandidate } from "@arke-studio/contracts";

/**
 * Taking an image idea to the place that can make it (#70 §14).
 *
 * A conversation can notice that something wants a picture. It cannot make one, and it cannot ask
 * the queue for one either: World Chat never sends a queue command. What it can do is carry the
 * brief to the screen that already knows how to generate — where the routed model, the estimate
 * and the Generate button live, and where a person presses it.
 *
 * That boundary is the point. Generation spends money and writes files; a conversation that could
 * trigger it would be a way to spend somebody's money by talking, with no screen in between
 * showing what it would cost.
 */

export type MediaRoute =
  | { kind: "route"; path: string }
  | { kind: "invalid"; reason: string };

/**
 * Where an idea goes (§14.1).
 *
 * Only three combinations are valid, and each maps to a workflow that already exists. There is
 * deliberately no generic "replace this image" destination: replacing an image without saying
 * which image, by which workflow, is how generated media ends up somewhere nobody expected.
 */
export function routeFor(candidate: WorldChangeCandidate, worldId: string): MediaRoute {
  if (candidate.classification !== "media.image-opportunity") {
    return { kind: "invalid", reason: "this is not an image idea" };
  }
  const draft = candidate.draft as {
    target: { kind: string; sheetId?: string; sheetKind?: string };
    purpose: "world-key-art" | "character-main-photo" | "character-look";
  };

  if (draft.purpose === "world-key-art") {
    return draft.target.kind === "world"
      ? { kind: "route", path: `/w/${worldId}` }
      : { kind: "invalid", reason: "key art belongs to the world, not to one entity" };
  }

  if (draft.target.kind !== "sheet" || draft.target.sheetKind !== "character") {
    return { kind: "invalid", reason: "this needs a character to be about" };
  }
  const slug = draft.target.sheetId!;
  return draft.purpose === "character-main-photo"
    ? { kind: "route", path: `/w/${worldId}/cast/${slug}/main-photo` }
    : { kind: "route", path: `/w/${worldId}/cast/${slug}/looks` };
}

export interface BlockingDependency {
  /** The proposal that has not been decided yet, when it is one. */
  proposalId?: string;
  /** What the reviewer is waiting on, in their own terms. */
  summary: string;
}

/**
 * Whether everything this idea depends on has actually landed (§14.2).
 *
 * The rule is strict on purpose: every dependency must be *accepted*, not merely proposed. A
 * picture generated from a character who exists only in a proposal is orphaned the moment that
 * proposal is discarded — an image of somebody the world never had, sitting in the artifacts with
 * nothing to attach it to.
 *
 * The alternative was proposal-aware prompt assembly and staged provenance, which is a large
 * amount of machinery to make a picture slightly sooner.
 */
export function blockingDependencies(
  candidate: WorldChangeCandidate,
  bundle: WorldBundle,
  staged: readonly Proposal[],
): BlockingDependency[] {
  if (candidate.classification !== "media.image-opportunity") return [];
  const draft = candidate.draft as {
    target: { kind: string; sheetId?: string };
    dependencies: Array<{ candidateId?: string; proposalId?: string }>;
  };

  const blocking: BlockingDependency[] = [];

  for (const dependency of draft.dependencies) {
    if (dependency.proposalId) {
      const proposal = staged.find((p) => p.id === dependency.proposalId);
      // Still staged means still undecided: a proposal that had been accepted would be gone
      // from the staged set and its changes in the world.
      if (proposal) {
        blocking.push({ proposalId: proposal.id, summary: proposal.summary });
      }
      continue;
    }
    // A pending-entity reference names a proposition, not a proposal. It cannot have landed
    // unless wrap-up carried it and somebody accepted what it became.
    if (dependency.candidateId) {
      blocking.push({ summary: "something from this conversation that has not been accepted yet" });
    }
  }

  // The target itself is a dependency, and the commonest one to be missing: an idea about a
  // character proposed in the same conversation cannot be generated until that character exists.
  if (draft.target.kind === "sheet" && draft.target.sheetId) {
    const exists = bundle.sheets.some((s) => s.id === draft.target.sheetId && s.retired !== true);
    if (!exists) {
      const pending = staged.find((p) =>
        p.targets.some((t) => t.path.endsWith(`/${draft.target.sheetId}.md`)),
      );
      blocking.push(
        pending
          ? { proposalId: pending.id, summary: pending.summary }
          : { summary: "the character this is about is not in the world" },
      );
    }
  }

  return blocking;
}

/**
 * What the card says when Generate is not available.
 *
 * It names the proposal rather than saying "dependencies unmet", because the reviewer's next
 * action is to go and decide that proposal, and they need to know which one.
 */
export function explainBlocked(blocking: readonly BlockingDependency[]): string {
  if (blocking.length === 0) return "";
  if (blocking.length === 1) {
    return `Waiting on ${blocking[0]!.summary}. Accept it and this can be generated.`;
  }
  return `Waiting on ${blocking.length} changes that have not been accepted yet, including ${blocking[0]!.summary}.`;
}
