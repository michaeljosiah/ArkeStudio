import type { ProductionSetupDraft } from "@arke-studio/contracts";

export function ProductionSetupOutline({ draft, sheetName }: { draft: ProductionSetupDraft; sheetName: (id: string) => string }) {
  const scene = (key: string) => {
    const item = draft.scenes.find(item => item.key === key);
    return item ? <li key={key}><strong>{item.title}</strong>{item.synopsis && <p>{item.synopsis}</p>}
      {item.inherits?.location && <p>Location: {sheetName(item.inherits.location)}</p>}
      {item.inherits?.timeOfDay && <p>Time: {item.inherits.timeOfDay}</p>}
      {item.inherits?.tone && <p>Tone: {item.inherits.tone}</p>}
      {!!item.scriptBlocks?.length && <details><summary>{item.scriptBlocks.length} script block{item.scriptBlocks.length === 1 ? "" : "s"}</summary>
        {item.scriptBlocks.map(block => <p key={block.id}>{block.speaker && <strong>{sheetName(block.speaker)}: </strong>}{block.text}</p>)}</details>}
    </li> : <li key={key}>Scene removed: {key}</li>;
  };
  return <>
    {Object.entries(draft.narrative).filter(([, value]) => value).map(([key, value]) => <section key={key}>
      <h3>{{ question: "Dramatic question", direction: "Through-line", ending: "Ending", arcNotes: "Arc notes" }[key]}</h3><p>{value}</p>
    </section>)}
    {!!draft.references.length && <section><h3>From the world</h3><p>{draft.references.map(sheetName).join(" · ")}</p></section>}
    {draft.series && <section><h3>Series · {draft.series.title}</h3>{draft.series.engine && <p>{draft.series.engine}</p>}{draft.series.continuity && <p>Continuity: {draft.series.continuity}</p>}</section>}
    {draft.episodes.map(episode => <section key={episode.key}><h3>{episode.title}</h3>
      {Object.entries(episode.promise ?? {}).map(([key, value]) => <p key={key}><strong>{key}: </strong>{value}</p>)}
      <ol>{episode.scenes.map(scene)}</ol></section>)}
    {draft.scenes.some(item => !draft.episodes.some(episode => episode.scenes.includes(item.key))) &&
      <section><h3>{draft.kind === "microdrama" ? "Scenes awaiting an episode" : "Scenes"}</h3><ol>
        {draft.scenes.filter(item => !draft.episodes.some(episode => episode.scenes.includes(item.key))).map(item => scene(item.key))}
      </ol></section>}
    {!!draft.arcs.length && <section><h3>Season arcs</h3>{draft.arcs.map(arc => <p key={arc.id}><strong>{arc.title}</strong> · {arc.note}
      {(["setup", "turn", "payoff"] as const).map(part => arc[part] && <span key={part}> · {part}: {draft.episodes.find(episode => episode.key === arc[part])?.title ?? arc[part]}</span>)}</p>)}</section>}
    {!!draft.openQuestions.length && <section><h3>Open questions</h3><ul>{draft.openQuestions.map((question, i) => <li key={i}>{question}</li>)}</ul></section>}
  </>;
}
