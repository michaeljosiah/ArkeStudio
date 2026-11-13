import { audioPassageId, bindAudioPassages, type AudioArrangementCommand, type AudioStudioSnapshot, type ResolvedAudioArrangement } from "@arke-studio/contracts";
import { Button, Select } from "../components/ui.js";

export function AudioStudioRepairs({ snapshot, plan, disabled, onSelect, onReview }: {
  snapshot: AudioStudioSnapshot; plan: ResolvedAudioArrangement; disabled: boolean; onSelect: (id: string) => void;
  onReview: (label: string, commands: AudioArrangementCommand[]) => void;
}) {
  // A sound the first arrangement could not place has no clip to mark (issue 1888): the snapshot
  // named it as unavailable and nothing on screen did, so a placed cue was simply missing.
  const unplaced = (snapshot.unavailable ?? []).filter(entry => !snapshot.state.clips.some(clip => clip.source?.file === entry.file));
  if (!plan.issues.length && !snapshot.state.omissions.length && !unplaced.length) return null;
  const bindings = bindAudioPassages(snapshot.state, snapshot.script);
  // A passage by its words, not its key (issue 1888): an episode's keys are block ids.
  const said = (key: string | undefined) => key === undefined ? undefined : snapshot.passages.find(entry => entry.key === key)?.text.slice(0, 120);
  const count = plan.issues.length + unplaced.length;
  return <details className="fy-audio-repairs"><summary>{count ? `${count} repair${count === 1 ? "" : "s"} before final delivery` : "Acknowledged omissions"}</summary><p>Draft listening is available. Final delivery requires every repair to be resolved or each omission explicitly acknowledged.</p>
    {unplaced.map(entry => <div key={`unplaced/${entry.file}`}><p><b>Not placed</b> · {entry.message}</p></div>)}
    {plan.issues.map(issue => {
      const passage = snapshot.state.passages.find(entry => entry.id === issue.id), clip = snapshot.state.clips.find(entry => entry.id === issue.id);
      const current = snapshot.script.passages.find(entry => entry.key === issue.id);
      const omission = snapshot.state.omissions.find(entry => entry.id === issue.id);
      return <div key={`${issue.kind}/${issue.id}`}><p><b>{said(passage?.key) ?? clip?.label ?? said(current?.key) ?? omission?.label ?? passage?.key ?? current?.key ?? issue.id}</b> · {issue.message}</p>
        {clip && <Button size="sm" onClick={() => onSelect(clip.id)}>Inspect clip</Button>}
        {passage && snapshot.state.clips.filter(entry => entry.passageId === passage.id).map(entry => <Button key={entry.id} size="sm" onClick={() => onSelect(entry.id)}>Inspect {entry.label}</Button>)}
        {omission && <Button size="sm" disabled={disabled} onClick={() => onReview("Acknowledge omission", [{ kind: "acknowledge-omission", id: omission.id, acknowledged: true }])}>Review omission</Button>}
        {passage && !bindings.has(passage.id) && <form onSubmit={event => {
          event.preventDefault(); const key = String(new FormData(event.currentTarget).get("passage")); const target = snapshot.script.passages.find(entry => entry.key === key);
          if (target) onReview("Reattach passage", [{ kind: "bind-passage", id: passage.id, key, textHash: target.textHash, scriptHash: snapshot.script.hash }]);
        }}><Select label="Reattach to passage" name="passage">{snapshot.passages.filter(entry => ![...bindings.values()].some(bound => bound.key === entry.key)).map(entry => <option key={entry.key} value={entry.key}>{entry.text.slice(0, 100)}</option>)}</Select><Button type="submit" size="sm" disabled={disabled}>Review attachment</Button></form>}
        {passage && !bindings.has(passage.id) && <Button size="sm" disabled={disabled} onClick={() => onReview("Remove deleted passage audio and attached cues", [{ kind: "remove-passage", id: passage.id }])}>Review removal</Button>}
        {(current || passage && bindings.has(passage.id)) && <Button size="sm" disabled={disabled} onClick={() => {
          const id = passage?.id ?? audioPassageId(current!.key, current!.textHash);
          const commands: AudioArrangementCommand[] = passage ? [] : [{ kind: "add-passage", passage: { id, ...current!, confirmedHash: snapshot.script.hash } }];
          commands.push({ kind: "omit-passage", id, label: snapshot.passages.find(entry => entry.key === (current?.key ?? passage?.key))?.text.slice(0, 120) ?? id, acknowledged: true });
          onReview("Omit unread passage", commands);
        }}>Review omission</Button>}
      </div>;
    })}
    {snapshot.state.omissions.map(entry => <div key={entry.id}><p>{entry.label} · {entry.acknowledged ? "omission acknowledged" : "omission needs review"}</p>
      {plan.clips.some(clip => clip.clip.passageId === entry.passageId && clip.clip.role === "speech" && !clip.clip.repeated && clip.clip.source && !clip.muted) && <Button size="sm" disabled={disabled} onClick={() => onReview("Confirm restored performance", [{ kind: "clear-omission", id: entry.id }])}>Review restored passage</Button>}
    </div>)}
  </details>;
}
