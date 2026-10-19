import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { DEFAULT_STORY_PDF_SETTINGS, StoryPublicationSettingsSchema, worldImageReferences, type ProductionBundle, type StoryEdition, type StoryPublicationReview, type StoryPublicationSettings, type StoryStyleFinding, type StoryPublishAction } from "@arke-studio/contracts";
import { listStoryPublications, publishStory, subscribeStoryPublications, useStore, useWorld } from "../lib/store.js";
import { storyEditionMediaUrl, storyPreviewMediaUrl } from "../lib/media.js";
import { PageSheet } from "./page-sheet.js";
import { Button } from "./ui.js";
import { StoryPdfPreview } from "./story-pdf-preview.js";
import { waitForChapterSaves } from "../lib/chapter-drafts.js";

const steps = ["Edition", "Chapters", "Formatting & style", "Preview", "Files"] as const;
type Step = typeof steps[number];
export function StoryEditionFiles({ edition }: { edition: StoryEdition }) {
  const [saved, setSaved] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<"kindle" | "audio" | null>(null);
  return <div className="fy-publish-files">
    {saved && <p role="status">{saved}</p>}
    {edition.error && <p role="alert">{edition.error}</p>}
    {edition.files.map(file => <article className="fy-publish-card" key={file.format}>
      <div><strong>{file.format === "pdf" ? "Book · PDF" : file.format === "epub" ? "Book · EPUB" : "Audiobook · M4B"}</strong><p>{(file.bytes / 1024 / 1024).toFixed(1)} MB · {edition.settings.chapterIds.length} chapters{file.pdf ? ` · ${file.pdf.pageCount} pages` : ""}</p></div>
      {edition.status === "ready" && <a className="fy-publish-link" href={storyEditionMediaUrl(edition.id, file.name)} download={edition.settings.title + "." + file.format} onClick={async event => {
        const host = window.arke?.saveStoryPublication;
        if (!host) return;
        event.preventDefault(); setSaved(null);
        const result = await host(edition.id, file.name).catch(() => ({ ok: false, reason: "The file could not be saved." }));
        if (result.ok) setSaved("File saved. Import or share it when you’re ready.");
        else if (!("cancelled" in result) || !result.cancelled) setSaved(result.reason ?? "The file could not be saved.");
      }}>Save {file.format.toUpperCase()}</a>}
      {edition.error && window.arke?.locateStoryPublication && <Button onClick={async () => {
        const result = await window.arke!.locateStoryPublication!(edition.id, file.name);
        setSaved(result.ok ? "Matching file restored. You can save it again." : result.cancelled ? null : result.reason ?? "The file could not be restored.");
      }}>Locate {file.format.toUpperCase()}</Button>}
      {edition.status === "ready" && file.format !== "pdf" && <Button variant="ghost" onClick={() => setHandoff(file.format === "epub" ? "kindle" : "audio")}>{file.format === "epub" ? "Read on Kindle" : "Listen on your phone"}</Button>}
      {file.format === "m4b" && <audio controls preload="none" aria-label="Preview the captured audiobook" src={storyPreviewMediaUrl(edition.id, file.name)} />}
    </article>)}
    {handoff === "kindle" && <div className="fy-publish-card"><strong>Read on Kindle</strong><ol><li>Save the EPUB file.</li><li>Open Amazon’s Send to Kindle and sign in to your Amazon account.</li><li>Upload the EPUB, then open your Kindle app after Amazon finishes processing it.</li></ol><a className="fy-publish-link" href="https://www.amazon.com/sendtokindle" target="_blank" rel="noreferrer">Open Send to Kindle</a><p>Arke cannot confirm that Amazon has received or delivered your book.</p></div>}
    {handoff === "audio" && <div className="fy-publish-card"><strong>Listen with Arke’s voices</strong><ol><li>Save the M4B file to your phone’s Files or Downloads.</li><li>Import it into an audiobook app that accepts M4B files.</li><li>Check playback and offline access in that app.</li></ol><p>The audiobook includes the chosen narration and character voices. Your listening position is separate from your Kindle reading position.</p></div>}
    {edition.status === "ready" && <p className="fy-publish-muted">Files ready. Sharing a copy is a separate step; copies you share cannot be recalled by Arke.</p>}
  </div>;
}

