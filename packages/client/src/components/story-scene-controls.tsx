import { useState } from "react";
import { orderedShots, exploreStory, RoutingSchema, type Routing, type SceneRecord, type StoryPresentation, type StoryEnding } from "@arke-studio/contracts";
import { PageSheet } from "./page-sheet.js";
import { Button, Input, Select, Textarea } from "./ui.js";
import { StoryCondition, StoryRuleSummary, useStorySave, StorySaveStatus } from "./story-controls.js";

export function StorySceneDialog({ routing, scene, blockId, onClose, onSave, inline = false }: { routing: Routing; scene: SceneRecord; blockId?: string; onClose: () => void; onSave: (value: StoryPresentation, baseVersion: number) => void; inline?: boolean }) {
  const [value, setValue] = useState<StoryPresentation>(routing.presentation?.find(p => p.sceneId === scene.id) ?? { sceneId: scene.id, blocks: [], shots: [] });
  const [review, setReview] = useState(false);
  const save = useStorySave(routing, JSON.stringify(routing.presentation?.find(p => p.sceneId === scene.id)) === JSON.stringify(value), onClose, () => setValue(routing.presentation?.find(p => p.sceneId === scene.id) ?? { sceneId: scene.id, blocks: [], shots: [] }));
  const valid = RoutingSchema.safeParse({ ...routing, schemaVersion: 2, presentation: [...(routing.presentation ?? []).filter(p => p.sceneId !== scene.id), value] });
  const actions = <><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!valid.success || save.busy || save.stale} onClick={() => setReview(true)}>Review change</Button></>;
  const body = <>
    {value.blocks.filter(rule => !(scene.script?.blocks ?? []).some(block => block.id === rule.blockId)).map(rule => <p role="alert" key={rule.blockId}>This script block was removed: {rule.blockId}. <Button onClick={() => setValue({ ...value, blocks: value.blocks.filter(block => block.blockId !== rule.blockId) })}>Remove rule for {rule.blockId}</Button></p>)}
    {value.shots.filter(rule => !orderedShots(scene).some(shot => shot.id === rule.shotId)).map(rule => <p role="alert" key={rule.shotId}>This shot was removed: {rule.shotId}. <Button onClick={() => setValue({ ...value, shots: value.shots.filter(shot => shot.shotId !== rule.shotId) })}>Remove rule for {rule.shotId}</Button></p>)}
    <p>Conditions use facts as this scene begins. Hidden lines have no text, captions or voice. Hidden shots hide their lines too.</p>
    {(scene.script?.blocks ?? []).filter(block => !blockId || block.id === blockId).map(block => <section className="story-form-section" key={block.id}><h3>{block.kind === "dialogue" ? "Dialogue" : "Narration"}</h3><p>{block.text}</p><StoryCondition title="Show when" facts={routing.facts ?? []} value={value.blocks.find(b => b.blockId === block.id)?.when} onChange={when => setValue({ ...value, blocks: [...value.blocks.filter(b => b.blockId !== block.id), ...(when ? [{ blockId: block.id, when }] : [])] })} /></section>)}
    {!blockId && orderedShots(scene).map(shot => <section key={shot.id}><h3>Shot · {shot.id}</h3><StoryCondition facts={routing.facts ?? []} value={value.shots.find(s => s.shotId === shot.id)?.when} onChange={when => setValue({ ...value, shots: [...value.shots.filter(s => s.shotId !== shot.id), ...(when ? [{ shotId: shot.id, when }] : [])] })} /></section>)}
    <StorySaveStatus save={save} />
    {!valid.success && <p role="alert">{valid.error.issues[0]?.message}</p>}
  </>;
  const editor = inline ? <section className="bm-insp story-scene-inspector" aria-label="Dialogue rules"><header className="bm-insp__head"><b>Dialogue</b><span className="bm-spacer"/><Button variant="ghost" onClick={onClose}>Back to scene</Button></header><div className="bm-insp__body">{body}</div><footer className="story-inspector-footer">{actions}</footer></section> : <PageSheet open title="Show when" subtitle={scene.title} onClose={onClose} dismissOnBackdrop={false} className="story-dialog" footer={actions}>{body}</PageSheet>;
  return <>{editor}{review && <PageSheet open title="Keep this story rule?" subtitle={scene.title} onClose={() => setReview(false)} className="story-dialog" dismissOnBackdrop={false} footer={<><Button onClick={() => setReview(false)}>Back</Button><Button variant="primary" disabled={!valid.success || save.busy || save.stale} onClick={() => save.submit(version => onSave(value,version))}>Keep change</Button></>}><p>Hidden lines skip their text, caption and voice together.</p>{(scene.script?.blocks ?? []).filter(block => value.blocks.some(rule => rule.blockId === block.id) || block.id === blockId).map(block => <section key={block.id}><p>{block.text}</p><StoryRuleSummary title="Show when" routing={routing} when={value.blocks.find(rule => rule.blockId === block.id)?.when}/></section>)}{value.shots.map(rule => <section key={rule.shotId}><h3>Shot {orderedShots(scene).findIndex(shot => shot.id === rule.shotId)+1}</h3><StoryRuleSummary title="Show when" routing={routing} when={rule.when}/></section>)}{!value.blocks.length && !value.shots.length && <p>No presentation conditions. Every line and shot is shown.</p>}<StorySaveStatus save={save}/></PageSheet>}</>;
}

