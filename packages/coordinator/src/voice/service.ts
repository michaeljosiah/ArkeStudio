import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  clonedVoiceCandidates,
  normalizeSpeechText,
  KOKORO_VOICE_MODEL,
  estimateMicroUsd,
  extractVoiceAttributes,
  previewLineFor,
  rankVoices,
  isGraphScene,
  splitBible,
  type ClonedVoice,
  type DomainEvent,
  type ManifestModel,
  type ModelManifest,
  type PreviewLine,
  type ProseReadSource,
  type Sheet,
  type VoiceCandidate,
  type VoiceAudioFormat,
  voiceFormatForModel,
  voiceTargetKey,
  type WorldBundle,
  chapterParagraphs,
} from "@arke-studio/contracts";
import { atomicWriteFile } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import type { EnqueueInput } from "../queue/dispatcher.js";
import { flacProblem, verifyArtifact } from "../queue/verify.js";

/**
 * The voice service (SPEC-011): a unified catalogue over local presets and cloud voices
 * (R-6), honest attribute-overlap matching (R-7, R-8), preview lines from the character's own
 * words with a per-voice-and-line cache (R-9, R-10), and local dictation (R-17). Local
 * synthesis goes straight to the sidecar — no queue, no ledger, zero cost; cloud previews and
 * lines go through the queue like every other dispatch (R-2, D1).
 */

