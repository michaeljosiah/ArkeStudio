import { useState } from "react";
import { bindAudioPassages } from "@arke-studio/contracts";
import { Button, Select } from "../components/ui.js";
import { useAudioStudio } from "../lib/audio-studio.js";
import { AudioStudioInspector } from "./audio-studio-inspector.js";

/** Audiobook's existing Timing tab becomes another view of the same saved arrangement. */
export function AudioStudioPassagePanel(props: {
  worldId: string; productionId: string; chapterId: string; chapterFile: string; connection: string;
  stamp: unknown; passageKey: string | null; onOpen: () => void; locked: boolean;
}) {
  const studio = useAudioStudio(props), [chosen, setChosen] = useState<string | null>(null);
  const snapshot = studio.snapshot;
  const passageId = snapshot ? [...bindAudioPassages(snapshot.state, snapshot.script)].find(([, passage]) => passage.key === props.passageKey)?.[0] : undefined;
  const clips = snapshot?.state.clips.filter(clip => passageId !== undefined && clip.passageId === passageId && clip.role === "speech") ?? [];
  const selected = clips.find(clip => clip.id === chosen) ?? clips[0];
  return <section aria-label="Arranged passage timing"><p>This chapter uses its saved Audio Studio arrangement.</p>
    {studio.problem && <p role="status">{studio.problem}</p>}
    {clips.length > 1 && <Select label="Passage clip" value={selected?.id ?? ""} onChange={event => setChosen(event.target.value)}>{clips.map(clip => <option key={clip.id} value={clip.id}>{clip.label}</option>)}</Select>}
    {snapshot && selected ? <AudioStudioInspector snapshot={snapshot} selected={selected.id} trackId={selected.trackId} disabled={props.locked || studio.pending || props.connection !== "open"}
      onEdit={(label, commands, base) => studio.edit({ kind: "commands", label, commands }, base)} onReplace={props.onOpen} />
      : <p>{snapshot ? "Open Audio Studio to add or repair this passage's performance." : "Opening arrangement…"}</p>}
    <Button onClick={props.onOpen}>Open in Audio Studio</Button>
  </section>;
}
