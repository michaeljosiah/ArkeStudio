import { zipEntry } from "../world-chat/document-text.js";
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, lstat, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve, relative } from "node:path";
import { z } from "zod";
import { manuscriptDocument, StoryEditionSchema, StoryPublicationSettingsSchema, StoryPdfMetadataSchema,
  type ChapterMix, type ManuscriptDocument, type StoryEdition, type StoryPublicationSettings,
  type StoryStyleFinding } from "@arke-studio/contracts";
import { writeSpeechWav } from "../audio/speech-wav.js";
import { resampleStereo, writeStereoWav } from "../audio/stereo-wav.js";
import { renderAudioStudioMix } from "../productions/audio-studio-mix.js";
import type { MediaProbe } from "../media/probe.js";
import { mixSamples, MIX_RATE } from "../productions/audiobook-mix.js";
import { writeEpub } from "../productions/manuscript.js";
import type { FfmpegRunner } from "../takes/export.js";
import { atomicWriteFile, serializeFileMutation } from "../world/atomic.js";
import type { WorldStore } from "../world/store.js";
import { capturePublicationInputs } from "./capture.js";
import { checkedPublicationPath, readPublicationFile, requirePublicationDigest } from "./files.js";
import { applyStoryStyleChange, readStoryPublication, STORY_COMPILER, storyCompiler, storyDigest, type StoryAudioStudio } from "./story-review.js";
import { renderStoryPdfBounded } from "./story-pdf-runner.js";
import type { STORY_PDF_IDENTITY } from "./story-pdf.js";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Stored = z.object({ edition: StoryEditionSchema, inputHash: Hash.optional() }).strict();
const Draft = z.object({ settings: StoryPublicationSettingsSchema, kept: z.array(Hash) }).strict();
interface FrozenStory {
  document: ManuscriptDocument;
  mixes: Array<{ title: string; mix?: ChapterMix; studio?: StoryAudioStudio }>;
  media: Array<{ file: string; sha256: string; byteLength: number }>;
  cover: { file: string; mediaType: "image/png" | "image/jpeg" } | null;
  compiler: typeof STORY_COMPILER;
  encoder: string | null;
  pdfIdentity?: typeof STORY_PDF_IDENTITY;
  chapterIds?: string[];
}
const metadata = (value: string) => value.replace(/\\/g, "\\\\").replace(/[=;#]/g, "\\$&").replace(/[\r\n]+/g, " ");
const errorText = (error: unknown) => error instanceof Error ? error.message : "The edition could not be prepared.";
const LIMIT = 32 * 1024 ** 3;

/** Host-owned private files. No edition depends on a world folder after its inputs are captured. */
export class StoryPublicationService {
  private readonly active = new Map<string, AbortController>();
  private readonly pdfWork = new Set<Promise<unknown>>();
  private stopping = false;
  private readonly verified = new Map<string, { expected: string; path: string; assertUnchanged(): Promise<void> }>();
  constructor(private readonly root: string, private readonly options: { ffmpeg?: FfmpegRunner; probe?: MediaProbe } = {}) {}
  async stop(): Promise<void> {
    this.stopping = true;
    for (const controller of this.active.values()) controller.abort();
    await Promise.allSettled(this.pdfWork);
  }
  cancel(id: string): void { this.active.get(z.string().uuid().parse(id))?.abort(); }
  private directory(id: string): string { return join(this.root, z.string().uuid().parse(id)); }
  private draftPath(worldId: string, productionId: string): string { return join(this.root, "drafts", storyDigest([worldId, productionId]) + ".json"); }
  private async readDraft(worldId: string, productionId: string) {
    try { return Draft.parse(JSON.parse(await readFile(this.draftPath(worldId, productionId), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw new Error("The saved Publish draft could not be read."); }
  }
  async settings(worldId: string, productionId: string): Promise<StoryPublicationSettings | undefined> { return (await this.readDraft(worldId, productionId))?.settings; }
  async review(store: WorldStore, productionId: string, settings: StoryPublicationSettings) {
    const path = this.draftPath(store.worldId, productionId);
    return serializeFileMutation(path, async () => {
      const previous = await this.readDraft(store.worldId, productionId);
      const read = await store.ownedRead(() => readStoryPublication(store, productionId, settings, new Set(previous?.kept)));
      const kept = read.review.findings.filter(finding => finding.kept).map(finding => finding.id);
      await atomicWriteFile(path, JSON.stringify({ settings: read.review.settings, kept }));
      return read.review;
    });
  }
  async decide(store: WorldStore, productionId: string, settings: StoryPublicationSettings, finding: StoryStyleFinding, decision: "apply" | "keep", replacement: string) {
    if (decision === "apply") await applyStoryStyleChange(store, productionId, settings, finding, replacement);
    else {
      const path = this.draftPath(store.worldId, productionId);
      await serializeFileMutation(path, async () => {
        const current = await store.ownedRead(() => readStoryPublication(store, productionId, settings));
        const actual = current.review.findings.find(row => row.id === finding.id);
        if (!actual || actual.baseHash !== finding.baseHash) throw new Error("The source changed. Recheck this suggestion.");
        const previous = await this.readDraft(store.worldId, productionId);
        await atomicWriteFile(path, JSON.stringify({ settings, kept: [...new Set([...(previous?.kept ?? []), actual.id])] }));
      });
    }
    return this.review(store, productionId, settings);
  }
  private async load(id: string) {
    const directory = this.directory(id);
    const bytes: Buffer[] = [];
    await readPublicationFile(directory, "edition.json", 1024 * 1024, undefined, undefined, bytes);
    return Stored.parse(JSON.parse(Buffer.concat(bytes).toString("utf8")));
  }
  private async write(value: z.infer<typeof Stored>): Promise<void> {
    await atomicWriteFile(join(this.directory(value.edition.id), "edition.json"), JSON.stringify(Stored.parse(value)));
  }
  async list(worldId?: string, productionId?: string): Promise<StoryEdition[]> {
    const names = await readdir(this.root).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return []; throw error; });
    const editions: StoryEdition[] = [];
    for (const id of names.filter(name => z.string().uuid().safeParse(name).success)) {
      let saved: z.infer<typeof Stored>;
      try { saved = await this.load(id); }
      catch (error) {
        // A crash before the first receipt can leave a directory, not an edition.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      let edition = saved.edition;
      if ((worldId && edition.worldId !== worldId) || (productionId && edition.productionId !== productionId)) continue;
      if (edition.status === "creating" && !this.active.has(id)) {
        edition = { ...edition, status: "failed", phase: "Interrupted", error: "Preparation was interrupted. Retry uses this edition’s captured inputs." };
      }
      if (edition.status === "ready" || edition.status === "preview") {
        try { await this.verify(edition); }
        catch { edition = { ...edition, error: "A file is missing or changed. This edition cannot be delivered." }; }
      }
      editions.push(edition);
    }
    return editions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  private async verifiedFile(edition: StoryEdition, file: StoryEdition["files"][number]): Promise<string> {
    const key = edition.id + "/" + file.name, expected = file.sha256 + ":" + file.bytes;
    const cached = this.verified.get(key);
    if (cached?.expected === expected) {
      try { await cached.assertUnchanged(); return cached.path; }
      catch { this.verified.delete(key); }
    }
    const digest = await readPublicationFile(this.directory(edition.id), "files/" + file.name, LIMIT);
    requirePublicationDigest(digest, { sha256: file.sha256, byteLength: file.bytes });
    const path = await checkedPublicationPath(this.directory(edition.id), "files/" + file.name);
    this.verified.set(key, { expected, path, assertUnchanged: digest.assertUnchanged });
    return path;
  }
  private async verify(edition: StoryEdition): Promise<void> {
    if (edition.files.length !== edition.settings.outputs.length || new Set(edition.files.map(file => file.format)).size !== edition.files.length) throw new Error("The edition is incomplete.");
    for (const file of edition.files) {
      if (file.name !== "story." + file.format || !edition.settings.outputs.includes(file.format)) throw new Error("Invalid edition inventory.");
      if (file.format === "pdf" && (!file.pdf || file.pdf.chapters.length !== edition.settings.chapterIds.length ||
        new Set(file.pdf.chapters.map(chapter => chapter.id)).size !== edition.settings.chapterIds.length ||
        file.pdf.chapters.some(chapter => !edition.settings.chapterIds.includes(chapter.id)))) throw new Error("The PDF navigation is incomplete.");
      await this.verifiedFile(edition, file);
    }
  }
  async serve(id: string, name: string) { return this.resolveMedia(id, name, false); }
  async previewMedia(id: string, name: string) {
    const hit = await this.resolveMedia(id, name, true);
    return hit ? { path: hit.path, contentType: hit.contentType } : null;
  }
  private async resolveMedia(id: string, name: string, preview: boolean): Promise<{ path: string; contentType: string; downloadName: string } | null> {
    try {
      const { edition } = await this.load(id);
      if (edition.status !== "ready" && !(preview && edition.status === "preview")) return null;
      const file = edition.files.find(file => file.name === name);
      if (!file) return null;
      // Range requests recheck file identity; unchanged multi-hour books need not be rehashed at each seek.
      const path = await this.verifiedFile(edition, file);
      return { path, contentType: file.format === "epub" ? "application/epub+zip" : file.format === "pdf" ? "application/pdf" : "audio/mp4", downloadName: [...edition.settings.title].map(char => char.charCodeAt(0) < 32 || '<>:"/\\\\|?*'.includes(char) ? "_" : char).slice(0, 100).join("") + "." + file.format };
    } catch { return null; }
  }
  /** Only the trusted desktop picker supplies source; matching bytes repair the same edition. */
  async restoreFile(id: string, name: string, source: string): Promise<void> {
    await serializeFileMutation(join(this.directory(id), "restore"), async () => {
      const { edition } = await this.load(id);
      const file = edition.files.find(row => row.name === name && row.name === "story." + row.format);
      if (!file || !["preview", "ready"].includes(edition.status)) throw new Error("This edition file cannot be restored.");
      if (await this.previewMedia(id, name)) return;
      const folder = join(this.directory(id), "files"), info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The edition folder is unavailable.");
      const stage = join(folder, randomUUID() + ".restore");
      try {
        const destination = await open(stage, "wx");
        try {
          const digest = await readPublicationFile(dirname(source), basename(source), LIMIT, undefined, destination);
          requirePublicationDigest(digest, { sha256: file.sha256, byteLength: file.bytes });
          await destination.sync();
        } finally { await destination.close(); }
        await rename(stage, join(folder, file.name));
      } finally { await rm(stage, { force: true }); }
    });
  }
  async previewPage(id: string, chapter: number): Promise<{ html: string; chapter: number; count: number }> {
    const { edition } = await this.load(id);
    const file = await this.previewMedia(id, "story.epub");
    if (!file || !Number.isInteger(chapter) || chapter < 0 || chapter >= edition.settings.chapterIds.length) throw new Error("The captured book page is unavailable.");
    const bytes = await readFile(file.path);
    const page = zipEntry(bytes, "OEBPS/chapter-" + (chapter + 1) + ".xhtml");
    const css = zipEntry(bytes, "OEBPS/style.css");
    if (!page || !css) throw new Error("The captured book page is incomplete.");
    const html = new TextDecoder().decode(page).replace(/<link[^>]+>/, "<style>" + new TextDecoder().decode(css) + "</style>");
    if (html.length > 4_000_000) throw new Error("This chapter is too large for the in-app preview.");
    return { html, chapter, count: edition.settings.chapterIds.length };
  }
  async preview(store: WorldStore, productionId: string, settings: StoryPublicationSettings, fingerprint: string, notify: (edition: StoryEdition) => void): Promise<StoryEdition> {
    if (this.stopping) throw new Error("Publishing is stopping. Reopen Arke before preparing another edition.");
    const id = randomUUID(), directory = this.directory(id);
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, store.closingSignal]);
    this.active.set(id, controller);
    const saved: z.infer<typeof Stored> = { edition: { id, worldId: store.worldId, productionId, createdAt: new Date().toISOString(), settings,
      fingerprint, status: "creating", phase: "Capturing source", files: [] } };
    try {
      await mkdir(directory, { recursive: true });
      await this.write(saved); notify(saved.edition);
      const draft = await this.readDraft(store.worldId, productionId);
      let snapshot: Awaited<ReturnType<typeof readStoryPublication>> | undefined;
      const captured = await capturePublicationInputs(store, async () => {
        snapshot = await readStoryPublication(store, productionId, settings, new Set(draft?.kept));
        if (snapshot.review.fingerprint !== fingerprint) throw new Error("The source changed. Recheck and preview the edition again.");
        const blockers = [...snapshot.review.blockers, ...snapshot.review.chapters.flatMap(chapter => settings.outputs.includes("m4b") ? chapter.audioProblems.map(problem => chapter.title + ": " + problem) : [])];
        if (snapshot.review.findings.some(finding => !finding.kept)) blockers.push("Review the remaining style suggestions or turn off the optional rule.");
        if (blockers.length) throw new Error(blockers.join("\n"));
        if (settings.outputs.includes("m4b") && (!this.options.ffmpeg || !this.options.probe?.info)) throw new Error("Audiobook export needs the host’s audio tools.");
        const records = Object.fromEntries(Object.keys(snapshot.manifest).map(path => [path, path]));
        const identity = snapshot.identity;
        return { request: { records, media: Object.fromEntries(snapshot.media.map(file => [file.key, file.key])), receipt: {
          version: 1, compiler: storyCompiler(settings), timelineRevision: null,
          records: Object.entries(snapshot.manifest).map(([key, hash]) => ({ key, sha256: hash.replace(/^sha256:/, "") })),
          media: snapshot.media, resolvedPlanSha256: fingerprint, settingsSha256: storyDigest(settings),
        } }, revalidate: async () => {
          const next = await readStoryPublication(store, productionId, settings, new Set(draft?.kept));
          if (next.identity !== identity) throw new Error("The source changed while it was being captured. Recheck and preview again.");
        } };
      }, directory, { signal });
      try {
        const inputRoot = join(directory, "inputs");
        await mkdir(join(inputRoot, "artifacts"), { recursive: true });
        const paths = new Map<string, string>();
        const media: FrozenStory["media"] = [];
        for (const [index, entry] of captured.receipt.media.entries()) {
          const file = "artifacts/source-" + index + extname(entry.key).toLowerCase();
          paths.set(entry.key, file);
          await copyFile(captured.media[entry.key]!, join(inputRoot, file));
          const handle = await open(join(inputRoot, file), "r+"); try { await handle.sync(); } finally { await handle.close(); }
          requirePublicationDigest(await readPublicationFile(inputRoot, file, LIMIT, signal), entry);
          media.push({ file, sha256: entry.sha256, byteLength: entry.byteLength });
        }
        let cover: FrozenStory["cover"] = null;
        if (settings.cover) {
          const file = paths.get(settings.cover)!;
          const bytes = await readFile(join(inputRoot, file));
          const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
          const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
          if (!png && !jpeg) throw new Error("Choose a PNG or JPEG cover.");
          cover = { file, mediaType: png ? "image/png" : "image/jpeg" };
        }
        const pathOf = (file: string) => { const path = paths.get(file); if (!path) throw new Error("An audio input was not captured."); return path; };
        const frozen: FrozenStory = { compiler: storyCompiler(settings), ...(snapshot!.pdfIdentity ? { pdfIdentity: snapshot!.pdfIdentity, chapterIds: snapshot!.chapters.map(chapter => chapter.id) } : {}), encoder: settings.outputs.includes("m4b") ? await this.options.ffmpeg?.identity?.(signal) ?? "injected-runner" : null, document: manuscriptDocument({ title: settings.title, worldName: "", chapters: snapshot!.chapters }),
          mixes: snapshot!.chapters.flatMap((chapter): FrozenStory["mixes"] => settings.outputs.includes("m4b") && chapter.studio ? [{ title: chapter.title, studio: { ...chapter.studio, state: { ...chapter.studio.state,
            clips: chapter.studio.state.clips.map(clip => ({ ...clip, source: clip.source ? { ...clip.source, file: pathOf(clip.source.file) } : null })),
          } } }] : chapter.mix ? [{ title: chapter.title, mix: { ...chapter.mix,
            voices: chapter.mix.voices.map(voice => ({ ...voice, segments: voice.segments.map(segment => ({ ...segment, file: pathOf(segment.file) })) })),
            beds: chapter.mix.beds.map(bed => ({ ...bed, file: pathOf(bed.file) })),
            sounds: chapter.mix.sounds.map(sound => ({ ...sound, file: pathOf(sound.file) })),
          } }] : []), media, cover };
        const text = JSON.stringify(frozen);
        await atomicWriteFile(join(directory, "inputs.json"), text);
        saved.inputHash = storyDigest(frozen);
        await this.write(saved);
      } finally { await captured.dispose(); }
      return await this.render(saved, signal, notify);
    } catch (error) {
      saved.edition = { ...saved.edition, status: signal.aborted ? "cancelled" : "failed", phase: signal.aborted ? "Cancelled" : "Preparation failed", error: errorText(error) };
      await this.write(saved); notify(saved.edition); return saved.edition;
    } finally { this.active.delete(id); }
  }
  async retry(id: string, notify: (edition: StoryEdition) => void): Promise<StoryEdition> {
    if (this.stopping) throw new Error("Publishing is stopping. Reopen Arke before retrying an edition.");
    if (this.active.has(id)) throw new Error("This edition is already being prepared.");
    const saved = await this.load(id);
    if (this.stopping) throw new Error("Publishing is stopping. Reopen Arke before retrying an edition.");
    if (saved.edition.status === "ready") { await this.verify(saved.edition); return saved.edition; }
    if (saved.edition.status === "preview") { await this.verify(saved.edition); return saved.edition; }
    if (!saved.inputHash) throw new Error("Capture did not finish. Recheck the source and prepare a new preview.");
    const controller = new AbortController(); this.active.set(id, controller);
    try { return await this.render(saved, controller.signal, notify); }
    catch (error) {
      saved.edition = { ...saved.edition, status: controller.signal.aborted ? "cancelled" : "failed", phase: "Preparation stopped", error: errorText(error) };
      await this.write(saved); notify(saved.edition); return saved.edition;
    } finally { this.active.delete(id); }
  }
  private async render(saved: z.infer<typeof Stored>, signal: AbortSignal, notify: (edition: StoryEdition) => void): Promise<StoryEdition> {
    const edition = saved.edition, directory = this.directory(edition.id), inputRoot = join(directory, "inputs"), output = join(directory, "files");
    const frozen = JSON.parse(await readFile(await checkedPublicationPath(directory, "inputs.json"), "utf8")) as FrozenStory;
    if (!saved.inputHash || storyDigest(frozen) !== saved.inputHash) throw new Error("Captured inputs changed. This edition cannot be rebuilt.");
    if (frozen.compiler?.compiler !== STORY_COMPILER.compiler || !["1", "2", "3"].includes(frozen.compiler.compilerVersion)) throw new Error("This edition uses an unsupported compiler. Prepare a new edition.");
    if (edition.settings.outputs.includes("pdf")) {
      const current = await (await import("./story-pdf.js")).storyPdfIdentity();
      if (!frozen.pdfIdentity || frozen.compiler.compilerVersion !== "3" || storyDigest(frozen.pdfIdentity) !== storyDigest(current))
        throw new Error("The PDF renderer or fonts changed. Prepare a new edition.");
    }
    if (frozen.encoder !== null && frozen.encoder !== (await this.options.ffmpeg?.identity?.(signal) ?? "injected-runner")) throw new Error("The audio encoder changed. Recheck and prepare a fresh preview.");
    for (const input of frozen.media) requirePublicationDigest(await readPublicationFile(inputRoot, input.file, LIMIT, signal), input);
    await mkdir(output, { recursive: true });
    const phase = async (text: string) => { saved.edition = { ...saved.edition, status: "creating", phase: text }; delete saved.edition.error; await this.write(saved); notify(saved.edition); signal.throwIfAborted(); };
    const files: StoryEdition["files"] = [];
    for (const format of edition.settings.outputs) {
      await phase(format === "epub" ? "Preparing EPUB" : format === "pdf" ? "Formatting pages" : "Rendering audiobook");
      const name = "story." + format, path = join(output, name);
      let pdf: import("@arke-studio/contracts").StoryPdfMetadata | undefined;
      if (format === "epub") {
        const cover = frozen.cover ? { bytes: await readFile(join(inputRoot, frozen.cover.file)), mediaType: frozen.cover.mediaType } : undefined;
        const bytes = writeEpub(frozen.document, { identifier: "urn:uuid:" + edition.id, language: edition.settings.language,
          modified: edition.createdAt, author: edition.settings.author, description: edition.settings.description, ...(cover ? { cover } : {}) });
        await atomicWriteFile(path, bytes);
      } else if (format === "pdf") {
        if (!edition.settings.pdf) throw new Error("This edition has no saved PDF formatting. Prepare a new preview.");
        const cover = frozen.cover ? { bytes: await readFile(join(inputRoot, frozen.cover.file)), mediaType: frozen.cover.mediaType } : undefined;
        const task = renderStoryPdfBounded(frozen.document, { author: edition.settings.author, language: edition.settings.language,
          subtitle: edition.settings.subtitle, editionLabel: edition.settings.editionLabel, settings: edition.settings.pdf,
          chapterIds: frozen.chapterIds ?? edition.settings.chapterIds, ...(cover ? { cover } : {}) }, { signal, onPhase: phase });
        this.pdfWork.add(task);
        const rendered = await task.finally(() => this.pdfWork.delete(task));
        pdf = StoryPdfMetadataSchema.parse({ pageCount: rendered.pageCount, chapters: rendered.chapters, pageLabels: rendered.pageLabels });
        signal.throwIfAborted();
        await atomicWriteFile(path, rendered.bytes);
        await atomicWriteFile(join(directory, "pdf-validation.json"), JSON.stringify(rendered.receipt));
      } else {
        if (!this.options.ffmpeg || !this.options.probe?.info) throw new Error("Audiobook export needs the host’s audio tools.");
        const work = resolve(directory, "render");
        if (relative(resolve(directory), work) !== "render") throw new Error("Invalid render directory.");
        await mkdir(work, { recursive: true });
        try {
          const tracks: string[] = [], boundaries: Array<{ title: string; start: number; end: number }> = [];
          const stereo = frozen.mixes.some(chapter => chapter.studio !== undefined);
          let time = 0;
          for (const [index, chapter] of frozen.mixes.entries()) {
            await phase("Rendering chapter " + (index + 1) + " of " + frozen.mixes.length);
            const file = "chapter-" + index + ".wav";
            let duration: number;
            if (chapter.studio) {
              const rendered = await renderAudioStudioMix(inputRoot, chapter.studio.state, chapter.studio.script, { cacheRoot: work, ffmpeg: this.options.ffmpeg, signal, final: true });
              await copyFile(await checkedPublicationPath(work, rendered.file), join(work, file));
              duration = rendered.seconds;
            } else {
              if (!chapter.mix) throw new Error("The captured chapter has no audio plan.");
              const pcm = await mixSamples(inputRoot, chapter.mix, { ffmpeg: this.options.ffmpeg, signal });
              await atomicWriteFile(join(work, file), stereo ? writeStereoWav(resampleStereo({ rate: MIX_RATE, channels: 1, left: pcm.samples, right: pcm.samples }, 48000)) : writeSpeechWav(pcm));
              duration = pcm.samples.length / MIX_RATE;
            }
            tracks.push(file);
            boundaries.push({ title: chapter.title, start: time, end: time + duration }); time += duration;
          }
          if (!tracks.length) throw new Error("No complete narration was captured.");
          await atomicWriteFile(join(work, "chapters.txt"), tracks.map(file => "file '" + file + "'").join("\n") + "\n");
          await atomicWriteFile(join(work, "metadata.txt"), ";FFMETADATA1\ntitle=" + metadata(edition.settings.title) + "\nartist=" + metadata(edition.settings.author) + "\n" +
            boundaries.map(chapter => "[CHAPTER]\nTIMEBASE=1/1000\nSTART=" + Math.round(chapter.start * 1000) + "\nEND=" + Math.round(chapter.end * 1000) + "\ntitle=" + metadata(chapter.title)).join("\n") + "\n");
          const candidate = join(work, "candidate.m4b");
          const coverArgs = frozen.cover ? ["-i", join(inputRoot, frozen.cover.file)] : [];
          const coverMap = frozen.cover ? ["-map", "2:v:0", "-c:v", frozen.cover.mediaType === "image/png" ? "png" : "mjpeg", "-disposition:v:0", "attached_pic"] : ["-vn"];
          await this.options.ffmpeg.run(["-y", "-f", "concat", "-safe", "1", "-i", join(work, "chapters.txt"), "-i", join(work, "metadata.txt"), ...coverArgs,
            "-map", "0:a:0", ...coverMap, "-map_metadata", "1", "-map_chapters", "1", "-metadata", "album=" + edition.settings.title, "-metadata", "language=" + edition.settings.language, "-metadata", "description=" + edition.settings.description, "-metadata", "comment=" + edition.settings.label, "-c:a", "aac", "-b:a", "192k", ...(stereo ? ["-ac", "2", "-ar", "48000"] : []), "-movflags", "+faststart", "-f", "mp4", candidate], () => {}, signal);
          const info = await this.options.probe.info(candidate, { signal });
          if (!info?.hasAudio || !Number.isFinite(info.durationSec) || Math.abs(info.durationSec - time) > 0.2) throw new Error("The audiobook did not pass its duration and audio checks.");
          const handle = await open(candidate, "r+"); try { await handle.sync(); } finally { await handle.close(); }
          await rename(candidate, path);
        } finally { await rm(work, { recursive: true, force: true }); }
      }
      signal.throwIfAborted();
      const measured = await readPublicationFile(output, name, LIMIT, signal);
      if (measured.byteLength === 0) throw new Error("The output is empty.");
      files.push({ format, name, bytes: measured.byteLength, sha256: measured.sha256, ...(pdf ? { pdf } : {}) });
    }
    saved.edition = { ...saved.edition, files, status: "preview", phase: "Preview ready" };
    await this.verify(saved.edition); signal.throwIfAborted();
    await this.write(saved); notify(saved.edition); return saved.edition;
  }
  async create(store: WorldStore, productionId: string, id: string): Promise<StoryEdition> {
    return serializeFileMutation(join(this.directory(id), "create"), async () => {
      const saved = await this.load(id), edition = saved.edition;
      if (edition.worldId !== store.worldId || edition.productionId !== productionId) throw new Error("Open this edition’s source story before creating it.");
      if (edition.status === "ready") { await this.verify(edition); return edition; }
      if (edition.status !== "preview") throw new Error("Preview this edition before creating it.");
      return store.ownedRead(async () => {
      const current = await readStoryPublication(store, productionId, edition.settings);
      if (current.review.fingerprint !== edition.fingerprint) throw new Error("The source changed since preview. Recheck and prepare a fresh preview.");
      await this.verify(edition);
      saved.edition = { ...edition, status: "ready", phase: "Files ready" };
      await this.write(saved); return saved.edition;
      });
    });
  }
}
