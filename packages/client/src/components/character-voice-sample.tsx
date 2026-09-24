import { z } from "zod";
import { useEffect, useRef, useState } from "react";
import { characterSpeakingVideoRoutes, designatedVoiceSample, estimateMicroUsd, pickableArtifacts, ulid, type ClientMessage, type ManifestModel, type Sheet, type VoiceSampleReview, type WorldBundle } from "@arke-studio/contracts";
import { generateCharacterVoiceSample, send, sendAttachFilesCorrelated, subscribeQueueResults,
  subscribeVoiceSampleResults, useStore } from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { playClip } from "../lib/audio.js";
import { Button, cx } from "./ui.js";
import { Check } from "./icons.js";
import { PosterVideo } from "./player.js";
import { Portrait, sheetPortraitPath } from "./portrait.js";

const ReviewOperationId = z.string().uuid();

/**
 * What a route costs, said the same way for every row (issue 868): a cloud route its price for
 * this length, a local one "free" and the run it measured — because "free" against "$3.78" with
 * nothing beside it is how a person picks the free one once. Exported so the label can be read
 * back in a test rather than re-spelled there.
 */
export function costLabel(model: ManifestModel, durationSec: number): string {
  if (model.pricing.kind !== "unmetered") {
    const estimate = estimateMicroUsd(model, { durationSec, resolution: model.limits.resolutions?.[0] ?? "720p" });
    return `$${(estimate / 1_000_000).toFixed(2)}`;
  }
  const run = model.pricing.typicalRunSec;
  return run === undefined ? "free · minutes, not seconds" : `free · about ${Math.max(1, Math.round(run / 60))} min`;
}

/** A tick that is a human attestation, never an automated finding (design 114). */
function Tick({ on, onChange, label, note, testId }: {
  on: boolean; onChange: (next: boolean) => void; label: string; note?: string; testId?: string;
}) {
  return <label className="fy-vstick">
    {/* The house box, not the platform's (issue 1010, U2). */}
    <span className="ui-check__box">
      <input type="checkbox" checked={on} data-testid={testId} onChange={event => onChange(event.target.checked)} />
      <Check size={11} />
    </span>
    <span>{label}</span>
    {note !== undefined && <span className="fy-mono">{note}</span>}
  </label>;
}

/**
 * Setting the voice a character speaks with on screen (design 132f/132g; issue 1011).
 *
 * Two sheets rather than one panel, and the order is what turn 114 bound: a source is generated
 * or chosen, prepared locally, and only then reviewed and assigned. Nothing here assigns as a
 * side effect of anything else — generation lands a candidate and stops, preparation lands a
 * review and stops, and `Use on screen` is the single press that designates.
 *
 * The panel this replaces did all three in one column of native selects and checkboxes. What has
 * not changed is underneath it: the same preparation, the same quality report, the same
 * attestations and the same rights ledger, including every recovery path — a review that
 * outlives a reload, a legacy sample that has to be revalidated, a source that vanished.
 */
