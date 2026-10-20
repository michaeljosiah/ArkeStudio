import { useEffect, useRef, useState } from "react";
import type { StoryEdition } from "@arke-studio/contracts";
import type { StoryPdfPreviewDocument } from "../lib/story-pdf-preview.js";
import { storyPreviewMediaUrl } from "../lib/media.js";
import { Button } from "./ui.js";

type LoadPdf = (url: string, signal: AbortSignal) => Promise<StoryPdfPreviewDocument>;
const loadPdf: LoadPdf = async (url, signal) => (await import("../lib/story-pdf-preview.js")).loadStoryPdfPreview(url, signal);

export function StoryPdfPreview({ edition, load = loadPdf }: { edition: StoryEdition; load?: LoadPdf }) {
  const file = edition.files.find(row => row.format === "pdf"), metadata = file?.pdf;
  const [document, setDocument] = useState<StoryPdfPreviewDocument | null>(null);
  const [page, setPage] = useState(1), [zoom, setZoom] = useState(1), [width, setWidth] = useState(560);
  const [error, setError] = useState<string | null>(null), [rendering, setRendering] = useState(true);
  const viewport = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), text = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!file || !metadata) return;
    const controller = new AbortController(); let opened: StoryPdfPreviewDocument | null = null;
    setDocument(null); setPage(1); setError(null); setRendering(true);
    void load(storyPreviewMediaUrl(edition.id, file.name), controller.signal).then(async result => {
      opened = result;
      if (controller.signal.aborted) { await result.destroy(); return; }
      if (result.pageCount !== metadata.pageCount) { await result.destroy(); opened = null; throw new Error("PDF page count changed. Recheck the edition."); }
      setDocument(result);
    }).catch(() => { if (!controller.signal.aborted) { setError("The captured PDF could not be opened. Recheck the edition."); setRendering(false); } });
    return () => { controller.abort(); void opened?.destroy(); };
  }, [edition.id, file?.sha256, file?.name, metadata?.pageCount, load]);
  useEffect(() => {
    const element = viewport.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => { const next = entries[0]?.contentRect.width; if (next) setWidth(Math.max(1, next)); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!document || !canvas.current || !text.current) return;
    const controller = new AbortController(); setRendering(true); setError(null);
    void document.render(page, width, zoom, canvas.current, text.current, controller.signal).then(() => {
      if (!controller.signal.aborted) setRendering(false);
    }).catch(() => { if (!controller.signal.aborted) { setError("This PDF page could not be displayed. Try opening the preview again."); setRendering(false); } });
    return () => controller.abort();
  }, [document, page, width, zoom]);
  if (!file || !metadata) return <p role="alert">PDF page information is unavailable. Prepare a new preview.</p>;
  return <section className="fy-pdf-preview" aria-label="Captured PDF preview">
    <div className="fy-pdf-toolbar">
      <Button disabled={!document || page <= 1} onClick={() => setPage(value => value - 1)}>Previous page</Button>
      <label>File page<input type="number" min={1} max={metadata.pageCount} value={page} disabled={!document} onChange={event => { const value = Number(event.target.value); if (Number.isInteger(value) && value >= 1 && value <= metadata.pageCount) setPage(value); }} /></label>
      <span>of {metadata.pageCount}</span>
      <Button disabled={!document || page >= metadata.pageCount} onClick={() => setPage(value => value + 1)}>Next page</Button>
      <label>Zoom<select value={zoom} onChange={event => setZoom(Number(event.target.value))}><option value={1}>Fit width</option><option value={1.25}>125%</option><option value={1.5}>150%</option><option value={2}>200%</option></select></label>
      <label className="fy-pdf-chapters">Chapter<select value="" disabled={!document} onChange={event => { if (event.target.value) setPage(Number(event.target.value)); }}><option value="">Go to chapter…</option>{metadata.chapters.map(chapter => <option key={chapter.id} value={chapter.physicalPage}>{chapter.title} · page {chapter.pageNumber}</option>)}</select></label>
    </div>
    <p className="fy-publish-muted">{metadata.pageLabels[page - 1] || "Front matter"} · Actual PDF pages. Select text to copy it.</p>
    {error && <p role="alert">{error}</p>}
    <div role="status" className="fy-pdf-status">{rendering ? "Opening PDF page…" : `File page ${page} of ${metadata.pageCount}`}</div>
    <div ref={viewport} className="fy-pdf-viewport" tabIndex={0} aria-label="PDF page, scroll to read" aria-busy={rendering}>
      <div className="fy-pdf-page" style={{ visibility: rendering || !!error ? "hidden" : "visible" }}><canvas ref={canvas} aria-hidden="true" /><div ref={text} className="fy-pdf-text" /></div>
    </div>
  </section>;
}
