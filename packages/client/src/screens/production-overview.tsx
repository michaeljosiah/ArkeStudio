import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router";
import { productionShape, proposalDecisionOf, type ProductionBundle, type StagedProposal } from "@arke-studio/contracts";
import { useStore } from "../lib/store.js";
import { ReadAloud } from "../components/read-aloud.js";
import { PageReadControl, type useProsePageRead } from "../components/page-read.js";
import { PageSheet } from "../components/page-sheet.js";
import { StagedDecision } from "../components/conversation.js";
import { ChevronDown, ChevronRight, Play } from "../components/icons.js";

function ProseCard({ label, children, className = "" }: { label: string; children: ReactNode; className?: string }) {
  return <section className={`fy-overview-card fy-texthost ${className}`}><h2>{label}</h2>{children}</section>;
}
function ClampedText({ children }: { children: string }) {
  const [expanded, setExpanded] = useState(false);
  return <><div className="fy-overview-prose" data-expanded={expanded || undefined}>{children}</div>
    <button className="fy-overview-more" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Less" : "More"}<ChevronDown size={14} /></button></>;
}

/** Turn 171's cards share the same read sources and proposal gate as the wide Overview. */
export function CompactOverview({ worldId, production, staged, read }: {
  worldId: string; production: ProductionBundle; staged?: StagedProposal;
  read: ReturnType<typeof useProsePageRead>;
}) {
  const [waiting, setWaiting] = useState(false);
  const { state } = useStore();
  const world = state?.world;
  const attended = !!staged && !!world && proposalDecisionOf(staged.proposal, world.conversations).mode === "attended";
  useEffect(() => { if (!attended) setWaiting(false); }, [attended]);
  const story = production.story, style = production.proseStyle;
  const id = production.meta.id;
  const develop = `/w/${worldId}/p/${id}/story`;
  const actions = (field: "logline" | "spine" | "question" | "ending" | "treatment" | "voice", text: string) =>
    <ReadAloud source={{ of: "story", productionId: id, field }} title={`${production.meta.title} · ${field}`} text={text} />;
  return <div className="fy-overview fy-prodscroll" data-screen="story-overview">
    <header className="fy-overview__head"><div><div className="fy-eyebrow-sm">Overview · {story?.targetLength || productionShape(production.meta).displayLabel.toLowerCase()}{story ? ` · v${story.version}` : ""}</div>
      <h1>The story, as it stands</h1></div><div className="fy-overview__read">{read.count > 0 && <PageReadControl read={read} label={<><Play size={14} />Read the overview</>} />}</div></header>
    {attended && staged && <button className="fy-overview-waiting" type="button" aria-haspopup="dialog" onClick={() => setWaiting(true)}><b>Waiting on you</b><span>{staged.review?.targets.flatMap(target => target.fields).length ?? 0} changes</span><ChevronRight size={18} /></button>}
    <div className="fy-overview__cards">
      {story?.logline && <ProseCard label="Logline" className="fy-overview-logline"><p>{story.logline}</p>{actions("logline", story.logline)}</ProseCard>}
      {story?.spine && <ProseCard label="Spine"><ClampedText>{story.spine}</ClampedText>{actions("spine", story.spine)}</ProseCard>}
      {(["question", "ending"] as const).map(field => story?.[field] ? <ProseCard key={field} label={field === "question" ? "Dramatic question" : "Ending"}><p>{story[field]}</p>{actions(field, story[field])}</ProseCard> : null)}
      {(story?.acts?.length ?? 0) > 0 && <section className="fy-overview-acts fy-texthost"><h2>Acts <span>{story!.acts!.length}</span></h2>
        <div className="fy-overview-acts__grid">{story!.acts!.map((act, index) => <article key={`${index}:${act.title}:${act.summary ?? ""}`} className="fy-overview-act fy-texthost">
          <span className="fy-overview-act__number">{index + 1}</span><span className="fy-overview-act__label">Act {index + 1}</span>
          <div><h3>{act.title}</h3>{act.summary && <p>{act.summary}</p>}
            <ReadAloud source={{ of: "story", productionId: id, field: "acts", act: index }} title={`Act ${index + 1} · ${act.title}`} text={`${act.title}${act.summary ? " — " + act.summary : ""}`} />
          </div></article>)}</div>
        <ReadAloud source={{ of: "story", productionId: id, field: "acts" }} title="Acts" text={story!.acts!.map(act => `${act.title} — ${act.summary ?? ""}`).join("\n")} />
      </section>}
      {production.treatment && <ProseCard label="Treatment"><ClampedText>{production.treatment}</ClampedText>{actions("treatment", production.treatment)}</ProseCard>}
      {style ? <><div className="fy-overview-style-head"><b>Style</b><span>v{style.version} · settled in Develop</span></div>
        {style.pov && <ProseCard label="Point of view"><p>{style.pov}</p></ProseCard>}
        {style.tense && <ProseCard label="Tense"><p>{style.tense}</p></ProseCard>}
        {style.voice && <ProseCard label="Voice"><p>{style.voice}</p>{actions("voice", style.voice)}</ProseCard>}
        {style.samples?.map((sample, index) => sample.trim() ? <ProseCard key={`${index}:${sample}`} label={`Sample ${index + 1}`}><p>{sample}</p><ReadAloud source={{ of: "story", productionId: id, field: "samples", sample: index }} title={`Sample ${index + 1}`} text={sample} /></ProseCard> : null)}
      </> : story ? <div className="fy-overview-style-unset"><b>Style</b><span>not set</span><NavLink to={develop}>Develop</NavLink></div> : null}
      {/* One empty state (design turn 192): the line and where it is settled, not a Style row
          beside a sentence that both say nothing is. */}
      {!story && !style && <div className="fy-overview-style-unset" data-testid="overview-empty"><b>Nothing settled yet</b><NavLink to={develop}>Develop</NavLink></div>}
    </div>
    <PageSheet open={waiting && attended} title="Waiting on you" onClose={() => setWaiting(false)} className="fy-develop-sheet" keepMounted>
      {attended && staged && <StagedDecision worldId={worldId} subject="the overview" staged={staged} onAccepted={() => setWaiting(false)} />}
    </PageSheet>
  </div>;
}
