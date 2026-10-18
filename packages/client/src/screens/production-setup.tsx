import { GlobalWorldChatEntry } from "../components/global-chat.js";
import { useClientRender } from "../components/production-studio-context.js";
import { ConversationPanelContent, useConversationPresentation, useConversationState, useGlobalChat } from "../components/global-chat-context.js";
import { HeldBar } from "../components/held-bar.js";
import { ResponsiveSheet } from "../components/responsive-sheet.js";
import { SceneBackRow } from "./scene-workspace/responsive-chrome.js";
import { ChevronUp } from "../components/icons.js";
import { useMediaQuery } from "../lib/media-query.js";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import {
  ADAPTATION_KINDS, AUDIO_DRAMA_KIND, ConversationIdSchema, adaptableStories, productionSetupProblems, ulid,
  type ProductionSetupCommand, type ProductionSetupDraft, type ProductionSetupState,
} from "@arke-studio/contracts";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { listHarnessModels, openWorldChat, send, subscribeProductionSetupResults, useStore, useWorldChatProgress } from "../lib/store.js";
import { ConversationTranscript, languageChoiceReason } from "../components/conversation.js";
import { Composer } from "../components/composer.js";
import { useReadReplies } from "../components/read-replies.js";
import { ProductionSetupOutline } from "../components/production-setup-outline.js";
import { ProductionTargetCard } from "../components/production-target-card.js";
import { Button } from "../components/ui.js";
import { HarnessModelStatus, harnessModelsNeedAWord } from "../components/harness-models.js";
import { ModelChip } from "../components/model-chip.js";
import { ModelsCard, PRODUCTION_MODEL_CAPABILITIES, withModelChoice } from "../components/models-card.js";
import { AudioDramaPlanCard, NARRATOR_LABEL, pilotChapters } from "../components/audio-drama-plan-card.js";

type SetupSeed = NonNullable<Extract<ProductionSetupCommand["action"], { operation: "start" }>["seed"]>;

/** How the Format reads back, in the words the door used (design turn 230c). */
function formatLine(draft: ProductionSetupDraft): string {
  return draft.kind === AUDIO_DRAMA_KIND
    ? `story · audio drama · ${draft.audioDrama?.episodes ?? 0} episodes`
    : `${draft.kind} · ${draft.aspect} · ${draft.scenes.length} scenes`;
}

/** Same transcript and composer as production chat; the rail is the authoritative setup draft. */
export function ProductionSetupScreen() {
  const { worldId, setupId } = useParams(), global = useGlobalChat(), client = useClientRender();
  if (worldId && setupId && ConversationIdSchema.safeParse(setupId).success && global && client) return <GlobalWorldChatEntry worldId={worldId} conversationId={setupId} />;
  return <ProductionSetupView />;
}