/** The sidecar slice this service needs; @arke-studio/voice's VoxaClient satisfies it. */
export interface SidecarLike {
  /**
   * Whether each engine can actually do its job — asked before the catalogue offers a voice.
   *
   * `listVoices` answers from the preset list and keeps answering after the speech engine has
   * failed to load, so the two questions are genuinely different and only one of them was being
   * asked. Structurally typed rather than importing SidecarHealth, so this package keeps not
   * depending on @arke-studio/voice.
   */
  health(): Promise<{ engineStatus: { kokoro: { ready: boolean; reason?: string } } } | null>;
  listVoices(): Promise<Array<{ id: string; label: string; attributes: string[] }>>;
  synthesize(input: { voiceId: string; text: string; params?: Record<string, number> }, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  transcribe(audio: Uint8Array, contentType: string): Promise<string>;
}

/** The one cloud-catalogue call the picker needs; ElevenLabsClient gains listVoicesCatalog. */
export interface CloudVoiceSource {
  provider: string;
  list(key: string): Promise<VoiceCandidate[]>;
}

export interface VoiceServiceDeps {
  sidecar: SidecarLike | null;
  localPresets: VoiceCandidate[];
  cloudSources: CloudVoiceSource[];
  getKey: (provider: string) => Promise<string | null>;
  emit: (event: DomainEvent) => void;
  clock?: () => string;
}

const PREVIEW_CACHE_DIR = ".cache/voice-previews";
const SPEECH_SETTINGS_VERSION = 1;

export { normalizeSpeechText } from "@arke-studio/contracts";

/**
 * How much text the local engine is asked to speak at once (2026-08-24).
 *
 * Measured, not guessed. 500 characters synthesises in about 32 seconds and leaves the engine
 * healthy; 8,610 in one request returns 503 after sixteen seconds and leaves Kokoro permanently
 * unavailable — not just for that request, for every voice feature in the app until it is
 * restarted. The cap this replaces was 10,000, which let the fatal request straight through.
 *
 * 450 sits under the largest size proven safe, with room for the sentence splitter to overshoot
 * slightly rather than cut a clause in half.
 */
const LOCAL_SPEECH_CHUNK = 450;

/**
 * Break text into pieces small enough to synthesise, preferring sentence ends.
 *
 * A chunk boundary is audible — the engine renders each piece with its own opening and closing
 * prosody — so they are placed where a reader would pause anyway. A sentence longer than the cap
 * falls back to clause boundaries, then to a hard cut, because refusing to speak a long sentence
 * would be a worse answer than breathing in an odd place.
 */
export function splitForSpeech(text: string, max = LOCAL_SPEECH_CHUNK): string[] {
  const pieces: string[] = [];
  let held = "";
  const flush = () => {
    if (held.trim() !== "") pieces.push(held.trim());
    held = "";
  };
  // Keep the terminator with the sentence it ends: the engine reads "?" differently from ".".
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (sentence.length > max) {
      flush();
      let rest = sentence;
      while (rest.length > max) {
        const window = rest.slice(0, max);
        // A comma or semicolon in the back half is a better seam than the middle of a word.
        const seam = Math.max(window.lastIndexOf(", "), window.lastIndexOf("; "));
        const cut = seam > max / 2 ? seam + 1 : Math.max(window.lastIndexOf(" "), max);
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      held = rest;
      continue;
    }
    if (held.length + sentence.length + 1 > max) flush();
    held = held === "" ? sentence : `${held} ${sentence}`;
  }
  flush();
  return pieces;
}

/**
 * Join RIFF/WAVE buffers into one, keeping the first header and concatenating the audio.
 *
 * Chunked synthesis returns a complete wav per piece, and a player handed them end to end would
 * hear the second header as a click. The `data` chunk is located rather than assumed at a fixed
 * offset — the engine is free to include `LIST` or `fact` chunks, and a hard-coded 44 would read
 * those as samples.
 */
export function concatWav(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 0) throw new Error("Nothing to join.");
  for (const part of parts) {
    if (!cachedVoiceAudioLooksRight(part, "wav")) throw new Error("Voxa returned invalid audio.");
  }
  if (parts.length === 1) return parts[0]!;
  const dataOf = (buf: Uint8Array): { header: Uint8Array; data: Uint8Array } => {
    const view = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.length < 12 || view.toString("ascii", 0, 4) !== "RIFF" || view.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Voxa returned invalid audio.");
    }
    let at = 12;
    while (at + 8 <= view.length) {
      const id = view.toString("ascii", at, at + 4);
      const size = view.readUInt32LE(at + 4);
      if (id === "data") {
        return { header: buf.subarray(0, at + 8), data: buf.subarray(at + 8, at + 8 + size) };
      }
      at += 8 + size + (size % 2); // chunks are word-aligned
    }
    throw new Error("Voxa returned invalid audio.");
  };
  const first = dataOf(parts[0]!);
  const bodies = parts.map((part) => dataOf(part).data);
  const total = bodies.reduce((sum, body) => sum + body.length, 0);
  const out = Buffer.alloc(first.header.length + total);
  Buffer.from(first.header).copy(out, 0);
  let at = first.header.length;
  for (const body of bodies) {
    Buffer.from(body).copy(out, at);
    at += body.length;
  }
  // The two sizes a player actually reads: the RIFF total and the data chunk's own length.
  out.writeUInt32LE(out.length - 8, 4);
  out.writeUInt32LE(total, first.header.length - 4);
  return new Uint8Array(out);
}

/**
 * The words of a readable section — and only the words.
 *
 * It used to resolve the voice too, from `sheet.voice`, which read prose *about* a character in
 * that character's own voice and refused outright for the many characters who have none. Who
 * narrates is a separate question with a separate answer (`narratorFor`), and asking it here
 * was what tied one to the other.
 */
export function authoritativeSheetSpeech(sheet: Sheet, heading: string): { text: string } {
  /*
   * Any section the sheet actually has, rather than a character's Essence and Appearance
   * (issue 857).
   *
   * The old pair was not a rule about what is readable; it was a record of which two blocks had
   * a speaker drawn beside them. Everything else the shapes declare — Relationships, a
   * location's Look and Sound, a faction's Wants — is prose of exactly the same kind, and
   * refusing it meant a whole sheet type could not be listened to at all. So the check becomes
   * the bible's: is the section on this sheet, and does it have words in it.
   */
  const section = sheet.sections.find((candidate) => candidate.heading === heading);
  if (!section) throw new Error("That section is no longer on this sheet.");
  const text = normalizeSpeechText(section.body);
  if (!text) throw new Error("Nothing to read yet.");
  return { text };
}