function StoryBookPreview({ edition }: { edition: StoryEdition }) {
  const [chapter, setChapter] = useState(0), [html, setHtml] = useState(""), [error, setError] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    const off = subscribeStoryPublications(answer => {
      if (answer.type !== "story.published" || answer.requestId !== asked.current) return;
      if (answer.result.preview) { setHtml(answer.result.preview.html); setError(null); }
      if (answer.result.error) setError(answer.result.error);
    });
    setHtml("");
    asked.current = publishStory(edition.worldId, edition.productionId, { action: "preview-page", editionId: edition.id, chapter });
    return off;
  }, [edition.id, chapter]);
  return <section aria-label="Captured EPUB preview">
    <div className="fy-publish-actions"><Button disabled={chapter === 0} onClick={() => setChapter(value => value - 1)}>Previous chapter</Button><span>Chapter {chapter + 1} of {edition.settings.chapterIds.length}</span><Button disabled={chapter + 1 >= edition.settings.chapterIds.length} onClick={() => setChapter(value => value + 1)}>Next chapter</Button></div>
    {error && <p role="alert">{error}</p>}
    {html ? <iframe title="Captured book page" sandbox="" srcDoc={html} className="fy-publish-book" /> : <p role="status">Opening captured book…</p>}
    <p className="fy-publish-muted">Text from this EPUB. Your reader controls type size and page layout.</p>
  </section>;
}

export function StoryEditionLibrary({ worldId, productionId, onPreview }: { worldId?: string; productionId?: string; onPreview?: (edition: StoryEdition) => void }) {
  const [editions, setEditions] = useState<StoryEdition[]>([]), [error, setError] = useState<string | null>(null);
  const asked = useRef<string | null>(null), retryAsked = useRef<string | null>(null);
  const connection = useStore().connection;
  useEffect(() => {
    const refresh = () => { asked.current = listStoryPublications(); };
    const off = subscribeStoryPublications(answer => {
      if (answer.type === "story.published" && answer.requestId === retryAsked.current && answer.result.error) setError(answer.result.error);
      if (answer.type === "story.published" && answer.result.edition && answer.result.edition.status !== "creating") { refresh(); return; }
      if (answer.type !== "story.editions" || answer.requestId !== asked.current) return;
      setEditions(answer.editions.filter(row => (!worldId || row.worldId === worldId) && (!productionId || row.productionId === productionId)));
      setError(answer.error ?? null);
    });
    const visible = () => { if (document.visibilityState === "visible") refresh(); };
    refresh(); document.addEventListener("visibilitychange", visible);
    return () => { off(); document.removeEventListener("visibilitychange", visible); };
  }, [worldId, productionId, connection]);
  return <section className="fy-publish-library" aria-label="Private story editions">
    <h2>Private story editions</h2>{error && <p role="alert">{error}</p>}
    {!editions.length && <p className="fy-publish-muted">Create a private reading or listening edition from a story’s Publish action.</p>}
    {editions.map(edition => <article className="fy-publish-card" key={edition.id}>
      <div><strong>{edition.settings.title}</strong><p>{edition.settings.label || "Private edition"} · {new Date(edition.createdAt).toLocaleString()} · {edition.phase}</p></div>
      {edition.status === "ready" ? <StoryEditionFiles edition={edition} /> : <>
        {edition.error && <p role="alert">{edition.error}</p>}
        {(edition.status === "failed" || edition.status === "cancelled") && <Button onClick={() => { retryAsked.current = publishStory(edition.worldId, edition.productionId, { action: "retry", editionId: edition.id }); }}>Retry captured edition</Button>}
        {onPreview ? <Button onClick={() => onPreview(edition)}>{edition.status === "preview" ? "Review preview" : "View preparation"}</Button> : <Link to={`/w/${edition.worldId}/p/${edition.productionId}/story/chapters`}>Continue in story</Link>}
      </>}
    </article>)}
  </section>;
}

