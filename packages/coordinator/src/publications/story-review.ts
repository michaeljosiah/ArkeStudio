import { createHash } from "node:crypto";
import {
  audiobookBlocks, audiobookBlockOptions, audiobookHeading, chapterMix, countWords, emDashSuggestions,
  manuscriptDocument, publicationTextProblems, StoryPublicationSettingsSchema,
  type ChapterMix, type StoryPublicationReview, type StoryPublicationSettings, type StoryStyleFinding,
} from "@arke-studio/contracts";
import { effectiveAudioRights, readAudioRights } from "../audio/rights.js";
import { ProseAuthoringService } from "../application/prose-authoring.js";
import { anyNarrator } from "../productions/audiobook-listening.js";
import { planAudiobook, type AudiobookPlan } from "../productions/audiobook.js";
import { chapterTiming, plannedReactions } from "../productions/audiobook-timing.js";
import { openChapter } from "../productions/ops.js";
import { scanWorld } from "../world/scan.js";
import type { WorldStore } from "../world/store.js";
import { readPublicationFile } from "./files.js";

export const storyDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const STORY_COMPILER = { compiler: "arke-private-story", compilerVersion: "1" };
export function mixFiles(mix: ChapterMix): string[] {
  return [...new Set([...mix.voices.flatMap(voice => voice.segments.map(segment => segment.file)), ...mix.beds.map(bed => bed.file), ...mix.sounds.map(sound => sound.file)])];
}

/** Run under the world's read gate. The fresh scan prevents stale bundle metadata winning over disk. */
export async function readStoryPublication(store: WorldStore, productionId: string, input: StoryPublicationSettings, kept: ReadonlySet<string> = new Set()) {
  const settings = StoryPublicationSettingsSchema.parse(input);
  const scan = await scanWorld(store.dir, { includeOperationalState: false, signal: store.closingSignal });
  const production = scan.bundle.productions.find(row => row.meta.id === productionId);
  if (!production) throw new Error("This story is no longer available.");
  const view = Object.create(store) as WorldStore;
  view.getBundle = () => scan.bundle;
  const selected = production.chapters.filter(chapter => !chapter.retired && settings.chapterIds.includes(chapter.id)).sort((a, b) => a.order - b.order);
  if (selected.length !== settings.chapterIds.length) throw new Error("The chapter selection changed. Choose the chapters again.");
  const blockers: string[] = [], warnings: string[] = [];
  const rights = settings.outputs.includes("m4b") ? await readAudioRights(store) : [];
  for (const problem of scan.problems.filter(problem => (problem.path.startsWith(`productions/${productionId}/chapters/`) || (settings.outputs.includes("m4b") && problem.path.startsWith(`productions/${productionId}/`))))) blockers.push(`${problem.path}: ${problem.message}`);
  for (const problem of publicationTextProblems([settings.title, settings.author, settings.description, settings.label].join("\n"))) blockers.push(problem);
  const chapters: Array<Awaited<ReturnType<typeof openChapter>> & { id: string; audioProblems: string[]; plan: AudiobookPlan | null; mix: ChapterMix | null }> = [];
  const findings: StoryStyleFinding[] = [];
  for (const summary of selected) {
    const chapter = await openChapter(view, productionId, summary.id, { canonicalId: true });
    if (!manuscriptDocument({ title: "", worldName: "", chapters: [chapter] }).chapters.length) blockers.push(`${chapter.title}: this chapter has no prose. Write it or explicitly leave it out.`);
    for (const problem of publicationTextProblems(chapter.body)) blockers.push(`${chapter.title}: ${problem}`);
    if (publicationTextProblems(chapter.title).length) blockers.push(`${chapter.title}: check the chapter heading.`);
    const plan = await planAudiobook(view, productionId, summary.id, { narrator: await anyNarrator(view, productionId) }).catch(() => null);
    const audioProblems: string[] = [];
    if (!plan || plan.record === "unreadable" || plan.cast === "unreadable") audioProblems.push("Narration records could not be read.");
    else {
      for (const block of [...plan.blocks, ...plannedReactions(view, plan, await anyNarrator(view, productionId))]) {
        if (block.state !== "made") audioProblems.push(`Block ${block.block.key}: ${block.state === "stale" ? "needs updating" : block.state}.`);
        const flag = plan.record?.flags[block.block.key], take = plan.record?.takes[block.block.key];
        const artifact = scan.bundle.artifacts.find(row => row.id === take?.artifactId);
        if (block.state === "made" && !(take?.grouped ? take.grouped.durationSec > 0 : (artifact?.mediaInfo?.durationSec ?? 0) > 0)) audioProblems.push('Block ' + block.block.key + ': measured duration is missing.');
        const generation = artifact?.generation;
        if (take?.source === "recorded") {
          const recording = generation && "recording" in generation ? generation.recording : undefined;
          if (!recording || !effectiveAudioRights(rights, recording.preparedHash, "recorded-take").some(event => event.id === recording.acknowledgementId)) audioProblems.push(`Block ${block.block.key}: recording clearance needs review.`);
        }
        if (flag && (!take || flag.at > take.madeAt) && block.state !== "flagged") audioProblems.push(`Block ${block.block.key}: flagged.`);
      }
      if (plan.blocks.length === 0) audioProblems.push("No narration blocks.");
      for (const key of Object.keys(plan.record?.reactions ?? {})) {
        const take = plan.record?.takes[key];
        if (!take || !plan.present.has(take.artifactId)) audioProblems.push(`Reaction ${key}: needs recording.`);
      }
    }
    const timing = settings.outputs.includes("m4b") && plan && audioProblems.length === 0 ? chapterTiming(view, plan, "skip") : null;
    if (timing) {
      for (const [kind, keys] of Object.entries(timing.lost)) for (const key of keys) audioProblems.push(`${kind} ${key}: placement needs review.`);
      if (timing.bars.some(bar => !bar.made)) audioProblems.push("Some narration or reactions are missing or stale.");
    }
    const mix = timing && audioProblems.length === 0 ? chapterMix(timing) : null;
    if (settings.avoidEmDashes) {
      for (const finding of emDashSuggestions(chapter.body)) {
        const id = storyDigest({ chapter: summary.id, scope: settings.chapterIds, rule: "avoid-em-dashes-v1", paragraph: finding.paragraph, before: finding.before });
        const narration = plan?.blocks.filter(block => block.block.paragraph === finding.paragraph && plan.record !== "unreadable" && plan.record?.takes[block.block.key]).map(block => block.block.key) ?? [];
        findings.push({ ...finding, id, chapterId: summary.id, chapterTitle: chapter.title, chapterFile: chapter.file,
          baseHash: chapter.hash, narration, kept: kept.has(id) });
      }
      if (chapter.title.includes("—")) warnings.push(`${chapter.title}: the heading contains an em dash. Review the title in the manuscript.`);
    }
    chapters.push({ ...chapter, id: summary.id, audioProblems, plan, mix });
  }
  const mediaPaths = [...new Set([...(settings.cover ? [settings.cover] : []), ...chapters.flatMap(chapter => chapter.mix ? mixFiles(chapter.mix) : [])])];
  const media: Array<{ key: string; sha256: string; byteLength: number }> = [];
  for (const path of mediaPaths) {
    try {
      const digest = await readPublicationFile(store.dir, path, 2 * 1024 ** 3, store.closingSignal);
      const artifact = scan.bundle.artifacts.find(row => `artifacts/${row.file}` === path);
      if (artifact && ! `sha256:${digest.sha256}`.startsWith(artifact.hash)) throw new Error("The media bytes differ from their saved identity.");
      media.push({ key: path, sha256: digest.sha256, byteLength: digest.byteLength });
    } catch { blockers.push(`${path.split("/").pop()}: media is missing, changed or unreadable.`); }
  }
  const identity = {
    settings, chapters: chapters.map(({ id, title, order, body, plan, mix }) => ({ id, title, order, body,
      ...(settings.outputs.includes("m4b") ? { record: plan?.record, book: plan?.book, cast: plan?.cast, blocks: plan?.blocks, mix } : {}) })),
    media, rights, compiler: STORY_COMPILER,
  };
  const fingerprint = storyDigest(identity);
  const review: StoryPublicationReview = { fingerprint, settings, chapters: chapters.map(chapter => ({ id: chapter.id, title: chapter.title, words: countWords(chapter.body), audioProblems: chapter.audioProblems })), findings, blockers, warnings };
  return { review, chapters, media, manifest: scan.manifest, identity: storyDigest({ identity, manifest: scan.manifest }) };
}

