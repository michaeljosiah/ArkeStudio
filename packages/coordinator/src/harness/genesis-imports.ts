import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import {
  GenesisImportProposalSchema, GenesisImportsSchema, GenesisSourceSchema, GenesisBlueprintSchema,
  completeGenesisSheet, genesisContentRows, genesisSheetIds,
  type GenesisBlueprint, type GenesisImportCard, type GenesisImportResolve, type GenesisSource,
} from "@arke-studio/contracts";
import { extractDocumentText, verifyCandidates } from "../artifacts/extraction.js";
import { fileArtifact, kindForFile } from "../artifacts/filing.js";
import { conversationActionDigest } from "../arke-actions/digest.js";
import { atomicWriteFile, serializeFileMutation } from "../world/atomic.js";
import type { WorldStore } from "../world/store.js";
import { slugify } from "../world/slug.js";
import { foldBlueprint } from "./blueprint.js";
import { genesisControlDir } from "./genesis-conversation.js";
import { sandboxAttachments } from "../artifacts/genesis-attachments.js";

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const pathFor = (dir: string) => join(genesisControlDir(dir), "imports.json");
const ResolutionSchema = z.object({
  status: z.enum(["prepared", "rejected", "deferred"]), target: z.string().optional(),
  write: z.object({ file: z.string(), content: z.string() }).optional(), applied: z.boolean(),
}).strict();
const StateSchema = z.object({
  cards: z.array(GenesisImportsSchema.shape.cards.element),
  resolutions: z.record(ResolutionSchema),
}).strict();
type State = z.infer<typeof StateSchema>;
async function stateFor(dir: string): Promise<State> {
  return readFile(pathFor(dir), "utf8").then(raw => StateSchema.parse(JSON.parse(raw)))
    .catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return { cards: [], resolutions: {} }; throw err; });
}
async function save(dir: string, state: State) { await atomicWriteFile(pathFor(dir), JSON.stringify(state) + "\n"); }
async function recover(dir: string, state: State) {
  for (const resolution of Object.values(state.resolutions)) {
    if (resolution.applied) continue;
    if (resolution.write) {
      // Only the application creates these records. Keep recovery within its known draft paths.
      if (!/^(draft\.json|draft\/(characters|locations|factions)\/[a-z0-9][a-z0-9-]*\.json)$/.test(resolution.write.file)) throw new Error("The import recovery path needs repair.");
      await atomicWriteFile(join(dir, resolution.write.file), resolution.write.content);
    }
    resolution.applied = true;
    await save(dir, state);
  }
}
export async function recoverGenesisImports(dir: string): Promise<void> {
  await serializeFileMutation(pathFor(dir), async () => recover(dir, await stateFor(dir)));
}
async function sourceBytes(dir: string, source: GenesisSource): Promise<Buffer> {
  const path = join(genesisControlDir(dir), "sources", source.hash.slice(7), basename(source.name));
  const bytes = await readFile(path);
  if (hash(bytes) !== source.hash.slice(7)) throw new Error("An imported source changed. Restore it before founding.");
  return bytes;
}
const textOf = (row: ReturnType<typeof genesisContentRows>[number]) =>
  row.content.kind === "canon" ? row.content.value.statement :
  ["character", "location", "faction"].includes(row.content.kind) && typeof row.content.value === "object" && "sheet" in row.content.value
    ? Object.values(row.content.value.sheet?.sections ?? {}).join("\n") : "";