export function VoiceSampleFlow({ world, sheet, onClose }: { world: WorldBundle; sheet: Sheet; onClose: () => void }) {
  const { state } = useStore();
  const sample = world.referenceKits.find(k => k.sheetId === sheet.id)?.designatedVoiceSample;
  const models = characterSpeakingVideoRoutes(state?.app.manifest?.models ?? []);
  const [modelId, setModelId] = useState(""), [script, setScript] = useState("");
  const [durationSec, setDurationSec] = useState(8), [sourceId, setSourceId] = useState("");
  const [trim, setTrim] = useState(false), [inSec, setInSec] = useState(0), [outSec, setOutSec] = useState(8);
  const [review, setReview] = useState<VoiceSampleReview | null>(null);
  const [singleSpeaker, setSingleSpeaker] = useState(false), [noMusic, setNoMusic] = useState(false);
  const [ackWarnings, setAckWarnings] = useState(false);
  const [rightsBasis, setRightsBasis] = useState<"self" | "authorized" | "licensed" | "">("");
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState("");
  const recoveryKey = `voice-sample-review/${world.meta.worldId}/${sheet.id}`;
  const [recovery, setRecovery] = useState(() => { try { const saved = ReviewOperationId.safeParse(localStorage.getItem(recoveryKey)); return saved.success ? saved.data : null; } catch { return null; } });
  // Only the opaque preparation UUID survives restart, never audio, paths, permission or provider credentials.
  const retainReview = (operationId: string | null) => { if (operationId !== null) ReviewOperationId.parse(operationId); setRecovery(operationId); try { if (operationId) localStorage.setItem(recoveryKey, operationId); else localStorage.removeItem(recoveryKey); } catch { /* Session review remains usable without browser storage. */ } };
  const pending = useRef<string | null>(null), generation = useRef<string | null>(null);
  const kit = world.referenceKits.find(k => k.sheetId === sheet.id);
  const photo = kit?.mainPhoto?.file ?? kit?.anchor;
  const artifacts = pickableArtifacts(world.artifacts).filter(a => ["audio", "video"].includes(a.kind));
  const takes = world.productions.flatMap(p => p.takes.filter(t => (t.kind === "voice" || t.kind === "clip") && (t.media || t.segment)).map(t => ({ production: p.meta.id, take: t.id })));
  const selectedArtifact = sourceId.startsWith("artifact:") ? artifacts.find(a => a.id === sourceId.slice(9)) : undefined;
  const model = models.find(m => m.id === modelId) ?? models[0];
  // Only lengths this route declares. The coordinator refuses one it does not, and now that a
  // route is admitted by description rather than by name, the offered list cannot stay a constant.
  const durations = [5, 6, 7, 8, 9, 10].filter(n => model?.limits.durations?.[String(n)]);
  const length = durations.includes(durationSec) ? durationSec : durations[0] ?? durationSec;
  const estimate = model ? estimateMicroUsd(model, { durationSec: length, resolution: model.limits.resolutions?.[0] ?? "720p" }) : 0;
  const warnings = review ? Object.values(review.provenance.qualityReport.checks).filter(c => c.outcome === "warning").map(c => c.code) : [];
  useEffect(() => subscribeVoiceSampleResults(result => {
    if (result.requestId !== pending.current || result.worldId !== world.meta.worldId || result.sheetId !== sheet.id) return;
    pending.current = null; setBusy(false);
    if (result.review) { retainReview(result.review.operationId); setReview(result.review); setSingleSpeaker(false); setNoMusic(false); setAckWarnings(false); }
    else if (result.status === "assigned" || result.status === "cleared") { setReview(null); retainReview(null); }
    setNotice(result.reason ?? ({ prepared: "Prepared locally. Audition and review before assigning.", assigned: "Character voice reference assigned.",
      cleared: "Voice reference cleared. Source media is retained.", withdrawn: "Cloud reuse withdrawn. Future uploads are blocked; submitted work is unchanged.", refused: "Unable to complete this action." }[result.status]));
  }), [world.meta.worldId, sheet.id]);
  useEffect(() => subscribeQueueResults(result => {
    if (result.requestId !== generation.current) return;
    generation.current = null; setBusy(false);
    setNotice(result.disposition === "accepted" ? "Speaking sample queued. Its completed video will appear in the source list; generation never assigns it automatically." : "Generation was not queued. Check Activity for the reason.");
  }), []);
  const act = (message: ClientMessage) => {
    pending.current = "requestId" in message ? String(message.requestId) : null;
    setBusy(true); setNotice("");
    if (!send(message)) { pending.current = null; setBusy(false); setNotice("The studio is disconnected. Nothing was changed."); }
  };
  const hear = (file: string, title: string, range?: { inSec: number; outSec: number }) => { void playClip({ ...(range ? { range } : {}), id: `${world.meta.worldId}/${file}`, url: mediaUrl(world.meta.slug, file), title }); };
  const validRange = Number.isFinite(inSec) && Number.isFinite(outSec) && inSec >= 0 && outSec > inSec;
  const prepare = (id: string) => {
    const parts = id.split(":");
    const ranged = trim || parts[0] === "take";
    const source = parts[0] === "artifact" ? { kind: "artifact" as const, artifactId: parts[1]!, ...(trim ? { range: { inSec, outSec } } : {}) }
      : { kind: "production-take" as const, productionId: parts[1]!, takeId: parts[2]!, range: { inSec, outSec } };
    if (ranged && !validRange) { setNotice("Give a range that ends after it starts."); return; }
    act({ kind: "prepare-character-voice-sample", requestId: ulid(), worldId: world.meta.worldId, sheetId: sheet.id, source });
  };
  const head = <header className="fy-voicesheet__head">
    <span className="fy-voicesheet__avatar"><Portrait worldSlug={world.meta.slug} path={sheetPortraitPath(sheet.id)} label="" radius={99} /></span>
    <div>
      <strong>{review ? "Review the sample" : "The voice on screen"}</strong>
      <span className="fy-mono">{review ? "one speaker, no music — your review, not a finding" : `${sheet.name} speaking, for routes that carry a voice`}</span>
    </div>
  </header>;
  if (review) return <>
    <div className="fy-voicescrim" onClick={onClose} />
    <div className="fy-voicesheet fy-voicesheet--wide" role="dialog" aria-label="Review the sample" data-testid="voice-review">
      {head}
      <div className="fy-vsbody">
        <div className="fy-vsab">
          <Button onClick={() => hear(review.sourceFile, `${sheet.name} · original source`, (() => { const settings = review.provenance.preparation[0]?.settings; return typeof settings?.inSec === "number" && typeof settings.outSec === "number" ? { inSec: settings.inSec, outSec: settings.outSec } : undefined; })())}>Hear source</Button>
          <Button onClick={() => hear(review.preparedFile, `${sheet.name} · prepared clip`)}>Hear prepared</Button>
          <span className="fy-mono">{review.provenance.outputTechnical.durationSec?.toFixed(2)} s · mono 48 kHz</span>
        </div>
        {/* The report as it is: a check the tool could not run says so rather than passing. */}
        <div className="fy-vschecks">
          {Object.values(review.provenance.qualityReport.checks).map(check => <div key={check.code} className={cx("fy-vscheck", check.outcome === "warning" && "fy-vscheck--warn")}>
            <span>{check.code}</span><span>{check.outcome}</span>
          </div>)}
        </div>
        <div className="fy-vsticks">
          <Tick on={singleSpeaker} onChange={setSingleSpeaker} label="One speaker" testId="sample-one-speaker" />
          <Tick on={noMusic} onChange={setNoMusic} label="No music" testId="sample-no-music" />
          {warnings.length > 0 && <Tick on={ackWarnings} onChange={setAckWarnings} label="I reviewed the warnings" note={warnings.join(", ")} testId="sample-warnings" />}
        </div>
        <div className="fy-vsrights">
          <span className="fy-vsrights__label">Cloud reuse</span>
          <div className="fy-seg">
            {([["", "Local only"], ["self", "I performed it"], ["authorized", "Authorised"], ["licensed", "Licensed"]] as const).map(([value, label]) =>
              <button key={label} type="button" className={cx("fy-seg__item", rightsBasis === value && "fy-seg__item--active")} onClick={() => setRightsBasis(value)}>{label}</button>)}
          </div>
        </div>
      </div>
      <footer className="fy-voicesheet__foot">
        <span className="fy-mono">sets on screen · source kept</span>
        <span className="fy-voicesheet__push" />
        <Button variant="ghost" onClick={() => { setReview(null); retainReview(null); }}>Cancel</Button>
        <Button variant="primary" data-testid="sample-use" disabled={busy || !singleSpeaker || !noMusic || (warnings.length > 0 && !ackWarnings)}
          onClick={() => act({ kind: "accept-character-voice-sample", worldId: world.meta.worldId, sheetId: sheet.id, requestId: ulid(),
            operationId: review.operationId, warningCodes: warnings, singleSpeaker, noMusic, rightsBasis: rightsBasis || null })}>Use on screen</Button>
      </footer>
      <p className="fy-vsnotice" role="status" aria-live="polite">{notice}</p>
    </div>
  </>;
  return <>
    <div className="fy-voicescrim" onClick={onClose} />
    <div className="fy-voicesheet fy-voicesheet--wide" role="dialog" aria-label="The voice on screen" data-testid="voice-sample">
      {head}
      <div className="fy-vsbody">
        {sample && <div className="fy-vsassigned">
          <span className="fy-vsassigned__what">{"schemaVersion" in sample ? "Assigned clip" : "Legacy clip · review before cloud reuse"}</span>
          {/* Both sample shapes name a file beneath `references/<sheetId>/`; only the resolver knows it. */}
          <Button variant="ghost" onClick={() => { const at = designatedVoiceSample(kit ?? null); if (at) hear(at.file, `${sheet.name} · assigned clip`); }}>Hear</Button>
          {!("schemaVersion" in sample) && <Button variant="ghost" disabled={busy} onClick={() => act({ kind: "prepare-character-voice-sample", requestId: ulid(), worldId: world.meta.worldId, sheetId: sheet.id, source: { kind: "legacy-character-sample", sheetId: sheet.id } })}>Revalidate</Button>}
          {"schemaVersion" in sample && sample.acknowledgementId && <Button variant="ghost" disabled={busy} onClick={() => act({ kind: "withdraw-character-voice-sample", worldId: world.meta.worldId, sheetId: sheet.id, requestId: ulid(), expectedHash: sample.provenance.outputHash })}>Withdraw cloud reuse</Button>}
          <Button variant="ghost" disabled={busy} onClick={() => act({ kind: "clear-character-voice-sample", worldId: world.meta.worldId, sheetId: sheet.id, requestId: ulid(),
            expectedHash: "schemaVersion" in sample ? sample.provenance.outputHash : sample.file })}>Clear</Button>
        </div>}
        {recovery && <div className="fy-vsassigned">
          <span className="fy-vsassigned__what">A prepared review is waiting</span>
          <Button variant="ghost" disabled={busy} data-testid="sample-resume" onClick={() => act({ kind: "resume-character-voice-sample", requestId: ulid(), worldId: world.meta.worldId, sheetId: sheet.id, operationId: recovery })}>Resume</Button>
        </div>}
        <section className="fy-vsgen">
          <div className="fy-vsgen__photo">
            {photo
              ? <Portrait worldSlug={world.meta.slug} path={`references/${sheet.id}/${photo}`} label={`${sheet.name} · accepted photo`} radius={10} />
              : <p className="fy-mono">Accept a photo first</p>}
          </div>
          <div className="fy-vsgen__form">
            <label className="fy-vsfield">
              <span>Script</span>
              <textarea aria-label="Reference script" value={script} maxLength={2000} rows={3} onChange={e => setScript(e.target.value)} />
            </label>
            {models.length > 0 && <div className="fy-vsgen__row">
              <span className="fy-vsgen__key">Model</span>
              <div className="fy-seg">
                {models.map(m => <button key={m.id} type="button" className={cx("fy-seg__item", m.id === model?.id && "fy-seg__item--active")} onClick={() => setModelId(m.id)}>
                  {`${m.displayName}${m.speechVideo === "verified" ? "" : " · untested"}`}
                </button>)}
              </div>
            </div>}
            {durations.length > 0 && <div className="fy-vsgen__row">
              <span className="fy-vsgen__key">Length</span>
              <div className="fy-seg">
                {durations.map(n => <button key={n} type="button" className={cx("fy-seg__item", n === length && "fy-seg__item--active")} onClick={() => setDurationSec(n)}>{`${n} s`}</button>)}
              </div>
              <span className="fy-mono fy-vsgen__price">{model ? costLabel(model, length) : ""}</span>
            </div>}
            {models.length === 0 && <p className="fy-mono">No route here can carry a photo and make sound.</p>}
            {model && model.speechVideo !== "verified" && <p className="fy-mono">Untested for speech · may not lip-sync</p>}
            <Button variant="primary" data-testid="sample-generate" disabled={busy || !model || !script.trim() || !photo}
              onClick={() => { if (!model) return; setBusy(true); generation.current = generateCharacterVoiceSample({ worldId: world.meta.worldId,
                sheetId: sheet.id, modelId: model.id, script, durationSec: length, confirmedMicroUsd: estimate });
                if (!generation.current) { setBusy(false); setNotice("The studio is disconnected."); } }}>
              {`Generate · ${model ? costLabel(model, length) : "$0.00"}`}
            </Button>
          </div>
        </section>
        <section className="fy-vssources">
          <div className="fy-vssources__head">
            <h3>Or use something already here</h3>
            <label className="fy-vstick">
              <span className="ui-check__box">
                <input type="checkbox" checked={trim} data-testid="sample-trim" onChange={e => setTrim(e.target.checked)} />
                <Check size={11} />
              </span>
              <span>Take a range</span>
            </label>
            {(trim || sourceId.startsWith("take:")) && <span className="fy-vsrange">
              <label><span className="fy-mono">from</span><input type="number" aria-label="Start seconds" min={0} step={0.1} value={inSec} onChange={e => { setInSec(Number(e.target.value)); setReview(null); }} /></label>
              <label><span className="fy-mono">to</span><input type="number" aria-label="End seconds" min={0} step={0.1} value={outSec} onChange={e => { setOutSec(Number(e.target.value)); setReview(null); }} /></label>
            </span>}
            <span className="fy-voicesheet__push" />
            <Button variant="ghost" onClick={() => sendAttachFilesCorrelated(world.meta.worldId, [sheet.id])}>Import a file</Button>
          </div>
          <div className="fy-voicelist">
            {artifacts.length === 0 && takes.length === 0 && <p className="fy-voicesheet__none">Nothing filed yet · generate one, or import a file</p>}
            {artifacts.map(a => <div key={a.id} className="fy-vssource" data-source={`artifact:${a.id}`}>
              <span className="fy-vssource__name">{a.file}</span>
              <span className="fy-mono">{a.kind}{a.generation ? " · generated" : ""}</span>
              <span className="fy-voicesheet__push" />
              <Button variant="ghost" onClick={() => hear(`artifacts/${a.file}`, `${sheet.name} · ${a.file}`)}>Hear</Button>
              <Button disabled={busy} onClick={() => { setSourceId(`artifact:${a.id}`); prepare(`artifact:${a.id}`); }}>Review</Button>
            </div>)}
            {takes.map(({ production, take }) => <div key={`${production}/${take}`} className="fy-vssource" data-source={`take:${production}:${take}`}>
              <span className="fy-vssource__name">{take}</span>
              <span className="fy-mono">{production}</span>
              <span className="fy-voicesheet__push" />
              <Button disabled={busy} onClick={() => { setSourceId(`take:${production}:${take}`); prepare(`take:${production}:${take}`); }}>Review</Button>
            </div>)}
          </div>
          {selectedArtifact?.kind === "video" && <PosterVideo label="Speaking video picture preview" muted src={mediaUrl(world.meta.slug, `artifacts/${selectedArtifact.file}`)} className="fy-vsvideo" />}
        </section>
      </div>
      <footer className="fy-voicesheet__foot">
        <span className="fy-mono">nothing here assigns · review first</span>
        <span className="fy-voicesheet__push" />
        <Button variant="ghost" onClick={onClose}>Close</Button>
      </footer>
      <p className="fy-vsnotice" role="status" aria-live="polite">{notice}</p>
    </div>
  </>;
}
