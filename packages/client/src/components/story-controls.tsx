import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { storyFactReferences, RoutingSchema, type Routing, type Choice, type StoryPredicate, type StoryEffect, type StoryFact } from "@arke-studio/contracts";
import { choiceIdFor } from "../lib/branch-map.js";
import { subscribeCommandFailures } from "../lib/store.js";
import { PageSheet } from "./page-sheet.js";
import { Button, IconButton, Input, Select, Textarea } from "./ui.js";
import { X } from "./icons.js";

/** Replacement forms keep their draft until acknowledgement, and fence a stale authoring snapshot. */
export function useStorySave(routing: Routing, saved: boolean, onClose: () => void, reload: () => void) {
  const [baseVersion, setBaseVersion] = useState(routing.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => subscribeCommandFailures(event => {
    if (busy && event.command === "routing-command") { setBusy(false); setError(event.reason); }
  }), [busy]);
  useEffect(() => {
    if (busy && saved && routing.version > baseVersion) { setBusy(false); setBaseVersion(routing.version); onClose(); }
  }, [busy, saved, routing.version, baseVersion, onClose]);
  return { baseVersion, busy, error, stale: routing.version !== baseVersion,
    submit: (send: (version: number) => void) => { setBusy(true); setError(""); send(baseVersion); },
    review: () => { reload(); setBaseVersion(routing.version); setError(""); setBusy(false); } };
}
export function StorySaveStatus({ save }: { save: ReturnType<typeof useStorySave> }) {
  return <>{save.error && <p role="alert">{save.error}</p>}{save.stale && <p role="status">Story rules changed. Your draft is retained; loading current rules replaces this draft. <Button onClick={save.review}>Load current rules</Button></p>}</>;
}

export function FactValue({ fact, value, onChange, label }: { fact: StoryFact; value: boolean | string; onChange: (value: boolean | string) => void; label: string }) {
  const values = fact.type === "boolean" ? [true, false] : fact.values;
  return <Select label={label} value={String(value)} onChange={e => onChange(fact.type === "boolean" ? e.target.value === "true" : e.target.value)}>{values.map(v => <option key={String(v)} value={String(v)}>{String(v)}</option>)}</Select>;
}
const enumValuesFromText = (raw:string) => raw.split(",").map(value=>value.trim());