async function reviewUnlocked(dir: string, state: State) {
  await recover(dir, state);
  const documents: Array<{ name: string; supported: boolean; detail: string }> = [], problems: string[] = [];
  const sources = new Map<string, { text: string; hash: string }>();
  for (const path of await sandboxAttachments(dir)) {
    const name = basename(path);
    if (["image", "audio", "video"].includes(kindForFile(name))) continue;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 10 * 1024 * 1024) throw new Error("Source exceeds 10 MB or is not a regular file.");
      const bytes = await readFile(path), text = extractDocumentText(name, bytes);
      if (!text?.trim()) throw new Error(/\.pdf$/i.test(name) ? "No supported PDF text was found. Upload a text or Markdown copy." : "Upload text, Markdown, or a PDF with supported text.");
      const digest = hash(bytes);
      await atomicWriteFile(join(genesisControlDir(dir), "sources", digest, name), bytes);
      sources.set(name, { text, hash: `sha256:${digest}` });
      documents.push({ name, supported: true, detail: /\.pdf$/i.test(name) ? "Partial PDF text extraction; only verified quoted spans can be imported." : "Ready for extraction." });
    } catch (err) { documents.push({ name, supported: false, detail: err instanceof Error ? err.message : "This source could not be read." }); }
  }
  const folder = join(dir, "draft", "imports");
  const names = await readdir(folder).catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return []; throw err; });
  for (const name of names.filter(name => name.endsWith(".json")).slice(0, 300)) {
    try {
      const info = await lstat(join(folder, name));
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64000) throw new Error("Invalid import proposal file.");
      const proposal = GenesisImportProposalSchema.parse(JSON.parse(await readFile(join(folder, name), "utf8")));
      const source = sources.get(proposal.source);
      if (!source) throw new Error(`${proposal.source} is unavailable or unsupported.`);
      const verified = verifyCandidates([proposal], source.text, []);
      if (!verified.verified.length) throw new Error(verified.droppedReasons.join(" "));
      const offset = source.text.indexOf(proposal.quote);
      if (offset < 0) throw new Error("Use an exact quoted span from the source.");
      const id = hash([source.hash, proposal.kind, proposal.name, proposal.section ?? "", proposal.quote].join("\n"));
      const existing = state.cards.find(card => card.id === id);
      if (existing && state.resolutions[id]) continue;
      const evidence = GenesisSourceSchema.parse({ hash: source.hash, name: proposal.source, quote: proposal.quote,
        line: source.text.slice(0, offset).split("\n").length, candidateId: id,
        originalName: proposal.name, originalBody: proposal.body, modified: false });
      const card: GenesisImportCard = { id, digest: "", proposal, source: evidence, matches: [], related: [], status: "pending" };
      if (existing) state.cards[state.cards.indexOf(existing)] = card; else state.cards.push(card);
    } catch (err) { problems.push(`${name}: ${err instanceof Error ? err.message : "Unreadable candidate"}`); }
  }
  const rows = genesisContentRows(await foldBlueprint(dir));
  for (const card of state.cards) {
    card.matches = rows.filter(row => row.content.kind === card.proposal.kind && row.title.toLocaleLowerCase() === card.proposal.name.toLocaleLowerCase())
      .map(row => ({ key: row.key, name: row.title, text: textOf(row) }));
    card.related = state.cards.filter(other => other.id !== card.id && other.proposal.kind === card.proposal.kind &&
      other.proposal.name.toLocaleLowerCase() === card.proposal.name.toLocaleLowerCase() && state.resolutions[other.id]?.status !== "rejected")
      .map(other => ({ source: other.source.name, name: other.proposal.name, text: other.proposal.body }));
    card.digest = conversationActionDigest({ proposal: card.proposal, source: card.source, matches: card.matches, related: card.related });
    const resolved = state.resolutions[card.id];
    if (resolved) { card.status = resolved.status; if (resolved.target) card.target = resolved.target; }
  }
  await save(dir, state);
  return GenesisImportsSchema.parse({ cards: state.cards, documents, problems });
}
export async function reviewGenesisImports(dir: string) {
  return serializeFileMutation(pathFor(dir), async () => reviewUnlocked(dir, await stateFor(dir)));
}

