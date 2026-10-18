import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DramaEditionSchema, dramaCredits, dramaRoleName, dramaRoleVoice, episodeReadiness, episodeScriptFile, episodeScriptText, listenerTranscript, productionShape,
  type DramaDelivery, type DramaEdition,
} from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { FfmpegRunner } from "../takes/export.js";
import { openAudioStudio } from "../productions/audio-studio.js";
import { renderAudioStudioMix } from "../productions/audio-studio-mix.js";

/**
 * An audio drama's editions (SPEC-057 R-71..R-76, design turn 230q): each published into app
 * storage as copies — the finished audio of each ready episode, the listener's transcript, the
 * credits and the production script — with the inputs it was made from frozen in edition.json.
 * Nothing in the world can change a published edition afterwards.
 */
export class DramaEditionService {
  constructor(private readonly root: string, private readonly options: { ffmpeg?: FfmpegRunner } = {}) {}

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
    const signal = store.closingSignal;
    try {
      const files: DramaEdition["files"] = [];
      const episodes: DramaEdition["episodes"] = [];
      const keep = async (file: string, content: string | Uint8Array) => { await writeFile(join(dir, file), content); files.push(await describe(dir, file)); };
      const omitted = new Set<string>();
      for (const { episode, entry } of chosen) {
        signal.throwIfAborted();
        const stem = episodeScriptFile(episode).replace(/\.json$/, "");
        const opened = await openAudioStudio(store, productionId, stem, this.options.ffmpeg ? { ffmpeg: this.options.ffmpeg } : {});
        // The final render refuses any unresolved issue: a published episode is complete.
        const mix = await renderAudioStudioMix(store.dir, opened.state, opened.script, { final: true, signal, ...(this.options.ffmpeg ? { ffmpeg: this.options.ffmpeg } : {}) });
        // A line left out of the mix on purpose is left out of what the listener reads (codex on PR 1880).
        for (const passage of opened.state.passages) if (mix.plan.omitted.includes(passage.id)) omitted.add(passage.key);
        signal.throwIfAborted();
        const audio = `${stem}.wav`;
        await copyFile(join(store.dir, mix.file), join(dir, audio));
        files.push(await describe(dir, audio));
        await keep(`${stem}-script.txt`, episodeScriptText(entry.script.title, episode, entry.script.blocks, name));
        episodes.push({ episode, title: entry.script.title, seconds: mix.seconds, scriptVersion: entry.script.version, scriptHash: entry.hash, file: audio });
      }
      const last = chosen.at(-1)!.episode;
      const cast = production.audioDrama?.cast;
      if (await inputs() !== frozen) throw new Error("The production changed while publishing. Publish again.");
      await keep("transcript.txt", listenerTranscript(chosen.map(({ episode, entry }) => ({ episode, title: entry.script.title, blocks: entry.script.blocks.filter((block) => !omitted.has(block.id)) })), name, cast));
      // Who spoke, in what voice: a hidden role keeps its public label to the edition's last episode (R-59).
      const roles = new Map<string, { role: string; voice: string; recorded?: boolean }>();
      const sounds = new Map<string, { name: string; made: string }>();
      for (const { entry, takes } of chosen) {
        for (const block of entry.script.blocks) {
          if (block.kind === "dialogue" || block.kind === "narration") {
            const key = block.kind === "dialogue" ? block.speaker : "@narrator";
            const kept = takes?.lines[block.id]?.kept;
            if (!kept || roles.has(key)) continue;
            const artifact = bundle.artifacts.find((candidate) => candidate.id === kept.artifactId);
            const recorded = artifact?.generation?.source === "audiobook" && artifact.generation.recording !== undefined;
            roles.set(key, { role: key === "@narrator" ? "Narrator" : dramaRoleName(name(key), cast?.[key], last),
              voice: `${kept.voice.label ?? kept.voice.voiceId}${recorded ? "" : ` · ${kept.voice.provider}`}`, ...(recorded ? { recorded: true } : {}) });
          } else if ((block.kind === "sound" || block.kind === "ambience" || block.kind === "music") && block.soundArtifact && !sounds.has(block.soundArtifact)) {
            // Every placed sound is credited (codex on PR 1880): generated by its engine, else recorded or uploaded.
            const artifact = bundle.artifacts.find((candidate) => candidate.id === block.soundArtifact);
            if (!artifact) continue;
            sounds.set(block.soundArtifact, artifact.generation?.source === "sound"
              ? { name: artifact.generation.name, made: `generated with ${artifact.generation.model}` }
              : { name: artifact.file.split("/").pop() ?? artifact.file, made: "recorded or uploaded" });
          }
        }
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
    const described = await describe(join(this.root, id), file.name).catch(() => null);
    if (!described || described.sha256 !== file.sha256) return null;
    return { path: join(this.root, id, file.name), contentType: file.name.endsWith(".wav") ? "audio/wav" : "text/plain; charset=utf-8", downloadName: `${edition.name} - ${file.name}` };
  }
}

async function describe(dir: string, name: string): Promise<{ name: string; bytes: number; sha256: string }> {
  const bytes = await readFile(join(dir, name));
  return { name, bytes: (await stat(join(dir, name))).size, sha256: createHash("sha256").update(bytes).digest("hex") };
}
