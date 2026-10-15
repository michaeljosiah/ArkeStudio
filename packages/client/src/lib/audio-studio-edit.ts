import { audioPassageId, bindAudioPassages, editAudioArrangement, initialAudioArrangement, newAudioClip, resolveAudioArrangement, ulid,
  type AudioArrangementCommand, type AudioArrangementEdit, type AudioSource, type AudioStudioSnapshot } from "@arke-studio/contracts";

/** A typed or dropped addition shares the same passage identity and source rules. */
export function audioStudioAddition(snapshot: AudioStudioSnapshot, source: AudioSource, destination: { trackId?: string; at: number; passageKey?: string; anchorKey?: string }): AudioArrangementCommand[] {
  const commands: AudioArrangementCommand[] = [];
  let trackId = destination.trackId ?? snapshot.state.tracks[0]?.id;
  if (!trackId) { trackId = ulid(); commands.push({ kind: "add-track", track: { id: trackId, name: "Audio", gainDb: 0, muted: false } }); }
  const clip = newAudioClip(ulid(), trackId, source, source.samples);
  clip.placement = { kind: "fixed", at: destination.at };
  if (destination.anchorKey && !destination.passageKey) {
    const passageId = [...bindAudioPassages(snapshot.state, snapshot.script)].find(([, bound]) => bound.key === destination.anchorKey)?.[0];
    const passage = resolveAudioArrangement(snapshot.state, snapshot.script).passages.find(entry => entry.id === passageId);
    if (!passageId || !passage) throw new Error("Repair the selected passage attachment before adding a linked cue");
    clip.placement = { kind: "passage", anchor: { passageId, edge: "start", offset: destination.at - passage.at } };
  }
  if (destination.passageKey) {
    const passage = snapshot.script.passages.find(entry => entry.key === destination.passageKey);
    if (!passage) throw new Error("The selected passage changed; select it again");
    let passageId = [...bindAudioPassages(snapshot.state, snapshot.script)].find(([, bound]) => bound.key === passage.key)?.[0];
    if (!passageId) {
      passageId = audioPassageId(passage.key, passage.textHash);
      if (snapshot.state.passages.some(entry => entry.id === passageId)) throw new Error("Repair the existing passage attachment before adding its performance");
      commands.push({ kind: "add-passage", passage: { id: passageId, ...passage, confirmedHash: snapshot.script.hash } });
    }
    clip.role = "speech"; clip.passageId = passageId; clip.placement = { kind: "sequence", offset: 0 };
    clip.label = snapshot.passages.find(entry => entry.key === passage.key)?.text.slice(0, 120) || source.label;
  }
  commands.push({ kind: "add-clip", clip }); return commands;
}

export function audioStudioReview(snapshot: AudioStudioSnapshot, edit: AudioArrangementEdit) {
  const next = editAudioArrangement(initialAudioArrangement(snapshot.state, "{}"), edit).current;
  const current = resolveAudioArrangement(snapshot.state, snapshot.script), suggested = resolveAudioArrangement(next, snapshot.script);
  const changes = suggested.clips.flatMap(entry => {
    const before = current.clips.find(prior => prior.clip.id === entry.clip.id);
    return !before || before.at !== entry.at || before.samples !== entry.samples || JSON.stringify(before.clip) !== JSON.stringify(entry.clip)
      ? [{ id: entry.clip.id, label: entry.clip.label, before: before?.at, after: entry.at, samples: entry.samples }] : [];
  });
  const removed = current.clips.filter(entry => !next.clips.some(clip => clip.id === entry.clip.id));
  const trimsReset = edit.kind === "commands" && edit.commands.some(command => command.kind === "replace-source" && snapshot.state.clips.some(clip => clip.id === command.id && (clip.sourceIn > 0 || clip.sourceOut !== clip.source?.samples)));
  const details: string[] = [];
  for (const track of next.tracks) {
    const before = snapshot.state.tracks.find(entry => entry.id === track.id);
    if (!before) details.push(`Add track: ${track.name}`);
    else if (JSON.stringify(before) !== JSON.stringify(track)) details.push(`${track.name}: ${track.gainDb} dB · ${track.muted ? "muted in mix" : "audible in mix"}`);
  }
  for (const track of snapshot.state.tracks) if (!next.tracks.some(entry => entry.id === track.id)) details.push(`Remove track: ${track.name}`);
  if (JSON.stringify(next.master) !== JSON.stringify(snapshot.state.master)) details.push(`Chapter master: ${next.master.targetLufs} LUFS · ${next.master.ceilingDb} dBFS ceiling`);
  for (const omission of next.omissions) if (JSON.stringify(omission) !== JSON.stringify(snapshot.state.omissions.find(entry => entry.id === omission.id))) details.push(`${omission.label}: ${omission.acknowledged ? "omission acknowledged" : "omission needs acknowledgement"}`);
  for (const omission of snapshot.state.omissions) if (!next.omissions.some(entry => entry.id === omission.id)) details.push(`${omission.label}: mark performance restored`);
  const fixed = suggested.clips.filter(entry => entry.clip.placement.kind === "fixed" && current.clips.some(before => before.clip.id === entry.clip.id));
  return { base: snapshot.base, edit, current, suggested, changes, removed, trimsReset, next, fixed, details };
}
