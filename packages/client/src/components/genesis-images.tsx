import { useState } from "react";
import { formatMicroUsd, type GenesisBlueprint, type GenesisImageCandidate, type GenesisImages, type Job } from "@arke-studio/contracts";
import { Button, Callout } from "./ui.js";
import { genesisMediaUrl } from "../lib/media.js";

type Decision = (target: string, decision: "approve" | "reject" | "unassign", candidate?: GenesisImageCandidate) => void;
function Candidate({ genesisId, candidate, targets, images, busy, onDecide, onRevise }: {
  genesisId: string; candidate: GenesisImageCandidate; targets: Array<{ key: string; label: string }>;
  images: GenesisImages; busy: boolean; onDecide: Decision; onRevise(text: string): void;
}) {
  const [chosen, setChosen] = useState(images.selections.find(selection => selection.candidate.id === candidate.id)?.target ?? candidate.target ?? targets[0]?.key ?? "");
  const target = targets.find(target => target.key === chosen);
  const selected = images.selections.some(selection => selection.target === chosen && selection.candidate.id === candidate.id);
  const rejected = images.rejected.includes(`${chosen}/${candidate.id}`);
  return <article className="fy-actioncard" aria-label={candidate.label}>
    <h3>{candidate.label}</h3>
    <img className="fy-actioncard__media" src={genesisMediaUrl(genesisId, candidate.file)} alt={candidate.label} style={{ width: "100%", maxHeight: 480, objectFit: "contain" }} />
    <p>{candidate.source === "generated" ? "Generated image" : "Uploaded image"}{selected ? " · selected" : rejected ? " · rejected" : " · not selected"}</p>
    <label>Use for <select aria-label={`Image target for ${candidate.label}`} value={chosen} disabled={busy} onChange={event => setChosen(event.target.value)}>
      <option value="">Choose a character, location or prop state</option>
      {targets.filter(target => candidate.source === "upload" || candidate.target === target.key).map(target => <option key={target.key} value={target.key}>{target.label}</option>)}
    </select></label>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
      {!selected && <Button disabled={busy || !target} onClick={() => onDecide(chosen, "approve", candidate)}>Use this image</Button>}
      {selected && <Button variant="ghost" disabled={busy} onClick={() => onDecide(chosen, "unassign")}>Remove assignment</Button>}
      {!selected && !rejected && <Button variant="ghost" disabled={busy || !target} onClick={() => onDecide(chosen, "reject", candidate)}>Reject</Button>}
      <Button variant="ghost" disabled={busy || !target} onClick={() => onRevise(`Please revise the image for ${target?.label}: `)}>Request changes</Button>
    </div>
    <p>{selected ? "This exact image will be used at founding." : "Kept as an artifact when the world is founded."}</p>
  </article>;
}

export function GenesisImageCards({ genesisId, blueprint, images, jobs, busy, onGenerate, onDecide, onCancel, onRevise }: {
  genesisId: string; blueprint: GenesisBlueprint; images: GenesisImages; jobs: Job[]; busy: boolean;
  onGenerate(intentId: string, digest: string): void; onDecide: Decision; onCancel(jobId: string): void; onRevise(text: string): void;
}) {
  const targets = [...blueprint.characters.filter(character => !character.neverDepicted).map(character => ({ key: `character:${character.slug}`, label: `${character.name} — main photo` })),
    ...blueprint.locations.map(location => ({ key: `location:${location.slug}`, label: `${location.name} — establishing view` })),
    ...(blueprint.props ?? []).flatMap(prop => prop.states.map(state => ({ key: `prop:${prop.slug}:${state.slug}`, label: `${prop.name} · ${state.name} — reference` })))];
  return <section aria-label="Images in this conversation" style={{ display: "grid", gap: 14 }}>
    <h2>Images</h2>
    {images.problems.map(problem => <Callout key={problem} title="Image needs attention">{problem}</Callout>)}
    {images.plans.map(plan => {
      const active = jobs.find(job => job.target.id === plan.intent.target && !["succeeded", "failed", "cancelled"].includes(job.status));
      return <article className="fy-actioncard" key={plan.intent.id} aria-label={`Generate ${plan.title}`}>
        <h3>{plan.title} · {plan.role}</h3><p style={{ whiteSpace: "pre-wrap" }}>{plan.prompt}</p>
        <p>{plan.modelName} · 1 image · estimated {formatMicroUsd(plan.estimatedMicroUsd)}</p>
        <p>{String(plan.output["width"])} × {String(plan.output["height"])} pixels</p>
        <p>References: {plan.references.map(reference => reference.label).join(", ") || "none"}</p>
        {plan.references.map(reference => <img key={reference.id} src={genesisMediaUrl(genesisId, reference.file)} alt={reference.label} style={{ width: 96, height: 96, objectFit: "contain" }} />)}
        <Button disabled={busy || !!active} onClick={() => onGenerate(plan.intent.id, plan.digest)}>Generate · ~{formatMicroUsd(plan.estimatedMicroUsd)}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => onRevise(`Please revise the image prompt for ${plan.title}: `)}>Change prompt</Button>
      </article>;
    })}
    {jobs.map(job => <div key={job.id} role="status">
      <p>{String(job.params["label"] ?? "Image")} · {job.status}{job.error ? ` — ${job.error}` : ""}</p>
      {!["succeeded", "failed", "cancelled"].includes(job.status) && <Button variant="ghost" onClick={() => onCancel(job.id)}>Cancel generation</Button>}
    </div>)}
    {images.candidates.map(candidate => <Candidate key={candidate.id} genesisId={genesisId} candidate={candidate} targets={targets} images={images} busy={busy} onDecide={onDecide} onRevise={onRevise} />)}
  </section>;
}