/**
 * The world's other authored prose, named rather than sent (issue 857).
 *
 * The same contract as the sheet and bible resolvers, over the records the rest of the app puts
 * on screen: a canon entry, a scene's synopsis, a shot's script, the production overview, the
 * season and the Series. A source that no longer resolves refuses by name — an entry that has
 * been retired out from under an open screen should say so, not read the wrong paragraph.
 *
 * The `reply` arm is deliberately absent: a conversation is an event log rather than part of the
 * world bundle, so it is read where the log is, and this stays a pure function of the bundle.
 */
export function authoritativeProseSpeech(
  bundle: WorldBundle,
  source: Exclude<ProseReadSource, { of: "reply" } | { of: "chapter" }>,
): { text: string; heading: string; version: number; subjectId: string } {
  const production = (id: string) => {
    const found = bundle.productions.find((candidate) => candidate.meta.id === id);
    if (!found) throw new Error("That production is no longer in this world.");
    return found;
  };
  // The subject id keys the cache target and the queue row, so it names the record rather than
  // its kind: two canon entries read on the same voice must not land on one target.
  const spoken = (raw: string | undefined, heading: string, version: number, subjectId: string) => {
    const text = normalizeSpeechText(raw ?? "");
    if (!text) throw new Error("Nothing to read yet.");
    return { text, heading, version: Math.max(1, version), subjectId };
  };
  switch (source.of) {
    case "canon": {
      const entry = bundle.canon.find((candidate) => candidate.id === source.canonId);
      if (!entry) throw new Error("That canon entry is no longer in this world.");
      return spoken(entry.body, `${entry.id} · ${entry.title}`, bundle.meta.canonRevision, entry.id);
    }
    case "shot": {
      const scene = production(source.productionId).scenes.find((candidate) => candidate.id === source.sceneId);
      if (!scene) throw new Error("That scene is no longer in this production.");
      // Read off the structure directly rather than through `orderedShots`, which throws on an
      // invalid flow: a scene whose graph is broken still opens read-only, and its shots are
      // still prose somebody may want read to them. Finding one by id needs no order at all.
      const shots = isGraphScene(scene)
        ? scene.flow.nodes.flatMap((node) => (node.kind === "shot" ? [node.shot] : []))
        : scene.shots;
      const shot = shots.find((candidate) => candidate.id === source.shotId);
      if (!shot) throw new Error("That shot is no longer in this scene.");
      return spoken(shot.description, `Shot ${shot.number} · script`, scene.version, shot.id);
    }
    case "story": {
      const found = production(source.productionId);
      const story = found.story;
      const subjectId = `${source.productionId}/${source.field}`;
      // story.md is a file of its own with no version stamp; the overview's is the closest
      // honest number for a record that changes with it.
      if (source.field === "treatment") {
        return spoken(found.treatment ?? undefined, "Treatment", story?.version ?? 1, subjectId);
      }
      if (!story) throw new Error("Nothing has been settled about this production yet.");
      if (source.field === "acts") {
        const acts = (story.acts ?? [])
          .map((act, i) => `${i + 1}. ${act.title}${act.summary ? ` — ${act.summary}` : ""}`)
          .join(". ");
        return spoken(acts, "Acts", story.version, subjectId);
      }
      return spoken(story[source.field], source.field === "logline" ? "Logline" : "Spine", story.version, subjectId);
    }
    case "season": {
      const season = production(source.productionId).season;
      if (!season) throw new Error("This production has no season record.");
      return spoken(
        season[source.field],
        source.field === "question" ? "The question it answers" : "How it ends",
        season.version,
        `${source.productionId}/${source.field}`,
      );
    }
    case "series": {
      const series = bundle.series.find((candidate) => candidate.id === source.seriesId);
      if (!series) throw new Error("That Series is no longer in this world.");
      return spoken(series.engine, "Series engine", series.version, series.id);
    }
  }
}

