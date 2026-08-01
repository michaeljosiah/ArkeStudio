import type { StagedProposal } from "@arke-studio/contracts";
import {
  acceptProposal,
  discardProposal,
  markProposalSeen,
  rebaseProposal,
  resolveProposalConflict,
  useGateNotices,
  useWorld,
} from "../lib/store.js";
import { ProposalPanel } from "./domain.js";

/** ProposalPanel wired to the live gate (SPEC-004): accept, discard, rebase, resolve, seen. */
export function ConnectedProposalPanel({ staged }: { staged: StagedProposal }) {
  const world = useWorld();
  const notices = useGateNotices();
  if (!world) return null;
  const worldId = world.meta.worldId;
  const id = staged.proposal.id;
  return (
    <ProposalPanel
      staged={staged}
      notice={notices[id]}
      onAccept={(confirmSignature) => acceptProposal(worldId, id, confirmSignature)}
      onDiscard={() => discardProposal(worldId, id)}
      onRebase={() => rebaseProposal(worldId, id)}
      onResolve={(path, field, choice) => resolveProposalConflict(worldId, id, path, field, choice)}
      onMarkSeen={() => markProposalSeen(worldId, id)}
    />
  );
}
