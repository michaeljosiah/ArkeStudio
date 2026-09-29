import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { GenesisReadinessSchema, genesisContentRows, type GenesisReadiness, type Job, type VoiceCandidate, type ManifestModel } from "@arke-studio/contracts";
import { conversationActionDigest } from "../arke-actions/digest.js";
import { atomicWriteFile, serializeFileMutation } from "../world/atomic.js";
import { genesisControlDir } from "./genesis-conversation.js";
import { foldBlueprint } from "./blueprint.js";
import { reviewGenesisContent } from "./genesis-review.js";
import { reviewGenesisImports } from "./genesis-imports.js";
import { reviewedGenesisImages } from "./genesis-images.js";
import { reviewedGenesisVoices } from "./genesis-voices.js";

type Inputs = { jobs: readonly Job[]; catalogue: VoiceCandidate[]; models: readonly ManifestModel[] };
function describe(value: unknown): string {
  if (Array.isArray(value)) return value.map(describe).join("\n");
  if (value && typeof value === "object") return Object.entries(value).map(([field, child]) => field + ": " + describe(child)).join("\n");
  return String(value ?? "");
}
const pathFor = (dir: string) => join(genesisControlDir(dir), "readiness-choices.json");
async function choices(dir: string) {
  return readFile(pathFor(dir), "utf8").then(raw => z.array(z.string()).parse(JSON.parse(raw)))
    .catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
}
export async function reviewGenesisReadiness(dir: string, input: Inputs): Promise<GenesisReadiness> {
  const left = new Set(await choices(dir));
  const findings: GenesisReadiness["findings"] = [], approved: GenesisReadiness["approved"] = [], reused: string[] = [];
  const add = (category: GenesisReadiness["findings"][number]["category"], title: string, detail: string, records: Array<{ key: string; text: string }> = []) => {
    const id = conversationActionDigest({ category, title, detail, records });
    findings.push({ id, category, title, detail, records, leftOpen: category !== "blocker" && category !== "approval" && left.has(id) });
  };
  const draft = await foldBlueprint(dir);
  try {
    const review = await reviewGenesisContent(dir), selected = review.selected;
    if (!selected.name) add("blocker", "Approve a world name", "The world identity needs approval before Begin.", [{ key: "world", text: draft.name ?? "No name proposed." }]);
    for (const problem of review.problems) add("blocker", "Draft needs repair", problem);
    for (const card of review.cards.filter(card => card.status === "pending")) add("approval", card.title, "This revision is unapproved. Begin retains any previously approved version.", [{ key: card.key, text: describe(card.content.value) }]);
    for (const row of genesisContentRows(selected)) if (row.key !== "world" || selected.name) approved.push({ key: row.key, title: row.title });
    for (const question of [...selected.threads, ...(selected.canon ?? []).filter(entry => entry.type === "thread").map(entry => entry.statement)])
      add("open", "Open question", question, [{ key: "threads", text: question }]);
    try {
      const images = await reviewedGenesisImages(dir, selected, input.jobs);
      reused.push(...(images.selectedImages ?? []).map(selection => `${selection.target}: approved image ${selection.candidate.label}`));
    } catch (error) { add("blocker", "Image selection needs attention", error instanceof Error ? error.message : "Review images."); }
    try {
      const voices = await reviewedGenesisVoices(dir, selected, input.jobs, input.catalogue, input.models);
      reused.push(...(voices.selectedVoices ?? []).map(selection => `${selection.plan.intent.target}: voice ${selection.plan.voice.label}`));
    } catch (error) { add("blocker", "Voice selection needs attention", error instanceof Error ? error.message : "Review voices."); }
    if (!selected.characters.length && !selected.locations.length) add("optional", "A minimal world is valid", "Cast and places can be added later. No invented entities are required.");
    add("optional", "Images and voices are optional", "You can leave media and casting undecided. The build review shows any generations that Begin would authorize.");
  } catch (error) { add("blocker", "Content approval needs attention", error instanceof Error ? error.message : "Review the approved content."); }
  try {
    const imports = await reviewGenesisImports(dir);
    for (const problem of imports.problems) add("optional", "An import proposal was not verified", problem);
    for (const card of imports.cards.filter(card => card.status === "pending" || card.status === "deferred")) {
      const alternatives = [...card.matches.map(match => ({ key: match.key, text: match.text })),
        ...card.related.map(other => ({ key: other.source, text: other.text }))];
      if (alternatives.some(other => other.text.trim() !== card.proposal.body.trim())) add("possible-conflict", `Compare interpretations of ${card.proposal.name}`,
        "These records share a name but differ in wording. This may be a duplicate or creative contradiction; it is not a verified conflict.",
        [{ key: card.source.name + ":" + card.source.line, text: card.source.quote }, { key: card.id, text: card.proposal.body }, ...alternatives]);
      else add("optional", `Undecided import: ${card.proposal.name}`, "Leave it unestablished or prepare it for separate content approval.",
        [{ key: card.source.name + ":" + card.source.line, text: card.source.quote }]);
    }
  } catch (error) { add("blocker", "Import recovery needs attention", error instanceof Error ? error.message : "Review imports."); }
  const result = { findings, approved, reused, canBegin: !findings.some(finding => finding.category === "blocker") };
  return GenesisReadinessSchema.parse({ ...result, digest: conversationActionDigest({ draft, ...result }) });
}
export async function leaveGenesisFinding(dir: string, input: Inputs, digest: string, findingId: string): Promise<GenesisReadiness> {
  return serializeFileMutation(pathFor(dir), async () => {
    const review = await reviewGenesisReadiness(dir, input);
    if (review.digest !== digest) throw new Error("The readiness review changed. Refresh before deciding.");
    const finding = review.findings.find(finding => finding.id === findingId);
    if (!finding || finding.category === "blocker" || finding.category === "approval") throw new Error("This requires repair or ordinary content approval.");
    await atomicWriteFile(pathFor(dir), JSON.stringify([...new Set([...await choices(dir), findingId])]) + "\n");
    return reviewGenesisReadiness(dir, input);
  });
}