/**
 * A chapter, or one paragraph of it, as speech (turn 126, issue 874).
 *
 * The chapter arm is resolved off disk by the coordinator — the body is not in the bundle — and
 * handed here already read, so this stays a pure function like the resolver above it. A page
 * read names one paragraph per source; the whole chapter as one block is the per-block read of
 * a long section and streams the way the bible's does.
 */
export function chapterProseSpeech(
  chapter: { body: string; title: string; version: number },
  source: Extract<ProseReadSource, { of: "chapter" }>,
): { text: string; heading: string; version: number; subjectId: string } {
  const subjectId = `${source.productionId}/chapters/${source.chapterId}`;
  if (source.paragraph === undefined) {
    const text = normalizeSpeechText(chapter.body);
    if (!text) throw new Error("Nothing to read yet.");
    return { text, heading: chapter.title, version: Math.max(1, chapter.version), subjectId };
  }
  const paragraphs = chapterParagraphs(chapter.body);
  const paragraph = paragraphs[source.paragraph];
  // Refused by name rather than read off the end: a page declared against an unsaved draft
  // could name a paragraph the saved chapter does not have, and the wrong words would be worse
  // than the missing block the page read already tolerates.
  if (paragraph === undefined) throw new Error("That paragraph is not in the saved chapter.");
  const text = normalizeSpeechText(paragraph);
  if (!text) throw new Error("Nothing to read yet.");
  return {
    text,
    heading: `${chapter.title} · ${source.paragraph + 1} of ${paragraphs.length}`,
    version: Math.max(1, chapter.version),
    subjectId: `${subjectId}#${source.paragraph}`,
  };
}

/**
 * The same, for a section of the bible (2026-08-24).
 *
 * The one difference from the sheet version is where the headings come from. A sheet's are its
 * shape's, so a heading it does not carry is refused as gone; a bible is a blank page somebody
 * types into — `splitBible` exists precisely because its headings are the author's. Either way
 * the check is the same: is the section there, and does it have words in it.
 *
 * Asked for by an author who wanted the story read back to her rather than read. The bible is
 * where the whole arc lives and it was the one long-form document in the world with no way to
 * hear it.
 */
export function authoritativeBibleSpeech(bibleText: string, heading: string): { text: string } {
  const section = splitBible(bibleText).sections.find((candidate) => candidate.heading === heading);
  if (!section) throw new Error("That section is no longer in the bible.");
  const text = normalizeSpeechText(section.body);
  if (!text) throw new Error("Nothing to read yet.");
  return { text };
}

export interface SpeechSpec {
  /**
   * A provider id, not a closed pair. This was `"kokoro" | "elevenlabs"`, which is the same
   * two-provider assumption the cache key carried (SPEC-022 §2.7) expressed in the type system:
   * a third voice provider could not be spelled here, so its previews had to borrow another's
   * name. `VoiceAssignment.provider` has always been a plain string for the same reason.
   */
  provider: string;
  model: string;
  voiceId: string;
  text: string;
  /**
   * flac joins wav and mp3 (SPEC-022): ComfyUI's SaveAudio writes it, and a cache key that could
   * not spell the format a provider actually returns would point at a file that never exists.
   */
  format: VoiceAudioFormat;
  language?: string;
  params?: Record<string, number>;
}

const FORMAT_CONTENT_TYPE: Record<VoiceAudioFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  flac: "audio/flac",
};

export function speechCacheFile(spec: SpeechSpec): string {
  const key = createHash("sha256")
    .update(JSON.stringify({ ...spec, text: normalizeSpeechText(spec.text), settingsVersion: SPEECH_SETTINGS_VERSION }))
    .digest("hex")
    .slice(0, 24);
  return `${PREVIEW_CACHE_DIR}/${key}.${spec.format}`;
}

/**
 * The model a provider's previews are cached under when the caller does not name one. Read
 * through this map rather than branched on, because the branch it replaces was binary — anything
 * that was not Kokoro was filed as ElevenLabs, so a second *local* provider landed on the cloud
 * key and two providers' previews of the same voice id and line collided (SPEC-022 §2.7).
 */
