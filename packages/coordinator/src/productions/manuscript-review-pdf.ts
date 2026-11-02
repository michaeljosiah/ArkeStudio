import PDFDocument from "pdfkit";
import { fileURLToPath } from "node:url";
import { manuscriptReviewCoverage, type ManuscriptReview } from "@arke-studio/contracts";

/** Private export of the selected retained report; never reads or changes authored files. */
export async function manuscriptReviewPdf(review: ManuscriptReview): Promise<Buffer> {
  const pdf = new PDFDocument({ font: fileURLToPath(new URL("../publications/fonts/DejaVuSans.ttf", import.meta.url)), size: "A4", margins: { top: 50, bottom: 55, left: 50, right: 50 }, bufferPages: true,
    info: { Title: `${review.title} — Manuscript review`, Author: "Arke Studio", Subject: "Private editorial report" } });
  const chunks: Buffer[] = [];
  const finished = new Promise<Buffer>((resolve, reject) => { pdf.on("data", chunk => chunks.push(chunk)); pdf.on("end", () => resolve(Buffer.concat(chunks))); pdf.on("error", reject); });
  const paragraph = (text: string) => { if (text) pdf.fontSize(10).text(text, { lineGap: 4 }).moveDown(0.7); };
  const heading = (text: string) => { if (pdf.y > pdf.page.height - 115) pdf.addPage(); pdf.fontSize(15).text(text).moveDown(0.5); };
  const coverage = manuscriptReviewCoverage(review);
  heading(`${review.title} — Manuscript review`);
  paragraph(`Private · ${review.createdAt} · ${review.id}\n${review.status}${review.stale ? " · sources changed" : ""}\n${coverage.chapters}/${coverage.totalChapters} chapters fully supplied; ${coverage.stages}/${coverage.totalStages} reading stages complete; ${coverage.words.toLocaleString()} words.`);
  paragraph(review.staleReasons.join("\n"));
  heading("1. At a glance"); paragraph(`Author brief: ${review.brief || "None supplied."}`); paragraph(review.synthesis?.verdict ?? "No complete synthesis is available. Completed readings are retained below.");
  heading("2. Full synopsis"); paragraph(review.synthesis?.synopsis ?? "Incomplete coverage — no full-book synopsis claimed.");
  for (const source of review.sources) {
    heading(source.title);
    for (const task of review.tasks.filter(t => t.kind === "reading" && t.chapterId === source.id)) paragraph(task.reading?.synopsis ?? `${task.id}: ${task.state}. ${task.error ?? "Not read."}`);
  }
  heading("3. Candid editorial review"); paragraph(review.synthesis?.strengths ?? ""); paragraph(review.synthesis?.editorial ?? "Unavailable.");
  heading("4. Continuity and unresolved intent"); paragraph(review.synthesis?.continuity ?? "Unavailable.");
  heading("5. Prioritised revision plan");
  for (const finding of [...review.findings].sort((a,b) => a.priority - b.priority)) {
    heading(`Priority ${finding.priority}: ${finding.title}`);
    paragraph(`${finding.kind} · ${finding.decision}${finding.stale ? " · source changed" : ""}\n${finding.observation}\nRevision: ${finding.recommendation}\nPreserve: ${finding.preserve}\nDependencies: ${finding.dependencies}`);
    for (const cite of finding.citations) paragraph(`${review.sources.find(s => s.id === cite.chapterId)?.title ?? cite.chapterId}: “${cite.quote}”`);
  }
  heading("6. Method and limitations");
  paragraph("Every completed reading stage received its entire pinned source segment. Cross-chapter synthesis uses the retained readings, with bounded intermediate synthesis for long books. Model interpretation can omit or misread details; exact quotations prove linkage, not correctness. No pictures or audio were inspected. Editorial judgment is not an age classification. Review does not alter the manuscript or media.");
  paragraph(review.synthesis?.limitations ?? "Synthesis did not complete.");
  paragraph(`${review.rejectedCitations} findings omitted for invalid or ambiguous citations. ${review.notRaisedAgain} earlier findings were not raised again; this does not establish resolution.`);
  for (const source of review.sources) paragraph(`${source.title} · ${source.id} · ${source.file}\n${source.hash}`);
  paragraph(`Approved context digest: ${review.contextHash}. The exact planning and linked settled-canon snapshot is retained with this report in the world.`);
  try {
    const context = JSON.parse(review.context) as { planning?: { overview?: { version?: number } }; linkedSettledCanon?: Array<{ id: string; title: string; settledAt?: number; amendedAt?: number }>; omittedCanonReferences?: string[] };
    paragraph(`Production planning version: ${context.planning?.overview?.version ?? "none recorded"}. Chapter planning is pinned with each chapter source.`);
    for (const entry of context.linkedSettledCanon ?? []) paragraph(`${entry.id}: ${entry.title} · settled at ${entry.settledAt ?? "unrecorded"}${entry.amendedAt !== undefined ? ` · amended at ${entry.amendedAt}` : ""}`);
    if (context.omittedCanonReferences?.length) paragraph(`Referenced canon not assessed because unavailable, unsettled or retired: ${context.omittedCanonReferences.join(", ")}.`);
  } catch { paragraph("Context details are available in the retained in-app report."); }
  for (const task of review.tasks) paragraph(`${task.id}: ${task.state} · ${task.model ?? "model not recorded"} · ${task.provider ?? "provider not separately reported by harness"}\n${task.sessionId ?? ""}\n${task.disclosure ?? "Configured writing harness; manuscript text may be sent to its provider."}${task.error ? "\n" + task.error : ""}`);
  const pages = pdf.bufferedPageRange();
  for (let page = 0; page < pages.count; page++) {
    pdf.switchToPage(page); const bottom = pdf.page.margins.bottom; pdf.page.margins.bottom = 0;
    pdf.fontSize(8).text(`Private manuscript review · ${page + 1} / ${pages.count}`, 50, pdf.page.height - 30, { lineBreak: false }); pdf.page.margins.bottom = bottom;
  }
  pdf.end(); return finished;
}