export function StoryEndingDialog({ routing, sceneId, onClose, onSave }: { routing: Routing; sceneId: string; onClose: () => void; onSave: (variants: StoryEnding[], baseVersion: number) => void }) {
  const ending = routing.endings.find(e => e.sceneId === sceneId);
  const [initial] = useState(ending);
  const [variants, setVariants] = useState<StoryEnding[]>(() => initial?.variants ?? [{ id: "fallback", title: initial?.title ?? "Ending", text: "", fallback: true }]);
  const update = (at: number, variant: StoryEnding) => setVariants(variants.map((v, i) => i === at ? variant : v));
  const save = useStorySave(routing, !!ending && JSON.stringify(ending.variants) === JSON.stringify(variants), onClose, () => { if (ending) setVariants(ending.variants ?? [{ id: "fallback", title: ending.title, text: "", fallback: true }]); });
  const checked = RoutingSchema.safeParse({ ...routing, schemaVersion: 2, endings: routing.endings.map(e => e.sceneId === sceneId ? { ...e, variants } : e) });
  return <PageSheet open title="Ending variants" subtitle="Each reachable state must select one ending, or one fallback." onClose={onClose} dismissOnBackdrop={false} className="story-dialog" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ending || !checked.success || save.busy || save.stale} onClick={() => save.submit(version => onSave(variants, version))}>Save endings</Button></>}>
    {!ending && <p role="alert">This scene is no longer an ending. Your draft is retained, but cannot be saved while the ending is removed.</p>}
    {variants.map((variant, index) => <fieldset className="story-fact" key={variant.id}><legend>{"fallback" in variant ? "Fallback" : "Conditional ending"}</legend><label className="story-field">Title<Input aria-label={`Ending title ${index + 1}`} value={variant.title} onChange={e => update(index, { ...variant, title: e.target.value })} /></label><label className="story-field">Ending text<Textarea aria-label={`Ending text ${index + 1}`} value={variant.text} onChange={e => update(index, { ...variant, text: e.target.value })} /></label>{"when" in variant && <StoryCondition facts={routing.facts ?? []} value={variant.when} onChange={when => { if (when) update(index, { ...variant, when }); }} />}<Button onClick={() => setVariants(variants.filter((_, i) => i !== index))}>Remove variant</Button></fieldset>)}
    <Button disabled={!routing.facts?.length} onClick={() => { const fact = routing.facts![0]!; let id = "ending-" + (variants.length + 1); for (let n = variants.length + 2; variants.some(v => v.id === id); n++) id = "ending-" + n; setVariants([...variants, { id, title: "New ending", text: "", when: { op: "eq", fact: fact.id, value: fact.default } }]); }}>Add conditional ending</Button>
    <Button disabled={variants.some(v => "fallback" in v)} onClick={() => setVariants([...variants, { id: "fallback", title: ending?.title ?? initial?.title ?? "Ending", text: "", fallback: true }])}>Add fallback</Button>
    {ending && <StorySaveStatus save={save} />}
    {!checked.success && <p role="alert">{checked.error.issues[0]?.message}</p>}
  </PageSheet>;
}

/** A later scene can be previewed only with a real, explicitly selected witness route. */
export function StoryPreviewStart({ routing, sceneId, onClose, onStart }: { routing: Routing; sceneId: string; onClose: () => void; onStart: (prefix: string[]) => void }) {
  const graph = exploreStory(routing);
  const points = graph.points.filter(p => p.sceneId === sceneId);
  const [index, setIndex] = useState(0);
  const point = points[index];
  return <PageSheet open title="Preview from here" subtitle="Choose a reachable route into this scene." onClose={onClose} className="story-dialog" footer={<><Button onClick={onClose}>Cancel</Button><Button disabled={!point} variant="primary" onClick={() => point && onStart(point.prefix)}>Preview this route</Button></>}>
    <Select label="Route into scene" value={String(index)} onChange={e => setIndex(Number(e.target.value))}>{points.map((p, i) => <option key={i} value={i}>{p.prefix.map(id => routing.choices.find(c => c.id === id)?.label ?? id).join(" → ") || "Start"}</option>)}</Select>
    {point ? (routing.facts ?? []).map(fact => <p key={fact.id}>{fact.label}: <b>{String(point.state[fact.id])}</b></p>) : <p role="alert">No reachable route enters this scene. Repair its choices or preview from the start.</p>}
    {!graph.complete && <p role="alert">Exploration is incomplete; these are the routes found so far.</p>}
  </PageSheet>;
}
