import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DramaEditionSchema, dramaCredits, dramaRoleName, dramaRoleVoice, episodeReadiness, episodeScriptFile, episodeScriptText, listenerTranscript, productionShape,
  type DramaDelivery, type DramaEdition, type EpisodeScriptBlock,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import { audioStudioSourceProblems, openAudioStudio } from "../productions/audio-studio.js";
import { renderAudioStudioMix } from "../productions/audio-studio-mix.js";

/**
 * An audio drama's editions (SPEC-057 R-71..R-76, design turn 230q): each published into app
 * storage as copies — the finished audio of each ready episode, the listener's transcript, the
 * credits and the production script — with the inputs it was made from frozen in edition.json.
 * Nothing in the world can change a published edition afterwards.
 */
export class DramaEditionService {
  // Quitting stops a publication before the coordinator waits on it (codex on PR 1880).
  private readonly stopping = new AbortController();
  // A file verified once is trusted while its size and time are unchanged (codex on PR 1880):
  // a range request is never a full rehash.
  private readonly verified = new Map<string, string>();
  constructor(private readonly root: string, private readonly options: { ffmpeg?: FfmpegRunner } = {}) {}

  stop(): void { this.stopping.abort(); }

  /** The episodes asked for, refused by name where one is not ready (R-72). */
  async publish(store: WorldStore, productionId: string, input: { name: string; delivery: DramaDelivery; episodes: readonly number[] }): Promise<DramaEdition> {
    const bundle = store.getBundle();
    const production = bundle.productions.find((candidate) => candidate.meta.id === productionId);
    if (!production || !productionShape(production.meta).isAudioDrama) throw new Error("That production is not an audio drama.");
    if (input.episodes.length === 0) throw new Error("Choose an episode to publish.");
    const name = (slug: string) => bundle.sheets.find((sheet) => sheet.id === slug)?.name ?? slug;
    const chosen = [...new Set(input.episodes)].sort((a, b) => a - b).map((episode) => {
      const entry = production.episodeScripts?.find((candidate) => candidate.script.episode === episode);
      if (!entry) throw new Error(`Episode ${episode} has no script.`);
      const takes = production.episodeTakes?.find((candidate) => candidate.episode === episode);
      const ready = episodeReadiness(entry.script.blocks, takes, name, (line) => dramaRoleVoice(production.audioDrama?.cast, bundle.sheets, line));
      if (!ready.ready) throw new Error(`Episode ${episode} is not ready: ${ready.reasons.join(" · ")}.`);
      return { episode, entry, takes };
    });
    // Everything the edition is made from, read again once it is made (codex on PR 1880): a save, a
    // retake or a recast landing mid-publish refuses the edition rather than mixing two versions.
    const inputs = async () => {
      const live = store.getBundle();
      const now = live.productions.find((candidate) => candidate.meta.id === productionId);
      return JSON.stringify([
        chosen.map(({ episode }) => [now?.episodeScripts?.find((candidate) => candidate.script.episode === episode)?.hash ?? null, now?.episodeTakes?.find((candidate) => candidate.episode === episode) ?? null]),
        now?.audioDrama?.cast ?? null, live.sheets.map((sheet) => [sheet.id, sheet.voice ?? null]),
        await Promise.all(chosen.map(({ episode }) => readFile(join(store.dir, "productions", productionId, "drama-mix", episodeScriptFile(episode)), "utf8").catch(() => null))),
      ]);
    };
    const frozen = await inputs();
    const id = randomUUID();
    const dir = join(this.root, id);
    await mkdir(dir, { recursive: true });
    // A world closing stops the render and the copies with it (codex on PR 1880).
    const signal = AbortSignal.any([store.closingSignal, this.stopping.signal]);
    try {
      const files: DramaEdition["files"] = [];
      const episodes: DramaEdition["episodes"] = [];
      const keep = async (file: string, content: string | Uint8Array) => { await writeFile(join(dir, file), content); files.push(await describe(dir, file)); };
      // What the listener hears, read from each rendered plan (codex on PR 1880): a line or a cue the
      // mix leaves out, muted or removed, is not in the transcript, and every sound heard is credited.
      const heard = new Set<string>();
      const heardSounds = new Set<string>();
      for (const { episode, entry } of chosen) {
        signal.throwIfAborted();
        const stem = episodeScriptFile(episode).replace(/\.json$/, "");
        const opened = await openAudioStudio(store, productionId, stem, this.options.ffmpeg ? { ffmpeg: this.options.ffmpeg } : {});
        // The final render refuses any unresolved issue: a published episode is complete. Its sources
        // are checked as Audio Studio checks them, rights included (codex on PR 1880).
        const unavailable = await audioStudioSourceProblems(store, productionId, opened.state, true);
        const mix = await renderAudioStudioMix(store.dir, opened.state, opened.script, { final: true, signal, unavailable, ...(this.options.ffmpeg ? { ffmpeg: this.options.ffmpeg } : {}) });
        const passageKey = new Map(opened.state.passages.map((passage) => [passage.id, passage.key]));
        for (const { clip, muted } of mix.plan.clips) {
          if (muted) continue;
          if (clip.role === "speech" && clip.passageId !== undefined && !mix.plan.omitted.includes(clip.passageId)) heard.add(passageKey.get(clip.passageId) ?? "");
          else if (clip.role !== "speech") {
            heard.add(clip.id.replace(/^(sound|bed):/, ""));
            const artifact = bundle.artifacts.find((candidate) => candidate.id === clip.source?.artifactId || `artifacts/${candidate.file}` === clip.source?.file);
            if (artifact) heardSounds.add(artifact.id);
          }
        }
        // Streamed under the signal (codex on PR 1880): a closing world never waits on a long copy.
        const audio = `${stem}.wav`;
        await pipeline(createReadStream(join(store.dir, mix.file), { signal }), createWriteStream(join(dir, audio)), { signal });
        files.push(await describe(dir, audio));
        await keep(`${stem}-script.txt`, episodeScriptText(entry.script.title, episode, entry.script.blocks, name));
        episodes.push({ episode, title: entry.script.title, seconds: mix.seconds, scriptVersion: entry.script.version, scriptHash: entry.hash, file: audio });
      }
      const last = chosen.at(-1)!.episode;
      const cast = production.audioDrama?.cast;
      if (await inputs() !== frozen) throw new Error("The production changed while publishing. Publish again.");
      const listened = (block: EpisodeScriptBlock) => block.kind !== "dialogue" && block.kind !== "narration" && block.kind !== "sound" && block.kind !== "ambience" && block.kind !== "music" || heard.has(block.id);
      await keep("transcript.txt", listenerTranscript(chosen.map(({ episode, entry }) => ({ episode, title: entry.script.title, blocks: entry.script.blocks.filter(listened) })), name, cast));
      // Who spoke, in what voice: a hidden role keeps its public label to the edition's last episode (R-59).
      const roles = new Map<string, { role: string; voice: string; recorded?: boolean }>();
      const sounds = new Map<string, { name: string; made: string }>();
      for (const { entry, takes } of chosen) {
        for (const block of entry.script.blocks) {
          if (block.kind === "dialogue" || block.kind === "narration") {
            const key = block.kind === "dialogue" ? block.speaker : "@narrator";
            const kept = takes?.lines[block.id]?.kept;
            // Only a voice the mix plays is credited (codex on PR 1880).
            if (!kept || roles.has(key) || !heard.has(block.id)) continue;
            const artifact = bundle.artifacts.find((candidate) => candidate.id === kept.artifactId);
            const recorded = artifact?.generation?.source === "audiobook" && artifact.generation.recording !== undefined;
            roles.set(key, { role: key === "@narrator" ? "Narrator" : dramaRoleName(name(key), cast?.[key], last),
              voice: `${kept.voice.label ?? kept.voice.voiceId}${recorded ? "" : ` · ${kept.voice.provider}`}`, ...(recorded ? { recorded: true } : {}) });
          }
        }
      }
      // Every sound heard is credited (codex on PR 1880), a cue's or one imported onto the timeline:
      // generated by its engine, else recorded or uploaded.
      for (const artifactId of heardSounds) {
        const artifact = bundle.artifacts.find((candidate) => candidate.id === artifactId)!;
        sounds.set(artifactId, artifact.generation?.source === "sound"
          ? { name: artifact.generation.name, made: `generated with ${artifact.generation.model}` }
          : { name: artifact.file.split("/").pop() ?? artifact.file, made: "recorded or uploaded" });
      }
      await keep("credits.txt", dramaCredits({ title: production.meta.title, roles: [...roles.values()], sounds: [...sounds.values()] }));
      const story = production.audioDrama?.source ? bundle.productions.find((candidate) => candidate.meta.id === production.audioDrama!.source!.productionId) : undefined;
      const edition = DramaEditionSchema.parse({
        id, worldId: store.worldId, productionId, name: input.name, delivery: input.delivery, createdAt: store.now(), episodes, files,
        frozen: {
          ...(story ? { source: { productionId: story.meta.id, title: story.meta.title, ...(story.story?.version ? { version: story.story.version } : {}) } } : {}),
          voices: [...roles.values()].map((role) => `${role.role}: ${role.voice}`),
          sounds: [...sounds.values()].map((sound) => `${sound.name} (${sound.made})`),
        },
      });
      await writeFile(join(dir, "edition.json"), `${JSON.stringify(edition, null, 2)}\n`);
      return edition;
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  }

  async list(worldId: string, productionId: string): Promise<DramaEdition[]> {
    const ids = await readdir(this.root).catch(() => [] as string[]);
    const editions: DramaEdition[] = [];
    for (const id of ids) {
      // A damaged receipt is skipped, never the whole list (codex on PR 1880).
      const parsed = await readFile(join(this.root, id, "edition.json"), "utf8").then((raw) => DramaEditionSchema.safeParse(JSON.parse(raw))).catch(() => null);
      if (parsed?.success && parsed.data.worldId === worldId && parsed.data.productionId === productionId) editions.push(parsed.data);
    }
    return editions.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** A published file, only as recorded: its bytes must still be the ones the edition names. */
  async serve(id: string, name: string): Promise<{ path: string; contentType: string; downloadName: string } | null> {
    if (!z.string().uuid().safeParse(id).success) return null;
    const edition = await readFile(join(this.root, id, "edition.json"), "utf8").then((raw) => DramaEditionSchema.parse(JSON.parse(raw)), () => null);
    const file = edition?.files.find((candidate) => candidate.name === name);
    if (!edition || !file) return null;
    const path = join(this.root, id, file.name);
    const seen = await stat(path).catch(() => null);
    if (!seen) return null;
    const identity = `${path}:${seen.size}:${seen.mtimeMs}`;
    if (this.verified.get(identity) !== file.sha256) {
      const described = await describe(join(this.root, id), file.name).catch(() => null);
      if (!described || described.sha256 !== file.sha256) return null;
      this.verified.set(identity, file.sha256);
    }
    return { path: join(this.root, id, file.name), contentType: file.name.endsWith(".wav") ? "audio/wav" : "text/plain; charset=utf-8", downloadName: `${edition.name} - ${file.name}` };
  }
}

/** Hashed as a stream (codex on PR 1880): an hour of stereo WAV is never one buffer. */
async function describe(dir: string, name: string): Promise<{ name: string; bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(join(dir, name))) hash.update(chunk as Buffer);
  return { name, bytes: (await stat(join(dir, name))).size, sha256: hash.digest("hex") };
}
