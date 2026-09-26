import { formatMicroUsd, type GenesisVoices, type GenesisVoiceCandidate, type Job } from "@arke-studio/contracts";
import { Button, Callout } from "./ui.js";
import { genesisMediaUrl } from "../lib/media.js";

export function GenesisVoiceCards({ genesisId, voices, jobs, busy, onGenerate, onDecide, onRevise, onRefresh, onCancel }: {
  genesisId: string; voices: GenesisVoices; jobs: Job[]; busy: boolean;
  onGenerate(id: string, digest: string): void;
  onDecide(target: string, decision: "approve" | "reject" | "unassign", candidate?: GenesisVoiceCandidate): void;
  onRevise(text: string): void; onRefresh(): void; onCancel(id: string): void;
}) {
  return <section aria-label="Voices in this conversation" style={{ display: "grid", gap: 12 }}>
    <h2>Voices</h2><p>Voice casting is optional. Audition first, then choose the voice you hear.</p>
    <Button variant="ghost" disabled={busy} onClick={onRefresh}>Refresh voices</Button>
    <details><summary>Available voices ({voices.catalogue.length})</summary>
      {voices.catalogue.map(voice => <p key={JSON.stringify([voice.provider, voice.model, voice.voiceId])}>
        {voice.label} · {voice.provider} · {voice.model}{voice.unavailableReason ? " · " + voice.unavailableReason : ""}
        <Button variant="ghost" disabled={busy || !!voice.unavailableReason || !!voice.readsClone}
          onClick={() => onRevise(`Please propose an audition using ${voice.label} (provider ${voice.provider}, model ${voice.model}, voiceId ${voice.voiceId}) for `)}>Propose audition</Button>
      </p>)}
    </details>
    {voices.problems.map((problem, index) => <Callout key={index} title="Voice needs attention">{problem}</Callout>)}
    {voices.plans.map(plan => <article className="fy-actioncard" key={plan.intent.id}>
      <h3>{plan.title} · {plan.voice.label}</h3><p style={{ whiteSpace: "pre-wrap" }}>{plan.text}</p>
      <p>{plan.voice.provider} · {plan.voice.model} · estimated {formatMicroUsd(plan.estimatedMicroUsd)}</p>
      <p>{plan.transfer}</p>
      <Button disabled={busy || jobs.some(job => job.target.id === plan.intent.target && !["succeeded", "failed", "cancelled"].includes(job.status))}
        onClick={() => onGenerate(plan.intent.id, plan.digest)}>Generate audition</Button>
      <Button variant="ghost" disabled={busy} onClick={() => onRevise(`Please revise the voice or audition text for ${plan.title}: `)}>Request changes</Button>
    </article>)}
    {jobs.map(job => <p key={job.id} role="status">Audition · {job.status}
      {!["succeeded", "failed", "cancelled"].includes(job.status) && <Button variant="ghost" onClick={() => onCancel(job.id)}>Cancel audition</Button>}
    </p>)}
    {Object.values(voices.attempts).some(attempt => attempt.status !== "completed") && <p>An audition failed or was interrupted. You can authorize another audition.</p>}
    {voices.candidates.map(candidate => {
      const selected = voices.selections.some(one => one.id === candidate.id), rejected = voices.rejected.includes(candidate.id);
      return <article className="fy-actioncard" key={candidate.id}>
        <h3>{candidate.plan.title} · {candidate.plan.voice.label}</h3>
        <p>{candidate.plan.text}</p>
        <audio controls preload="none" src={genesisMediaUrl(genesisId, candidate.file)} aria-label={`Audition for ${candidate.plan.title}: ${candidate.plan.voice.label}`} />
        <p>{selected ? "Selected voice" : rejected ? "Rejected" : "Not assigned"}</p>
        {!selected && <Button disabled={busy} onClick={() => onDecide(candidate.plan.intent.target, "approve", candidate)}>Use this voice</Button>}
        {!selected && !rejected && <Button variant="ghost" disabled={busy} onClick={() => onDecide(candidate.plan.intent.target, "reject", candidate)}>Reject voice</Button>}
        {selected && <Button variant="ghost" disabled={busy} onClick={() => onDecide(candidate.plan.intent.target, "unassign")}>Continue without this voice</Button>}
      </article>;
    })}
    {voices.selections.filter(selected => !voices.candidates.some(candidate => candidate.id === selected.id)).map(selected =>
      <Button key={selected.id} disabled={busy} onClick={() => onDecide(selected.plan.intent.target, "unassign")}>Remove unavailable voice for {selected.plan.title}</Button>)}
  </section>;
}
