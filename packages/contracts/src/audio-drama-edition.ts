import { z } from "zod";
import { SlugSchema, UlidSchema } from "./ids.js";
import {
  DRAMA_NARRATOR, dramaRoleName, dramaTakeState,
  type AudioDramaRecord, type EpisodeScriptBlock, type EpisodeTakes, type ScriptHeading,
} from "./audio-drama.js";

/**
 * An audio drama's edition (SPEC-057 R-71..R-76, design turn 230q): the episodes ready to hear,
 * each as finished audio, with a listener's transcript, the credits and the production script,
 * frozen at publication. A later edit changes nothing published.
 */

/** How an edition is delivered: a format named, never a loudness promised (R-76). */
export const DramaDeliverySchema = z.enum(["podcast", "archive"]);
export type DramaDelivery = z.infer<typeof DramaDeliverySchema>;
export const DRAMA_DELIVERY_LABEL: Record<DramaDelivery, string> = { podcast: "Podcast · stereo", archive: "Archive · WAV" };

export const DramaEditionSchema = z.object({
  id: z.string().uuid(),
  worldId: UlidSchema,
  productionId: SlugSchema,
  name: z.string().trim().min(1).max(120),
  delivery: DramaDeliverySchema,
  createdAt: z.string(),
  episodes: z.array(z.object({
    episode: z.number().int().min(1).max(200),
    title: z.string().max(160),
    seconds: z.number().min(0),
    scriptVersion: z.number().int().min(1),
    scriptHash: z.string().min(1),
    file: z.string().min(1),
  }).strict()).min(1),
  files: z.array(z.object({ name: z.string().min(1), bytes: z.number().int().nonnegative(), sha256: z.string().min(1) }).strict()),
  frozen: z.object({
    source: z.object({ productionId: SlugSchema, title: z.string(), version: z.number().int().optional() }).strict().optional(),
    voices: z.array(z.string()),
    sounds: z.array(z.string()),
  }).strict(),
}).strict();
export type DramaEdition = z.infer<typeof DramaEditionSchema>;

type Spoken = Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>;
const spoken = (block: EpisodeScriptBlock): block is Spoken => block.kind === "dialogue" || block.kind === "narration";
type Voice = { provider: string; voiceId: string; model?: string | undefined };

/** A role's voice as takes compare it (R-60): this production's, else the character's; none for the app narrator. */
export function dramaRoleVoice(
  cast: Readonly<Record<string, { voice?: Voice | undefined }>> | undefined,
  sheets: ReadonlyArray<{ id: string; voice?: Voice | undefined }>,
  block: Spoken,
): Voice | undefined {
  if (block.kind === "narration") return cast?.[DRAMA_NARRATOR]?.voice;
  return cast?.[block.speaker]?.voice ?? sheets.find((sheet) => sheet.id === block.speaker)?.voice;
}

/**
 * Whether an episode can go out (R-72), and why not: every line performed in a current take, no
 * take waiting for a decision, every required sound placed. A stand-in is allowed, and said.
 */
export function episodeReadiness(
  blocks: readonly EpisodeScriptBlock[],
  takes: EpisodeTakes | undefined,
  name: (speaker: string) => string,
  /** The role's voice now: a take in another voice is out of date, as the mix leaves it out. */
  voice: (line: Spoken) => Voice | undefined = () => undefined,
): { ready: boolean; reasons: string[]; notes: string[] } {
  const lines = blocks.filter(spoken);
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  let missing = 0, stale = 0, waiting = 0;
  const standIns = new Set<string>();
  for (const line of lines) {
    const entry = takes?.lines[line.id];
    if (entry?.waiting) waiting++;
    const kept = entry?.kept;
    if (!kept) missing++;
    else if (dramaTakeState(line, { kept }, voice(line)) === "out of date") stale++;
    else if (kept.standIn && line.kind === "dialogue") standIns.add(name(line.speaker));
  }
  const sounds = blocks.filter((block) => (block.kind === "sound" || block.kind === "ambience" || block.kind === "music") && block.required && !block.soundArtifact).length;
  const reasons = [
    ...(lines.length === 0 ? ["no lines"] : []),
    ...(missing === lines.length && lines.length > 0 ? ["not performed"] : missing > 0 ? [count(missing, "line not performed", "lines not performed")] : []),
    ...(stale > 0 ? [count(stale, "take out of date", "takes out of date")] : []),
    ...(waiting > 0 ? [count(waiting, "take waits for a decision", "takes wait for a decision")] : []),
    ...(sounds > 0 ? [count(sounds, "sound missing", "sounds missing")] : []),
  ];
  return { ready: reasons.length === 0, reasons, notes: [...standIns].map((who) => `${who}'s stand-in kept`) };
}

