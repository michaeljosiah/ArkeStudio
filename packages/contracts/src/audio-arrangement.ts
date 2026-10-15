import { textDigest } from "./subtitles.js";
import { AUDIO_STUDIO_HISTORY, AUDIO_STUDIO_MAX_SAMPLES, AUDIO_STUDIO_RATE, AudioArrangementEditSchema, AudioArrangementStateSchema,
  type AudioArrangement, type AudioArrangementCommand, type AudioArrangementEdit, type AudioArrangementState, type AudioClip, type AudioSource } from "./audio-arrangement-schema.js";

export class AudioArrangementRefusal extends Error {}
export const audioSamples = (seconds: number): number => Math.round(seconds * AUDIO_STUDIO_RATE);
export const audioSeconds = (samples: number): number => samples / AUDIO_STUDIO_RATE;
export interface AudioScript { hash: string; passages: readonly { key: string; textHash: string }[] }
export interface AudioArrangementIssue { kind: "passage" | "source" | "cycle" | "omission" | "range"; id: string; message: string }
export interface ResolvedAudioClip { clip: AudioClip; at: number; samples: number; gainDb: number; muted: boolean }
export interface ResolvedAudioArrangement {
  sampleRate: 48000; channels: 2; samples: number; clips: ResolvedAudioClip[];
  passages: Array<{ id: string; key: string; at: number; samples: number }>;
  issues: AudioArrangementIssue[]; omitted: string[];
}

/** Repeated text is not identity evidence after a manuscript edit (SPEC-047 R-192). */
export function bindAudioPassages(state: AudioArrangementState, script: AudioScript): Map<string, { key: string; textHash: string; index: number }> {
  const bound = new Map<string, { key: string; textHash: string; index: number }>();
  const originalCounts = new Map<string, number>();
  for (const passage of state.passages) originalCounts.set(passage.textHash, (originalCounts.get(passage.textHash) ?? 0) + 1);
  const taken = new Set<string>();
  for (const passage of state.passages) {
    const candidates = script.passages.flatMap((current, index) => current.textHash === passage.textHash ? [{ ...current, index }] : []);
    const match = state.manuscriptHash === script.hash || passage.confirmedHash === script.hash
      ? candidates.find(candidate => candidate.key === passage.key)
      : originalCounts.get(passage.textHash) === 1 && candidates.length === 1 ? candidates[0] : undefined;
    if (match && !taken.has(match.key)) { bound.set(passage.id, match); taken.add(match.key); }
  }
  return bound;
}