// Legacy callers may omit a model. Known pre-recipe providers resolve through this migration map;
// new providers key under their own id rather than borrowing another provider's cache namespace.
export function cachedVoiceAudioLooksRight(data: Uint8Array, format: VoiceAudioFormat): boolean {
  if (format === "flac") return flacProblem(data) === null;
  return verifyArtifact({ name: `voice.${format}`, contentType: FORMAT_CONTENT_TYPE[format], data }) === null;
}

const PREVIEW_MODEL: Record<string, string> = {
  kokoro: "kokoro-82m",
  elevenlabs: "eleven_multilingual_v2",
};

export function previewCacheFile(
  provider: string,
  voiceId: string,
  line: string,
  format: VoiceAudioFormat,
  model?: string,
): string {
  return speechCacheFile({
    provider,
    // An unknown provider keys under its own name rather than a neighbour's: a wrong path is
    // recoverable, a shared one serves another provider's audio for this voice.
    model: model ?? PREVIEW_MODEL[provider] ?? provider,
    voiceId,
    text: line,
    format,
  });
}

export class VoiceService {
  constructor(private readonly deps: VoiceServiceDeps) {}

  private now(): string {
    return (this.deps.clock ?? (() => new Date().toISOString()))();
  }

  /**
   * The unified catalogue (R-6): local presets, the world's cloned voices, and cloud voices.
   *
   * The cloned voices are passed in rather than read here, because this service has no world —
   * it is constructed once and a world is opened and closed around it. The caller that has a
   * bundle supplies them; the caller that has none (the narrator, resolved before a world is
   * open) supplies nothing and gets the two catalogues that do not depend on one.
   */
  async catalogue(
    clonedVoices: readonly ClonedVoice[] = [],
    clonedAvailability: { local?: boolean; unavailableReason?: string } = {},
  ): Promise<VoiceCandidate[]> {
    let local = this.deps.localPresets;
    if (this.deps.sidecar) {
      /*
       * Ask whether it can speak before offering a voice (2026-08-24).
       *
       * Driven from a real failure, in front of somebody. The runtime was up and answering, its
       * top-level health said `ok: true`, and `/voices` listed Bella, Nicole and Michael — while
       * the speech engine had failed to load at startup and never retried. So Settings offered a
       * narrator, one was chosen, and the first anyone knew of it was a 503 at the moment of
       * pressing play. `/voices` reads a preset list; it is not evidence that anything can be
       * synthesised.
       *
       * Three states, and the middle one is the fix. No sidecar at all leaves the configured
       * presets alone, because an engine that has not started yet is not an engine that has
       * failed. A sidecar reporting the engine ready gives its live list. A sidecar reporting it
       * NOT ready contributes nothing — not even the presets — because that is the one case
       * where we have been told, in as many words, that none of them can be spoken.
       */
      const health = await this.deps.sidecar.health().catch(() => null);
      const speechEngine = health === null ? "unknown" : health.engineStatus.kokoro.ready ? "ready" : "down";
      if (speechEngine === "down") {
        return [...(await this.cloudVoices()), ...clonedVoiceCandidates(clonedVoices, clonedAvailability)];
      }
      const live = await this.deps.sidecar.listVoices().catch(() => []);
      if (live.length > 0) {
        local = live.map((v) => ({
          provider: "kokoro",
          model: KOKORO_VOICE_MODEL,
          voiceId: v.id,
          label: v.label,
          attributes: v.attributes,
          local: true,
          // Kokoro's presets cannot be cloned from. That is a fact about Kokoro, not about local
          // voice — SPEC-022 §2.4 retires "local means presets, cloud means cloning" precisely
          // because the voices appended below are local AND cloned.
          canClone: false,
        }));
      }
    }
    return [...(await this.cloudVoices()), ...local, ...clonedVoiceCandidates(clonedVoices, clonedAvailability)];
  }