export function ProductionSetupView({ embedded }: { embedded?: { worldId: string; setupId: string } }) {
  const phone = useMediaQuery("(max-width: 599px)");
  const [outlineOpen,setOutlineOpen] = useState(false);
  const route = useParams(), worldId = embedded?.worldId ?? route.worldId, routeId = embedded?.setupId ?? route.setupId;
  const presentation = useConversationPresentation();
  const world = useOpenWorldGuard(worldId);
  const idResult = ConversationIdSchema.safeParse(routeId);
  const setupId = idResult.success ? idResult.data : null;
  const { state, connection } = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  // What the door already answered — an audio drama and the story it adapts (SPEC-057 R-3). Read
  // only by a start: a setup that exists is never rewritten by the page that reopens it.
  const seed = (location.state as { seed?: SetupSeed } | null)?.seed;
  const onSetupPage = !embedded || location.pathname === `/w/${worldId}/productions/setup/${setupId}` || location.pathname === `/w/${worldId}/chat/${setupId}`;
  const workspace = state?.worldChat?.conversationId === setupId ? state.worldChat : null;
  const setup = workspace?.productionSetup;
  const readReplies = useReadReplies(workspace);
  const [message, setMessage] = useConversationState("draft", "");
  const [failure, setFailure] = useConversationState<string | null>("setupFailure", null);
  const [pendingRequest, setPendingRequest] = useConversationState<{ requestId: string; operation: string } | null>("setupPendingRequest", null);
  const pending = pendingRequest?.operation ?? null;
  const [tab, setTab] = useState<"conversation" | "outline">("conversation");
  const [modelId, setModelId] = useConversationState("languageModel", "");
  const pendingRef = useRef(pendingRequest); pendingRef.current = pendingRequest;
  useLayoutEffect(() => { presentation?.owner.holdOpening(presentation.key, pendingRequest !== null); }, [presentation?.owner, presentation?.key, pendingRequest]);
  const opened = useRef<string | null>(null);
  useEffect(() => { if (setupId) presentation?.owner.reportConversation(presentation.key, setupId); }, [presentation?.owner, presentation?.key, setupId]);
  useEffect(() => { if (presentation?.inPanel) setTab("outline"); }, [presentation?.inPanel]);
  const inheritedModel = state?.app.agents.find(agent => agent.name === "world-builder")?.model;
  const unavailable = languageChoiceReason(state, modelId || inheritedModel);
  const progress = useWorldChatProgress(setupId ?? undefined, workspace?.runStartedAt ?? null);
  const running = workspace?.runStatus === "running" || pending === "send" || pending === "retry";
  const locked = setup?.status === "creating" || setup?.status === "created";

  useEffect(() => {
    if (state?.app.health.harness.status === "healthy") listHarnessModels();
  }, [state?.app.health.harness.status, state?.app.harnessInfo?.generation]);

  function command(action: ProductionSetupCommand["action"]) {
    if (!worldId || !setupId) return;
    const requestId = ulid();
    pendingRef.current = { requestId, operation: action.operation };
    setPendingRequest(pendingRef.current);
    presentation?.owner.trackSetupRequest(presentation.key, requestId, action.operation, action.operation === "send" ? action.text : undefined);
    setFailure(null);
    if (!send({ kind: "production-setup", worldId, setupId, requestId, action })) {
      presentation?.owner.deliverSetupResult({ requestId, detail: "The studio is disconnected. Reconnect to continue this setup." });
      setPendingRequest(null);
      pendingRef.current = null;
      setFailure("The studio is disconnected. Reconnect to continue this setup.");
    }
  }
  useEffect(() => subscribeProductionSetupResults(result => {
    if (result.worldId !== worldId || result.setupId !== setupId) return;
    if (presentation) presentation.owner.deliverSetupResult(result);
    else if (result.requestId === pendingRef.current?.requestId) {
      if (!result.detail && pendingRef.current.operation === "send") setMessage("");
      pendingRef.current = null;
      setPendingRequest(null);
    }
    setFailure(result.detail ?? null);
    if (onSetupPage && result.state?.status === "discarded") navigate(`/w/${worldId}/productions`);
    if (onSetupPage && result.state?.status === "created" && result.state.productionId) navigate(`/w/${worldId}/p/${result.state.productionId}`, { replace: true });
  }), [worldId, setupId, navigate, onSetupPage, presentation?.owner]);
  useEffect(() => {
    if (!world || !worldId || !setupId || connection !== "open") return;
    const key = `${worldId}/${setupId}`;
    if (opened.current === key) return;
    opened.current = key;
    const exists = world.conversations.some(conversation => conversation.id === setupId);
    command(exists ? { operation: "resume" } : { operation: "start", ...(seed ? { seed } : {}) });
  }, [world, worldId, setupId, connection]);
  useEffect(() => {
    if (connection !== "open") {
      opened.current = null;
      pendingRef.current = null;
      setPendingRequest(null); presentation?.owner.holdOpening(presentation.key, false);
    }
  }, [connection]);
  useEffect(() => {
    if (onSetupPage && setup?.status === "created" && setup.productionId) navigate(`/w/${worldId}/p/${setup.productionId}`, { replace: true });
  }, [setup?.status, setup?.productionId, worldId, navigate, onSetupPage]);
  useEffect(() => () => { if (worldId) openWorldChat(worldId, null); }, [worldId, setupId]);
  /*
   * Plan with Arke is the request (SPEC-057 R-3): a setup the door seeded with a story opens with
   * that story asked for, rather than an empty conversation waiting to be told what it already
   * knows. Once per page, and only into a draft no turn has touched.
   *
   * Read from the saved draft, not the door's router state (codex on PR 1866): a start recorded
   * just before the app closed reopens from In development with no state, and is still owed its
   * ask. Only a seed makes a first revision an audio drama with a source, so the draft says it.
   */
  const seededAsk = useRef<string | null>(null);
  const untouched = setup?.status === "draft" && setup.draft.revision === 1 && setup.draft.kind === AUDIO_DRAMA_KIND ? setup.draft.source : undefined;
  const seededStory = untouched ? adaptableStories(world?.productions ?? []).find(story => story.id === untouched.productionId) : undefined;
  useEffect(() => {
    if (!seededStory || !setupId || seededAsk.current === setupId || pending || running || unavailable) return;
    if (!setup || setup.status !== "draft" || setup.draft.revision !== 1 || (workspace?.messages.length ?? 0) > 0) return;
    seededAsk.current = setupId;
    command({ operation: "send", text: `An audio drama of ${seededStory.title}.`, ...(modelId ? { modelId } : {}) });
  }, [seededStory?.id, setupId, setup?.status, setup?.draft.revision, workspace?.messages.length, pending, running, unavailable]);
  if (!setupId) return <p role="alert">This production setup address is invalid.</p>;
  const draft = setup?.draft;
  const audioDrama = draft?.kind === AUDIO_DRAMA_KIND;
  const problems = draft ? productionSetupProblems(draft, world?.sheets ?? [], world?.productions ?? []) : [];
  const stories = adaptableStories(world?.productions ?? []);
  const update = (fields: NonNullable<Extract<ProductionSetupCommand["action"], { operation: "update" }>["update"]["fields"]>) => {
    if (draft) command({ operation: "update", update: { expectedRevision: draft.revision, fields } });
  };
  return (
    <div className="fy-production-setup" data-screen="production-setup">
      {phone && <SceneBackRow context={`${world?.meta.name ?? "World"} · New production`} title={`${draft?.title || "New production"} · setup`} onBack={() => navigate(`/w/${worldId}/productions`)}><Button onClick={() => navigate(`/w/${worldId}/productions`)}>Save for later</Button></SceneBackRow>}
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
        <section id="setup-conversation" className="fy-production-setup__conversation" aria-label="Conversation with Arke"><ConversationPanelContent>
          <div className="fy-production-setup__log">
            <ConversationTranscript workspace={workspace} autoRead={readReplies.autoRead} running={running} progress={progress}
              failure={workspace?.lastFailure ?? null} canRetry={!locked && !running}
              onStop={() => command({ operation: "cancel" })}
              onRetry={turnId => command({ operation: "retry", turnId })}
              empty={<div className="fy-production-setup__welcome"><h2>Start with a possibility.</h2>
                <p>A scene you can see. A character with something to lose. A season you have already mapped out.</p>
                <p>We’ll shape it here, with {world?.meta.name ?? "your world"} around us.</p></div>} />
          </div>
          <HeldBar className="fy-production-setup__composer">
            {phone && <button type="button" className="fy-thread-peek" aria-haspopup="dialog" onClick={() => setOutlineOpen(true)}><span><b>Production so far · {draft ? [draft.title,draft.kind,draft.aspect,draft.logline,...draft.scenes.map(scene=>scene.title)].filter(Boolean).length : 0} settled</b><span>{draft ? formatLine(draft) : "Opening your draft…"}</span></span><ChevronUp size={18}/></button>}
            {harnessModelsNeedAWord(state) && <HarnessModelStatus state={state} />}
            <Composer value={message} onChange={setMessage} placeholder="Tell Arke what you have in mind…"
              // A setup is not yet a production, so there is nowhere to remember a model: the chip
              // picks for this conversation, and letting go of it is the configured writing model.
              modelControl={<ModelChip state={state} value={modelId || inheritedModel} set={modelId !== ""}
                onPick={id => setModelId(id ?? "")} unsetLabel="Use the default" disabled={running} />}
              onSubmit={() => command({ operation: "send", text: message, ...(modelId ? { modelId } : {}) })}
              agentLabel="Arke" busy={running} autoFocus={!phone}
              disabledReason={locked ? "Creation is being resolved." : !draft ? "Opening production setup…" : unavailable}
              onDictate={text => setMessage(value => value ? `${value} ${text}` : text)} readReplies={readReplies.composer} />
            <p className="fy-mono">Uses your configured writing model. No media generation starts here.</p>
          </HeldBar>
        </ConversationPanelContent></section>
        <ResponsiveSheet sheet={phone} open={outlineOpen} onClose={() => setOutlineOpen(false)} title="Production so far" className="fy-setup-outline-sheet">
        <aside id="setup-outline" className="fy-production-setup__outline" aria-label="Production so far">
          <h2>Production so far</h2>
          {!draft || !setup ? <p>Opening your draft…</p> : <>
            <p className="fy-mono">Draft · revision {draft.revision}</p>
            <fieldset disabled={!!pending || running || locked} className="fy-production-setup__fields">
              <label>Working title<input key={`title-${draft.revision}`} defaultValue={draft.title} maxLength={160}
                placeholder="A working title is enough" onBlur={event => { if (event.target.value !== draft.title) update({ title: event.target.value }); }} /></label>
              <label>Format<select value={draft.kind} onChange={event => {
                const kind = event.target.value as ProductionSetupDraft["kind"];
                // An audio drama has no frame; leaving one drops its plan, which no screen reads.
                update(kind === AUDIO_DRAMA_KIND ? { kind } : { kind, aspect: kind === "microdrama" ? "9:16" : "16:9", ...(audioDrama ? { audioDrama: null } : {}) });
              }}>
                <option value="microdrama">Micro drama</option><option value="film">Film · short</option>
                <option value="music-video">Music video</option><option value={AUDIO_DRAMA_KIND}>Story · audio drama</option>
                <option value="other">Other</option>
              </select></label>
              {/* A story for the ear is delivered in no frame and at no rate (SPEC-057 R-82). */}
              {!audioDrama && <div className="fy-production-setup__delivery">
                <label>Aspect<input key={`aspect-${draft.revision}`} defaultValue={draft.aspect} maxLength={40}
                  onBlur={event => { if (event.target.value !== draft.aspect) update({ aspect: event.target.value }); }} /></label>
                <label>Frame rate<select value={draft.frameRate} onChange={event => update({ frameRate: Number(event.target.value) as 24 | 25 | 30 })}>
                  {[24, 25, 30].map(rate => <option key={rate} value={rate}>{rate} fps</option>)}
                </select></label>
              </div>}
              {/* Adapt from (design turn 205, SPEC-052 R-1): a story of this world the production is
                  made from. Offered for a micro drama or a film while the world has a story with
                  chapters, and kept in view while a source is set, so it can always be cleared. */}
              {((ADAPTATION_KINDS.includes(draft.kind) && stories.length > 0) || draft.source) && <label>Adapt from<select value={draft.source?.productionId ?? ""}
                onChange={event => update({ source: event.target.value ? { productionId: event.target.value } : null })}>
                <option value="">Nothing — start from an idea</option>
                {stories.map(story => <option key={story.id} value={story.id}>{story.title} · {story.kind} · {story.chapters} chapter{story.chapters === 1 ? "" : "s"} · {story.words.toLocaleString("en-GB")} words</option>)}
                {draft.source && !stories.some(story => story.id === draft.source!.productionId) && <option value={draft.source.productionId}>{draft.source.productionId} · no longer here</option>}
              </select></label>}
            </fieldset>
            {/* Where it will be watched, and the numbers that follow (design turn 205, SPEC-052 R-6). */}
            {draft.kind === "microdrama" && <ProductionTargetCard draft={draft} update={update} disabled={!!pending || running || locked} />}
            {audioDrama && draft.audioDrama && <AudioDramaPlanCard plan={draft.audioDrama} disabled={!!pending || running || locked}
              onChange={plan => update({ audioDrama: plan })} />}
            {/* The production's own models (design turn 153), written with the production. Each
                row follows Settings until chosen here — Settings, not the world: the world's
                choice was for making the world. */}
            <ModelsCard
              state={state}
              capabilities={PRODUCTION_MODEL_CAPABILITIES}
              choices={draft.models}
              scopeWord="this production"
              disabled={!!pending || running || locked}
              onChange={(capability, modelId) => update({ models: withModelChoice(draft.models, capability, modelId) ?? {} })}
            />
            {draft.logline && <p>{draft.logline}</p>}
            <ProductionSetupOutline draft={draft} sheetName={id => world?.sheets.find(sheet => sheet.id === id)?.name ?? id} />
            {problems.length > 0 && <div className="fy-production-setup__problems" role="status"><h3>Still to resolve</h3><ul>{problems.map((problem, i) => <li key={i}>{problem}</li>)}</ul>
              {/* An audio drama keeps its plan and nothing of a screen's outline (SPEC-057 R-7). */}
              {audioDrama && (draft.scenes.length > 0 || draft.episodes.length > 0 || draft.arcs.length > 0 || draft.series) && <Button disabled={!!pending || locked || running}
                onClick={() => command({ operation: "update", update: { expectedRevision: draft.revision,
                  removeEpisodes: draft.episodes.map(episode => episode.key), removeScenes: draft.scenes.map(scene => scene.key),
                  fields: { arcs: [], series: null, defaults: null } } })}>
                Keep the plan only
              </Button>}
              {draft.kind !== "microdrama" && !audioDrama && (draft.episodes.length > 0 || draft.arcs.length > 0 || draft.series) && <Button disabled={!!pending || locked || running}
                onClick={() => command({ operation: "update", update: { expectedRevision: draft.revision,
                  removeEpisodes: draft.episodes.map(episode => episode.key), fields: { arcs: [], series: null, defaults: null } } })}>
                Keep scenes without episodes
              </Button>}
            </div>}
            {setup.review && (audioDrama ? <AudioDramaReview setup={setup} sourceTitle={stories.find(story => story.id === draft.source?.productionId)?.title} /> : <SetupReview setup={setup} />)}
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
        </ResponsiveSheet>
      </div>
    </div>
  );
}


/** What Create will write for an audio drama: its plan, and nothing of a book's or a screen's. */
function AudioDramaReview({ setup, sourceTitle }: { setup: ProductionSetupState; sourceTitle: string | undefined }) {
  const plan = setup.review!.plan;
  const drama = plan.initialContent?.audioDrama?.plan;
  return <section className="fy-production-setup__review" aria-label="Review production">
    <h3>Ready to create · {plan.production.title}</h3>
    <p>Story · audio drama{sourceTitle ? ` · adapts ${sourceTitle}` : ""}</p>
    {drama && <p>{drama.episodes} episodes · about {drama.minutes} minutes each · {drama.narrator ? NARRATOR_LABEL[drama.narrator].toLowerCase() : "narrator not decided"}</p>}
    {drama?.pilot && <p>Pilot: {[drama.pilot.title, pilotChapters(drama.pilot.chapters)].filter(Boolean).join(" · ")}</p>}
    {drama && drama.keptFromListener.length > 0 && <p>{drama.keptFromListener.length} kept from the listener</p>}
    <p>No voices, sounds or music will be generated.</p>
  </section>;
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
