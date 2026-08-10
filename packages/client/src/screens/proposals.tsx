import { useState } from "react";
import { useParams } from "react-router";
import type { StagedProposal } from "@arke-studio/contracts";
import { EmptyState } from "../components/layout.js";
import { Button, cx } from "../components/ui.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { acceptProposal } from "../lib/store.js";
import { explainNotCarried } from "../lib/not-carried.js";

/**
 * Every proposal waiting on a decision, in one place.
 *
 * Until now the only way to reach one was the world hub's "Needs you" section, which stacked the
 * full panels inline and had no room for the list beside them. Proposals arrive from several
 * places — a form, the studio, art direction, an import — and the thing you want first is which
 * ones are waiting, not the first one's ripple preview.
 *
 * The gate itself is untouched: ConnectedProposalPanel still owns accept, discard, rebase and
 * conflict resolution. This is a way in, not a second implementation of the decision.
 *
 * The design frame for this screen had no world nav, on the reasoning that proposals is not a nav
 * destination. It wears one here: WorldLayout owns the chrome for every world screen, and dropping
 * the nav would mean opting out of the layout and drawing a second one. Being able to leave for
 * canon or the cast from here is worth more than the frame's tidiness.
 */

/** Where a draft came from, in words. `source` is free text like "chat:studio" or "form". */
function originOf(proposal: StagedProposal["proposal"]): string {
  const source = proposal.source;
  if (source.startsWith("chat:")) return "From the studio";
  if (source.startsWith("import")) return "Imported";
  switch (source) {
    case "form":
    case "editor":
      return "Written by hand";
    case "ask":
    case "candidate":
      return "From a question";
    case "generated":
      return "Generated";
    case "promotion":
      return "Promoted";
    case "external-edit":
      return "Edited outside the app";
    default:
      return "Other";
  }
}

/** How many files a proposal would write, which is the honest measure of its size. */
function changeCount(staged: StagedProposal): number {
  return staged.proposal.targets.length;
}

export function ProposalsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  if (!world) return null;

  const proposals = world.proposals;
  const selected = proposals.find((p) => p.proposal.id === selectedId) ?? proposals[0] ?? null;
  const changes = proposals.reduce((total, p) => total + changeCount(p), 0);
  const entities = new Set(proposals.flatMap((p) => p.proposal.targets.map((t) => t.path))).size;

  // Grouped by where they came from, in first-seen order so the list does not reshuffle as
  // proposals resolve.
  /**
   * Accepting several at once is only safe when each would have been safe alone.
   *
   * So this refuses on the same grounds a single accept would: anything stale, conflicted,
   * awaiting review after a rebase, or carrying a question nobody has answered. The reason is
   * shown rather than the button simply being dead.
   */
  const blockingAcceptAll = ((): string | null => {
    const pending = proposals.find((p) => p.proposal.pendingReview);
    if (pending) return "One of these was rebased and needs a look first.";
    const conflicted = proposals.find((p) =>
      (p.proposal.conflicts ?? []).some((c) => c.resolution === undefined),
    );
    if (conflicted) return "One of these has a conflict to resolve first.";
    const unanswered = proposals.find((p) => (p.proposal.openChoices ?? []).length > 0);
    if (unanswered) return "One of these is still asking a question.";
    return null;
  })();

  /** What the conversations behind these proposals could not carry (R-27d). */
  const notCarried = world.conversations.flatMap((c) => c.notCarried ?? []);

  const groups: Array<{ origin: string; items: StagedProposal[] }> = [];
  for (const staged of proposals) {
    const origin = originOf(staged.proposal);
    const group = groups.find((g) => g.origin === origin);
    if (group) group.items.push(staged);
    else groups.push({ origin, items: [staged] });
  }

  return (
    <div data-screen="proposals">
      {proposals.length === 0 ? (
        <EmptyState
          title="Nothing is waiting"
          hint="A conversation writes what you save from its own rail, so most changes never come through here. What lands on this screen is a change that could not be decided by a press — one asking a question only you can answer — and anything written by hand."
        />
      ) : (
        <div className="fy-proposals">
          <div className="fy-proposals__head">
            <span className="fy-proposals__count">{proposals.length} waiting</span>
            <span className="fy-proposals__meta">
              {changes} change{changes === 1 ? "" : "s"} across {entities} entit
              {entities === 1 ? "y" : "ies"}
            </span>
            <Button
              variant="primary"
              disabled={blockingAcceptAll !== null}
              title={blockingAcceptAll ?? undefined}
              onClick={() => {
                for (const staged of proposals) acceptProposal(worldId!, staged.proposal.id);
              }}
            >
              Accept all {proposals.length}
            </Button>
          </div>
          {notCarried.length > 0 && (
            <div className="fy-proposals__note">
              {notCarried.map((n) => (
                <div key={n.candidateId}>
                  One point did not come with them — <strong>{n.summary}</strong>. {explainNotCarried(n.reason)}.
                </div>
              ))}
            </div>
          )}
          <div className="fy-proposals__body">
            <nav className="fy-proposals__list" aria-label="Proposals waiting">
              {groups.map((group) => (
                <div key={group.origin} className="fy-proposals__group">
                  <div className="fy-proposals__origin">{group.origin}</div>
                  {group.items.map((staged) => {
                    const on = staged.proposal.id === selected?.proposal.id;
                    return (
                      <button
                        key={staged.proposal.id}
                        type="button"
                        className={cx("fy-proposals__item", on && "fy-proposals__item--on")}
                        aria-current={on ? "true" : undefined}
                        onClick={() => setSelectedId(staged.proposal.id)}
                      >
                        <span className="fy-proposals__summary">{staged.proposal.summary}</span>
                        <span className="fy-proposals__sub">
                          {changeCount(staged)} change{changeCount(staged) === 1 ? "" : "s"}
                          {staged.proposal.pendingReview ? " · rebased, review" : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </nav>
            <div className="fy-proposals__detail">
              {selected && <ConnectedProposalPanel key={selected.proposal.id} staged={selected} />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
