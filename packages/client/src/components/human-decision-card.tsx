import { useMemo, useState } from "react";
import { orderedShots, productionFrameRate, timelineSourceFingerprint, type HumanDecisionCard,
  type HumanDecisionControl, type ProductionBundle, type SceneRecord, type WorldBundle } from "@arke-studio/contracts";
import { decideEditorRequest, send, useStore } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { editorTimeline } from "../lib/editor-timeline.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { EditorRequestCards } from "../screens/editor-requests.js";
import { exportViewFor } from "../screens/editor-export.js";
import { PlanGateControls } from "../screens/scene-workspace/plans.js";
import { SceneStage } from "../screens/scene-workspace/stage.js";
import { SelectionProvider } from "../screens/scene-workspace/selection.js";
import { useSceneWriter } from "../screens/scene-workspace/scene-writer.js";
import { VoiceSampleFlow } from "./character-voice-sample.js";
import { ExtractionReviewCandidates } from "./extraction-review.js";
import { OnYourPC } from "./on-your-pc.js";
import { Button } from "./ui.js";

/** These controls send the person's existing command; they never approve a model action. */
export function HumanDecisionCardView({ card }: { card: HumanDecisionCard }) {
  const { state } = useStore();
  const world = state?.world;
  if (!world || world.meta.worldId !== card.worldId) return null;
  const control = card.body.control;
  let content: React.ReactNode = null;
  switch (control.kind) {
    case "plan": content = <div className="fy-actioncard__actions"><PlanGateControls worldId={card.worldId} control={control} /></div>; break;
    case "proposal": {
      const staged = world.proposals.find(value => value.proposal.id === control.proposalId);
      if (staged) content = <ConnectedProposalPanel staged={staged} accept={card.status === "blocked" ? { blocked: card.detail ?? "Complete the preceding action first." } : undefined} />;
      break;
    }
    case "editor-request": {
      const production = world.productions.find(value => value.meta.id === control.productionId);
      if (production) content = <ThreadEditorRequest world={world} production={production} requestId={control.requestId} blocked={card.status === "blocked"} />;
      break;
    }
    case "extraction": {
      const artifact = world.artifacts.find(value => value.id === control.artifactId);
      if (artifact) content = <ExtractionReviewCandidates worldId={card.worldId} artifact={artifact} />;
      break;
    }
    case "voice-sample": {
      const sheet = world.sheets.find(value => value.id === control.review.sheetId);
      if (sheet) content = <VoiceSampleFlow key={control.review.operationId} world={world} sheet={sheet} initialReview={control.review} inline onClose={() => {}} />;
      break;
    }
    case "stage-host": case "stage-review": {
      const target = control.kind === "stage-review" ? control.review : control;
      const production = world.productions.find(value => value.meta.id === target.productionId);
      const scene = production?.scenes.find(value => value.id === target.sceneId);
      if (isRemoteSession()) content = <OnYourPC>render and review the Stage</OnYourPC>;
      else if (production && scene && orderedShots(scene).some(shot => shot.id === target.shotId)) {
        content = <ThreadStage world={world} production={production} scene={scene} control={control} conversationId={card.conversationId} />;
      }
      if (control.kind === "stage-review" && card.status === "blocked") content = <>{content}<Button variant="ghost"
        onClick={() => send({ kind: "stage-review-discard", worldId: card.worldId, reviewId: control.review.id })}>Discard draft</Button></>;
      break;
    }
  }
  return <article className="fy-actioncard" data-family="human-decision" data-status={card.status} data-decision={card.id} aria-label={card.title}>
    <header className="fy-actioncard__head"><div><span className="fy-actioncard__reason">{card.body.reason}</span><h3>{card.title}</h3></div></header>
    {card.detail && <p role="status">{card.detail}</p>}
    <div className="fy-actioncard__body">{content}</div>
  </article>;
}

function ThreadStage({ world, production, scene, control, conversationId }: {
  world: WorldBundle; production: ProductionBundle; scene: SceneRecord;
  control: Extract<HumanDecisionControl, { kind: "stage-host" | "stage-review" }>; conversationId: string;
}) {
  const writer = useSceneWriter(world, production, scene);
  const target = control.kind === "stage-review" ? control.review : control;
  const selection = useMemo(() => ({ subject: { kind: "shot" as const, shotId: target.shotId }, select: () => {} }), [target.shotId]);
  return <SelectionProvider value={selection}><SceneStage world={world} production={production} scene={writer.workingScene}
    aspect={production.meta.aspect ?? "16:9"} sceneFile={writer.sceneFile} locked={writer.locked} generatorPending={false}
    refusalVersion={writer.refusalVersion} onCommand={writer.write} head={false}
    {...(control.kind === "stage-review" ? { review: control.review } : control.mode === "construct"
      ? { constructionRequest: { actionId: control.actionId, conversationId, shotId: control.shotId, instruction: control.instruction ?? "", preserve: control.preserve ?? "none" } }
      : { playblastRequest: { actionId: control.actionId, conversationId, shotId: control.shotId } })} />
  </SelectionProvider>;
}

function ThreadEditorRequest({ world, production, requestId, blocked }: {
  world: WorldBundle; production: ProductionBundle; requestId: string; blocked: boolean;
}) {
  const [ghostId, setGhostId] = useState<string | null>(null);
  const state = production.timeline ?? { status: "absent" as const };
  let base = null, error = false;
  try { base = editorTimeline(production, state, world.artifacts).timeline; } catch { error = true; }
  const view = exportViewFor(world, production);
  const duration = view.kind === "spine" ? view.cut.trackDurationSec : view.kind === "silent" ? view.durationSec : null;
  return <EditorRequestCards requests={production.editorRequests.filter(value => value.id === requestId)} base={base} timelineState={state}
    currentFingerprint={timelineSourceFingerprint(production, duration)} frameRate={productionFrameRate(production.meta)}
    ghostId={ghostId} onGhost={setGhostId} onDecide={(id, decision) => decideEditorRequest(world.meta.worldId, production.meta.id, id, decision)}
    disabled={blocked || error} />;
}