  /** The keyed cloud catalogues, which are unaffected by whatever the local engine is doing. */
  private async cloudVoices(): Promise<VoiceCandidate[]> {
    const cloud: VoiceCandidate[] = [];
    for (const source of this.deps.cloudSources) {
      const key = await this.deps.getKey(source.provider);
      if (key === null) continue; // unkeyed providers simply contribute nothing
      cloud.push(...(await source.list(key).catch(() => [])));
    }
    return cloud;
  }

  /** Rank the catalogue against the sheet's written voice (R-7): emits voice.candidates. */
  async candidates(
    worldId: string,
    bundle: WorldBundle,
    sheet: Sheet,
    manifest: ModelManifest | null,
    clonedAvailability: { local?: boolean; unavailableReason?: string } = {},
  ): Promise<void> {
    const written = sheet.sections.find((s) => s.heading === "Voice · written")?.body ?? "";
    const extracted = extractVoiceAttributes(written);
    const ranked = rankVoices(extracted, await this.catalogue(bundle.clonedVoices, clonedAvailability));
    const line = previewLineFor(sheet, bundle.productions);
    const previewMicroUsdByVoice = Object.fromEntries(
      ranked.flatMap(({ candidate }): Array<[string, number]> => {
        const model = manifest?.models.find(
          (entry) =>
            entry.provider === candidate.provider &&
            entry.id === candidate.model &&
            entry.capability === "voice-tts",
        );
        return model
          ? [[voiceTargetKey(candidate), estimateMicroUsd(model, { characters: line.text.length })]]
          : [];
      }),
    );
    this.deps.emit({
      at: this.now(),
      type: "voice.candidates",
      worldId,
      sheetId: sheet.id,
      extracted,
      ranked,
      previewLine: line,
      // Stated before any preview that will incur a charge (R-10): per-line cloud cost.
      // Legacy clients read one aggregate figure. Use it only when every priced candidate agrees;
      // otherwise null is safer than quoting one sibling model for another.
      cloudPreviewMicroUsd: (() => {
        const prices = [...new Set(Object.values(previewMicroUsdByVoice).filter((price) => price > 0))];
        return prices.length === 1 ? prices[0]! : null;
      })(),
      previewMicroUsdByVoice,
    });
  }

  /**
   * A local preview (R-2): sidecar synthesis into the world's preview cache — no queue, no
   * ledger. Returns the cache path; a hit never re-synthesises (R-10).
   */
  async localSpeech(
    store: WorldStore,
    voiceId: string,
    text: string,
    /**
     * Called as each piece finishes, so a long read can start playing before it is all made.
     * Absent for short prose, where the whole thing arrives in one piece anyway and a caller
     * that does not want to think about parts should not have to.
     */
    onPart?: (part: { file: string; index: number; total: number }) => void,
  ): Promise<{ file: string; cached: boolean }> {
    const normalized = normalizeSpeechText(text);
    if (normalized.length === 0) throw new Error("Nothing to read yet.");
    const rel = speechCacheFile({ provider: "kokoro", model: KOKORO_VOICE_MODEL, voiceId, text: normalized, format: "wav" });
    const abs = join(store.dir, rel);
    try {
      const bytes = await readFile(toExtendedLength(abs));
      if (cachedVoiceAudioLooksRight(bytes, "wav")) {
        return { file: rel, cached: true };
      }
    } catch {
      /* miss → synthesise */
    }
    if (!this.deps.sidecar) throw new Error("Voxa is not running — local voice is off; cloud voice still works");
    /*
     * One request per chunk, in order, rather than one request for everything.
     *
     * A single 8,610-character request was measured returning 503 and leaving the engine
     * unavailable for the rest of the process — so the whole app lost voice because one section
     * of a bible was long. Sequential rather than parallel on purpose: this is one small model on
     * the user's own machine, and several concurrent syntheses is the other way to fell it.
     */
    const chunks = splitForSpeech(normalized);
    const rendered: Uint8Array[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const part = await this.deps.sidecar.synthesize({ voiceId, text: chunk });
      if (!cachedVoiceAudioLooksRight(part, "wav")) {
        throw new Error("Voxa returned invalid audio.");
      }
      rendered.push(part);
      /*
       * Hand each piece over the moment it exists, so listening can begin on the first one while
       * the rest are still being made. A ten-minute section takes about ten minutes to render on
       * this machine; waiting for all of it before the first word is a wait nobody should sit
       * through, and the pieces are already separate files.
       */
      if (onPart) {
        const partRel = speechCacheFile({ provider: "kokoro", model: KOKORO_VOICE_MODEL, voiceId, text: chunk, format: "wav" });
        await store.gateOp(async () => {
          await atomicWriteFile(join(store.dir, partRel), part);
        });
        onPart({ file: partRel, index, total: chunks.length });
      }
    }
    const audio = concatWav(rendered);
    await store.gateOp(async () => {
      await atomicWriteFile(abs, audio);
    });
    return { file: rel, cached: false };
  }

