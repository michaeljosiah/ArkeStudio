import { useEffect, useState } from "react";
import type { StagedProposal } from "@arke-studio/contracts";
import { Badge, Button } from "../components/ui.js";
import {
  acceptProposal,
  cancelAuthoring,
  continueStudio,
  discardProposal,
  markProposalSeen,
  rebaseProposal,
  resolveProposalConflict,
  resolveProposalChoice,
  subscribeProposalResolutions,
  useAuthoring,
  useGateNotices,
  sendProposalBack,
  useWorld,
} from "../lib/store.js";
import { ProposalPanel } from "./domain.js";

/** ProposalPanel wired to the live gate (SPEC-004) plus authoring activity (SPEC-005). */
export function ConnectedProposalPanel({
  staged,
  onAccepted,
  conversationPath,
}: {
  staged: StagedProposal;
  /** Called only after the coordinator reports that this proposal actually landed. */
  onAccepted?: () => void;
  /** A proposal-backed Studio conversation that can keep revising this same draft. */
  conversationPath?: string;
}) {
  const world = useWorld();
  const notices = useGateNotices();
  const authoring = useAuthoring();
  const id = staged.proposal.id;
  const [instruction, setInstruction] = useState("");
  useEffect(
    () =>
      subscribeProposalResolutions((resolution) => {
        if (resolution.proposalId === id && resolution.outcome === "accepted") onAccepted?.();
      }),
    [id, onAccepted],
  );
  if (!world) return null;
  const worldId = world.meta.worldId;
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
      {conversationPath !== undefined && (
        <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "flex-end" }}>
          <label style={{ display: "grid", gap: 4, flex: 1 }}>
            <span className="fy-mono">Keep shaping this draft</span>
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.currentTarget.value)}
              placeholder="Tell the studio what to revise…"
              rows={2}
              disabled={running}
            />
          </label>
          <Button
            variant="outline"
            disabled={running || instruction.trim().length === 0}
            onClick={() => {
              const next = instruction.trim();
              if (!next) return;
              continueStudio(worldId, conversationPath, id, next);
              setInstruction("");
            }}
          >
            Revise
          </Button>
        </div>
      )}
    </div>
  );
}