/** Every consumer receives this sample-domain plan; unavailable clips cannot fall back to takes. */
export function resolveAudioArrangement(state: AudioArrangementState, script: AudioScript, unavailable: ReadonlySet<string> = new Set()): ResolvedAudioArrangement {
  const bindings = bindAudioPassages(state, script);
  const order = [...bindings].sort((a, b) => a[1].index - b[1].index).map(([id]) => id);
  const issues: AudioArrangementIssue[] = [];
  const issue = (kind: AudioArrangementIssue["kind"], id: string, message: string) => {
    if (!issues.some(held => held.kind === kind && held.id === id)) issues.push({ kind, id, message });
  };
  const omitted = state.omissions.filter(entry => entry.acknowledged).map(entry => entry.passageId);
  for (const entry of state.omissions) if (!entry.acknowledged) issue("omission", entry.id, `${entry.label}: confirm the omission before delivery`);
  const tracks = new Map(state.tracks.map(track => [track.id, track]));
  const clips = new Map(state.clips.map(clip => [clip.id, clip]));
  const resolved = new Map<string, ResolvedAudioClip | null>();
  const spans = new Map<string, { at: number; samples: number } | null>();
  const visiting = new Set<string>();
  const enter = (key: string) => {
    if (visiting.has(key)) { issue("cycle", key, "Passage attachments form a cycle"); return false; }
    if (visiting.size >= 256) { issue("cycle", key, "This attachment chain is too deep; attach cues directly to their passage"); return false; }
    visiting.add(key); return true;
  };
  const previousEnd = (id: string): number | null => {
    const index = order.indexOf(id);
    if (index < 0) return null;
    const before = order.slice(0, index).findLast(candidate => {
      const performances = state.clips.filter(clip => clip.passageId === candidate && clip.role === "speech" && !clip.repeated);
      return performances.length === 0 || performances.some(clip => clip.placement.kind === "sequence");
    });
    if (before === undefined) return 0;
    const previous = span(before);
    return previous === null ? null : previous.at + previous.samples;
  };
  const span = (id: string): { at: number; samples: number } | null => {
    if (spans.has(id)) return spans.get(id)!;
    if (!bindings.has(id)) { issue("passage", id, "The passage changed or its identity is ambiguous; reattach or omit it"); return null; }
    if (!enter(`passage:${id}`)) return null;
    const entries = state.clips.filter(clip => clip.passageId === id && clip.role === "speech" && !clip.repeated).map(clip => resolve(clip.id)).filter((entry): entry is ResolvedAudioClip => entry !== null);
    let value: { at: number; samples: number } | null = null;
    if (entries.length) {
      const at = Math.min(...entries.map(entry => entry.at));
      value = { at, samples: Math.max(...entries.map(entry => entry.at + entry.samples)) - at };
    } else {
      if (!omitted.includes(id)) issue("passage", id, "This passage has no arranged performance");
      const at = previousEnd(id);
      if (at !== null) value = { at, samples: 0 };
    }
    visiting.delete(`passage:${id}`); spans.set(id, value); return value;
  };
  const boundary = (anchor: { passageId: string; edge: "start" | "end"; offset: number }): number | null => {
    const held = span(anchor.passageId);
    return held === null ? null : held.at + (anchor.edge === "end" ? held.samples : 0) + anchor.offset;
  };
  const resolve = (id: string): ResolvedAudioClip | null => {
    if (resolved.has(id)) return resolved.get(id)!;
    const clip = clips.get(id);
    if (!clip || !enter(`clip:${id}`)) return null;
    let at: number | null = null, samples = clip.sourceOut - clip.sourceIn;
    const placement = clip.placement;
    if (placement.kind === "fixed") at = placement.at;
    else if (placement.kind === "sequence") {
      const before = clip.passageId === undefined ? null : previousEnd(clip.passageId);
      if (before !== null) at = before + placement.offset;
    } else if (placement.kind === "passage") at = boundary(placement.anchor);
    else {
      at = boundary(placement.from);
      const end = boundary(placement.to);
      if (at !== null && end !== null) samples = end - at;
      else at = null;
    }
    if (clip.passageId !== undefined && !bindings.has(clip.passageId)) {
      issue("passage", clip.passageId, "The recorded passage changed; repair its attachment before playback"); at = null;
    }
    if (clip.source === null || unavailable.has(clip.source.file)) issue("source", id, `${clip.label}: audio is missing or has changed`);
    if (at !== null && (at < 0 || samples <= 0 || at + samples > AUDIO_STUDIO_MAX_SAMPLES)) {
      issue("range", id, `${clip.label}: placement is outside the chapter clock`); at = null;
    }
    if (placement.kind === "range" && !clip.loop && samples > clip.sourceOut - clip.sourceIn) {
      issue("range", id, `${clip.label}: the source is shorter than its range; enable Loop or trim the range`); at = null;
    }
    const track = tracks.get(clip.trackId);
    const value = at === null || !track ? null : { clip, at, samples, gainDb: clip.gainDb + track.gainDb, muted: track.muted };
    visiting.delete(`clip:${id}`); resolved.set(id, value); return value;
  };
  // Resolve passages before independent cues; the run's ordering is the current manuscript's.
  for (const id of order) span(id);
  for (const clip of state.clips) resolve(clip.id);
  for (const current of script.passages) if (![...bindings.values()].some(bound => bound.key === current.key)) issue("passage", current.key, "This new or changed passage needs an arranged performance");
  const entries = [...resolved.values()].filter((entry): entry is ResolvedAudioClip => entry !== null);
  return { sampleRate: AUDIO_STUDIO_RATE, channels: 2, samples: Math.max(0, ...entries.map(entry => entry.at + entry.samples)), clips: entries,
    passages: order.flatMap(id => { const value = spans.get(id); return value ? [{ id, key: bindings.get(id)!.key, ...value }] : []; }), issues, omitted };
}

