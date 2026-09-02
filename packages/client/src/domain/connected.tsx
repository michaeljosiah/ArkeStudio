import type { StagedProposal } from "@arke-studio/contracts";
import { Badge, Button } from "../components/ui.js";
import {
  acceptProposal,
  cancelAuthoring,
  discardProposal,
  markProposalSeen,
  rebaseProposal,
  resolveProposalConflict,
  resolveProposalChoice,
  useAuthoring,
  useGateNotices,
  sendProposalBack,
  useWorld,
} from "../lib/store.js";
import { ProposalPanel } from "./domain.js";

/** ProposalPanel wired to the live gate (SPEC-004) plus authoring activity (SPEC-005). */
export function ConnectedProposalPanel({ staged }: { staged: StagedProposal }) {
  const world = useWorld();
  const notices = useGateNotices();
  const authoring = useAuthoring();
  if (!world) return null;
  const worldId = world.meta.worldId;
  const id = staged.proposal.id;
  const activity = authoring[id];
  const running = activity?.status === "running";
  return (
    <div style={{ display: "grid", gap: "var(--space-2)" }}>
      {activity && (
        <div className="dom-authoring" role="log">
          <div className="dom-authoring__head">
            <Badge tone={running ? "neutral" : activity.status === "completed" ? "success" : "warning"}>
              {running ? "studio is drafting…" : `drafting ${activity.status}`}
            </Badge>
            {activity.detail && <span className="dom-authoring__detail">{activity.detail}</span>}
            {running && (
              <Button variant="ghost" onClick={() => cancelAuthoring(worldId, id)}>
                Cancel
              </Button>
            )}
          </div>
          {activity.lines.length > 0 && (
            <ul className="dom-authoring__lines">
              {activity.lines.map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ProposalPanel
        staged={staged}
        notice={notices[id]}
        onAccept={running ? undefined : (confirmSignature) => acceptProposal(worldId, id, confirmSignature)}
        onDiscard={running ? undefined : () => discardProposal(worldId, id)}
        {...(!running && (staged.proposal.worldChatOrigins ?? []).length > 0
          ? { onSendBack: () => sendProposalBack(worldId, id) }
          : {})}
        onRebase={() => rebaseProposal(worldId, id)}
        onResolve={(path, field, choice) => resolveProposalConflict(worldId, id, path, field, choice)}
        onResolveChoice={
          running
            ? undefined
            : (choiceId, optionId) =>
                resolveProposalChoice(worldId, id, choiceId, optionId, staged.proposal.draftRevision)
        }
        onMarkSeen={() => markProposalSeen(worldId, id)}
        disabledReason={running ? "the studio is still drafting — cancel first if you need to act now" : undefined}
      />
    </div>
  );
}
