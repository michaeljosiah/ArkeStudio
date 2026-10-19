import {
  DRAMA_NARRATOR, dramaRoleVoice, narrationQuotes, sheetSound,
  type AudiobookReader, type DramaRole, type EpisodeScriptBlock, type ProductionBundle, type Sheet, type WorldBundle,
} from "@arke-studio/contracts";
import { isCrowdSpeaker, speakerLabel } from "./episode-script.js";

/**
 * An audio drama's speaking roles (SPEC-057 R-55..R-58, design turn 230k): the narrator when the
 * drama has one, every speaker in its scripts — a character or a name no sheet carries — and every
 * character the narrator quotes. Each with its voice and where it comes from, How they sound, and
 * the narrator's version where the narrator quotes them.
 */
export interface DramaCastRole {
  key: string;
  name: string;
  sheet: Sheet | undefined;
  role: DramaRole | undefined;
  voice: AudiobookReader | null;
  /** Where the voice comes from: this production's cast, or the character's sheet. */
  from: "production" | "character" | null;
  /** How they sound, as sent: this production's note, else where the sheet starts it. */
  sound: string | undefined;
  /** The sheet's start for How they sound (R-57). */
  sheetSound: string | undefined;
  /** The narrator's version where the narrator quotes them (R-58), else undefined. */
  narration: string | undefined;
  lines: number;
  /** Narrated blocks that quote them: the narrator's version shows only where this is above 0. */
  quoted: number;
}

type Spoken = Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>;

/** Every block of every episode's script, with its episode. */
export function dramaBlocks(production: ProductionBundle): Array<{ episode: number; block: EpisodeScriptBlock }> {
  return (production.episodeScripts ?? [])
    .slice().sort((a, b) => a.script.episode - b.script.episode)
    .flatMap((entry) => entry.script.blocks.map((block) => ({ episode: entry.script.episode, block })));
}

/** The names a narration may quote, as the coordinator matches them for a request. */
export function quotableNames(world: WorldBundle, production: ProductionBundle): Record<string, string> {
  const names: Record<string, string> = {};
  // A retired character the scripts still give lines is still quoted, as the coordinator matches.
  const scripted = new Set(dramaBlocks(production).flatMap(({ block }) => block.kind === "dialogue" ? [block.speaker] : []));
  for (const sheet of world.sheets) if (sheet.type === "character" && (!sheet.retired || scripted.has(sheet.id))) names[sheet.id] = sheet.name;
  for (const key of Object.keys(production.audioDrama?.cast ?? {})) if (key !== DRAMA_NARRATOR) names[key] ??= key;
  return names;
}

export function dramaCastRoles(world: WorldBundle, production: ProductionBundle): DramaCastRole[] {
  const cast = production.audioDrama?.cast ?? {};
  const blocks = dramaBlocks(production).map((entry) => entry.block);
  const lines = new Map<string, number>();
  const quoted = new Map<string, number>();
  let narrated = 0;
  const quotable = quotableNames(world, production);
  for (const block of blocks) {
    if (block.kind === "dialogue") lines.set(block.speaker, (lines.get(block.speaker) ?? 0) + 1);
    if (block.kind === "narration") {
      narrated += 1;
      for (const key of narrationQuotes(block.words, quotable)) quoted.set(key, (quoted.get(key) ?? 0) + 1);
    }
  }
  const keys = new Set<string>([...lines.keys(), ...quoted.keys(), ...Object.keys(cast).filter((key) => key !== DRAMA_NARRATOR)]);
  const roles: DramaCastRole[] = [...keys].map((key): DramaCastRole => {
    const sheet = world.sheets.find((candidate) => candidate.id === key);
    const role = cast[key];
    const start = sheetSound(sheet);
    const voice = role?.voice ?? (sheet?.voice ? { provider: sheet.voice.provider, model: sheet.voice.model ?? "", voiceId: sheet.voice.voiceId, ...(sheet.voice.label ? { label: sheet.voice.label } : {}) } : null);
    return {
      key, name: sheet?.name ?? speakerLabel(key), sheet, role, voice,
      from: role?.voice ? "production" : sheet?.voice ? "character" : null,
      sound: role?.sound ?? start, sheetSound: start,
      narration: quoted.has(key) ? role?.narration ?? (sheet?.narration?.trim() || undefined) : undefined,
      lines: lines.get(key) ?? 0, quoted: quoted.get(key) ?? 0,
    };
  }).sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name));
  // The narrator is a role of its own, optional (R-55): there when the drama narrates.
  const narrator = cast[DRAMA_NARRATOR];
  if (narrated > 0 || narrator !== undefined || production.audioDrama?.plan.narrator === "narrated") {
    roles.unshift({
      key: DRAMA_NARRATOR, name: "Narrator", sheet: undefined, role: narrator, voice: narrator?.voice ?? null,
      from: narrator?.voice ? "production" : null, sound: narrator?.sound, sheetSound: undefined, narration: undefined,
      lines: narrated, quoted: 0,
    });
  }
  return roles;
}