/** Closed, typed predicates: nesting represents Any/All without accepting executable text. */
function StoryConditionTree({ facts, value, onChange, depth = 1 }: { facts: StoryFact[]; value?: StoryPredicate; onChange: (next?: StoryPredicate) => void; depth?: number }) {
  const first = facts[0];
  const fresh = (): StoryPredicate => ({ op: "eq", fact: first!.id, value: first!.default });
  if (!value) return <Button disabled={!first} onClick={() => onChange(fresh())}>Add condition</Button>;
  return <div className="story-condition">
    <div className="story-rule-row"><Select label="Condition type" disabled={!first} value={value.op} onChange={e => {
      const op = e.target.value;
      onChange(op === "eq" ? fresh() : op === "not" ? { op, arg: fresh() } : { op: op as "all" | "any", args: [fresh()] });
    }}><option value="eq">Equals</option>{depth < 8 && <><option value="all">All of</option><option value="any">Any of</option><option value="not">Not</option></>}</Select>
    <Button variant="ghost" onClick={() => onChange(undefined)}>Remove condition</Button></div>
    {value.op === "eq" ? <div className="story-rule-row"><Select label="Condition fact" value={value.fact} onChange={e => { const f = facts.find(f => f.id === e.target.value)!; onChange({ op: "eq", fact: f.id, value: f.default }); }}>{facts.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>{facts.find(f => f.id === value.fact) ? <FactValue fact={facts.find(f => f.id === value.fact)!} value={value.value} label="Condition value" onChange={next => onChange({ ...value, value: next })} /> : <span role="alert">Missing fact</span>}</div>
      : value.op === "not" ? <StoryConditionTree facts={facts} value={value.arg} depth={depth + 1} onChange={arg => onChange(arg ? { op: "not", arg } : undefined)} />
      : <>{value.args.map((arg, index) => <StoryConditionTree key={index} facts={facts} value={arg} depth={depth + 1} onChange={next => { const args = value.args.flatMap((a, i) => i === index ? next ? [next] : [] : [a]); onChange(args.length ? { ...value, args } : undefined); }} />)}<Button disabled={!first || value.args.length >= 128} onClick={() => onChange({ ...value, args: [...value.args, fresh()] })}>Add condition</Button></>}
  </div>;
}

type Equality = Extract<StoryPredicate, { op: "eq" }>;
const equalityOf = (condition: StoryPredicate): Equality | undefined => condition.op === "eq" ? condition : condition.op === "not" && condition.arg.op === "eq" ? condition.arg : undefined;

/** Turn 240's ordinary rules are rows of fact / is or is not / value. Existing nested trees remain editable. */
export function StoryCondition({ facts, value, onChange, title }: { facts: StoryFact[]; value?: StoryPredicate; onChange: (next?: StoryPredicate) => void; title?: string }) {
  const rows = value === undefined ? [] : value.op === "all" || value.op === "any" ? value.args : [value];
  const simple = rows.every(row => equalityOf(row) !== undefined);
  const match = value?.op === "any" ? "any" : "all";
  const change = (next: StoryPredicate[], op: "all" | "any" = match) => onChange(next.length === 0 ? undefined : next.length === 1 && value?.op !== "all" && value?.op !== "any" ? next[0] : { op, args: next });
  const add = () => { const first = facts[0]; if (first) change([...rows, { op: "eq", fact: first.id, value: first.default }]); };
  return <div className="story-conditions">
    <div className="story-section-head">{title && <h3>{title}</h3>}<Button variant="ghost" aria-label="Add condition" disabled={!facts.length || rows.length >= 128 || !simple} onClick={add}>+ Condition</Button></div>
    {rows.length === 0 ? <p>{title === "Show when" ? "Always shown. Add a condition to limit when it appears." : "Always available. Add a condition to limit this choice."}</p> : !simple ? <StoryConditionTree facts={facts} value={value} onChange={onChange} /> : <>
      <Select label="Match conditions" value={match} onChange={e => onChange({ op: e.target.value as "all" | "any", args: rows })}><option value="all">All conditions</option><option value="any">Any condition</option></Select>
      {rows.map((row, index) => {
        const eq = equalityOf(row)!;
        const fact = facts.find(f => f.id === eq.fact);
        const replace = (next: StoryPredicate) => change(rows.map((current, at) => at === index ? next : current));
        const compare = (next: Equality): StoryPredicate => row.op === "not" ? { op: "not", arg: next } : next;
        return <div className="story-condition-row" key={index}>
          <Select label="Condition fact" value={eq.fact} disabled={!facts.length} onChange={e => { const next = facts.find(f => f.id === e.target.value); if (next) replace(compare({ op: "eq", fact: next.id, value: next.default })); }}>{!fact && <option value={eq.fact}>Missing fact</option>}{facts.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>
          <Select label="Condition comparison" disabled={!fact} value={row.op === "not" ? "not" : "eq"} onChange={e => replace(e.target.value === "not" ? { op: "not", arg: eq } : eq)}><option value="eq">is</option><option value="not">is not</option></Select>
          {fact ? <FactValue fact={fact} value={eq.value} label="Condition value" onChange={next => replace(compare({ ...eq, value: next }))} /> : <span role="alert">Missing fact</span>}
          <IconButton label={index ? `Remove condition ${index + 1}` : "Remove condition"} onClick={() => change(rows.filter((_, at) => at !== index))}><X size={14} /></IconButton>
        </div>;
      })}
    </>}
  </div>;
}

export function StoryEffects({ facts, effects, onChange }: { facts: StoryFact[]; effects: StoryEffect[]; onChange: (effects: StoryEffect[]) => void }) {
  const available = facts.filter(f => !effects.some(e => e.fact === f.id));
  return <><div className="story-section-head"><h3>Remember</h3><Button variant="ghost" aria-label="Remember a value" disabled={!available.length} onClick={() => onChange([...effects, { fact: available[0]!.id, value: available[0]!.default }])}>+ Value</Button></div>{effects.map((effect, index) => {
    const fact = facts.find(f => f.id === effect.fact);
    return <div className="story-effect-row" key={index}><Select label="Remember fact" value={effect.fact} onChange={e => { const f = facts.find(f => f.id === e.target.value)!; onChange(effects.map((v, i) => i === index ? { fact: f.id, value: f.default } : v)); }}>{!fact && <option value={effect.fact}>Missing fact</option>}{facts.filter(f => f.id === effect.fact || !effects.some(e => e.fact === f.id)).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</Select><span aria-hidden="true">→</span>{fact ? <FactValue fact={fact} value={effect.value} label="Remember value" onChange={value => onChange(effects.map((v, i) => i === index ? { ...v, value } : v))} /> : <span role="alert">Missing fact</span>}<IconButton label={`Remove remembered value ${index + 1}`} onClick={() => onChange(effects.filter((_, i) => i !== index))}><X size={14} /></IconButton></div>;
  })}<p>{effects.length ? "Set these values after this choice is taken." : "No values change. Add a value to remember a consequence."}</p></>;
}

export function ConnectorDialog({ routing, initial, editing, scenes, picking, destination, onPick, onClose, onSave, onDraft }: {
  routing: Routing; initial: Choice; editing: boolean; scenes: readonly { id: string; title: string }[]; picking: boolean; destination: string | null;
  onPick: (source: string) => void; onClose: () => void; onSave: (choice: Choice, baseVersion: number) => void; onDraft?: (choice: Choice) => void;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => { onDraft?.(draft); }, [draft, onDraft]);
  useEffect(() => { if (destination !== null) setDraft(current => ({ ...current, to: destination })); }, [destination]);
  const [chooseSource] = useState(!initial.from);
  const choice = { ...draft, id: editing ? draft.id : choiceIdFor(draft.label, routing), to: draft.to, label: draft.label.trim() };
  const facts = routing.facts ?? [];
  const save = useStorySave(routing, false, () => {}, () => setDraft(editing ? routing.choices.find(c => c.id === initial.id) ?? initial : { ...initial, label: "", effects: undefined, when: undefined }));
  const checked = RoutingSchema.safeParse({ ...routing, ...(choice.when || choice.effects?.length ? { schemaVersion: 2 } : {}), choices: editing ? routing.choices.map(c => c.id === choice.id ? choice : c) : [...routing.choices, choice] });
  const ready = checked.success && (!editing || routing.choices.some(c => c.id === initial.id)) && (editing || choice.from !== choice.to) && scenes.some(s => s.id === choice.from) && scenes.some(s => s.id === choice.to) && !routing.excluded.some(e => e.sceneId === choice.to);
  return <PageSheet returnFocus={() => (editing ? document.querySelector<HTMLElement>(`[data-walk="c:${initial.id}"]`) : null) ?? document.querySelector<HTMLElement>(`[data-scene="${initial.from}"] .bm-port`) ?? document.querySelector<HTMLElement>(`[data-walk="s:${initial.from}"]`) ?? document.querySelector<HTMLElement>(".bm-count")} open={!picking} title={editing ? "Edit connector" : "Define connector"} subtitle="Choose where this choice goes and what it remembers." onClose={onClose} dismissOnBackdrop={false} className="story-dialog story-connector" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || save.busy || save.stale} onClick={() => save.submit(version => onSave(choice, version))}>{editing ? "Save choice" : "Add choice"}</Button></>}>
    <div className="story-scene-pair">
    <label className="story-field">From scene{chooseSource ? <Select label="From scene" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })}><option value="">Choose a source scene…</option>{scenes.filter(s => !routing.excluded.some(e => e.sceneId === s.id)).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</Select> : <Input aria-label="From scene" value={scenes.find(s => s.id === draft.from)?.title ?? draft.from} readOnly />}</label>
    <label className="story-field">To scene<Select label="Destination scene" value={choice.to} onChange={e => setDraft({ ...draft, to: e.target.value })}><option value="">Choose…</option>{scenes.filter(s => (editing || s.id !== draft.from) && !routing.excluded.some(e => e.sceneId === s.id)).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</Select></label></div>
    <Button className="story-map-action" disabled={!draft.from} onClick={() => onPick(draft.from)}>Choose on map</Button>
    <label className="story-field">Choice text<Textarea aria-label="Choice text" value={draft.label} rows={2} placeholder="What the player reads" onChange={e => setDraft({ ...draft, label: e.target.value })} /></label>
    <section className="story-form-section"><StoryCondition title="Available when" facts={facts} value={draft.when} onChange={when => setDraft({ ...draft, when })} /></section>
    <section className="story-form-section"><StoryEffects facts={facts} effects={draft.effects ?? []} onChange={effects => setDraft({ ...draft, effects })} /></section>
    {!!draft.effects?.length && <p className="story-consequence">{draft.effects.map(effect => { const fact = facts.find(f => f.id === effect.fact); return `${fact?.label ?? effect.fact}: ${String(fact?.default ?? "starting value")} → ${String(effect.value)}`; }).join(" · ")}</p>}
    <p>{editing ? "Your changes are kept together when you press Save choice." : "Nothing is added until you press Add choice."}</p>
    <StorySaveStatus save={save} />
    {!checked.success && draft.label.trim() && choice.to && <p role="alert">{checked.error.issues[0]?.message}</p>}
    {!facts.length && <p>Declare Story facts on the Branch Map to add conditions and remembered values.</p>}
  </PageSheet>;
}

