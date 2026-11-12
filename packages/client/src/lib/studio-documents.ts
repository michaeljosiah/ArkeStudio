import { STUDIO_ASSISTANT_LIMITS, StudioTextAttachmentsSchema, studioRequestFits, type StudioTextAttachment } from "@arke-studio/contracts";

export const STUDIO_DOCUMENT_ACCEPT = ".txt,.md,.markdown,.log,.json,.csv,.tsv,.yaml,.yml,.xml,.html,.css,.js,.ts,.tsx,.jsx,.py,.sh,.sql,text/plain,text/markdown";
export interface StudioDocumentTrouble { name: string; reason: string }
const extensions = new Set(STUDIO_DOCUMENT_ACCEPT.split(",").filter(value => value.startsWith(".")));
export function studioDocumentsFit(text: string, attachments: readonly StudioTextAttachment[]): boolean {
  return text.length <= STUDIO_ASSISTANT_LIMITS.requestChars && StudioTextAttachmentsSchema.safeParse(attachments).success && studioRequestFits({ text, attachments });
}
export function studioPastedDocument(text: string, id: string): StudioTextAttachment | null {
  if (!text.length || text.length > STUDIO_ASSISTANT_LIMITS.attachmentBytes) return null;
  const document = { id, name: "Pasted text.txt", text };
  return StudioTextAttachmentsSchema.safeParse([document]).success ? document : null;
}
/** Read only selected slices. Native paths, world importers and binary extraction are absent. */
export async function loadStudioDocuments(files: readonly File[], existing: readonly StudioTextAttachment[], id: () => string, current = () => true): Promise<{
  documents: StudioTextAttachment[]; trouble: StudioDocumentTrouble[];
}> {
  const documents: StudioTextAttachment[] = [], trouble: StudioDocumentTrouble[] = [];
  if (files.length > STUDIO_ASSISTANT_LIMITS.attachments) return { documents, trouble: [{ name: "Documents", reason: "Choose up to four text documents at a time." }] };
  for (const file of files) {
    if (!current()) return { documents: [], trouble: [] };
    const name = typeof file.name === "string" ? file.name.slice(0, 128) : "Document";
    if (existing.length + documents.length >= STUDIO_ASSISTANT_LIMITS.attachments) { trouble.push({ name, reason: "A request can include up to four text documents." }); continue; }
    if (!extensions.has(file.name.slice(file.name.lastIndexOf(".")).toLowerCase())) { trouble.push({ name, reason: "Choose a text document. Images, audio, PDF and Office files are not supported here yet." }); continue; }
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > STUDIO_ASSISTANT_LIMITS.attachmentBytes) { trouble.push({ name, reason: "Choose a nonempty text document smaller than 32 KiB." }); continue; }
    try {
      const raw = await file.slice(0, STUDIO_ASSISTANT_LIMITS.attachmentBytes + 1).arrayBuffer();
      if (!current()) return { documents: [], trouble: [] };
      if (raw.byteLength > STUDIO_ASSISTANT_LIMITS.attachmentBytes) throw new Error("Document is too large.");
      const document = { id: id(), name: file.name, text: new TextDecoder("utf-8", { fatal: true }).decode(raw) };
      if (!StudioTextAttachmentsSchema.safeParse([...existing, ...documents, document]).success) throw new Error("Text documents exceed their limit.");
      documents.push(document);
    } catch { trouble.push({ name, reason: "Use UTF-8 text without binary data; all document names and contents must fit within 32 KiB." }); }
  }
  return { documents, trouble };
}