export async function resolveGenesisImport(dir: string, input: GenesisImportResolve) {
  return serializeFileMutation(pathFor(dir), async () => {
    const state = await stateFor(dir);
    const review = await reviewUnlocked(dir, state);
    const card = review.cards.find(card => card.id === input.id);
    if (!card) throw new Error("This import candidate is unavailable.");
    if (state.resolutions[card.id]?.status !== "deferred" && state.resolutions[card.id]) return review;
    if (card.digest !== input.digest) throw new Error("The candidate or matching draft changed. Review it again.");
    if (input.decision !== "prepare") {
      state.resolutions[card.id] = { status: input.decision === "reject" ? "rejected" : "deferred", applied: true };
    } else {
      const draft = await foldBlueprint(dir);
      if (draft.dropped.length) throw new Error("Repair unreadable draft files before preparing an import.");
      const proposal = card.proposal, name = input.name ?? proposal.name, body = input.body ?? proposal.body;
      const rows = genesisContentRows(draft), kind = proposal.kind;
      const existing = input.target ? rows.find(row => row.key === input.target && row.content.kind === kind) : undefined;
      if (input.target && !existing) throw new Error("The selected merge target is unavailable.");
      if (card.matches.length && !input.mode) throw new Error("Choose whether to merge or retain a distinct entity.");
      if (input.mode !== "distinct" && !existing && card.matches.length) throw new Error("Select the record to merge.");
      if (existing && !["append", "replace"].includes(input.mode ?? "")) throw new Error("Choose append or replace for this merge.");
      let slug = existing?.key.split(":")[1] ?? `${slugify(name) || kind}-${card.id.slice(0, 8)}`;
      if (!existing) { const stem = slug; for (let n = 2; rows.some(row => row.key === `${kind}:${slug}`); n++) slug = `${stem}-${n}`; }
      const source = { ...card.source, modified: name !== proposal.name || body !== proposal.body };
      // The interpretation and exact evidence remain visibly different in the eventual sheet.
      const sourced = `${body}\n\nSource: ${source.name}, line ${source.line} — "${source.quote}"`;
      let file: string, content: string;
      if (kind === "canon") {
        const old = draft.canon?.find(entry => entry.slug === slug);
        const entry = { ...(old ?? { slug, type: "lore" as const }), title: name,
          statement: input.mode === "append" && old ? `${old.statement}\n\n${sourced}` : sourced,
          sources: [...(input.mode === "replace" ? [] : old?.sources ?? []), source] };
        const raw = JSON.parse(await readFile(join(dir, "draft.json"), "utf8").catch((err: NodeJS.ErrnoException) => { if (err.code === "ENOENT") return "{}"; throw err; }));
        file = "draft.json"; content = JSON.stringify({ ...raw, canon: [...(draft.canon ?? []).filter(entry => entry.slug !== slug), entry] }, null, 2) + "\n";
        GenesisBlueprintSchema.parse({ ...draft, canon: [...(draft.canon ?? []).filter(entry => entry.slug !== slug), entry] });
      } else {
        const entities = kind === "character" ? draft.characters : kind === "location" ? draft.locations : draft.factions;
        const old = entities.find(entity => entity.slug === slug);
        const entity = completeGenesisSheet(kind, old ?? { name });
        const section = proposal.section ?? (kind === "location" ? "Look" : "Essence");
        const previous = entity.sheet.sections[section];
        const next = { ...entity, name, sources: [...(input.mode === "replace" ? [] : old?.sources ?? []), source],
          sheet: { ...entity.sheet, sections: { ...entity.sheet.sections,
            [section]: input.mode === "append" && previous && previous !== "—" ? `${previous}\n\n${sourced}` : sourced },
            links: [...new Set([...(entity.sheet.links ?? []), ...(proposal.links ?? [])])] } };
        file = `draft/${kind === "character" ? "characters" : kind === "location" ? "locations" : "factions"}/${slug}.json`;
        content = JSON.stringify(next, null, 2) + "\n";
        const key = kind === "character" ? "characters" : kind === "location" ? "locations" : "factions";
        GenesisBlueprintSchema.parse({ ...draft, [key]: [...entities.filter(entity => entity.slug !== slug), { ...next, slug }] });
      }
      state.resolutions[card.id] = { status: "prepared", target: `${kind}:${slug}`, write: { file, content }, applied: false };
    }
    // Persist the exact intended draft write first. Recovery can finish a lost response safely.
    await save(dir, state); await recover(dir, state);
    return reviewUnlocked(dir, state);
  });
}

