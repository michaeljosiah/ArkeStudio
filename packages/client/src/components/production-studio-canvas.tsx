import { orderedShots, sortScenes, productionShape, type ConversationActionCard, type ProductionBundle, type WorldBundle } from "@arke-studio/contracts";
import type { StudioFocus } from "../lib/production-studio.js";
import { editorTimeline } from "../lib/editor-timeline.js";
import { ProductionCardBody, type ProductionCardContext } from "./production-card-body.js";
import { ProductionTimelineCard } from "./production-timeline-card.js";
import { ConversationFrameRunCard } from "./conversation-frame-run-card.js";
import { GenerationReferences, GenerationResults } from "./generation-card-body.js";
import { TakeMediaFigure } from "./take-comparison-card.js";

export function ProductionStudioCanvas({ world, production, focus, actions, onFocus }: {
  world: WorldBundle; production?: ProductionBundle; focus: StudioFocus; actions: readonly ConversationActionCard[]; onFocus(focus: StudioFocus): void;
}) {
  const action = actions.find(a => a.actionId === focus.actionId && a.worldId === world.meta.worldId && a.productionId === production?.meta.id);
  const pending = action?.status === "pending";
  if (pending && action.shown.productionPreview) return <section data-pending-preview aria-label="Pending canvas preview"><p>Pending preview · {action.shown.title}</p>
    <ProductionCardBody action={action} preview={action.shown.productionPreview} /></section>;
  if (action?.shown.body.family === "generation") return <section aria-label="Shot generation canvas">
    <GenerationReferences action={action} /><GenerationResults action={action} /><ConversationFrameRunCard action={action} /></section>;
  if (!production) return <p>The production will appear here when it is created.</p>;
  const scene = production.scenes.find(s => s.id === focus.sceneId) ?? production.scenes.find(s => orderedShots(s).some(shot => shot.id === focus.shotId));
  // Display context cannot decide or prepare an action. Native preview components only read it.
  const context: ProductionCardContext = { worldId: world.meta.worldId, productionId: production.meta.id,
    actionKind: focus.view === "stage" ? "world-chat-production-stage-construct" : focus.view === "board" ? "world-chat-production-board-compile" : "world-chat-production-scene-command",
    authority: { kind: "scene-store", id: scene?.id ?? production.meta.id }, targets: focus.shotId ? [{ kind: "shot", id: focus.shotId }] : [],
    shown: { title: "Current production", consequence: "", affectedTargets: [], ripples: [], permissionReason: "authored-change",
      body: { family: "command", commands: [], expectedResult: "", undoAvailable: false } } };
  if (focus.view === "cut") {
    let timeline = null;
    try { timeline = editorTimeline(production, production.timeline ?? { status: "absent" }, world.artifacts).timeline; } catch { /* The native cut can have unavailable sources. */ }
    return timeline ? <ProductionTimelineCard action={context} comparison={false} preview={{ kind: "timeline", before: timeline, after: timeline,
      beforeSelections: production.selections, afterSelections: production.selections, range: null }} /> : <p>No cut assembled yet.</p>;
  }
  if (focus.view === "shot" && scene) {
    const shot = orderedShots(scene).find(s => s.id === focus.shotId);
    if (!shot) return <p>This shot is no longer in the production.</p>;
    const selection = production.selections[shot.id];
    const selected = selection?.acceptedTakeId ?? selection?.startFrameTakeId ?? selection?.startFrameArtifactId ?? null;
    return <section aria-label="Current shot takes"><h2>{shot.number}. {shot.title}</h2><p>{shot.description}</p>
      <div className="fy-generation-card__grid"><TakeMediaFigure world={world} production={production} id={selected} label="Current selection" />
        {production.takes.filter(t => t.coversShots.includes(shot.id) && !t.boardSheetParent && t.id !== selected).map(t =>
          <TakeMediaFigure key={t.id} world={world} production={production} id={t.id} label={`Candidate · ${t.kind}`} />)}</div>
    </section>;
  }
  if (scene && ["scene", "board", "stage"].includes(focus.view)) return <ProductionCardBody action={context} preview={{ kind: "scene", before: scene, after: scene }} onSelectShot={id => onFocus({view:"shot",sceneId:scene.id,shotId:id})} />;
  return <section aria-label="Current production outline"><h2>{production.meta.title}</h2>
    <p>{productionShape(production.meta).medium} · {production.meta.aspect ?? "World aspect"}</p>
    {production.story && <p>{production.story.logline}</p>}
    {production.episodes.map(episode => <section key={episode.id}><h3>{episode.order}. {episode.title}</h3>
      <ul>{episode.scenes.map(id => production.scenes.find(s => s.id === id)).filter(s => !!s).map(s => <li key={s.id}>
        <button type="button" onClick={() => onFocus({ view: "scene", sceneId: s.id })}>{s.title} · {orderedShots(s).length} shots</button></li>)}</ul></section>)}
    <ul>{sortScenes(production.scenes).map(s => <li key={s.id}><button type="button" onClick={() => onFocus({ view: "scene", sceneId: s.id })}>
      {s.number}. {s.title} · {orderedShots(s).length} shots</button></li>)}</ul>
  </section>;
}