/** The selected edge explains and edits the same rules as the connector helper. */
export function StoryChoiceRules({ routing, choice, onSave, actionHost }: { routing: Routing; choice: Choice; onSave: (when: StoryPredicate | undefined, effects: StoryEffect[], unavailable:Choice["unavailable"], baseVersion: number) => void; actionHost?: HTMLElement | null }) {
  const [when, setWhen] = useState(choice.when);
  const [effects, setEffects] = useState(choice.effects ?? []);
  const [unavailable,setUnavailable] = useState(choice.unavailable);
  const [review, setReview] = useState(false);
  const current = routing.choices.find(c => c.id === choice.id);
  const save = useStorySave(routing, JSON.stringify(current?.when) === JSON.stringify(when) && JSON.stringify(current?.effects ?? []) === JSON.stringify(effects) && JSON.stringify(current?.unavailable) === JSON.stringify(unavailable), () => setReview(false), () => { setWhen(current?.when); setEffects(current?.effects ?? []); setUnavailable(current?.unavailable); });
  const checked = RoutingSchema.safeParse({ ...routing, schemaVersion: 2, choices: routing.choices.map(c => c.id === choice.id ? { ...c, when, effects, unavailable } : c) });
  const changed = JSON.stringify(when) !== JSON.stringify(current?.when) || JSON.stringify(effects) !== JSON.stringify(current?.effects ?? []) || JSON.stringify(unavailable) !== JSON.stringify(current?.unavailable);
  const action=<Button className="story-review-action" variant="primary" disabled={!changed || !checked.success || save.busy || save.stale || !current} onClick={() => setReview(true)}>Review change</Button>;
  return <div className="story-choice-rules">
    <section className="story-form-section"><StoryCondition title="Available when" facts={routing.facts ?? []} value={when} onChange={setWhen} /></section>
    <section className="story-form-section"><h3>If unavailable</h3><label className="story-field">In the player<Select label="If unavailable" value={unavailable ? "disabled" : "hidden"} onChange={e => setUnavailable(e.target.value === "disabled" ? {reason:""} : undefined)}><option value="hidden">Hide this choice</option><option value="disabled">Show disabled with a reason</option></Select></label>{unavailable && <label className="story-field">Reason<Textarea aria-label="Unavailable reason" maxLength={600} rows={2} value={unavailable.reason} onChange={e => setUnavailable({...unavailable,reason:e.target.value})}/></label>}</section>
    <section className="story-form-section"><StoryEffects facts={routing.facts ?? []} effects={effects} onChange={setEffects} /></section>
    <StorySaveStatus save={save} />
    {!checked.success && <p role="alert">{checked.error.issues[0]?.message}</p>}
    {actionHost ? createPortal(action,actionHost) : action}
    {review && <PageSheet open title="Keep this story rule?" subtitle={choice.label} className="story-dialog" onClose={() => setReview(false)} dismissOnBackdrop={false} footer={<><Button onClick={() => setReview(false)}>Back</Button><Button variant="primary" disabled={!current || !checked.success || save.stale || save.busy} onClick={() => save.submit(version => onSave(when, effects, unavailable, version))}>Keep change</Button></>}><StoryRuleSummary routing={routing} when={when} effects={effects} /><h3>If unavailable</h3><p>{unavailable ? `Shown disabled: ${unavailable.reason}` : "Hidden in the player."}</p><p>Future routes use this rule. Existing saved routes are checked against the changed story before resuming.</p><StorySaveStatus save={save}/></PageSheet>}
  </div>;
}