  /** A deliberate performance is always a fresh synthesis; preview caches are not take authority. */
  async synthesizePerformance(voiceId: string, text: string, params: Record<string, number>, signal: AbortSignal): Promise<Uint8Array> {
    if (!this.deps.sidecar) throw new Error("Local synthesis is unavailable.");
    const rendered: Uint8Array[] = [];
    for (const chunk of splitForSpeech(normalizeSpeechText(text))) {
      if (signal.aborted) throw new Error("Performance generation cancelled.");
      const bytes = await this.deps.sidecar.synthesize({ voiceId, text: chunk, params }, { signal });
      if (!cachedVoiceAudioLooksRight(bytes, "wav")) throw new Error("Local synthesis returned invalid audio.");
      rendered.push(bytes);
    }
    if (!rendered.length) throw new Error("This line has no spoken text.");
    return concatWav(rendered);
  }

  async localPreview(store: WorldStore, _sheet: Sheet, voiceId: string, line: PreviewLine): Promise<string> {
    return (await this.localSpeech(store, voiceId, line.text)).file;
  }

  /**
   * A preview that goes through the queue (R-2): idempotency-protected, ledgered, cached.
   *
   * Named for the queue rather than for the cloud, because it is no longer only the cloud's. A
   * cloned voice runs on this machine and still comes through here — being local changes what a
   * take costs, not how it is made (SPEC-022 §2.1). Only Kokoro bypasses the queue, and that is
   * because the Voxa sidecar answers synchronously with no job to track.
   */
  queuedPreviewRequest(input: {
    worldId: string;
    sheet: Sheet;
    provider: string;
    voiceId: string;
    line: PreviewLine;
    model: ManifestModel;
    /**
     * Marks a voice whose identity is a world clip. The queue resolves and confines its bytes
     * immediately before provider I/O; no absolute path enters this request.
     */
    voiceReference?: boolean;
    /**
     * Opaque remote engine instance approved for this clip upload. This is destination approval,
     * not the separate paid read-aloud confirmation token.
     */
    voiceUploadConfirmedFor?: string;
  }): { input: EnqueueInput; cacheFile: string } {
    const {
      worldId,
      sheet,
      provider,
      voiceId,
      line,
      model,
      voiceReference,
      voiceUploadConfirmedFor,
    } = input;
    const normalized = normalizeSpeechText(line.text);
    // The format the provider actually returns, not a guess: ComfyUI's SaveAudio writes FLAC, and
    // keying an mp3 path for it would cache a hit that never matches the bytes on disk.
    const format = voiceFormatForModel(model);
    // The caller's provider, not a hardcoded one: this used to key the cache under "elevenlabs"
    // regardless, so a second provider's preview of the same voice id and line would have replayed
    // ElevenLabs' audio (SPEC-022 §2.7).
    const cacheFile = speechCacheFile({ provider, voiceId, text: normalized, model: model.id, format });
    const name = cacheFile.slice(PREVIEW_CACHE_DIR.length + 1);
    return {
      cacheFile,
      input: {
        worldId,
        target: { kind: "voice-preview", id: `${sheet.id}/${provider}/${model.id}/${voiceId}` },
        capability: "voice-tts",
        provider,
        model: model.id,
        params: {
          voiceId,
          text: normalized,
          audioFormat: format,
        },
        ...(voiceReference === true ? { voiceReference: true } : {}),
        ...(voiceUploadConfirmedFor !== undefined ? { voiceUploadConfirmedFor } : {}),
        // Unmetered rows estimate at zero, so a local preview states no price where a cloud one
        // states an exact figure (turn 70). No branch needed — the manifest already says which.
        estimatedMicroUsd: estimateMicroUsd(model, { characters: normalized.length }),
        // Landed under its cache key, so reopening the picker replays without a call (R-10).
        landing: { dir: PREVIEW_CACHE_DIR, name },
      },
    };
  }

