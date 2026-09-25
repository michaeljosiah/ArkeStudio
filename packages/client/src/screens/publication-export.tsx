import { useState } from "react";
import { PRESETS, productionFrameRate, VideoPublicationRequestSchema, buildVideoPublicationPlan, type ProductionBundle, type WorldBundle, type VideoPublicationRequest } from "@arke-studio/contracts";
import { Button } from "../components/ui.js";
import { subtitleTracksOf } from "./editor-subtitles.js";
import { PublicationJobs } from "./publications.js";

/** The publication has its own options: caption sidecars never inherit burn-in export choices. */
export function PublicationExport({ worldId, production, world, preset, disabled }: {
  worldId: string; production: ProductionBundle; world: WorldBundle | null; preset: VideoPublicationRequest["preset"]; disabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState(production.meta.title);
  const [edition, setEdition] = useState("First edition");
  const [language, setLanguage] = useState("en");
  const [format, setFormat] = useState<"directory" | "zip">("zip");
  const [scope, setScope] = useState("");
  const [selected, setSelected] = useState<VideoPublicationRequest["textTracks"]>([]);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const timeline = production.timeline;
  const tracks = timeline?.status === "ready" ? subtitleTracksOf(timeline.timeline) : [];
  const bridge = typeof window === "undefined" ? undefined : window.arke?.publications;
  if (!bridge) return null;
  const candidate = VideoPublicationRequestSchema.safeParse({ productionId: production.meta.id,
    id: "urn:uuid:00000000-0000-4000-8000-000000000000", title, edition, language, preset,
    scope: scope ? { kind: "episode", episodeId: scope } : { kind: "production" },
    timelineRevision: timeline?.status === "ready" ? timeline.timeline.revision : null, textTracks: selected });
  let refusal: string | null = candidate.success ? null : "Enter a title, edition, language tag and track labels.";
  if (candidate.success) {
    try {
      const plan = buildVideoPublicationPlan({ production, artifacts: world?.artifacts ?? [], timeline: timeline ?? { status: "absent" } }, candidate.data);
      if (!plan.ok) refusal = plan.reason;
    } catch { refusal = "The timeline is not ready to publish."; }
  }
  const start = async () => {
    if (!candidate.success || refusal || disabled || busy) return;
    setBusy(true); setNote(null);
    try {
      const result = await bridge.start({ worldId, request: { ...candidate.data, id: `urn:uuid:${crypto.randomUUID()}` }, format });
      setNote(result.ok ? "Publication started. You can follow it here or in Publications." : result.reason);
    } catch { setNote("Could not start the publication."); }
    finally { setBusy(false); }
  };
  return <section className="fy-publication-form">
    <Button variant="ghost" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>Publish playable edition</Button>
    {expanded && <>
      <p>A clean movie with selectable caption tracks.</p>
      <p>Output: {PRESETS[preset].width} × {PRESETS[preset].height} · {productionFrameRate(production.meta)} fps · {preset === "review-cut" ? "Review quality" : preset === "social-excerpt" ? "Social quality" : "Master quality"}. Change the preset in Resolution above.</p>
      <label className="fy-publication-field">Title<input value={title} onChange={e => setTitle(e.target.value)} /></label>
      <label className="fy-publication-field">Edition<input value={edition} onChange={e => setEdition(e.target.value)} /></label>
      <label className="fy-publication-field">Language<input value={language} onChange={e => setLanguage(e.target.value)} placeholder="en-GB" /></label>
      <label className="fy-publication-field">Container<select value={format} onChange={e => setFormat(e.target.value as typeof format)}><option value="zip">ZIP</option><option value="directory">Folder</option></select></label>
      <label className="fy-publication-field">Scope<select value={scope} onChange={e => setScope(e.target.value)}><option value="">Full production</option>{production.episodes.map(episode => <option key={episode.id} value={episode.id}>{episode.title}</option>)}</select></label>
      {tracks.map(track => {
        const chosen = selected.find(item => item.trackId === track.id);
        const change = (patch: Partial<NonNullable<typeof chosen>>) => setSelected(items => items.map(item => item.trackId === track.id ? { ...item, ...patch } : patch.default ? { ...item, default: false } : item));
        return <fieldset key={track.id}><legend>{track.name} · {track.language}</legend>
          <label><input type="checkbox" checked={!!chosen} onChange={e => setSelected(items => e.target.checked ? [...items, { trackId: track.id, label: track.name, kind: "subtitles", default: false }] : items.filter(item => item.trackId !== track.id))} /> Include track</label>
          {chosen && <>
            <label className="fy-publication-field">Track label<input value={chosen.label} onChange={e => change({ label: e.target.value })} /></label>
            <label className="fy-publication-field">Kind<select value={chosen.kind} onChange={e => change({ kind: e.target.value as "captions" | "subtitles" })}><option value="subtitles">Subtitles — dialogue</option><option value="captions">Captions — dialogue and sound cues</option></select></label>
            <label><input type="checkbox" checked={chosen.default} onChange={e => change({ default: e.target.checked })} /> Show by default</label>
          </>}
        </fieldset>;
      })}
      {refusal && <p role="status">{refusal}</p>}
      <Button disabled={disabled || busy || !!refusal} onClick={() => void start()}>{busy ? "Starting…" : "Choose folder and publish"}</Button>
      {note && <p role="status">{note}</p>}
    </>}
    <PublicationJobs worldId={worldId} productionId={production.meta.id} />
  </section>;
}