export function StoryRuleSummary({ routing, when, effects, title = "Available when" }: { routing: Routing; when?: StoryPredicate; effects?: StoryEffect[]; title?: string }) {
  const name = (id: string) => routing.facts?.find(f => f.id === id)?.label ?? id;
  const condition = (p: StoryPredicate): string => p.op === "eq" ? `${name(p.fact)} is ${String(p.value)}` : p.op === "not" && p.arg.op === "eq" ? `${name(p.arg.fact)} is not ${String(p.arg.value)}` : p.op === "not" ? `Not (${condition(p.arg)})` : p.args.map(arg => `(${condition(arg)})`).join(p.op === "all" ? " and " : " or ");
  return <div className="story-rule-summary"><h3>{title}</h3><p>{when ? condition(when) : title === "Show when" ? "Always shown." : "Always available."}</p>{effects && <><h3>Remember</h3>{effects.length ? effects.map(effect => <p key={effect.fact}>{name(effect.fact)} → {String(effect.value)}</p>) : <p>No values change.</p>}</>}</div>;
}

export function StoryFactsInspector({ routing, onClose, onSave }: { routing: Routing; onClose: () => void; onSave: (facts: StoryFact[], baseVersion: number) => void }) {
  const [editing, setEditing] = useState<string | null>(null);
  return <section className="bm-insp story-facts-inspector" aria-label="Story facts"><header className="bm-insp__head"><b>Story facts</b><span className="bm-spacer"/><Button variant="ghost" onClick={onClose}>Arke</Button><IconButton label="Close" onClick={onClose}><X size={14}/></IconButton></header><div className="bm-insp__body"><h3>What this story remembers</h3><p>Defaults apply when a new playthrough starts. Choices change them along each route.</p>{(routing.facts ?? []).map(fact => <div className="story-fact-row" key={fact.id}><span className="story-initials" aria-hidden="true">{fact.label.split(/\s+/).map(word => word[0]).slice(0,2).join("")}</span><div><strong>{fact.label}</strong><small>Starts {String(fact.default)}</small></div><Button onClick={() => setEditing(fact.id)} aria-label={`Edit ${fact.label}`}>{String(fact.default)} ›</Button></div>)}<p className="story-facts-note">These values belong to this production. The world’s character sheets stay as they are.</p></div><footer className="story-inspector-footer"><Button onClick={() => setEditing("")}>+ Add fact</Button></footer>{editing !== null && <StoryFactsDialog key={editing} routing={routing} initialFactId={editing} onClose={() => setEditing(null)} onSave={onSave}/>}</section>;
}