/**
 * The listener's transcript (R-74): what is said, by whom the listener knows them as, and the
 * sound that carries meaning — never a direction. A hidden role is its public label until the
 * episode that reveals it.
 */
export function listenerTranscript(
  episodes: ReadonlyArray<{ episode: number; title: string; blocks: readonly EpisodeScriptBlock[] }>,
  name: (speaker: string) => string,
  cast: AudioDramaRecord["cast"],
): string {
  const out: string[] = [];
  for (const { episode, title, blocks } of episodes) {
    out.push(`Episode ${episode}${title ? ` · ${title}` : ""}`, "");
    for (const block of blocks) {
      if (block.kind === "dialogue") out.push(`${dramaRoleName(name(block.speaker), cast?.[block.speaker], episode).toUpperCase()}: ${block.words}`);
      else if (block.kind === "narration") out.push(`NARRATOR: ${block.words}`);
      else if ((block.kind === "sound" || block.kind === "music") && (block.required || block.soundArtifact)) out.push(`[${block.heard}]`);
    }
    out.push("");
  }
  return `${out.join("\n").trim()}\n`;
}

/** The credits (R-75): who speaks in what voice, what was recorded, what was generated and by what. */
export function dramaCredits(input: {
  title: string;
  roles: ReadonlyArray<{ role: string; voice: string; recorded?: boolean }>;
  sounds: ReadonlyArray<{ name: string; engine: string }>;
}): string {
  const lines = [input.title, "", "Cast"];
  for (const role of input.roles) lines.push(`  ${role.role} — ${role.voice}${role.recorded ? " (recorded)" : ""}`);
  if (input.sounds.length > 0) {
    lines.push("", "Sound");
    for (const sound of input.sounds) lines.push(`  ${sound.name} — generated with ${sound.engine}`);
  }
  lines.push("", "Voices and sounds marked generated were made with AI.");
  return `${lines.join("\n")}\n`;
}

const HEARD_AS_LABEL = { narrated: "Narrated", "in-the-room": "In the room", recording: "A recording" } as const;
export function heardAsLabel(value: ScriptHeading["heardAs"]): string {
  return value ? HEARD_AS_LABEL[value] : "";
}

/**
 * The script as a numbered radio script (R-11's export, and the production script an edition
 * carries): scenes as headings, spoken lines numbered, direction in parentheses, cues in capitals.
 * What is read aloud and what is sound stay apart.
 */
export function episodeScriptText(title: string, episode: number, blocks: readonly EpisodeScriptBlock[], name: (slug: string) => string): string {
  const lines: string[] = [`EPISODE ${episode}${title ? ` · ${title}` : ""}`, ""];
  let scene = 0;
  let spoken = 0;
  // Where a bed stops is part of the score (codex on PR 1870): said at the block it stops before.
  const stops = new Map<string, string[]>();
  for (const block of blocks) {
    if ((block.kind === "ambience" || block.kind === "music") && block.until) stops.set(block.until, [...(stops.get(block.until) ?? []), `     ${block.kind.toUpperCase()} ENDS: ${block.heard}`]);
  }
  for (const block of blocks) {
    const ends = stops.get(block.id);
    if (ends) lines.push(...ends, "");
    switch (block.kind) {
      case "heading":
        scene++;
        lines.push("", `${scene}. ${block.place.toUpperCase()}${block.time ? ` — ${block.time}` : ""}${block.heardAs ? ` [${heardAsLabel(block.heardAs)}]` : ""}`, "");
        break;
      case "dialogue":
        spoken++;
        lines.push(`${String(spoken).padStart(3)}  ${name(block.speaker).toUpperCase()}${block.channel ? ` (${block.channel})` : ""}${block.direction ? ` (${block.direction})` : ""}`);
        lines.push(`     ${block.words}${block.cut ? " —" : ""}`, "");
        break;
      case "narration":
        spoken++;
        lines.push(`${String(spoken).padStart(3)}  NARRATOR${block.direction ? ` (${block.direction})` : ""}`, `     ${block.words}`, "");
        break;
      case "sound": case "ambience": case "music":
        lines.push(`     ${block.kind.toUpperCase()}: ${block.heard}`, "");
        break;
      case "silence":
        lines.push(`     SILENCE ${block.seconds} s${block.note ? ` · ${block.note}` : ""}`, "");
        break;
      case "note":
        lines.push(`     [${block.text}]`, "");
        break;
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}