/** Approve one exact proposal through the manuscript's ordinary versioned save. No provider work. */
export async function applyStoryStyleChange(store: WorldStore, productionId: string, settings: StoryPublicationSettings, finding: StoryStyleFinding, replacement: string): Promise<void> {
  if (!replacement.trim() || /\n[ \t]*\n/.test(replacement) || publicationTextProblems(replacement).length) throw new Error("Enter a valid replacement before applying.");
  const current = await store.ownedRead(() => readStoryPublication(store, productionId, settings));
  const actual = current.review.findings.find(row => row.id === finding.id);
  if (!actual || actual.baseHash !== finding.baseHash || actual.before !== finding.before) throw new Error("The source changed. Recheck this suggestion before applying it.");
  if (replacement === actual.before) throw new Error("The text is unchanged. Choose Keep original.");
  const chapter = current.chapters.find(row => row.id === actual.chapterId)!;
  const body = chapter.body.slice(0, actual.start) + replacement + chapter.body.slice(actual.end);
  await new ProseAuthoringService(store).save(productionId, chapter.file, body, { baseHash: actual.baseHash, source: "publish-style-review", newVersion: true });
}

/** Show precisely which existing recordings a replacement changes, including split/joined blocks. */
export function affectedStoryNarration(plan: AudiobookPlan, body: string): string[] {
  const record = plan.record === "unreadable" ? null : plan.record;
  const next = audiobookBlocks(body, plan.cast === "unreadable" ? null : plan.cast, audiobookHeading(plan.chapter.order, plan.chapter.title), audiobookBlockOptions(plan.book, record));
  return plan.blocks.filter(block => record?.takes[block.block.key] && !next.blocks.some(candidate => candidate.key === block.block.key && candidate.text === block.block.text)).map(block => block.block.key);
}


