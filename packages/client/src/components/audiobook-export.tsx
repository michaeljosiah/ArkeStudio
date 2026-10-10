import { useEffect, useRef, useState, type ReactNode } from "react";
import { audiobookScopeKey, clockTime, DEFAULT_VIDEO_OPTIONS, ulid, type AudiobookListening, type AudiobookScope, type AudiobookVideoOptions, type AudiobookVideoResult, type ProductionBundle, type VideoShape } from "@arke-studio/contracts";
import {
  exportAudiobookPlayer,
  exportAudiobookVideo,
  listWebPackages,
  openAudiobookListening,
  openExportsFolder,
  subscribeAudiobookExported,
  subscribeAudiobookListening,
  subscribeAudiobookVideoExported,
  subscribeWebPackages,
  useAudiobookRecords,
  useExports,
  useStore,
  type AudiobookExported,
  type WebPackagesListed,
} from "../lib/store.js";
import { useMediaQuery } from "../lib/media-query.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { PageSheet } from "./page-sheet.js";
import { WordTimingControl } from "./audiobook-word-timing.js";
import { Button } from "./ui.js";
import { Folder, Seg, SHAPES, SUBTITLES, VideoFiles, VideoOptionRows, VideoPreview, VideoExportPreview, megabytes, useVideoState, videoQuote, wholeChapters, withShape } from "./audiobook-video.js";

/**
 * Export audiobook (design turns 186e and 197, SPEC-047 R-72): the book as the player — a web
 * package — or as a video, chosen from three kinds as 197a draws them. What either would hold is
 * read from the same listening plan the player plays, so the sheet's counts are the export's.
 *
 * Chapter files (146d) are SPEC-047's own export, not yet built (issue 1336): drawn where 197a
 * draws it, and not offered — it says so on the card.
 */

/** What a package of this plan would hold: the chapters read whole, of all of them, and each picture once. */
export function packageCounts(listening: AudiobookListening): { chapters: number; of: number; pictures: number } {
  const whole = listening.chapters.filter((chapter) => chapter.state === "read" && chapter.blocks.length > 0);
  const pictures = new Set<string>([...(listening.cover !== null ? [listening.cover] : []), ...whole.flatMap((chapter) => [...chapter.pictures.map((picture) => picture.file), ...(chapter.opening !== null ? [chapter.opening] : [])])]);
  return { chapters: whole.length, of: listening.chapters.length, pictures: pictures.size };
}

type Kind = "player" | "video";

