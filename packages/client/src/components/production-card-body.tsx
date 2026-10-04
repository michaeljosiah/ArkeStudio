import { useMemo } from "react";
import { effectiveFraming, resolveCast, orderedShots, shotChanges, type ProductionCardPreview, type ConversationActionCard } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { StoryboardRows } from "../screens/scene-workspace/rows.js";
import { boardsForScene } from "../screens/scene-workspace/boards.js";
import { SceneStage } from "../screens/scene-workspace/stage.js";
import { SelectionProvider } from "../screens/scene-workspace/selection.js";
import { Portrait, characterPortraitPath, locationPortraitPath } from "./portrait.js";
import { ProductionTimelineCard } from "./production-timeline-card.js";
import { ProductionExportCard } from "./production-export-card.js";

export type ProductionCardContext = Pick<ConversationActionCard, "worldId" | "productionId" | "actionKind" | "targets" | "shown" | "authority" | "exportState">;

const EMPTY = new Set<string>();
const nothing = () => {};
/** The native surfaces consume a frozen scene. Their write controls remain locked in a preview. */
export function ProductionCardBody({ preview, action, onSelectShot }: { preview: ProductionCardPreview; action: ProductionCardContext; onSelectShot?: (id: string) => void }) {
  const world = useStore().state?.world;
  const production = world?.meta.worldId === action.worldId ? world.productions.find(p => p.meta.id === action.productionId) : undefined;
  const changes = useMemo(() => preview.kind === "scene" ? shotChanges(preview.before, preview.after) : null, [preview]);
  const marks = useMemo(() => new Map(changes?.shots.map(row => [row.shot.id, [row.inserted ? "Inserted" : "", row.moved ? `Moved ↑ ${row.from} → ${row.shot.number}` : "", row.changed ? "Changed" : ""].filter(Boolean).join(" · ")]) ?? []), [changes]);
  const newShots = useMemo(() => new Set(changes?.shots.filter(row => row.inserted).map(row => row.shot.id) ?? []), [changes]);
  const reviewShots = useMemo(() => preview.kind === "scene" ? new Map(orderedShots(preview.after).map(shot => [shot.id, {
    framing: Object.values(effectiveFraming(preview.after, shot)).filter(Boolean).join(" · "),
    cast: world ? resolveCast(shot.description, world.sheets).cast.filter(entry => entry.sheet.type === "character").map(entry => entry.sheet.name) : [],
  }])) : undefined, [preview, world]);
  if (preview.kind === "production") return <div className="fy-production-preview" aria-label="Resulting production">
    <h4>{preview.title}</h4><dl>{[
      ["Medium", `${preview.medium} · ${preview.productionKind}`], ["Aspect", preview.aspect ?? "Not required"],
      ["Frame rate", `${preview.frameRate} fps`], ["Series", preview.series ?? "None"], ["Season", preview.season ?? "None"],
      ["Episodes", String(preview.episodes)], ["Style", preview.style ?? "World style"], ["Model", preview.model ?? "World default"],
    ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </div>;
  if (preview.kind === "timeline") return <ProductionTimelineCard preview={preview} action={action} />;
  if (preview.kind === "export") return <ProductionExportCard preview={preview} action={action} />;
  const scene = preview.after;
  const stageAction = action.actionKind === "world-chat-production-stage-construct" || action.actionKind === "world-chat-production-stage-playblast";
  const stageShot = stageAction ? orderedShots(scene).find(shot => shot.id === action.targets.find(target => target.kind === "shot")?.id) : null;
  if (stageAction) return <div className="fy-production-preview" aria-label="Stage review preview">
    <h4>{scene.title} · {stageShot?.title ?? "Shot unavailable"}</h4>
    {action.shown.body.family === "host-action" && <p>{action.shown.body.action} · {action.shown.body.effect}</p>}
    {world && production && stageShot ? <section className="fy-production-preview__stage" aria-label={`Stage preview for shot ${stageShot.number}`}>
      <SelectionProvider value={{ subject: { kind: "shot", shotId: stageShot.id }, select: nothing }}>
        <SceneStage world={world} production={production} scene={scene} aspect={production.meta.aspect ?? "16:9"}
          sceneFile={production.sceneFiles[scene.id]} locked frozenScene generatorPending={false} refusalVersion={0} onCommand={() => false} head={false} />
      </SelectionProvider>
    </section> : <p>The frozen Stage target is unavailable.</p>}
  </div>;
  const beforeBlocks = new Map(preview.before?.script?.blocks.map(block => [block.id, block]) ?? []);
  const blocks = scene.script?.blocks ?? [];
  const removedBlocks = preview.before?.script?.blocks.filter(block => !blocks.some(current => current.id === block.id)) ?? [];
  const shots = orderedShots(scene);
  const stageChanged = shots.filter(shot => shot.staging && JSON.stringify(shot.staging) !== JSON.stringify(preview.before ? orderedShots(preview.before).find(old => old.id === shot.id)?.staging : undefined));
  const castChanged = JSON.stringify(scene.cast) !== JSON.stringify(preview.before?.cast) || scene.inherits?.location !== preview.before?.inherits?.location;
  const boardChanged = JSON.stringify(scene.boards) !== JSON.stringify(preview.before?.boards) || action.actionKind === "world-chat-production-board-compile" || action.actionKind === "world-chat-production-board-export";
  const pack = world && production ? boardsForScene({ scene, production, sheets: world.sheets, artifacts: world.artifacts, capSec: 60 }) : null;
  return <div className="fy-production-preview" aria-label="Resulting scene">
    <h4>{scene.title}</h4>
    {blocks.length + removedBlocks.length > 0 && <section className="fy-production-preview__script" aria-label="Resulting screenplay">
      {blocks.map(block => {
        const old = beforeBlocks.get(block.id);
        const changed = !old || old.text !== block.text || old.kind !== block.kind || old.speaker !== block.speaker;
        return <div key={block.id} data-kind={block.kind} data-changed={changed || undefined}>
          {changed && <small>{old ? "Changed" : "Inserted"}</small>}
          {block.speaker && <strong>{world?.sheets.find(sheet => sheet.id === block.speaker)?.name ?? block.speaker}</strong>}
          {old && changed && <del>{old.text}</del>}<p>{block.text}</p>
        </div>;
      })}
      {removedBlocks.map(block => <div key={block.id} data-removed><small>Removed</small><del>{block.text}</del></div>)}
    </section>}
    {castChanged && world && <section aria-label="Cast and place" className="fy-production-preview__cast">
      {Object.keys(scene.cast ?? {}).map(id => <figure key={id}><Portrait worldSlug={world.meta.slug} path={characterPortraitPath(world, id)} label={world.sheets.find(s => s.id === id)?.name ?? id} />
        <figcaption>{world.sheets.find(s => s.id === id)?.name ?? id}{!world.referenceKits.some(kit => kit.sheetId === id) && <small>Missing kit</small>}</figcaption></figure>)}
      {scene.inherits?.location && <figure><Portrait worldSlug={world.meta.slug} path={locationPortraitPath(world, scene.inherits.location)} label={scene.inherits.location} /><figcaption>{scene.inherits.location}</figcaption></figure>}
    </section>}
    <p>{shots.length} shots · {shots.reduce((sum, shot) => sum + (shot.durationSec ?? 4), 0)}s</p>
    {world && production && pack ? <div className="fy-production-preview__rows" data-screen="scene-detail" tabIndex={0} aria-label={boardChanged ? "Resulting board grid" : "Resulting shot list"}>
      <StoryboardRows layout={boardChanged ? "grid" : "list"} scene={scene} acceptedScene={preview.before ?? scene}
        world={world} production={production} artifacts={world.artifacts} sheets={world.sheets} slug={world.meta.slug}
        digests={new Map()} aspect={production.meta.aspect ?? "16:9"} capSec={60} boardPack={pack} showBoards={boardChanged}
        stagedShotIds={EMPTY} newShotIds={newShots} stagedBoards={false} locked generatorPending={false} onCommand={() => false}
        refusalVersion={0} frameRun={null} jobs={[]} worldId={world.meta.worldId} reviewMarks={marks} reviewShots={reviewShots}
        onViewBoardSheet={nothing} onGenerateFrame={nothing} onEditShot={onSelectShot ?? nothing} onOpenShotInGenerator={nothing}
        onPreviewShot={onSelectShot ?? nothing} onTalkToArke={nothing} onPlanVideo={nothing} onRenderBoard={nothing} />
    </div> : <ol aria-label="Resulting shot list">{changes?.shots.map(row => <li key={row.shot.id}><strong>{row.shot.number}. {row.shot.title}</strong> · {row.shot.durationSec ?? 4}s · {marks.get(row.shot.id)}</li>)}</ol>}
    {changes?.removed.length ? <ol aria-label="Removed shots">{changes.removed.map(shot => <li key={shot.id} data-removed><del>{shot.number}. {shot.title}</del> · Removed</li>)}</ol> : null}
    {world && production && stageChanged.map(shot => <section key={shot.id} className="fy-production-preview__stage" aria-label={`Stage preview for shot ${shot.number}`}>
      <SelectionProvider value={{ subject: { kind: "shot", shotId: shot.id }, select: nothing }}>
        <SceneStage world={world} production={production} scene={scene} aspect={production.meta.aspect ?? "16:9"}
          sceneFile={production.sceneFiles[scene.id]} locked frozenScene generatorPending={false} refusalVersion={0} onCommand={() => false} head={false} />
      </SelectionProvider>
    </section>)}
  </div>;
}