/** Schema shape alone cannot establish referential integrity or source-window validity. */
export function validateAudioArrangement(input: AudioArrangementState): AudioArrangementState {
  const state = AudioArrangementStateSchema.parse(input);
  const unique = (values: readonly { id: string }[], label: string) => {
    if (new Set(values.map(value => value.id)).size !== values.length) throw new AudioArrangementRefusal(`Duplicate ${label} identity`);
  };
  unique(state.passages, "passage"); unique(state.clips, "clip"); unique(state.tracks, "track"); unique(state.omissions, "omission");
  const passageIds = new Set(state.passages.map(passage => passage.id));
  for (const clip of state.clips) {
    if (!state.tracks.some(track => track.id === clip.trackId)) throw new AudioArrangementRefusal("The destination track no longer exists");
    if (clip.passageId !== undefined && !passageIds.has(clip.passageId)) throw new AudioArrangementRefusal("The clip's passage no longer exists");
    const anchors = clip.placement.kind === "range" ? [clip.placement.from, clip.placement.to] : clip.placement.kind === "passage" ? [clip.placement.anchor] : [];
    if (anchors.some(anchor => !passageIds.has(anchor.passageId))) throw new AudioArrangementRefusal("The attached passage no longer exists");
    if (clip.placement.kind === "sequence" && (clip.passageId === undefined || clip.role !== "speech")) throw new AudioArrangementRefusal("Only a passage performance can follow the reading sequence");
    if (clip.sourceOut <= clip.sourceIn || clip.source !== null && clip.sourceOut > clip.source.samples) throw new AudioArrangementRefusal("The trim is outside this exact source");
    const duration = clip.sourceOut - clip.sourceIn;
    if (clip.fadeIn + clip.fadeOut > duration && clip.placement.kind !== "range") throw new AudioArrangementRefusal("The fades exceed the clip length");
    if (clip.loopFade * 2 > duration) throw new AudioArrangementRefusal("The loop seam exceeds half the source window");
  }
  if (state.omissions.some(entry => !passageIds.has(entry.passageId))) throw new AudioArrangementRefusal("The omitted passage no longer exists");
  const resolved = resolveAudioArrangement(state, { hash: state.manuscriptHash, passages: state.passages });
  const invalid = resolved.issues.find(issue => issue.kind === "cycle" || issue.kind === "range");
  if (invalid) throw new AudioArrangementRefusal(invalid.message);
  return state;
}