export function StoryPublishSheet({ worldId, production, onClose, onOtherExports }: { worldId: string; production: ProductionBundle; onClose: () => void; onOtherExports?: () => void }) {
  const chapters = production.chapters.filter(chapter => !chapter.retired).sort((a, b) => a.order - b.order);
  const [settings, setSettings] = useState<StoryPublicationSettings>(() => ({ title: production.meta.title, author: "", language: "en", description: "", label: "Private edition", cover: null,
    chapterIds: chapters.map(chapter => chapter.id), outputs: ["epub"], avoidEmDashes: false }));
  const [step, setStep] = useState<Step>("Edition"), [review, setReview] = useState<StoryPublicationReview | null>(null);
  const [edition, setEdition] = useState<StoryEdition | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [finding, setFinding] = useState<StoryStyleFinding | null>(null), [replacement, setReplacement] = useState("");
  const [changed, setChanged] = useState(false), [applied, setApplied] = useState<string[]>([]);
  const asked = useRef<string | null>(null), loading = useRef<string | null>(null), dirty = useRef(false), operation = useRef(""), pendingImpact = useRef<string[]>([]), watching = useRef<string | null>(null);
  const saving = useRef<AbortController | null>(null);
  const connection = useStore().connection, world = useWorld();
  const sourceStamp = JSON.stringify(chapters.map(chapter => [chapter.id, chapter.hash, chapter.version, chapter.audiobook]));
  const priorSource = useRef(sourceStamp);
  const update = (patch: Partial<StoryPublicationSettings>) => { dirty.current = true; setSettings(value => ({ ...value, ...patch })); setReview(null); setChanged(edition !== null); };
  const request = async (input: StoryPublishAction) => {
    setError(null); operation.current = input.action; setBusy(input.action !== "cancel");
    saving.current?.abort();
    if (["review", "preview", "create"].includes(input.action)) {
      const controller = new AbortController(); saving.current = controller;
      const ids = "settings" in input ? input.settings.chapterIds : input.action === "create" && edition ? edition.settings.chapterIds : settings.chapterIds;
      try { await waitForChapterSaves(worldId, production.meta.id, chapters.filter(chapter => ids.includes(chapter.id)), controller.signal); }
      catch (error) { if (!controller.signal.aborted) { setBusy(false); setError(error instanceof Error ? error.message : "Check the manuscript save before publishing."); } return; }
      if (controller.signal.aborted) return;
    }
    if (["review", "decide", "preview"].includes(input.action)) watching.current = null;
    asked.current = publishStory(worldId, production.meta.id, input);
    if (!asked.current) { setBusy(false); setError("Connect to the host to continue."); }
  };
  useEffect(() => () => saving.current?.abort(), [worldId, production.meta.id]);
  useEffect(() => {
    const off = subscribeStoryPublications(answer => {
      if (answer.type !== "story.published") return;
      if (answer.requestId === loading.current) {
        if (watching.current && answer.result.editions) {
          const current = answer.result.editions.find(row => row.id === watching.current);
          if (current) { setEdition(current); setBusy(current.status === "creating"); setStep(current.status === "ready" ? "Files" : "Preview"); setError(null); }
          else { setBusy(false); setError("The saved edition could not be found. Recheck the source."); }
        }
        if (answer.result.settings && !dirty.current && !watching.current) setSettings(answer.result.settings);
        if (answer.result.error) setError(answer.result.error);
        return;
      }
      if (answer.requestId !== asked.current && (!answer.result.edition || answer.result.edition.id !== watching.current)) return;
      const result = answer.result;
      if (result.error) { setError(result.error); setBusy(false); return; }
      if (result.review) {
        setReview(result.review); setBusy(false); setFinding(null);
        if (operation.current === "decide") { setApplied(pendingImpact.current); pendingImpact.current = []; }
        if (operation.current === "review" || operation.current === "decide") { setChanged(false); setStep("Formatting & style"); }
      }
      if (result.edition) {
        watching.current = result.edition.id; setEdition(result.edition); setBusy(result.edition.status === "creating");
        setChanged(false); setStep(result.edition.status === "ready" ? "Files" : "Preview");
      }
    });
    loading.current = publishStory(worldId, production.meta.id, { action: "list" });
    return off;
  }, [worldId, production.meta.id, connection]);
  useEffect(() => {
    if (priorSource.current !== sourceStamp) { priorSource.current = sourceStamp; setChanged(true); }
  }, [sourceStamp]);
  useEffect(() => { if (connection !== "open" && busy) { setBusy(false); setError("Connection lost. Reconnect and check the saved edition below."); } }, [connection, busy]);
  const valid = StoryPublicationSettingsSchema.safeParse(settings).success;
  const blockers = review ? [...review.blockers, ...(settings.outputs.includes("m4b") ? review.chapters.flatMap(chapter => chapter.audioProblems.map(problem => chapter.title + ": " + problem)) : [])] : [];
  const unreviewed = review?.findings.filter(row => !row.kept) ?? [];
  const openFinding = (row: StoryStyleFinding) => { setFinding(row); setReplacement(row.suggestion); };
  const retry = () => { if (edition) request({ action: "retry", editionId: edition.id }); };
  const refresh = () => request({ action: "review", settings });
  const footer = <div className="fy-publish-actions">
    {step !== "Edition" && !busy && <Button variant="ghost" onClick={() => { setFinding(null); setStep(steps[Math.max(0, steps.indexOf(step) - 1)]!); }}>Back</Button>}
    {busy ? <><span role="status">{edition?.status === "creating" ? edition.phase : "Checking…"}</span>{edition?.status === "creating" && <Button onClick={() => { publishStory(worldId, production.meta.id, { action: "cancel", editionId: edition.id }); }}>Cancel preparation</Button>}</> :
      step === "Edition" ? <Button variant="primary" disabled={!valid} onClick={() => setStep("Chapters")}>Review chapters</Button> :
      step === "Chapters" ? <Button variant="primary" disabled={!valid} onClick={refresh}>Formatting & style</Button> :
      step === "Formatting & style" ? <Button variant="primary" disabled={!review || !!blockers.length || !!unreviewed.length || changed} onClick={() => review && request({ action: "preview", settings, fingerprint: review.fingerprint })}>Prepare preview</Button> :
      step === "Preview" && edition?.status === "preview" ? <Button variant="primary" disabled={changed || !!edition.error} onClick={() => request({ action: "create", editionId: edition.id })}>Create edition</Button> :
      step === "Files" ? <Button onClick={onClose}>Done</Button> : null}
  </div>;
  return <PageSheet open onClose={onClose} title="Publish" subtitle={production.meta.title + " · Private reading & listening"} className="fy-publish-sheet" resetKey={step + (finding?.id ?? "")} footer={footer}>
    <div className="fy-publish">
      <nav className="fy-publish-steps" aria-label="Publishing steps">{steps.map((label, index) => <span key={label} aria-current={step === label ? "step" : undefined}>{index + 1}. {label}</span>)}</nav>
      <h3>{finding ? "Review proposed change" : step === "Files" ? "Your private edition is ready" : step}</h3>
      {error && <p role="alert" className="fy-publish-notice">{error}</p>}
      {changed && <div role="status" className="fy-publish-notice">The source or options changed. Recheck before creating an edition. <Button disabled={busy || !valid} onClick={() => { setChanged(false); refresh(); }}>Recheck</Button></div>}
      {step === "Edition" && <>
        <div className="fy-publish-fields">
          <label>Title<input value={settings.title} onChange={event => update({ title: event.target.value })} /></label>
          {settings.outputs.includes("pdf") && <label>Subtitle · optional<input value={settings.subtitle ?? ""} onChange={event => update({ subtitle: event.target.value })} /></label>}
          <label>Author or pen name<input value={settings.author} onChange={event => update({ author: event.target.value })} /></label>
          <label>Language<input value={settings.language} onChange={event => update({ language: event.target.value })} placeholder="en" /></label>
          <label>Edition label<input value={settings.label} onChange={event => update({ label: event.target.value })} /></label>
          {settings.outputs.includes("pdf") && <label>Title-page edition label · optional<input value={settings.editionLabel ?? ""} onChange={event => update({ editionLabel: event.target.value })} /></label>}
          <label>Cover<select value={settings.cover ?? ""} onChange={event => update({ cover: event.target.value || null })}><option value="">No cover</option>{world && worldImageReferences(world).filter(ref => /\.(png|jpe?g)$/i.test(ref.file)).map(ref => <option key={ref.file} value={ref.file}>{ref.name}</option>)}</select></label>
          <label>Description<textarea value={settings.description} onChange={event => update({ description: event.target.value })} /></label>
        </div>
        <fieldset><legend>Create files for</legend>{(["epub", "pdf", "m4b"] as const).map(format => <label className="fy-publish-choice" key={format}><input type="checkbox" checked={settings.outputs.includes(format)} onChange={event => update({ outputs: event.target.checked ? [...settings.outputs, format] : settings.outputs.filter(value => value !== format), ...(format === "pdf" && event.target.checked ? { pdf: settings.pdf ?? { ...DEFAULT_STORY_PDF_SETTINGS } } : {}) })} /><span><strong>{format === "pdf" ? "PDF — fixed pages" : format === "epub" ? "Read · EPUB" : "Listen · M4B"}</strong><small>{format === "pdf" ? "A formatted book with selectable text and chapter navigation" : format === "epub" ? "Send to Kindle or use another book reader" : "Arke’s chosen narration and character voices, as produced"}</small></span></label>)}</fieldset>
        {settings.outputs.includes("pdf") && <StoryPdfOptions settings={settings.pdf ?? DEFAULT_STORY_PDF_SETTINGS} onChange={pdf => update({ pdf })} />}
        <p className="fy-publish-muted">Creates private files on your host. No upload or new narration is started.</p>
        {onOtherExports && <Button variant="ghost" onClick={onOtherExports}>Other exports</Button>}
        <StoryEditionLibrary worldId={worldId} productionId={production.meta.id} onPreview={row => { watching.current = row.id; setBusy(row.status === "creating"); setEdition(row); setSettings(row.settings); setStep(row.status === "ready" ? "Files" : "Preview"); }} />
      </>}
      {step === "Chapters" && <><p>Chapters stay in manuscript order. Empty or incomplete chapters must be fixed or explicitly left out.</p>
        {chapters.map(chapter => <label className="fy-publish-choice" key={chapter.id}><input type="checkbox" checked={settings.chapterIds.includes(chapter.id)} onChange={event => update({ chapterIds: event.target.checked ? chapters.filter(row => row.id === chapter.id || settings.chapterIds.includes(row.id)).map(row => row.id) : settings.chapterIds.filter(id => id !== chapter.id) })} /><span><strong>{chapter.order}. {chapter.title}</strong><small>{chapter.words ?? 0} words</small></span></label>)}
        <p>{settings.chapterIds.length} of {chapters.length} chapters selected</p></>}
      {step === "Formatting & style" && (finding ? <div className="fy-publish-review">
        <p>{finding.chapterTitle} · Paragraph {finding.paragraph + 1}</p><p>{finding.reason}</p>
        <div className="fy-publish-comparison"><section><h4>Before</h4><p>{finding.before}</p></section><section><h4>Proposed</h4><textarea aria-label="Proposed text" value={replacement} onChange={event => setReplacement(event.target.value)} /></section></div>
        <p className="fy-publish-notice">{finding.narration.length ? finding.narration.length + (finding.narration.length === 1 ? " recording in this paragraph needs" : " recordings in this paragraph need") + " checking after applying. Changed recordings will need updating." : "No kept recording was found for this paragraph."} Arke will not regenerate audio here.</p>
        <div className="fy-publish-actions"><Button disabled={busy} onClick={() => { pendingImpact.current = []; request({ action: "decide", settings, finding, decision: "keep", replacement: finding.before }); }}>Keep original</Button><Button disabled={busy || !replacement.trim() || replacement === finding.before} variant="primary" onClick={() => { pendingImpact.current = finding.narration; request({ action: "decide", settings, finding, decision: "apply", replacement }); }}>Apply to manuscript</Button><Button variant="ghost" onClick={() => setFinding(null)}>Cancel</Button></div>
      </div> : <>
        <label className="fy-publish-choice"><input type="checkbox" checked={settings.avoidEmDashes} onChange={event => { const next = { ...settings, avoidEmDashes: event.target.checked }; update(next); request({ action: "review", settings: next }); }} /><span><strong>Avoid em dashes</strong><small>Optional style rule. Em dashes are valid book text. Each proposed change needs your approval.</small></span></label>
        {applied.length > 0 && <p role="status">Text updated. Review the {applied.length} affected {applied.length === 1 ? "recording" : "recordings"} before including the audiobook.</p>}
        {blockers.length > 0 && <div className="fy-publish-notice" role="alert"><strong>Needs attention</strong><ul>{blockers.map((problem, index) => <li key={index}>{problem}</li>)}</ul></div>}
        {review?.warnings.map((warning, index) => <p key={index}>{warning}</p>)}
        {settings.outputs.includes("m4b") && review?.chapters.filter(chapter => chapter.audioProblems.length).map(chapter => <Link key={chapter.id} to={'/w/' + worldId + '/p/' + production.meta.id + '/story/chapters/' + encodeURIComponent(chapter.id) + '?view=audiobook'} onClick={onClose}>Review narration · {chapter.title}</Link>)}
        {review && review.findings.length === 0 && <p>No findings for the selected style rule.</p>}
        {review?.findings.map(row => <article className="fy-publish-card" key={row.id}><strong>{row.chapterTitle} · Paragraph {row.paragraph + 1}</strong><p>{row.before}</p><span>{row.kept ? "Original kept for this text" : row.narration.length ? "Narration may need updating" : "Optional style suggestion"}</span><Button disabled={busy} onClick={() => openFinding(row)}>Review change</Button></article>)}
        {settings.outputs.includes("pdf") && settings.pdf && <p className="fy-publish-muted">PDF · {settings.pdf.preset === "book" ? "Book · 6 × 9 in" : settings.pdf.preset.toUpperCase()} · {settings.pdf.font === "serif" ? "Serif" : "Sans serif"} · {settings.pdf.bodySize} pt · {settings.pdf.lineSpacing} line spacing · Contents {settings.pdf.contents ? "on" : "off"} · Running headers {settings.pdf.runningHeaders ? "on" : "off"}</p>}
        <div className="fy-publish-actions"><Button disabled={busy} onClick={() => { setChanged(false); refresh(); }}>Recheck</Button>{settings.outputs.includes("m4b") && <><Link to={`/w/${worldId}/p/${production.meta.id}/story/audiobook`} onClick={onClose}>Review narration</Link><Button onClick={() => { const remaining = settings.outputs.filter(format => format !== "m4b"); const next: StoryPublicationSettings = { ...settings, outputs: remaining.length ? remaining : ["epub"] }; update(next); request({ action: "review", settings: next }); }}>Without audiobook</Button></>}</div>
      </>)}
      {(step === "Preview" || step === "Files") && edition && <>
        <p>{edition.settings.title} · {edition.settings.author || "No author set"} · {edition.settings.language}</p>
        {edition.status === "preview" && <p>Review the captured files below. These exact files become the edition when you choose Create edition.</p>}
        {edition.files.some(file => file.format === "epub") && <StoryBookPreview edition={edition} />}
        {edition.files.some(file => file.format === "pdf") && <StoryPdfPreview edition={edition} />}
        <StoryEditionFiles edition={edition} />
        {(edition.status === "failed" || edition.status === "cancelled") && <div className="fy-publish-actions"><Button disabled={busy} onClick={retry}>Retry captured edition</Button><Button disabled={busy} onClick={refresh}>Recheck source</Button></div>}
      </>}
    </div>
  </PageSheet>;
}