  /** The words in some audio, for a caller that wants them back rather than an event (issue 683). */
  async transcribe(audio: Uint8Array, contentType: string): Promise<string> {
    if (!this.deps.sidecar) throw new Error("Voxa is not running — speech-to-text is off");
    return this.deps.sidecar.transcribe(audio, contentType);
  }

  /** Local dictation (R-17, R-18): loopback transcription; the text lands as editable input. */
  async dictate(requestId: string, audio: Uint8Array, contentType: string): Promise<void> {
    if (!this.deps.sidecar) {
      this.deps.emit({
        at: this.now(),
        type: "dictation.result",
        requestId,
        text: null,
        error: "Voxa is not running — dictation is off; typing still works",
      });
      return;
    }
    try {
      const text = await this.deps.sidecar.transcribe(audio, contentType);
      this.deps.emit({ at: this.now(), type: "dictation.result", requestId, text, error: null });
    } catch (err) {
      this.deps.emit({
        at: this.now(),
        type: "dictation.result",
        requestId,
        text: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * A dialogue-line dispatch (R-14, R-15): the voice is the sheet's — a retake keeps it by
 * construction, only the delivery params change. An inexpressible delivery is stated, and the
 * notice travels with the job rather than being silently dropped.
 */
export function voiceLineRequest(input: {
  worldId: string;
  productionId: string;
  shotId: string;
  sheet: Sheet;
  text: string;
  deliveryParams: Record<string, number> | null;
  deliveryNotice: string | null;
  model: ManifestModel;
  voiceReference?: boolean;
  voiceUploadConfirmedFor?: string;
}): EnqueueInput {
  const voice = input.sheet.voice;
  if (!voice) throw new Error(`${input.sheet.name} has no assigned voice — assign one on the sheet first`);
  const assignedModel = voice.model;
  if (voice.provider !== input.model.provider || (assignedModel !== undefined && assignedModel !== input.model.id)) {
    throw new Error("The assigned voice no longer matches its speech model — choose the voice again.");
  }
  return {
    worldId: input.worldId,
    productionId: input.productionId,
    target: { kind: "voice-line", id: input.shotId },
    capability: "voice-tts",
    provider: voice.provider,
    model: input.model.id,
    params: {
      voiceId: voice.voiceId,
      text: input.text,
      audioFormat: voiceFormatForModel(input.model),
      ...(input.deliveryParams !== null ? { voiceSettings: input.deliveryParams } : {}),
      ...(input.deliveryNotice !== null ? { deliveryNotice: input.deliveryNotice } : {}),
    },
    estimatedMicroUsd: estimateMicroUsd(input.model, { characters: input.text.length }),
    landing: { dir: `productions/${input.productionId}/audio` },
    ...(input.voiceReference === true ? { voiceReference: true } : {}),
    ...(input.voiceUploadConfirmedFor !== undefined
      ? { voiceUploadConfirmedFor: input.voiceUploadConfirmedFor }
      : {}),
  };
}
