import { useEffect, useRef, useState } from "react";
import { DesignedVoiceModelSchema, VoiceDesignDraftSchema, designedVoiceTarget, formatMicroUsd, quoteSpeech, quoteVoiceDesign,
  type VoiceCandidate, type WorldDesignedVoice } from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { Button, Input, Select, Textarea } from "./ui.js";
import { mediaUrl } from "../lib/media.js";
import { designVoice, hearDesignedVoice, requestVoiceCatalogue, saveVoiceDesign, subscribeDesignedAuditions,
  subscribeDesignedVoices, subscribeQueueResults, useStore } from "../lib/store.js";

/** SPEC-049 R-18/R-19: free drafting, explicit creation, local replay, then independent adoption. */
export function DesignVoiceDialog({ worldId, description: initialDescription = "", name: initialName = "", line: initialLine = "",
  useLabel = "Use this voice", onUse, onClose }: {
  worldId: string; description?: string; name?: string; line?: string; useLabel?: string;
  onUse: (voice: VoiceCandidate) => void; onClose: () => void;
}) {
  const { state, connection } = useStore();
  const world = state?.world?.meta.worldId === worldId ? state.world : null;
  const models = (state?.app.manifest?.models ?? []).filter(model => model.provider === "google"
    && DesignedVoiceModelSchema.safeParse(model.id).success && !state?.app.models.disabled.includes(model.id));
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [language, setLanguage] = useState("en-GB");
  const [modelId, setModelId] = useState(models.find(row => row.id === "gemini-3.8-flash-tts")?.id ?? models[0]?.id ?? "gemini-3.8-flash-tts");
  const [line, setLine] = useState(initialLine);
  const [remoteId, setRemoteId] = useState("");
  const [saved, setSaved] = useState<WorldDesignedVoice | null>(null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [trouble, setTrouble] = useState<string | null>(null);
  const [auditionFile, setAuditionFile] = useState<string | null>(null);
  const [hearId, setHearId] = useState<string | null>(null);
  const request = useRef<string | null>(null);
  const saveRequest = useRef<string | null>(null);
  const hearing = useRef<string | null>(null);
  const model = models.find(row => row.id === modelId);
  const draft = VoiceDesignDraftSchema.safeParse({ model: modelId, name, description, language });
  const quote = model ? quoteVoiceDesign(model, description) : null;
  const readModel = models.find(row => row.id === saved?.model);
  const readQuote = readModel ? quoteSpeech(readModel, line) : null;
  const jobs = (state?.app.jobs ?? []).filter(job => job.worldId === worldId && job.target.kind === "voice-design").slice().reverse();
  const active = jobs.some(job => !["succeeded", "failed", "cancelled", "needs-reconciliation"].includes(job.status));
  const heard = state?.app.jobs.find(job => job.params.requestId === hearId);
  const hearingBusy = hearId !== null && (!heard || !["succeeded", "failed", "cancelled", "needs-reconciliation"].includes(heard.status)) && auditionFile === null;
  useEffect(() => subscribeQueueResults(result => {
    if (result.requestId !== request.current && result.requestId !== hearing.current) return;
    if (result.requestId === request.current) setGenerating(false);
    if (result.failures.length) { setTrouble(result.failures[0]!.reason); if (result.requestId === hearing.current) setHearId(null); }
  }), []);
  useEffect(() => subscribeDesignedVoices(result => {
    if (result.requestId !== saveRequest.current || result.worldId !== worldId) return;
    setSaving(false);
    setTrouble(result.reason);
    if (result.voice) { setSaved(result.voice); requestVoiceCatalogue(worldId); }
  }), [worldId]);
  useEffect(() => subscribeDesignedAuditions(result => {
    if (result.requestId === hearing.current && result.worldId === worldId) setAuditionFile(result.file);
  }), [worldId]);
  useEffect(() => {
    if (connection !== "open") { setGenerating(false); setSaving(false); }
  }, [connection]);
  const save = (source: { jobId: string } | { remoteId: string }) => {
    setSaving(true); setTrouble(null); saveRequest.current = saveVoiceDesign(worldId, source);
  };
  const select = (voice: WorldDesignedVoice) => { setSaved(voice); setAuditionFile(null); setHearId(null); };
  const playable = auditionFile ?? heard?.landedFiles?.[0];
  return <EditorDialog open title="Design a voice" subtitle="A voice imagined from your words · saved with this world" onClose={onClose} width={680}>
    <div className="fy-clone__body fy-designed-voice" data-testid="design-voice-dialog">
      <label className="fy-clone__field"><span>Name</span><Input value={name} maxLength={120} onChange={event => setName(event.target.value)} /></label>
      <label className="fy-clone__field"><span>Written voice</span><Textarea value={description} maxLength={4000} rows={4}
        placeholder="Low, warm, slightly weathered. A patient storyteller with a coastal British accent."
        onChange={event => setDescription(event.target.value)} /></label>
      <label className="fy-clone__field"><span>Language</span><Input value={language} placeholder="en-GB" onChange={event => setLanguage(event.target.value)} /></label>
      <Select label="Voice model" value={modelId} onChange={event => setModelId(event.target.value)}>
        {models.map(row => <option key={row.id} value={row.id}>{row.displayName}</option>)}
      </Select>
      <p>Editing is free. Each Generate makes one candidate and a provider-selected audition. Generate again to compare another.</p>
      {quote && <p>Budgeting estimate: {formatMicroUsd(quote.expectedMicroUsd)} per candidate, using full model token limits and Google’s published paid rates.
        This is an estimate, not a spending cap. Google applies any free-tier allowance. <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer">Pricing basis</a></p>}
      <Button variant="primary" disabled={!draft.success || !quote || connection !== "open" || generating || active}
        onClick={() => { if (!draft.success || !quote) return; setTrouble(null); setGenerating(true); request.current = designVoice(worldId, draft.data, quote.authorisedMicroUsd); }}>
        {generating || active ? "Creating a candidate…" : `Generate one candidate${quote ? ` · est. ${formatMicroUsd(quote.expectedMicroUsd)}` : ""}`}
      </Button>
      {jobs.length > 0 && <section aria-label="Voice candidates">
        <h3>Candidates</h3>
        {jobs.slice(0, 12).map(job => {
          const kept = world?.designedVoices?.find(voice => voice.creationJobId === job.id);
          return <div key={job.id} className="fy-clone__field">
            <strong>{String(job.params.name ?? "Candidate")} · {job.status}</strong>
            <span>{String(job.params.text ?? "")}</span>
            {job.landedFiles?.[0] && world && <audio controls preload="none" src={mediaUrl(world.meta.slug, job.landedFiles[0])} aria-label="Provider audition" />}
            {job.error && <p role="status">{job.error}</p>}
            {job.status === "needs-reconciliation" && <p>The outcome is uncertain. Do not repeat this creation unless you accept that it may charge again. You can import its ID if it appears in your Google project.</p>}
            {kept ? <Button onClick={() => select(kept)}>Saved · choose this voice</Button>
              : job.providerJobId && <Button disabled={saving || connection !== "open"} onClick={() => save({ jobId: job.id })}>{saving ? "Saving…" : "Save voice"}</Button>}
          </div>;
        })}
      </section>}
      <details><summary>Import an existing Google voice</summary>
        <p>Enter a stored voice ID from the connected Google project. Arke verifies it and saves its audition; this does not create another voice.</p>
        <Input aria-label="Google voice ID" value={remoteId} placeholder="voice_…" onChange={event => setRemoteId(event.target.value)} />
        <Button disabled={saving || connection !== "open" || !/^voice_[A-Za-z0-9_-]{1,200}$/.test(remoteId)} onClick={() => save({ remoteId })}>Verify and save</Button>
      </details>
      {(world?.designedVoices?.length ?? 0) > 0 && <details><summary>Saved voices in this world · {world!.designedVoices!.length}</summary>
        {world!.designedVoices!.map(voice => <div className="fy-clone__field" key={voice.id}>
          <Button onClick={() => select(voice)}>{voice.name} · {voice.origin === "imported" ? "imported" : "designed"}</Button>
          <span>{Date.parse(voice.expiresAt) <= Date.now() ? "Expired for new reads · saved audition still plays" : `Available until ${new Date(voice.expiresAt).toLocaleDateString()}`}</span>
          <audio controls preload="none" src={mediaUrl(world!.meta.slug, voice.sample)} aria-label={`${voice.name} saved audition`} />
        </div>)}
      </details>}
      {saved && <section aria-label="Saved designed voice">
        <h3>{saved.name} · saved</h3>
        <p>{saved.origin === "imported" ? "Imported from Google" : "Designed in Arke"} · available until {new Date(saved.expiresAt).toLocaleDateString()} · saved audio stays in this world.</p>
        {world && <audio controls preload="none" src={mediaUrl(world.meta.slug, saved.sample)} aria-label="Saved audition" />}
        <label className="fy-clone__field"><span>Try your own line</span><Textarea value={line} maxLength={4000} rows={2} onChange={event => setLine(event.target.value)} /></label>
        <Button disabled={!line.trim() || !readQuote || connection !== "open" || hearingBusy} onClick={() => {
          if (!readQuote) return; setTrouble(null); setAuditionFile(null);
          hearing.current = hearDesignedVoice(worldId, saved.model, designedVoiceTarget(saved), line, readQuote.authorisedMicroUsd);
          setHearId(hearing.current);
        }}>{hearingBusy ? "Reading…" : `Hear this line${readQuote ? ` · up to ${formatMicroUsd(readQuote.authorisedMicroUsd)}` : ""}`}</Button>
        <p>Saved auditions replay free. A new line is a separate read; matching cached reads are reused.</p>
        {heard?.error && <p role="status">{heard.error}</p>}
        {playable && world && <audio controls preload="none" src={mediaUrl(world.meta.slug, playable)} aria-label="Your audition line" />}
        <Button variant="primary" disabled={Date.parse(saved.expiresAt) <= Date.now()} onClick={() => onUse({ provider: "google", model: saved.model,
          voiceId: designedVoiceTarget(saved), label: saved.name, attributes: [], local: false, canClone: false, readsDesigned: saved.id })}>{useLabel}</Button>
      </section>}
      {trouble && <p role="alert">{trouble}</p>}
      {connection !== "open" && <p role="status">Reconnect to generate or save. Existing audio remains available.</p>}
    </div>
    <div className="fy-rectake__foot"><Button variant="ghost" onClick={onClose}>{saved ? "Keep saved without assigning" : "Close"}</Button></div>
  </EditorDialog>;
}
