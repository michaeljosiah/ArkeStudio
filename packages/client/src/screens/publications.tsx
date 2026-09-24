import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { PublicationJob, PublicationPlayback } from "@arke-studio/contracts";
import { Button } from "../components/ui.js";
import { AppChrome } from "../components/chrome.js";
import { readPublicationPreference, savePublicationPreference } from "../lib/publication-preferences.js";

/** Native controls keep keyboard/seek/volume behavior; preferences never write into the edition. */
export function PublicationVideo({ publication }: { publication: PublicationPlayback }) {
  const video = useRef<HTMLVideoElement>(null);
  const { manifest } = publication;
  const key = `arke-publication:${manifest.id}:${publication.manifestSha256}`;
  const saved = useRef(readPublicationPreference(key, manifest.content.textTracks.find(track => track.default)?.asset ?? ""));
  const [caption, setCaption] = useState(() => manifest.content.textTracks.some(track => track.asset === saved.current.caption) ? saved.current.caption : "");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    if (element.canPlayType(publication.mediaType) === "") setError("This player does not support the publication’s video codec.");
    else setSupported(true);
  }, [publication.mediaType]);
  const applyCaption = () => {
    const tracks = video.current?.textTracks;
    if (!tracks) return;
    manifest.content.textTracks.forEach((track, index) => { if (tracks[index]) tracks[index]!.mode = track.asset === caption ? "showing" : "disabled"; });
  };
  useEffect(applyCaption, [caption, manifest]);
  useEffect(() => {
    const tracks = video.current?.textTracks;
    if (!tracks?.addEventListener) return;
    // The native fullscreen menu can change tracks too. Keep the explicit selector and saved
    // preference in step with it instead of restoring a stale choice on the next open.
    const changed = () => {
      const index = Array.from(tracks).findIndex(track => track.mode === "showing");
      setCaption(manifest.content.textTracks[index]?.asset ?? "");
    };
    tracks.addEventListener("change", changed);
    return () => tracks.removeEventListener("change", changed);
  }, [supported, manifest]);
  const remember = () => {
    savePublicationPreference(key, { time: video.current && video.current.readyState >= 1 ? video.current.currentTime : saved.current.time, caption });
  };
  useEffect(remember, [caption]);
  return <div className="fy-publication-video">
    <video ref={video} controls crossOrigin="anonymous" preload="metadata" aria-label={manifest.title}
      src={supported ? publication.assets[manifest.content.video] : undefined}
      onLoadedMetadata={() => {
        const element = video.current!;
        if (saved.current.time < element.duration - 1) element.currentTime = saved.current.time;
        applyCaption();
      }} onPause={remember} onSeeked={remember} onTimeUpdate={remember}
      onError={() => setError("The video could not be decoded or its media became unavailable.")}>
      {supported && manifest.content.textTracks.map(track => <track key={track.asset} src={publication.assets[track.asset]} kind={track.kind}
        label={track.label} srcLang={track.language} default={track.asset === saved.current.caption} onLoad={applyCaption}
        onError={() => setError(`Could not load ${track.label}.`)} />)}
    </video>
    <label className="fy-publication-field">Captions and subtitles
      <select value={caption} onChange={event => setCaption(event.target.value)}>
        <option value="">Off</option>
        {manifest.content.textTracks.map(track => <option key={track.asset} value={track.asset}>{track.label} · {track.language} · {track.kind === "captions" ? "CC" : "subtitles"}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function PublicationJobs({ worldId, productionId, onOpen }: { worldId?: string; productionId?: string; onOpen?: (id: string) => void }) {
  const [jobs, setJobs] = useState<PublicationJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await window.arke?.publications?.list();
        if (!active || !result) return;
        if (result.ok) setJobs(result.value); else setError(result.reason);
      } catch { if (active) setError("Could not read publication jobs."); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 1000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const action = async (kind: "retry" | "reveal" | "cancel", id: string) => {
    try {
      const result = await window.arke?.publications?.[kind](id);
      if (result && !result.ok) setError(result.reason);
    } catch { setError("Publication action failed."); }
  };
  const mine = jobs.filter(job => (!worldId || job.worldId === worldId) && (!productionId || job.productionId === productionId)).reverse();
  return <div className="fy-publication-jobs" aria-label="Publication jobs">
    {error && <p role="alert">{error}</p>}
    {mine.map(job => <div className="fy-publication-job" key={job.operationId}>
      <strong>{job.title}</strong><span role="status">{job.status} · {job.phase}</span>
      {job.reason && <span>{job.reason}</span>}
      <div className="fy-publication-actions">
        {job.status === "running" ? <Button variant="ghost" onClick={() => void action("cancel", job.operationId)}>Cancel</Button> :
          job.status === "completed" ? <>
            {onOpen ? <Button onClick={() => onOpen(job.operationId)}>Play</Button> : <Link to={`/publications?operation=${job.operationId}`}>Play</Link>}
            <Button variant="ghost" onClick={() => void action("reveal", job.operationId)}>Show in folder</Button>
          </> : job.retryable !== false ? <Button variant="ghost" onClick={() => void action("retry", job.operationId)}>Check or retry</Button> : null}
      </div>
    </div>)}
  </div>;
}

export function PublicationsScreen() {
  const [params, setParams] = useSearchParams();
  const [publication, setPublication] = useState<PublicationPlayback | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);
  const opening = useRef(false);
  const bridge = typeof window === "undefined" ? undefined : window.arke?.publications;
  const open = async (kind: "directory" | "zip" | { operationId: string }) => {
    if (!bridge || opening.current) return;
    opening.current = true;
    setBusy(true); setError(null);
    try {
      const result = await bridge.open(kind);
      if (!alive.current) { if (result.ok) await bridge.close(result.value.sessionId); return; }
      if (result.ok) setPublication(result.value);
      else if (!result.cancelled) setError(result.reason);
    } catch { if (alive.current) setError("Could not open the publication."); }
    finally { opening.current = false; if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, [bridge]);
  useEffect(() => () => {
    // The old video has unmounted before its pinned bytes are released. Cancelled/failed
    // replacements never change this dependency, so the current movie remains playable.
    if (publication) void bridge?.close(publication.sessionId).catch(() => {});
  }, [bridge, publication?.sessionId]);
  useEffect(() => {
    const id = params.get("operation");
    if (id && bridge) { setParams({}, { replace: true }); void open({ operationId: id }); }
  }, [params, bridge]);
  return <div data-screen="publications" className="fy-app">
    <AppChrome back={{ label: "Worlds", to: "/worlds" }} context={{ label: "Publications" }} />
    <main className="fy-publications">
    <h1 className="fy-h1">{publication?.manifest.title ?? "Publications"}</h1>
    <p>{publication ? publication.manifest.edition : "Open a finished edition. No world needs to be open."}</p>
    <div className="fy-publication-actions">
      <Button disabled={!bridge || busy} onClick={() => void open("zip")}>Open ZIP</Button>
      <Button variant="ghost" disabled={!bridge || busy} onClick={() => void open("directory")}>Open folder</Button>
    </div>
    {!bridge && <p>Open publications in the desktop app.</p>}
    {busy && <p role="status">Verifying publication…</p>}
    {error && <p role="alert">{error}</p>}
    {publication && <PublicationVideo key={publication.sessionId} publication={publication} />}
    <PublicationJobs onOpen={id => void open({ operationId: id })} />
    </main>
  </div>;
}