function editedState(input: AudioArrangementState, commands: readonly AudioArrangementCommand[]): AudioArrangementState {
  const state = structuredClone(input);
  for (const command of commands) {
    const clipFor = (id: string, allowProtected = false) => {
      const clip = state.clips.find(entry => entry.id === id);
      if (!clip) throw new AudioArrangementRefusal("That clip no longer exists");
      if (clip.protected && !allowProtected) throw new AudioArrangementRefusal("Release this clip's protection before editing it");
      return clip;
    };
    switch (command.kind) {
      case "add-track": state.tracks.push(structuredClone(command.track)); break;
      case "set-track": {
        const track = state.tracks.find(entry => entry.id === command.id);
        if (!track) throw new AudioArrangementRefusal("That track no longer exists");
        Object.assign(track, command.changes); break;
      }
      case "remove-track":
        if (!state.tracks.some(track => track.id === command.id)) throw new AudioArrangementRefusal("That track no longer exists");
        if (state.clips.some(clip => clip.trackId === command.id)) throw new AudioArrangementRefusal("Move or remove the track's clips first");
        state.tracks = state.tracks.filter(track => track.id !== command.id); break;
      case "add-clip": state.clips.push(structuredClone(command.clip)); break;
      case "set-clip": Object.assign(clipFor(command.id), structuredClone(command.changes)); break;
      case "protect-clip": clipFor(command.id, true).protected = command.protected; break;
      case "remove-clip": {
        const clip = clipFor(command.id);
        if (clip.role === "speech" && clip.passageId !== undefined) state.omissions.push({ id: clip.id, passageId: clip.passageId, label: clip.label, acknowledged: false });
        state.clips = state.clips.filter(entry => entry.id !== command.id); break;
      }
      case "split-clip": {
        const clip = clipFor(command.id);
        if (clip.loop || clip.placement.kind === "range") throw new AudioArrangementRefusal("Set a fixed source window before splitting a loop or range");
        const length = clip.sourceOut - clip.sourceIn;
        if (command.at <= 0 || command.at >= length) throw new AudioArrangementRefusal("Split inside the clip");
        const next = structuredClone(clip); next.id = command.nextId; next.sourceIn += command.at; next.fadeIn = 0;
        if (next.placement.kind === "fixed") next.placement.at += command.at;
        else if (next.placement.kind === "sequence") next.placement.offset += command.at;
        else if (next.placement.kind === "passage") next.placement.anchor.offset += command.at;
        clip.sourceOut = clip.sourceIn + command.at; clip.fadeOut = 0;
        clip.fadeIn = Math.min(clip.fadeIn, command.at); next.fadeOut = Math.min(next.fadeOut, length - command.at);
        state.clips.push(next); break;
      }
      case "duplicate-clip": {
        const clip = clipFor(command.id);
        state.clips.push({ ...structuredClone(clip), id: command.nextId, repeated: clip.role === "speech", placement: { kind: "fixed", at: command.at } }); break;
      }
      case "replace-source": {
        const clip = clipFor(command.id); clip.source = structuredClone(command.source); clip.sourceIn = 0; clip.sourceOut = command.source.samples;
        clip.fadeIn = Math.min(clip.fadeIn, clip.sourceOut); clip.fadeOut = Math.min(clip.fadeOut, clip.sourceOut - clip.fadeIn);
        clip.loopFade = Math.min(clip.loopFade, Math.floor(clip.sourceOut / 2)); break;
      }
      case "bind-passage": {
        const passage = state.passages.find(entry => entry.id === command.id);
        if (!passage) throw new AudioArrangementRefusal("That passage no longer exists");
        passage.key = command.key; passage.textHash = command.textHash; passage.confirmedHash = command.scriptHash; break;
      }
      case "add-passage": state.passages.push(structuredClone(command.passage)); break;
      case "omit-passage": {
        if (!state.passages.some(passage => passage.id === command.id)) throw new AudioArrangementRefusal("That passage no longer exists");
        const id = `passage:${command.id}`;
        state.omissions = state.omissions.filter(entry => entry.id !== id);
        state.omissions.push({ id, passageId: command.id, label: command.label, acknowledged: command.acknowledged }); break;
      }
      case "acknowledge-omission": {
        const omission = state.omissions.find(entry => entry.id === command.id);
        if (!omission) throw new AudioArrangementRefusal("That omission no longer exists");
        omission.acknowledged = command.acknowledged; break;
      }
      case "set-master": state.master = structuredClone(command.master); break;
    }
  }
  return validateAudioArrangement(state);
}