export function StoryFactsDialog({ routing, onClose, onSave, initialFactId }: { routing: Routing; onClose: () => void; onSave: (facts: StoryFact[], baseVersion: number) => void; initialFactId?: string }) {
  const [facts, setFacts] = useState(routing.facts ?? []);
  const [initialIds] = useState(() => new Set((routing.facts ?? []).map(fact => fact.id)));
  const [enumDrafts,setEnumDrafts] = useState<Record<string,string>>({});
  const [label, setLabel] = useState("");
  const [type, setType] = useState<"boolean" | "enum">("enum");
  const update = (index: number, fact: StoryFact) => setFacts(facts.map((f, i) => i === index ? fact : f));
  const normalizedFacts:StoryFact[] = facts.map(fact=>fact.type === "enum" && enumDrafts[fact.id] !== undefined ? {...fact,values:enumValuesFromText(enumDrafts[fact.id]!)} : fact);
  const save = useStorySave(routing, routing.schemaVersion === 2 && JSON.stringify(routing.facts ?? []) === JSON.stringify(normalizedFacts), onClose, () => { setFacts(routing.facts ?? []); setEnumDrafts({}); });
  const validation = RoutingSchema.safeParse({ ...routing, schemaVersion: 2, facts:normalizedFacts });
  return <PageSheet open title={initialFactId === undefined ? "Story facts" : initialFactId === "" ? "Add fact" : facts.find(fact => fact.id === initialFactId)?.label ?? "Story fact"} subtitle="Story facts · starting values for this production" onClose={onClose} dismissOnBackdrop={false} className={`story-dialog${initialFactId === undefined ? "" : " story-single-fact"}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!validation.success || save.busy || save.stale || initialFactId === "" && facts.every(fact => initialIds.has(fact.id))} onClick={() => save.submit(version => onSave(normalizedFacts, version))}>{initialFactId === undefined ? "Save facts" : "Keep fact"}</Button></>}>
    {facts.map((fact, index) => initialFactId === "" && initialIds.has(fact.id) || initialFactId !== undefined && initialFactId !== "" && fact.id !== initialFactId ? null : <fieldset className="story-fact" key={fact.id}><legend>{fact.label}</legend><label className="story-field">Name<Input aria-label={`Name for ${fact.id}`} value={fact.label} onChange={e => update(index, { ...fact, label: e.target.value })} /></label><label className="story-field">Type<Input readOnly value={fact.type === "enum" ? "Choose from a list" : "Yes or no"}/></label><details><summary>Used by {storyFactReferences(routing, fact.id).length}</summary><ul>{storyFactReferences(routing, fact.id).map((use, i) => <li key={i}>{use.label} · {use.kind}</li>)}</ul></details>{fact.type === "enum" && <div className="story-field"><span>Values</span><div className="story-value-chips">{fact.values.map((value,index)=><span key={index}>{value || "Empty value"}</span>)}</div><details><summary>Edit values</summary><Input aria-label={`Values for ${fact.id}`} value={enumDrafts[fact.id] ?? fact.values.join(", ")} onChange={e => setEnumDrafts(current=>({...current,[fact.id]:e.target.value}))} onBlur={()=>{ const raw=enumDrafts[fact.id]; if(raw !== undefined) { update(index,{...fact,values:enumValuesFromText(raw)}); setEnumDrafts(current=>{ const {[fact.id]:_raw,...rest}=current;return rest; }); } }} /></details></div>}<label className="story-field">Starting value<FactValue fact={fact} value={fact.default} label={`Starting value for ${fact.id}`} onChange={value => update(index, { ...fact, default: value } as StoryFact)} /></label><Button variant="ghost" disabled={storyFactReferences(routing, fact.id).length > 0} onClick={() => setFacts(facts.filter((_, i) => i !== index))}>Remove fact</Button></fieldset>)}
    {(initialFactId === undefined || initialFactId === "") && <fieldset className="story-fact"><legend>Add a fact</legend><Input aria-label="New fact name" value={label} placeholder="Dev Malik" onChange={e => setLabel(e.target.value)} /><Select label="Fact type" value={type} onChange={e => setType(e.target.value as "boolean" | "enum")}><option value="enum">List of values</option><option value="boolean">True or false</option></Select><Button disabled={!label.trim() || facts.length >= 32} onClick={() => {
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "fact";
      const rootId = /^[a-z]/.test(base) ? base : "fact-" + base;
      let id = rootId;
      for (let n = 2; facts.some(f => f.id === id); n++) id = rootId + "-" + n;
      setFacts([...facts, type === "boolean" ? { id, label: label.trim(), type, default: false } : { id, label: label.trim(), type, values: ["Alive", "Lost"], default: "Alive" }]); setLabel("");
    }}>Add fact</Button></fieldset>}
    <StorySaveStatus save={save} />
    {!validation.success && <p role="alert">{validation.error.issues[0]?.message}. Repair references before removing or changing a used value.</p>}
  </PageSheet>;
}