/** A role's voice as takes compare it: this production's, else the character's; none for the app narrator. */
export function roleVoice(production: ProductionBundle, sheets: readonly Sheet[], block: Spoken): { provider: string; voiceId: string } | undefined {
  return dramaRoleVoice(production.audioDrama?.cast, sheets, block);
}

/** The kept takes a new voice would put out of date (R-60), listed before it is confirmed. */
export function takesOutOfDate(production: ProductionBundle, key: string, voice: { provider: string; voiceId: string; model?: string | undefined }): Array<{ episode: number; block: string; words: string }> {
  const out: Array<{ episode: number; block: string; words: string }> = [];
  for (const { episode, block } of dramaBlocks(production)) {
    const speaks = key === DRAMA_NARRATOR ? block.kind === "narration" : block.kind === "dialogue" && block.speaker === key;
    if (!speaks || !("words" in block)) continue;
    const kept = production.episodeTakes?.find((entry) => entry.episode === episode)?.lines[block.id]?.kept;
    if (!kept) continue;
    // A stand-in goes out of date once the role has a voice of its own (codex on PR 1873).
    if (kept.standIn) { out.push({ episode, block: block.id, words: block.words }); continue; }
    // The model too (codex on PR 1873): Hear would not reuse a take read by another model.
    if (kept.voice.provider !== voice.provider || kept.voice.voiceId !== voice.voiceId || (voice.model !== undefined && voice.model !== "" && kept.voice.model !== voice.model)) {
      out.push({ episode, block: block.id, words: block.words });
    }
  }
  return out;
}

/** A row of Cast (230k, issue 1882): one role, or a crowd of two or more voices as one row. */
export type DramaCastRow = { kind: "role"; role: DramaCastRole } | { kind: "crowd"; members: DramaCastRole[] };

/**
 * Cast's rows: each role in its order, except that the crowd's voices — `crowd`, `crowd-2` and on —
 * are one row where the first of them stood, each line still named to its own speaker. One crowd
 * voice alone is an ordinary role.
 */
export function dramaCastRows(roles: readonly DramaCastRole[]): DramaCastRow[] {
  const crowd = roles.filter((role) => isCrowdSpeaker(role.key));
  if (crowd.length < 2) return roles.map((role) => ({ kind: "role", role }));
  const order = (key: string) => Number(/-(\d+)$/u.exec(key)?.[1] ?? 1);
  const rows: DramaCastRow[] = [];
  for (const role of roles) {
    if (!isCrowdSpeaker(role.key)) rows.push({ kind: "role", role });
    else if (!rows.some((row) => row.kind === "crowd")) rows.push({ kind: "crowd", members: [...crowd].sort((a, b) => order(a.key) - order(b.key)) });
  }
  return rows;
}