/** History snapshots never include their own history. Undo cannot lower the schema or revision. */
export function editAudioArrangement(held: AudioArrangement, input: AudioArrangementEdit): AudioArrangement {
  const edit = AudioArrangementEditSchema.parse(input);
  if (held.revision >= Number.MAX_SAFE_INTEGER) throw new AudioArrangementRefusal("The arrangement revision cannot advance");
  if (edit.kind === "commands") {
    const current = editedState(held.current, edit.commands);
    if (JSON.stringify(current) === JSON.stringify(held.current)) return held;
    return { ...held, revision: held.revision + 1, current, undo: [...held.undo, { label: edit.label, state: held.current }].slice(-AUDIO_STUDIO_HISTORY), redo: [] };
  }
  const from = held[edit.kind], entry = from.at(-1);
  if (!entry) throw new AudioArrangementRefusal(`Nothing to ${edit.kind}`);
  const opposite = edit.kind === "undo" ? "redo" : "undo";
  return { ...held, revision: held.revision + 1, current: validateAudioArrangement(entry.state), [edit.kind]: from.slice(0, -1), [opposite]: [...held[opposite], { label: entry.label, state: held.current }].slice(-AUDIO_STUDIO_HISTORY) };
}

export function initialAudioArrangement(current: AudioArrangementState, legacy: string): AudioArrangement {
  return { schemaVersion: 1, sampleRate: AUDIO_STUDIO_RATE, channels: 2, revision: 1, current: validateAudioArrangement(current), undo: [], redo: [], legacy };
}
export function audioPassageId(key: string, textHash: string): string { return `passage:${textDigest(`${key}\n${textHash}`)}`; }
export function newAudioClip(id: string, trackId: string, source: AudioSource | null, samples: number): AudioClip {
  return { id, trackId, label: source?.label ?? "Not read", role: "sfx", source, sourceIn: 0, sourceOut: samples, placement: { kind: "fixed", at: 0 },
    gainDb: 0, pan: 0, fadeIn: 0, fadeOut: 0, loop: false, loopFade: 0, duckDb: 0, protected: false, repeated: false };
}

/** Both the native mixer and audition use this envelope on the exact resolved sample clock. */
export function audioClipGain(entry: ResolvedAudioClip, at: number, speech: readonly { at: number; samples: number }[]): number {
  const local = at - entry.at;
  if (entry.muted || local < 0 || local >= entry.samples) return 0;
  const clip = entry.clip;
  const fade = Math.min(1, clip.fadeIn > 0 ? local / clip.fadeIn : 1, clip.fadeOut > 0 ? (entry.samples - local) / clip.fadeOut : 1);
  let duck = 0;
  if (clip.role !== "speech" && clip.duckDb > 0) for (const voice of speech) {
    const end = voice.at + voice.samples;
    const envelope = at < voice.at ? 1 - (voice.at - at) / audioSamples(.15) : at <= end ? 1 : 1 - (at - end) / audioSamples(.5);
    duck = Math.max(duck, Math.max(0, Math.min(1, envelope)));
  }
  return 10 ** ((entry.gainDb - clip.duckDb * duck) / 20) * fade;
}

export function audioReplacementDiff(current: AudioArrangementState, script: AudioScript, clipId: string, source: AudioSource) {
  const suggested = editedState(current, [{ kind: "replace-source", id: clipId, source }]);
  const before = resolveAudioArrangement(current, script), after = resolveAudioArrangement(suggested, script);
  const changes = after.clips.flatMap(next => {
    const prior = before.clips.find(entry => entry.clip.id === next.clip.id);
    return prior && (prior.at !== next.at || prior.samples !== next.samples) ? [{ id: next.clip.id, label: next.clip.label, from: prior.at, to: next.at, beforeSamples: prior.samples, afterSamples: next.samples, fixed: next.clip.placement.kind === "fixed" }] : [];
  });
  const clip = current.clips.find(entry => entry.id === clipId)!;
  return { suggested, changes, beforeSamples: before.samples, afterSamples: after.samples, trimsReset: clip.sourceIn > 0 || clip.sourceOut !== clip.source?.samples,
    fixed: after.clips.filter(entry => entry.clip.placement.kind === "fixed").map(entry => entry.clip.id) };
}
