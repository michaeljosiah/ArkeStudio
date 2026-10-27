import { useEffect, useState } from "react";
import { storyFactReferences, RoutingSchema, type Routing, type Choice, type StoryPredicate, type StoryEffect, type StoryFact } from "@arke-studio/contracts";
import { choiceIdFor } from "../lib/branch-map.js";
import { subscribeCommandFailures } from "../lib/store.js";
import { PageSheet } from "./page-sheet.js";
import { Button, Input, Select } from "./ui.js";

/** Replacement forms keep their draft until acknowledgement, and fence a stale authoring snapshot. */
export function useStorySave(routing: Routing, saved: boolean, onClose: () => void, reload: () => void) {
  const [baseVersion, setBaseVersion] = useState(routing.version);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => subscribeCommandFailures(event => {
    if (busy && event.command === "routing-command") { setBusy(false); setError(event.reason); }
  }), [busy]);
  useEffect(() => {
    if (busy && saved && routing.version > baseVersion) { setBusy(false); onClose(); }
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

/** Closed, typed predicates: nesting represents Any/All without accepting executable text. */
export function StoryCondition({ facts, value, onChange, depth = 1 }: { facts: StoryFact[]; value?: StoryPredicate; onChange: (next?: StoryPredicate) => void; depth?: number }) {
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
      : value.op === "not" ? <StoryCondition facts={facts} value={value.arg} depth={depth + 1} onChange={arg => onChange(arg ? { op: "not", arg } : undefined)} />
      : <>{value.args.map((arg, index) => <StoryCondition key={index} facts={facts} value={arg} depth={depth + 1} onChange={next => { const args = value.args.flatMap((a, i) => i === index ? next ? [next] : [] : [a]); onChange(args.length ? { ...value, args } : undefined); }} />)}<Button disabled={!first || value.args.length >= 128} onClick={() => onChange({ ...value, args: [...value.args, fresh()] })}>Add condition</Button></>}
  </div>;
}

export function StoryEffects({ facts, effects, onChange }: { facts: StoryFact[]; effects: StoryEffect[]; onChange: (effects: StoryEffect[]) => void }) {
  const available = facts.filter(f => !effects.some(e => e.fact === f.id));
  return <>{effects.map((effect, index) => {
    const fact = facts.find(f => f.id === effect.fact);
    return <div className="story-rule-row" key={index}><Select label="Remember fact" value={effect.fact} onChange={e => { const f = facts.find(f => f.id === e.target.value)!; onChange(effects.map((v, i) => i === index ? { fact: f.id, value: f.default } : v)); }}>{facts.filter(f => f.id === effect.fact || !effects.some(e => e.fact === f.id)).map(f => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>{fact && <FactValue fact={fact} value={effect.value} label="Remember value" onChange={value => onChange(effects.map((v, i) => i === index ? { ...v, value } : v))} />}<Button variant="ghost" onClick={() => onChange(effects.filter((_, i) => i !== index))}>Remove value</Button></div>;
  })}<Button disabled={!available.length} onClick={() => onChange([...effects, { fact: available[0]!.id, value: available[0]!.default }])}>Remember a value</Button></>;
}

export function ConnectorDialog({ routing, initial, editing, scenes, picking, destination, onPick, onClose, onSave }: {
  routing: Routing; initial: Choice; editing: boolean; scenes: readonly { id: string; title: string }[]; picking: boolean; destination: string | null;
  onPick: (source: string) => void; onClose: () => void; onSave: (choice: Choice, baseVersion: number) => void;
}) {
  const [draft, setDraft] = useState(initial);
  useEffect(() => { if (destination !== null) setDraft(current => ({ ...current, to: destination })); }, [destination]);
  const [chooseSource] = useState(!initial.from);
  const choice = { ...draft, id: editing ? draft.id : choiceIdFor(draft.label, routing), to: draft.to, label: draft.label.trim() };
  const facts = routing.facts ?? [];
  const save = useStorySave(routing, false, () => {}, () => setDraft(editing ? routing.choices.find(c => c.id === initial.id) ?? initial : { ...initial, label: "", effects: undefined, when: undefined }));
  const checked = RoutingSchema.safeParse({ ...routing, ...(choice.when || choice.effects?.length ? { schemaVersion: 2 } : {}), choices: editing ? routing.choices.map(c => c.id === choice.id ? choice : c) : [...routing.choices, choice] });
  const ready = checked.success && (!editing || routing.choices.some(c => c.id === initial.id)) && scenes.some(s => s.id === choice.from) && scenes.some(s => s.id === choice.to) && !routing.excluded.some(e => e.sceneId === choice.to);
  return <PageSheet returnFocus={() => document.querySelector<HTMLElement>(`[data-scene="${initial.from}"] .bm-port`) ?? document.querySelector<HTMLElement>(`[data-walk="s:${initial.from}"]`) ?? document.querySelector<HTMLElement>(".bm-count")} open={!picking} title={editing ? "Edit connector" : "Define connector"} subtitle="A choice connects two scenes. Its rules travel with it." onClose={onClose} dismissOnBackdrop={false} className="story-dialog" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || save.busy || save.stale} onClick={() => save.submit(version => onSave(choice, version))}>{editing ? "Save choice" : "Add choice"}</Button></>}>
    <label className="story-field">From scene{chooseSource ? <Select label="From scene" value={draft.from} onChange={event => setDraft({ ...draft, from: event.target.value })}><option value="">Choose a source scene…</option>{scenes.filter(s => !routing.excluded.some(e => e.sceneId === s.id)).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</Select> : <Input aria-label="From scene" value={scenes.find(s => s.id === draft.from)?.title ?? draft.from} readOnly />}</label>
    <div className="story-rule-row"><label className="story-field">Destination scene<Select label="Destination scene" value={choice.to} onChange={e => setDraft({ ...draft, to: e.target.value })}><option value="">Choose a scene…</option>{scenes.filter(s => !routing.excluded.some(e => e.sceneId === s.id)).map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</Select></label><Button disabled={!draft.from} onClick={() => onPick(draft.from)}>Choose on map</Button></div>
    <label className="story-field">Choice text<Input aria-label="Choice text" value={draft.label} placeholder="Ask Dev to hold the release" onChange={e => setDraft({ ...draft, label: e.target.value })} /></label>
    <section><h3>Available when</h3><p>Checked before this choice is made. No conditions means always available.</p><StoryCondition facts={facts} value={draft.when} onChange={when => setDraft({ ...draft, when })} /></section>
    <section><h3>Remember</h3><p>Set these values together after the player chooses this path.</p><StoryEffects facts={facts} effects={draft.effects ?? []} onChange={effects => setDraft({ ...draft, effects })} /></section>
    <StorySaveStatus save={save} />
    {!checked.success && draft.label.trim() && choice.to && <p role="alert">{checked.error.issues[0]?.message}</p>}
    {!facts.length && <p>Declare Story facts on the Branch Map to add conditions and remembered values.</p>}
  </PageSheet>;
}

export function StoryFactsDialog({ routing, onClose, onSave }: { routing: Routing; onClose: () => void; onSave: (facts: StoryFact[], baseVersion: number) => void }) {
  const [facts, setFacts] = useState(routing.facts ?? []);
  const [label, setLabel] = useState("");
  const [type, setType] = useState<"boolean" | "enum">("enum");
  const update = (index: number, fact: StoryFact) => setFacts(facts.map((f, i) => i === index ? fact : f));
  const save = useStorySave(routing, routing.schemaVersion === 2 && JSON.stringify(routing.facts ?? []) === JSON.stringify(facts), onClose, () => setFacts(routing.facts ?? []));
  const validation = RoutingSchema.safeParse({ ...routing, schemaVersion: 2, facts });
  return <PageSheet open title="Story facts" subtitle="Starting values belong to this production. Player choices remember changes." onClose={onClose} dismissOnBackdrop={false} className="story-dialog" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!validation.success || save.busy || save.stale} onClick={() => save.submit(version => onSave(facts, version))}>Save facts</Button></>}>
    {facts.map((fact, index) => <fieldset className="story-fact" key={fact.id}><legend>{fact.label}</legend><label className="story-field">Name<Input aria-label={`Name for ${fact.id}`} value={fact.label} onChange={e => update(index, { ...fact, label: e.target.value })} /></label><small>{fact.id} · {fact.type}</small><details><summary>Used by {storyFactReferences(routing, fact.id).length}</summary><ul>{storyFactReferences(routing, fact.id).map((use, i) => <li key={i}>{use.label} · {use.kind}</li>)}</ul></details>{fact.type === "enum" && <label className="story-field">Values, separated by commas<Input aria-label={`Values for ${fact.id}`} value={fact.values.join(", ")} onChange={e => update(index, { ...fact, values: e.target.value.split(",").map(v => v.trim()) })} /></label>}<label className="story-field">Starting value<FactValue fact={fact} value={fact.default} label={`Starting value for ${fact.id}`} onChange={value => update(index, { ...fact, default: value } as StoryFact)} /></label><Button variant="ghost" disabled={storyFactReferences(routing, fact.id).length > 0} onClick={() => setFacts(facts.filter((_, i) => i !== index))}>Remove fact</Button></fieldset>)}
    <fieldset className="story-fact"><legend>Add a fact</legend><Input aria-label="New fact name" value={label} placeholder="Dev Malik" onChange={e => setLabel(e.target.value)} /><Select label="Fact type" value={type} onChange={e => setType(e.target.value as "boolean" | "enum")}><option value="enum">List of values</option><option value="boolean">True or false</option></Select><Button disabled={!label.trim() || facts.length >= 32} onClick={() => {
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 55) || "fact";
      const rootId = /^[a-z]/.test(base) ? base : "fact-" + base;
      let id = rootId;
      for (let n = 2; facts.some(f => f.id === id); n++) id = rootId + "-" + n;
      setFacts([...facts, type === "boolean" ? { id, label: label.trim(), type, default: false } : { id, label: label.trim(), type, values: ["Alive", "Lost"], default: "Alive" }]); setLabel("");
    }}>Add fact</Button></fieldset>
    <StorySaveStatus save={save} />
    {!validation.success && <p role="alert">{validation.error.issues[0]?.message}. Repair references before removing or changing a used value.</p>}
  </PageSheet>;
}