/** `2026-10-04 20:41` in this device's time. */
const stamp = (iso: string) => {
  const at = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return Number.isNaN(at.getTime()) ? iso.slice(0, 16).replace("T", " ") : `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

export function AudiobookExportSheet({ worldId, production, chapterId, onReadRemaining, onClose }: { worldId: string; production: ProductionBundle; chapterId?: string; onReadRemaining?: (blockNumbers: number[]) => void; onClose: () => void }) {
  const connection = useStore().connection;
  const exportsState = useExports();
  const phone = useMediaQuery("(max-width: 599px)");
  const remote = isRemoteSession();
  const asked = useRef<string | null>(null);
  const exporting = useRef<string | null>(null);
  /** The package being made, by its id: found again by listing the packages if a reconnect lost the answer. */
  const making = useRef<string | null>(null);
  const listing = useRef<string | null>(null);
  const [kind, setKind] = useState<Kind>("player");
  const [plan, setPlan] = useState<AudiobookListening | null>(null);
  const [planRefused, setPlanRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AudiobookExported["result"] | null>(null);
  // The video (197): its options, whether the subtitles were chosen (else they follow the shape),
  // the render in hand by its export id, and what it made.
  const [options, setOptions] = useState<AudiobookVideoOptions>(() => ({ ...DEFAULT_VIDEO_OPTIONS, scope: chapterId === undefined ? { kind: "book" } : { kind: "chapter", chapterId } }));
  const scope: AudiobookScope = options.scope ?? { kind: "book" };
  const scopeKey = audiobookScopeKey(scope);
  const records = useAudiobookRecords();
  const prefix = `${worldId}/${production.meta.id}/`;
  const planStamp = JSON.stringify([
    production.chapters.filter((chapter) => scope.kind === "book" || chapter.id === scope.chapterId).map((chapter) => [chapter.id, chapter.version, chapter.audiobook]),
    Object.entries(records).filter(([key]) => scope.kind === "chapter" ? key === prefix + scope.chapterId : key.startsWith(prefix)).map(([key, record]) => [key, record.seq]),
  ]);
  const [subtitlesChosen, setSubtitlesChosen] = useState(false);
  const [rendering, setRendering] = useState<string | null>(null);
  const [video, setVideo] = useState<AudiobookVideoResult | null>(null);
  const [again, setAgain] = useState(0);
  const [preview, setPreview] = useState(false);
  const [wordTimingReady, setWordTimingReady] = useState(false);
  const highlights = options.captionStyle === "word" && (options.subtitles === "burn-in" || options.subtitles === "burn-in+sidecar");
  const state = useVideoState(worldId, production.meta.id, options, connection === "open" && kind === "video", again);
  const quote = videoQuote(state, options);
  useEffect(() => {
    const offPlan = subscribeAudiobookListening((answer) => {
      if (answer.requestId !== asked.current) return;
      setPlan(answer.listening);
      setPlanRefused(answer.refused ?? null);
    });
    const offExport = subscribeAudiobookExported((answer) => {
      if (answer.requestId !== exporting.current) return;
      exporting.current = null;
      making.current = null;
      setBusy(false);
      setResult(answer.result);
    });
    // A connection dropped mid-export loses the one answer it would have heard (codex on PR 1498):
    // on the way back the packages are listed, and the one with this export's id is the answer.
    const offPackages = subscribeWebPackages((answer) => {
      if (answer.requestId !== listing.current || making.current === null) return;
      const id = making.current;
      const found = answer.packages.find((entry) => entry.dir.endsWith(`-${id}`));
      if (found === undefined) return;
      exporting.current = null;
      making.current = null;
      setBusy(false);
      setResult({ ok: true, id, dir: found.dir, file: `${found.dir}/player.html`, chapters: 0, pictures: 0, bytes: 0, joined: false, ...(found.scope !== undefined ? { scope: found.scope } : {}), ...(found.chapterIds !== undefined ? { chapterIds: found.chapterIds } : {}) });
    });
    asked.current = openAudiobookListening(worldId, production.meta.id, scope);
    return () => {
      offPlan();
      offExport();
      offPackages();
    };
  }, [worldId, production.meta.id, scopeKey]);
  // A scoped read's quote can cover this sheet while it keeps its options. Saved takes update
  // readiness here without replacing the sheet or navigating away from the originating chapter.
  useEffect(() => {
    if (connection !== "open") return;
    const timer = setTimeout(() => {
      asked.current = openAudiobookListening(worldId, production.meta.id, scope);
      setAgain((value) => value + 1);
    }, 1200);
    return () => clearTimeout(timer);
  }, [worldId, production.meta.id, scopeKey, connection, planStamp]);
  useEffect(
    () =>
      subscribeAudiobookVideoExported((answer) => {
        if (answer.exportId !== rendering) return;
        setRendering(null);
        setVideo(answer.result);
        setAgain((n) => n + 1);
      }),
    [rendering],
  );
  useEffect(() => {
    if (connection === "open" && making.current !== null) listing.current = listWebPackages(worldId);
  }, [connection, worldId]);
  // A render the window lost the answer to still reports in Activity: its finished files land on
  // the export's own entry, and the sheet takes them from there.
  const held = rendering === null ? undefined : exportsState[rendering];
  useEffect(() => {
    if (rendering === null || held === undefined) return;
    if (held.made !== undefined && held.status === "done") {
      setRendering(null);
      setVideo({ ok: true, ...held.made, made: 0, renderedAt: new Date().toISOString() });
    } else if (held.status === "cancelled" || held.status === "failed") {
      setRendering(null);
      setVideo({ ok: false, blockers: [held.status === "cancelled" ? "the render was cancelled" : (held.error ?? "the render failed")] });
    }
  }, [rendering, held]);
  const counts = plan === null ? null : packageCounts(plan);
  const start = () => {
    setBusy(true);
    setResult(null);
    making.current = `ab_${ulid()}`;
    exporting.current = exportAudiobookPlayer(worldId, production.meta.id, making.current, scope);
    if (exporting.current === null) {
      making.current = null;
      setBusy(false);
    }
  };
  const render = () => {
    const id = `vb_${ulid()}`;
    setVideo(null);
    if (exportAudiobookVideo(worldId, production.meta.id, id, options) !== null) setRendering(id);
  };
  const shape = (next: VideoShape) => setOptions(withShape(options, next, subtitlesChosen));
  const choose = (next: AudiobookVideoOptions) => {
    if (next.subtitles !== options.subtitles) setSubtitlesChosen(true);
    setOptions(next);
  };
  const folder = result?.ok === true ? result.dir.slice("exports/".length) : null;
  const whole = plan === null ? [] : wholeChapters(plan);
  const incomplete = scope.kind === "chapter" && plan !== null && whole.length !== 1;
  const omitted = scope.kind === "book" ? (plan?.chapters.filter((chapter) => chapter.state !== "read" || chapter.blocks.length === 0) ?? []) : [];
  const missing = plan?.chapters.flatMap((chapter) => chapter.gaps.flatMap((gap) => Array.from({ length: gap.to - gap.from + 1 }, (_, index) => gap.from + index))) ?? [];
  const length = whole.reduce((sum, chapter) => sum + chapter.seconds, 0);
  const finished = kind === "video" && video?.ok === true ? video : null;
  const progress = held?.status === "running" ? Math.round(held.percent) : null;
  const renderable = connection === "open" && quote !== null && !quote.empty && rendering === null && !incomplete && plan !== null && planRefused === null && (state?.blockers?.length ?? 0) === 0 && (!highlights || wordTimingReady);
  const sub = finished !== null ? `video · ${finished.made === 0 ? "nothing changed · " : ""}rendered ${stamp(finished.renderedAt)}` : plan === null ? "…" : `${whole.length} of ${plan.chapters.length} chapter${plan.chapters.length === 1 ? "" : "s"} read · ${clockTime(length)}`;
  const blockers = kind === "video" ? (video?.ok === false ? video.blockers : state?.blockers ?? []) : [];
  const selectScope = (kind: AudiobookScope["kind"]) => {
    if (busy || rendering !== null || (kind === "chapter" && chapterId === undefined)) return;
    const next: AudiobookScope = kind === "chapter" ? { kind, chapterId: chapterId! } : { kind };
    setOptions({ ...options, scope: next, ...(kind === "chapter" ? { files: "chapter" } : {}) });
    setPlan(null);
    setPlanRefused(null);
    setResult(null);
    setVideo(null);
  };
  const scopeRow = (
    <div className="fy-abv-opt fy-abv-scope" data-testid="audiobook-export-scope">
      <b>Scope</b>
      {chapterId === undefined ? <span>Whole book</span> : <Seg label="Scope" value={scope.kind} options={[["chapter", "This chapter"], ["book", "Whole book"]] as const} onChange={selectScope} disabled={busy || rendering !== null} />}
      {scope.kind === "chapter" && <span className="fy-abv-scope-title">{production.chapters.find((chapter) => chapter.id === scope.chapterId)?.title ?? scope.chapterId}</span>}
    </div>
  );
  const scopeReadiness = (
    <>
      {planRefused !== null && <div className="fy-abv-warn" role="status">{planRefused}</div>}
      {incomplete && <div className="fy-abv-scope-notice" role="status" data-testid="audiobook-export-incomplete">
        <b>This chapter is not ready to export</b>
        <span>{missing.length > 0 ? `${missing.length} block${missing.length === 1 ? "" : "s"} still to read.` : "The chapter needs a complete saved reading."}</span>
        {onReadRemaining !== undefined && missing.length > 0 && <button type="button" className="fy-abv-btn" disabled={connection !== "open"} onClick={() => onReadRemaining(missing)}>Read remaining blocks…</button>}
      </div>}
      {omitted.length > 0 && <div className="fy-abv-scope-notice" data-testid="audiobook-export-omitted">
        <b>{omitted.length} incomplete chapter{omitted.length === 1 ? "" : "s"} will be left out</b>
        <span>{omitted.map((chapter) => chapter.title).join(" · ")}</span>
      </div>}
    </>
  );

  const playerRows = (
    <>
      <div className="fy-abv-opt">
        <b>Chapters</b>
        <span>{counts === null ? "…" : `${counts.chapters} of ${counts.of} · read whole`}</span>
      </div>
      <div className="fy-abv-opt">
        <b>Pictures</b>
        <span>{counts === null ? "…" : `${counts.pictures} · cover where a chapter has none`}</span>
      </div>
    </>
  );
  const playerLines = (
    <>
      {busy && <div className="fy-abv-note" data-testid="audiobook-export-busy">exporting…</div>}
      {result?.ok === false && result.blockers.map((blocker) => <div key={blocker} className="fy-abv-warn">{blocker}</div>)}
      {result?.ok === true && (
        <div className="fy-abv-note" data-testid="audiobook-export-done">
          {result.chapters > 0 ? `${result.dir} · ${result.chapters} chapter${result.chapters === 1 ? "" : "s"} · ${megabytes(result.bytes)}` : result.dir}
        </div>
      )}
    </>
  );
  const playerFoot = (
    <div className="fy-abv-foot">
      <span className="grow" />
      {result?.ok === true ? (
        <>
          {!remote && (
            <button type="button" className="fy-abv-btn" onClick={() => folder !== null && openExportsFolder(worldId, folder)}>
              <Folder />
              Show in folder
            </button>
          )}
          <button type="button" className="fy-abv-btn pri" onClick={onClose}>
            Done
          </button>
        </>
      ) : (
        <>
          <button type="button" className="fy-abv-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="fy-abv-btn pri" style={phone ? { flex: 1 } : undefined} disabled={busy || connection !== "open" || counts === null || counts.chapters === 0 || incomplete || planRefused !== null} onClick={start} data-testid="audiobook-export-start">
            Export
          </button>
        </>
      )}
    </div>
  );
  const finishedBody = finished === null ? null : (
    <>
      <div className="fy-abv-est">
        <b>
          {finished.files.length} video{finished.files.length === 1 ? "" : "s"} · {megabytes(finished.files.reduce((sum, file) => sum + file.bytes, 0))}
        </b>
        <span className="m">{finished.dir.slice("exports/".length) === "" ? finished.dir : `${finished.dir}/`}</span>
        <span style={{ flex: 1 }} />
        {!remote && !phone && (
          <button type="button" className="fy-abv-btn" onClick={() => openExportsFolder(worldId, finished.dir.slice("exports/".length))}>
            <Folder />
            Show in folder
          </button>
        )}
        {!phone && (
          <button type="button" className="fy-abv-btn" onClick={render} data-testid="audiobook-video-again">
            Render again
          </button>
        )}
      </div>
      <div>
        <VideoFiles worldId={worldId} dir={finished.dir} files={finished.files} />
      </div>
      <div className="fy-abv-foot" style={{ marginTop: 4 }}>
        <span className="grow" />
        <button type="button" className="fy-abv-btn pri" style={phone ? { flex: 1, height: 44, justifyContent: "center" } : undefined} onClick={onClose}>
          Done
        </button>
      </div>
    </>
  );
  const estimate = (onMachine: boolean): ReactNode => (
    <div className="fy-abv-est" data-testid="audiobook-video-estimate">
      <b>{quote === null ? "…" : `${quote.price}${onMachine && !quote.price.endsWith("already rendered") ? " on this machine" : ""}`}</b>
      <span className="m">{progress !== null && held?.video !== undefined ? `rendering · ${progress}%` : remote ? "renders on the desktop" : (quote?.meta ?? "")}</span>
    </div>
  );

  const timingControl = <WordTimingControl worldId={worldId} productionId={production.meta.id} chapters={scope.kind === "chapter" ? [scope.chapterId] : undefined} enabled={highlights} onReady={(ready) => { setWordTimingReady(ready); if (ready) { setAgain((n) => n + 1); asked.current = openAudiobookListening(worldId, production.meta.id, scope); } }} usePhrases={() => choose({ ...options, captionStyle: "phrases" })} />;
  const framePreview = <VideoExportPreview plan={plan} options={options} ready={wordTimingReady} onPreview={() => setPreview(true)} />;
  if (phone) {
    // One column, from the foot, 44-high presses (197f). The kind is a row of its own here: the
    // phone frame draws Video alone, and the player package must stay reachable from a phone.
    return (
      <>
      <PageSheet open={!preview} onClose={onClose} title="Export audiobook" headless className="fy-abv-modal fy-abv-modal--phone">
        <div className="fy-abv-psheet" data-testid="audiobook-export">
          <div className="fy-abv-grab" />
          <h3 id="audiobook-export-title" tabIndex={-1}>Export · {kind === "video" ? "Video" : "Audiobook player"}</h3>
          {finished !== null ? (
            finishedBody
          ) : (
            <>
              <div className="fy-abv-opts">
                {scopeRow}
                <div className="fy-abv-opt">
                  <b>Export</b>
                  <Seg label="Export" value={kind} options={[["player", "Player"], ["video", "Video"]] as const} onChange={setKind} />
                </div>
                {kind === "video" && !incomplete && <>
                  {framePreview}
                  {scope.kind === "book" && <div className="fy-abv-opt"><b>Files</b><Seg label="Files" value={options.files} options={[["chapter", "One a chapter"], ["book", "Book"]] as const} onChange={(files) => choose({ ...options, files })} /></div>}
                  <div className="fy-abv-opt"><b>Subtitles</b><Seg label="Subtitles" value={options.subtitles} options={SUBTITLES} onChange={(subtitles) => choose({ ...options, subtitles })} /></div>
                  {(options.subtitles === "burn-in" || options.subtitles === "burn-in+sidecar") && <><div className="fy-abv-opt"><b>Style</b><Seg label="Caption style" value={options.captionStyle ?? "phrases"} options={[["phrases", "Phrases"], ["word", "Highlight current word"]] as const} onChange={(captionStyle) => choose({ ...options, captionStyle })} /></div>{timingControl}</>}
                  <div className="fy-abv-opt"><b>Shape</b><select aria-label="Shape" value={options.shape} onChange={(event) => shape(event.target.value as VideoShape)}>{SHAPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></div>
                  {(options.subtitles === "burn-in" || options.subtitles === "burn-in+sidecar") && <div className="fy-abv-opt"><b>Size</b><Seg label="Size" value={options.captionSize} options={[["s", "S"], ["m", "M"], ["l", "L"]] as const} onChange={(captionSize) => choose({ ...options, captionSize })} /></div>}
                </>}
                {kind === "player" && playerRows}
              </div>
              {scopeReadiness}
              {kind === "video" ? (
                <>
                  {estimate(false)}
                  {blockers.map((blocker) => <div key={blocker} className="fy-abv-warn">{blocker}</div>)}
                  <div className="fy-abv-foot">
                  <button type="button" className="fy-abv-btn" onClick={onClose}>Cancel</button>
                  <button type="button" className="fy-abv-btn pri" disabled={!renderable} onClick={render} data-testid="audiobook-video-render">
                    {highlights && !wordTimingReady ? "Prepare timing first" : quote?.press ?? "Render"}
                  </button>
                  </div>
                </>
              ) : (
                <>
                  {playerLines}
                  {playerFoot}
                </>
              )}
            </>
          )}
        </div>
      </PageSheet>
      {preview && plan !== null && <VideoPreview worldId={worldId} productionId={production.meta.id} plan={plan} options={options} onClose={() => setPreview(false)} />}
      </>
    );
  }

  return (
    <>
      {/* The preview stands in the sheet's place (197b), and Done comes back to it. */}
      <PageSheet open={!preview} onClose={onClose} title={`Export audiobook · ${production.meta.title}`} headless className={kind === "video" ? "fy-abv-modal fy-abv-modal--video" : "fy-abv-modal"}>
        <div className="fy-abv-sheet">
        <h3 id="audiobook-export-title" tabIndex={-1}>Export audiobook · {production.meta.title}</h3>
        <div className="fy-abv-sub">{sub}</div>
        {finished !== null ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="audiobook-export">
            <div className="fy-abv-opts">{scopeRow}</div>
            {finishedBody}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }} data-testid="audiobook-export">
            <div className="fy-abv-opts">{scopeRow}</div>
            <div className="fy-abv-kinds" role="radiogroup" aria-label="Export">
              <button type="button" role="radio" aria-checked={kind === "player"} className={kind === "player" ? "fy-abv-kind on" : "fy-abv-kind"} onClick={() => setKind("player")}>
                <span className="r" />
                <div>
                  <b>Audiobook player</b>
                  <span>player.html · web package</span>
                </div>
              </button>
              <button type="button" role="radio" aria-checked={false} className="fy-abv-kind" disabled title="Not built yet: issue 1336" aria-describedby="audiobook-export-chapter-files">
                <span className="r" />
                <div>
                  <b>Chapter files</b>
                  <span id="audiobook-export-chapter-files">Retail · no pictures</span>
                </div>
              </button>
              <button type="button" role="radio" aria-checked={kind === "video"} className={kind === "video" ? "fy-abv-kind on" : "fy-abv-kind"} onClick={() => setKind("video")} data-testid="audiobook-export-video">
                <span className="r" />
                <div>
                  <b>Video</b>
                  <span>MP4 · pictures · captions</span>
                </div>
              </button>
            </div>
            {scopeReadiness}
            {kind === "player" ? (
              <>
                <div className="fy-abv-opts">{playerRows}</div>
                {playerLines}
                {playerFoot}
              </>
            ) : (
              <>
                {!incomplete && <div className="fy-abv-exportcols"><div className="fy-abv-opts">
                  <VideoOptionRows options={options} setOptions={choose} plan={plan} split={quote?.split ?? "…"} onShape={shape} />
                  {timingControl}<p className="fy-abv-note">Sidecar captions remain plain text.</p>
                </div><aside>{framePreview}{estimate(true)}</aside></div>}
                {blockers.map((blocker) => <div key={blocker} className="fy-abv-warn">{blocker}</div>)}
                <div className="fy-abv-foot">
                  <span className="grow" />
                  <button type="button" className="fy-abv-btn" onClick={onClose}>
                    Cancel
                  </button>
                  <button type="button" className="fy-abv-btn pri" disabled={!renderable} onClick={render} data-testid="audiobook-video-render">
                    {highlights && !wordTimingReady ? "Prepare timing first" : quote?.press ?? "Render"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        </div>
      </PageSheet>
      {preview && plan !== null && (
        <VideoPreview
          worldId={worldId}
          productionId={production.meta.id}
          plan={plan}
          options={options}
          onClose={() => {
            setPreview(false);
            // A focus moved in the preview is the book's now: read the plan again, and what a render would make.
            asked.current = openAudiobookListening(worldId, production.meta.id, scope);
            setAgain((n) => n + 1);
          }}
        />
      )}
    </>
  );
}

const KIND: Record<WebPackagesListed["packages"][number]["kind"], string> = { interactive: "Interactive", "visual-novel": "Visual novel", audiobook: "Audiobook", "audiobook-video": "Video" };

/** The open world's web packages in Publications (186e), and the audiobook's videos beside them (197e). */
export function WebPackages({ worldId }: { worldId: string }) {
  const connection = useStore().connection;
  const asked = useRef<string | null>(null);
  const [packages, setPackages] = useState<WebPackagesListed["packages"] | null>(null);
  useEffect(() => {
    const off = subscribeWebPackages((answer) => {
      if (answer.requestId === asked.current) setPackages(answer.packages);
    });
    if (connection === "open") asked.current = listWebPackages(worldId);
    return off;
  }, [worldId, connection]);
  if (packages === null || packages.length === 0) return null;
  return (
    <section className="fy-publication-packages" aria-label="Web packages" data-testid="web-packages">
      <h2 className="fy-h2">Web packages</h2>
      {packages.map((entry) => (
        <div key={entry.dir} className="fy-publication-job" data-testid="web-package">
          <strong>{entry.title}</strong>
          <span className="fy-mono">{KIND[entry.kind]} · {entry.exportedAt.slice(0, 10)}</span>
          <div className="fy-publication-actions">
            <Button variant="ghost" onClick={() => openExportsFolder(worldId, entry.dir.slice("exports/".length))}>
              Show in folder
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}