export function StoryPdfOptions({ settings, onChange }: { settings: NonNullable<StoryPublicationSettings["pdf"]>; onChange: (settings: NonNullable<StoryPublicationSettings["pdf"]>) => void }) {
  return <fieldset><legend>PDF formatting</legend><div className="fy-publish-fields">
    <label>Page size<select value={settings.preset} onChange={event => onChange({ ...settings, preset: event.target.value as typeof settings.preset })}><option value="book">Book · 6 × 9 in</option><option value="a4">A4 · 210 × 297 mm</option><option value="letter">Letter · 8.5 × 11 in</option></select></label>
    <label>Typeface<select value={settings.font} onChange={event => onChange({ ...settings, font: event.target.value as typeof settings.font })}><option value="serif">Serif</option><option value="sans">Sans serif</option></select></label>
    <label>Text size · pt<input type="number" min={10} max={14} step={0.5} value={settings.bodySize} onChange={event => onChange({ ...settings, bodySize: Number(event.target.value) })} /></label>
    <label>Line spacing<input type="number" min={1.25} max={1.6} step={0.05} value={settings.lineSpacing} onChange={event => onChange({ ...settings, lineSpacing: Number(event.target.value) })} /></label>
  </div><label className="fy-publish-choice"><input type="checkbox" checked={settings.contents} onChange={event => onChange({ ...settings, contents: event.target.checked })} />Contents page</label>
    <label className="fy-publish-choice"><input type="checkbox" checked={settings.runningHeaders} onChange={event => onChange({ ...settings, runningHeaders: event.target.checked })} />Book title in running headers</label>
    <p className="fy-publish-muted">Chapters start on new pages. Page numbers begin with the first chapter.</p>
  </fieldset>;
}
