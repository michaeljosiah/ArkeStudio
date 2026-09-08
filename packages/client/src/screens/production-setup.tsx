import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  ConversationIdSchema, productionSetupProblems, ulid,
  type ProductionSetupCommand, type ProductionSetupDraft, type ProductionSetupState,
} from "@arke-studio/contracts";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { openWorldChat, send, subscribeProductionSetupResults, useStore, useWorldChatProgress } from "../lib/store.js";
import { ConversationTranscript, languageChoiceReason } from "../components/conversation.js";
import { Composer } from "../components/composer.js";
import { ProductionSetupOutline } from "../components/production-setup-outline.js";
import { Button } from "../components/ui.js";

/** Same transcript and composer as production chat; the rail is the authoritative setup draft. */
export function ProductionSetupScreen() {
  const { worldId, setupId: routeId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const idResult = ConversationIdSchema.safeParse(routeId);
  const setupId = idResult.success ? idResult.data : null;
  const { state, connection } = useStore();
  const navigate = useNavigate();
  const workspace = state?.worldChat?.conversationId === setupId ? state.worldChat : null;
  const setup = workspace?.productionSetup;
  const [message, setMessage] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [tab, setTab] = useState<"conversation" | "outline">("conversation");
  const [modelId, setModelId] = useState("");
  const pendingRef = useRef<{ requestId: string; operation: string } | null>(null);
  const opened = useRef<string | null>(null);
  const models = state?.app.manifest?.models.filter(model => model.capability === "llm") ?? [];
  const unavailable = languageChoiceReason(state, modelId || undefined, models.find(model => model.id === modelId));
  const progress = useWorldChatProgress(setupId ?? undefined, workspace?.runStartedAt ?? null);
  const running = workspace?.runStatus === "running" || pending === "send" || pending === "retry";
  const locked = setup?.status === "creating" || setup?.status === "created";

  function command(action: ProductionSetupCommand["action"]) {
    if (!worldId || !setupId) return;
    const requestId = ulid();
    pendingRef.current = { requestId, operation: action.operation };
    setPending(action.operation);
    setFailure(null);
    if (!send({ kind: "production-setup", worldId, setupId, requestId, action })) {
      setPending(null);
      pendingRef.current = null;
      setFailure("The studio is disconnected. Reconnect to continue this setup.");
    }
  }
  useEffect(() => subscribeProductionSetupResults(result => {
    if (result.worldId !== worldId || result.setupId !== setupId) return;
    if (result.requestId === pendingRef.current?.requestId) {
      if (!result.detail && pendingRef.current.operation === "send") setMessage("");
      pendingRef.current = null;
      setPending(null);
    }
    setFailure(result.detail ?? null);
    if (result.state?.status === "discarded") navigate(`/w/${worldId}/productions`);
    if (result.state?.status === "created" && result.state.productionId) navigate(`/w/${worldId}/p/${result.state.productionId}`, { replace: true });
  }), [worldId, setupId, navigate]);
  useEffect(() => {
    if (!world || !worldId || !setupId || connection !== "open") return;
    const key = `${worldId}/${setupId}`;
    if (opened.current === key) return;
    opened.current = key;
    command({ operation: world.conversations.some(conversation => conversation.id === setupId) ? "resume" : "start" });
  }, [world, worldId, setupId, connection]);
  useEffect(() => {
    if (connection !== "open") {
      opened.current = null;
      pendingRef.current = null;
      setPending(null);
    }
  }, [connection]);
  useEffect(() => {
    if (setup?.status === "created" && setup.productionId) navigate(`/w/${worldId}/p/${setup.productionId}`, { replace: true });
  }, [setup?.status, setup?.productionId, worldId, navigate]);
  useEffect(() => () => { if (worldId) openWorldChat(worldId, null); }, [worldId, setupId]);
  if (!setupId) return <p role="alert">This production setup address is invalid.</p>;
  const draft = setup?.draft;
  const problems = draft ? productionSetupProblems(draft, world?.sheets ?? []) : [];
  const update = (fields: NonNullable<Extract<ProductionSetupCommand["action"], { operation: "update" }>["update"]["fields"]>) => {
    if (draft) command({ operation: "update", update: { expectedRevision: draft.revision, fields } });
  };
  return (
    <div className="fy-production-setup" data-screen="production-setup">
      <header className="fy-production-setup__head">
        <div><div className="fy-eyebrow-sm">{world?.meta.name} · New production</div><h1>What are we making?</h1></div>
        <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/productions`)}>Save for later</Button>
      </header>
      <div className="fy-production-setup__tabs" role="tablist" aria-label="Production setup panels" onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "conversation" : event.key === "End" ? "outline" : tab === "conversation" ? "outline" : "conversation";
        setTab(next);
        document.getElementById(`setup-${next}-tab`)?.focus();
      }}>
        <button role="tab" id="setup-conversation-tab" tabIndex={tab === "conversation" ? 0 : -1} aria-selected={tab === "conversation"} aria-controls="setup-conversation"
          onClick={() => setTab("conversation")}>Conversation</button>
        <button role="tab" id="setup-outline-tab" tabIndex={tab === "outline" ? 0 : -1} aria-selected={tab === "outline"} aria-controls="setup-outline"
          onClick={() => setTab("outline")}>Production so far</button>
      </div>
      {failure && <p className="fy-production-setup__notice" role="alert">{failure}</p>}
      <div className="fy-production-setup__panels" data-active={tab}>
        <section id="setup-conversation" className="fy-production-setup__conversation" aria-label="Conversation with Arke">
          <div className="fy-production-setup__log">
            <ConversationTranscript workspace={workspace} running={running} progress={progress}
              failure={workspace?.lastFailure ?? null} canRetry={!locked && !running}
              onStop={() => command({ operation: "cancel" })}
              onRetry={turnId => command({ operation: "retry", turnId })}
              empty={<div className="fy-production-setup__welcome"><h2>Start with a possibility.</h2>
                <p>A scene you can see. A character with something to lose. A season you have already mapped out.</p>
                <p>We’ll shape it here, with {world?.meta.name ?? "your world"} around us.</p></div>} />
          </div>
          <div className="fy-production-setup__composer">
            {models.length > 0 && <label className="fy-production-setup__model">Writing model
              <select value={modelId} onChange={event => setModelId(event.target.value)} disabled={running}>
                <option value="">Configured writing model</option>
                {models.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
              </select></label>}
            <Composer value={message} onChange={setMessage} placeholder="Tell Arke what you have in mind…"
              onSubmit={() => command({ operation: "send", text: message, ...(modelId ? { modelId } : {}) })}
              agentLabel="Arke" busy={running} autoFocus
              disabledReason={locked ? "Creation is being resolved." : !draft ? "Opening production setup…" : unavailable}
              onDictate={text => setMessage(value => value ? `${value} ${text}` : text)} />
            <p className="fy-mono">Uses your configured writing model. No media generation starts here.</p>
          </div>
        </section>
        <aside id="setup-outline" className="fy-production-setup__outline" aria-label="Production so far">
          <h2>Production so far</h2>
          {!draft || !setup ? <p>Opening your draft…</p> : <>
            <p className="fy-mono">Draft · revision {draft.revision}</p>
            <fieldset disabled={!!pending || running || locked} className="fy-production-setup__fields">
              <label>Working title<input key={`title-${draft.revision}`} defaultValue={draft.title} maxLength={160}
                placeholder="A working title is enough" onBlur={event => { if (event.target.value !== draft.title) update({ title: event.target.value }); }} /></label>
              <label>Format<select value={draft.kind} onChange={event => {
                const kind = event.target.value as ProductionSetupDraft["kind"];
                update({ kind, aspect: kind === "microdrama" ? "9:16" : "16:9" });
              }}>
                <option value="microdrama">Micro drama</option><option value="film">Film · short</option>
                <option value="music-video">Music video</option><option value="other">Other</option>
              </select></label>
              <div className="fy-production-setup__delivery">
                <label>Aspect<input key={`aspect-${draft.revision}`} defaultValue={draft.aspect} maxLength={40}
                  onBlur={event => { if (event.target.value !== draft.aspect) update({ aspect: event.target.value }); }} /></label>
                <label>Frame rate<select value={draft.frameRate} onChange={event => update({ frameRate: Number(event.target.value) as 24 | 25 | 30 })}>
                  {[24, 25, 30].map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
                </select></label>
              </div>
              {draft.kind === "microdrama" && <div className="fy-production-setup__delivery">
                <label>Episode min · seconds<input type="number" min={1} key={`min-${draft.revision}`} defaultValue={draft.defaults?.episodeSecondsMin ?? ""}
                  onBlur={event => { if (event.target.value) update({ defaults: { episodeSecondsMin: Number(event.target.value) } }); }} /></label>
                <label>Episode max · seconds<input type="number" min={1} key={`max-${draft.revision}`} defaultValue={draft.defaults?.episodeSecondsMax ?? ""}
                  onBlur={event => { if (event.target.value) update({ defaults: { episodeSecondsMax: Number(event.target.value) } }); }} /></label>
              </div>}
            </fieldset>
            {draft.logline && <p>{draft.logline}</p>}
            <ProductionSetupOutline draft={draft} sheetName={id => world?.sheets.find(sheet => sheet.id === id)?.name ?? id} />
            {problems.length > 0 && <div className="fy-production-setup__problems" role="status"><h3>Still to resolve</h3><ul>{problems.map((problem, i) => <li key={i}>{problem}</li>)}</ul>
              {draft.kind !== "microdrama" && (draft.episodes.length > 0 || draft.arcs.length > 0 || draft.series) && <Button disabled={!!pending || locked || running}
                onClick={() => command({ operation: "update", update: { expectedRevision: draft.revision,
                  removeEpisodes: draft.episodes.map(episode => episode.key), fields: { arcs: [], series: null, defaults: null } } })}>
                Keep scenes without episodes
              </Button>}
            </div>}
            {setup.review && <SetupReview setup={setup} />}
            {setup.problem && <p role="status">{setup.problem}</p>}
            {locked ? <p role="status">Resolving creation… This draft is saved. Reopen the world if recovery is needed.</p> :
              <div className="fy-production-setup__actions">
                <Button disabled={!!pending || running || problems.length > 0} onClick={() => {
                  setTab("outline");
                  if (setup.review) command({ operation: "create", expectedRevision: draft.revision, reviewId: setup.review.id });
                  else command({ operation: "review", expectedRevision: draft.revision });
                }}>{setup.review ? "Create production" : "Review production"}</Button>
                <Button variant="ghost" disabled={!!pending || running} onClick={() => command({ operation: "discard" })}>Discard setup</Button>
              </div>}
          </>}
        </aside>
      </div>
    </div>
  );
}


function SetupReview({ setup }: { setup: ProductionSetupState }) {
  const plan = setup.review!.plan;
  const content = plan.initialContent!;
  const blocks = content.scenes.reduce((n, scene) => n + (scene.record.script?.blocks.length ?? 0), 0);
  const defaults = plan.initialSeason?.defaults;
  return <section className="fy-production-setup__review" aria-label="Review production">
    <h3>Ready to create · {plan.production.title}</h3>
    <p>{setup.draft.kind} · {plan.production.aspect} · {plan.production.frameRate} fps</p>
    <p>{content.episodes.length} episodes · {content.scenes.length} scenes · {blocks} script block{blocks === 1 ? "" : "s"}</p>
    {defaults && <p>Episodes: {defaults.episodeSecondsMin ?? "—"}–{defaults.episodeSecondsMax ?? "—"} seconds
      {defaults.hookWindowSec !== undefined && <> · hook within {defaults.hookWindowSec}s</>}
      {defaults.exportPreset && <> · {defaults.exportPreset}</>}</p>}
    {plan.series.operation !== "none" && <p>{plan.series.operation === "join" ? "Join" : "Create"} Series: {plan.series.record.title}
      {plan.series.record.engine && <> · {plan.series.record.engine}</>}</p>}
    <p>Includes the outline and developed text shown above. {setup.draft.openQuestions.length} open question{setup.draft.openQuestions.length === 1 ? " stays" : "s stay"} in the conversation.</p>
    <p>No images, video, voice or renders will be generated.</p>
  </section>;
}