export async function validateGenesisSources(dir: string, blueprint: GenesisBlueprint): Promise<void> {
  const state = await stateFor(dir);
  for (const entity of [...blueprint.characters, ...blueprint.locations, ...blueprint.factions, ...(blueprint.canon ?? [])]) {
    for (const source of entity.sources ?? []) {
      const candidate = state.cards.find(card => card.id === source.candidateId);
      if (!candidate || candidate.source.hash !== source.hash || candidate.source.quote !== source.quote || candidate.source.name !== source.name ||
        candidate.source.line !== source.line || candidate.source.originalName !== source.originalName || candidate.source.originalBody !== source.originalBody)
        throw new Error("An import source does not match its verified evidence.");
      const text = extractDocumentText(source.name, await sourceBytes(dir, source));
      if (!text?.includes(source.quote)) throw new Error("An imported quote cannot be verified.");
    }
  }
}

/** Evidence belongs to the accepted import identity, even when the harness revises its prose. */
export async function restoreGenesisSources(dir: string, blueprint: GenesisBlueprint): Promise<GenesisBlueprint> {
  const state = await stateFor(dir);
  const result = structuredClone(blueprint);
  for (const card of state.cards) {
    const resolution = state.resolutions[card.id];
    if (resolution?.status !== "prepared" || !resolution.target) continue;
    const [kind, slug] = resolution.target.split(":");
    const entity = kind === "character" ? result.characters.find(entity => entity.slug === slug) :
      kind === "location" ? result.locations.find(entity => entity.slug === slug) :
      kind === "faction" ? result.factions.find(entity => entity.slug === slug) : result.canon?.find(entity => entity.slug === slug);
    if (!entity) continue;
    const name = "name" in entity ? entity.name : entity.title;
    const text = "statement" in entity ? entity.statement : Object.values(entity.sheet?.sections ?? {}).join("\n");
    const source = { ...card.source, modified: name !== card.source.originalName || !text.includes(card.source.originalBody) };
    entity.sources = [...(entity.sources ?? []).filter(old => old.candidateId !== card.id), source];
  }
  return result;
}

export async function carryGenesisSources(dir: string, blueprint: GenesisBlueprint, store: WorldStore): Promise<void> {
  await validateGenesisSources(dir, blueprint);
  const ids = genesisSheetIds(blueprint);
  for (const row of genesisContentRows(blueprint)) {
    if (typeof row.content.value !== "object" || !("sources" in row.content.value)) continue;
    for (const source of row.content.value.sources ?? []) {
      await sourceBytes(dir, source);
      if (row.content.kind === "canon") continue; // canon IDs are allocated by the existing gate
      const target = ids.get(row.key)!;
      const result = await fileArtifact(store, { sourcePath: join(genesisControlDir(dir), "sources", source.hash.slice(7), basename(source.name)),
        links: [target], importedFrom: source.name });
      if (result.outcome === "refused" || result.outcome === "needs-consent") throw new Error(result.reason);
    }
  }
}

export async function carryGenesisCanonSources(dir: string, sources: readonly GenesisSource[], entryId: string, store: WorldStore): Promise<void> {
  for (const source of sources) {
    await sourceBytes(dir, source);
    const result = await fileArtifact(store, { sourcePath: join(genesisControlDir(dir), "sources", source.hash.slice(7), basename(source.name)),
      links: [entryId], importedFrom: source.name });
    if (result.outcome === "refused" || result.outcome === "needs-consent") throw new Error(result.reason);
  }
}
