import { useEffect, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import type { ClientState, StudioAssistantThread, StudioCloudShare } from "@arke-studio/contracts";
import { STUDIO_ASSISTANT_LIMITS } from "@arke-studio/contracts";
import { StudioConversationClient, type StudioConversationView } from "../lib/studio-assistant.js";
import { onStudioAssistantReply, send, useStore } from "../lib/store.js";
import { useMediaQuery } from "../lib/media-query.js";
import { useKeyboardInset } from "../lib/keyboard-inset.js";
import { isRemoteSession } from "../lib/remote-session.js";
import { closeSystemPanel } from "../lib/system-panel.js";
import { chatSurfaceForPage } from "../lib/global-chat.js";
import { StudioAssistantContext } from "./studio-assistant-context.js";
import { useGlobalChat } from "./global-chat-context.js";
import { PageSheet } from "./page-sheet.js";
import { Composer } from "./composer.js";
import { StudioDictation } from "./studio-dictation.js";
import type { DictationPhase } from "./dictation.js";
import { ModelChip } from "./model-chip.js";
import { ConversationReply } from "./conversation-reply.js";
import { Cpu, Folder, Help, ListBullet, X } from "./icons.js";
type StudioAssistantMessage = StudioAssistantThread["messages"][number];

const threadTitle = (messages: readonly StudioAssistantMessage[]) => messages.find(message => message.role === "user")?.text.slice(0, 80) || "New conversation";

/** Existing native controls, with an independently owned app conversation (turn 239 rev 2).
 * No world transcript, tool permission or automatic model fallback is adopted here. */
export function StudioAssistantProvider({ children }: { children: ReactNode }) {
  const { state, connection } = useStore(), contextual = useGlobalChat();
  const [client] = useState(() => new StudioConversationClient({ send, id: () => crypto.randomUUID() }));
  const view = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const contextualView = useSyncExternalStore(contextual?.subscribe ?? (() => () => {}), contextual?.getSnapshot ?? (() => null), () => null);
  const compact = useMediaQuery("(max-width: 1023px)"), keyboard = useKeyboardInset();
  const configured = state?.app.agents.find(agent => agent.name === "studio-assistant")?.model;
  const model = view.model ?? configured;
  // Subscriptions mount before restoring observation. StrictMode may reattach them without
  // constructing a second authoritative conversation or resending an accepted mutation.
  useEffect(() => { const detach = onStudioAssistantReply(frame => client.receive(frame)); return () => { detach(); client.setConnected(false); }; }, [client]);
  useEffect(() => { client.setConnected(connection === "open" && !isRemoteSession()); }, [client, connection]);
  useEffect(() => { if (contextualView?.open) client.close(); }, [client, contextualView?.open]);
  useEffect(() => { if (view.open) closeSystemPanel(); }, [view.open]);
  return <StudioAssistantContext.Provider value={client}>
    {children}
    <PageSheet open={view.open} onClose={client.close} title="Arke — Studio assistant" headless modeless={!compact} preserveReturnFocus className="fy-studio-assistant"
      style={{ "--studio-keyboard": `${keyboard}px` } as CSSProperties}>
      <div className="fy-studio-dialog"
        onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); client.close(); } }}>
        <StudioAssistantView view={view} client={client} appState={state} model={model} modelSet={view.model !== undefined} pickModel={client.pickModel} />
      </div>
    </PageSheet>
  </StudioAssistantContext.Provider>;
}

export function StudioAssistantView({ view, client, appState, model, modelSet = false, pickModel }: {
  view: StudioConversationView; client: StudioConversationClient; appState: ClientState | null;
  model?: string; modelSet?: boolean; pickModel(value: string | undefined): void;
}) {
  const [history, setHistory] = useState(false), [focus, requestFocus] = useState(0);
  const [dictationPhase, setDictationPhase] = useState<DictationPhase>("idle");
  const thread = view.state?.threads.find(thread => thread.id === view.selected), pending = thread?.pending;
  const share = view.state?.share && view.state.share.threadId === thread?.id ? view.state.share : null;
  const working = pending && pending.state !== "interrupted";
  const unavailable = !view.connected ? "Reconnect to use Studio. Your draft is retained."
    : !view.fresh ? "Waiting for Studio history. Your draft is retained."
    : view.state?.audit !== "available" ? "Studio history is unavailable. Your draft is retained."
    : thread?.archived ? "This conversation is archived. Restore it to continue."
    : pending?.state === "interrupted" ? "Review the interrupted request before continuing."
    : view.draft.length > STUDIO_ASSISTANT_LIMITS.requestChars ? `Studio accepts up to ${STUDIO_ASSISTANT_LIMITS.requestChars.toLocaleString()} characters per request.`
    : !model ? "Choose a model for the Studio assistant." : undefined;
  const draft = (text: string) => { client.draft(text); requestFocus(value => value + 1); };
  return <>
    <header className="fy-studio-head"><div><h2 tabIndex={-1}>Arke</h2><span>Studio assistant</span></div>
      <button type="button" className="fy-studio-icon" aria-label="Studio conversations" aria-expanded={history} onClick={() => setHistory(value => !value)}><ListBullet size={16} /></button>
      <button type="button" className="fy-studio-icon" aria-label="Close Studio assistant" onClick={client.close}><X size={16} /></button>
    </header>
    <div className="fy-studio-scope"><b>Studio</b><span>Setup, local AI &amp; help</span></div>
    {history ? <nav className="fy-studio-history" aria-label="Studio conversations">
      <button type="button" className="fy-studio-button" onClick={() => { client.select(null); setHistory(false); }}>New conversation</button>
      {view.state?.threads.map(row => <div key={row.id}>
        <button type="button" className="fy-studio-history-choice" aria-current={row.id === thread?.id ? "true" : undefined} disabled={row.archived}
          onClick={() => { client.select(row.id); setHistory(false); }}>{threadTitle(row.messages)}{row.archived ? " · archived" : ""}</button>
        <button type="button" className="fy-studio-button" disabled={!view.fresh || !!row.pending || view.submitting}
          onClick={() => void client.request({ action: "archive", threadId: row.id, archived: !row.archived })}>{row.archived ? "Restore" : "Archive"}</button>
      </div>)}
      {!view.state?.threads.length && <p>No Studio conversations yet.</p>}
    </nav> : <div className="fy-studio-messages" role="log" aria-label="Studio conversation" aria-live="polite" aria-relevant="additions text">
      {!thread?.messages.length && <div className="fy-studio-welcome"><div className="fy-studio-mark" aria-hidden="true">a</div><h3>How can I help?</h3>
        <p>Ask about Arke, your setup or what needs attention.</p>
        <div className="fy-studio-prompts">
          <button type="button" className="fy-studio-prompt" onClick={() => draft("Check local AI")}><Cpu size={14} />Check local AI</button>
          <button type="button" className="fy-studio-prompt" onClick={() => draft("Review storage")}><Folder size={14} />Review storage</button>
          <button type="button" className="fy-studio-prompt" onClick={() => draft("Help with Arke")}><Help size={14} />Help with Arke</button>
        </div></div>}
      {thread?.messages.map(message => <StudioMessage key={message.id} message={message} appState={appState} close={client.close} />)}
      {view.state?.ephemeralReply && view.selected === view.state.threads.find(row => row.pending)?.id && <div className="fy-studio-unsaved" role="status">
        <p>This reply could not be saved. Copy it before leaving this session.</p><StudioMessage message={view.state.ephemeralReply} appState={appState} close={client.close} />
      </div>}
      {share && <CloudApproval key={`${share.id}:${share.digest}`} share={share} approve={() => void client.request({ action: "approve-cloud", threadId: share.threadId, runId: share.runId, shareId: share.id, digest: share.digest })} />}
      {pending?.state === "interrupted" && <div className="fy-studio-fact-card" role="status"><b>Request interrupted</b>
        <p>Arke cannot confirm that this request finished. It will not be sent again automatically.</p>
        <p className="fy-studio-note">Model: {pending.model}</p><button type="button" className="fy-studio-button" disabled={!view.fresh || view.state?.busy}
          onClick={() => void client.request({ action: "acknowledge", threadId: thread!.id, runId: pending.id })}>Acknowledge interruption</button></div>}
      {working && <div className="fy-studio-working" role="status"><span>{share ? "Waiting for your approval" : pending.phase === "diagnostic" ? "Checking operational evidence…" : "Arke is working…"}</span>
        <button type="button" className="fy-studio-button" disabled={!view.fresh} onClick={() => void client.request({ action: "cancel", threadId: thread!.id, runId: pending.id })}>Stop request</button></div>}
    </div>}
    {view.trouble && <p className="fy-studio-trouble" role="status">{view.trouble}</p>}
    <footer className="fy-studio-compose"><Composer value={view.draft} onChange={client.draft} onSubmit={() => { if (model && dictationPhase === "idle") void client.send(model); }}
      placeholder="Ask Arke…" agentLabel="Arke" focusRequest={focus} busy={view.submitting || !!working || !!view.state?.busy || dictationPhase !== "idle"} disabledReason={unavailable}
      busyLabel={dictationPhase === "requesting" ? "Microphone permission…" : dictationPhase === "listening" ? "Dictating…" : dictationPhase === "transcribing" ? "Transcribing…" : "Working…"}
      dictationControl={<StudioDictation client={client} onPhase={setDictationPhase} enabled={view.open && view.connected && view.fresh && !view.submitting && !working && !view.state?.busy && !thread?.archived && pending?.state !== "interrupted"} />}
      modelControl={<ModelChip state={appState} value={model} set={modelSet} onPick={pickModel} unsetLabel="Use Studio’s configured model" disabled={view.submitting || !!view.state?.busy} />} />
      {view.draft.length > STUDIO_ASSISTANT_LIMITS.requestChars && <p className="fy-studio-note" role="status">Studio accepts up to {STUDIO_ASSISTANT_LIMITS.requestChars.toLocaleString()} characters per request.</p>}
    </footer>
  </>;
}

function StudioMessage({ message, appState, close }: { message: StudioAssistantMessage; appState: ClientState | null; close(): void }) {
  return <article className={message.role === "user" ? "fy-studio-user" : "fy-studio-answer"} aria-label={message.role === "user" ? "You" : "Arke"}>
    {message.role === "arke" && <div className="fy-studio-answer-label">Arke</div>}
    <ConversationReply text={message.text} />
    {message.diagnostic && <div className="fy-studio-fact-card"><b>Operational findings</b><ConversationReply text={message.diagnostic.answer.explanation} />
      <p className="fy-studio-note">Observed {new Date(message.diagnostic.evidence.at).toLocaleString()}. Findings describe that observation.</p>
      {message.diagnostic.answer.hypotheses.length > 0 && <><b>Possible causes</b><ul>{message.diagnostic.answer.hypotheses.map((hypothesis, index) => <li key={index}>{hypothesis}</li>)}</ul></>}
    </div>}
    {message.handoff && <StudioHandoff handoff={message.handoff} appState={appState} close={close} />}
  </article>;
}

function StudioHandoff({ handoff, appState, close }: { handoff: NonNullable<StudioAssistantMessage["handoff"]>; appState: ClientState | null; close(): void }) {
  const owner = useGlobalChat(), world = appState?.world;
  const [draft, setDraft] = useState(handoff.draft), [selection, setSelection] = useState<{ worldId: string; productionId: string } | null>(null);
  const [replacement, setReplacement] = useState<{ key: string; draft: string } | null>(null), [trouble, setTrouble] = useState<string | null>(null);
  const productionId = selection?.worldId === world?.meta.worldId ? selection?.productionId ?? "" : "";
  const production = world?.productions.find(row => row.meta.id === productionId);
  const path = world ? `/w/${encodeURIComponent(world.meta.worldId)}` + (handoff.destination === "world" ? "/chat" : production ? `/p/${encodeURIComponent(production.meta.id)}` : "") : null;
  const target = path && (handoff.destination === "world" || production) ? chatSurfaceForPage(appState, path) : null;
  const replace = replacement?.key === target?.key ? replacement : null;
  const title = handoff.destination === "world" ? "World Chat" : "Builder Chat";
  return <div className="fy-studio-fact-card"><b>Continue in {title}</b>
    <p className="fy-studio-note">Only this editable request draft moves. Review and send it in the destination conversation.</p>
    {world ? <p className="fy-studio-note">World: {world.meta.name}</p> : <p className="fy-studio-note">Open a world, then choose its conversation here.</p>}
    {world && handoff.destination === "builder" && <label className="fy-studio-target">Production<select aria-label="Handoff production" value={productionId} onChange={event => { setSelection({ worldId: world.meta.worldId, productionId: event.target.value }); setReplacement(null); setTrouble(null); }}>
      <option value="">Choose a production</option>{world.productions.map(row => <option key={row.meta.id} value={row.meta.id}>{row.meta.title}</option>)}</select></label>}
    <textarea className="fy-studio-handoff-draft" aria-label="Request draft for destination" value={draft} maxLength={STUDIO_ASSISTANT_LIMITS.requestChars} onChange={event => { setDraft(event.target.value); setReplacement(null); }} />
    {trouble && <p className="fy-studio-note" role="status">{trouble}</p>}
    {replace && <><p className="fy-studio-note">This destination already has an unsent draft. Replace it with the request above?</p><details><summary>Existing draft</summary><pre>{replace.draft}</pre></details></>}
    <button type="button" className="fy-studio-button" disabled={!target || !owner || !draft.trim()} onClick={() => {
      if (!target || !owner) return;
      const outcome = owner.stageDraft(target, draft, replace?.draft);
      if (outcome === "replace-required") { setReplacement({ key: target.key, draft: owner.value(target.key, "draft", "") }); return; }
      if (outcome === "busy") { setTrouble("Finish the destination’s current capture or request before moving this draft."); return; }
      close();
    }}>{replace ? "Replace draft and open " : "Open "}{title}{production ? ` · ${production.meta.title}` : world ? ` · ${world.meta.name}` : ""}</button>
    {replace && <button type="button" className="fy-studio-button" onClick={() => setReplacement(null)}>Keep existing draft</button>}
  </div>;
}

function CloudApproval({ share, approve }: { share: StudioCloudShare; approve(): void }) {
  const [confirmed, setConfirmed] = useState(false);
  // Every phase has its own one-use disclosure. A prior approval never selects the next one.
  useEffect(() => setConfirmed(false), [share.id]);
  return <section className="fy-studio-fact-card" aria-label="Review cloud request"><b>Review before sending</b>
    <p>This request will go to {share.provider} using {share.model}.</p>
    <p className="fy-studio-note">{share.role === "diagnostic-specialist" ? "Diagnostic evidence" : "Studio request"} · {share.phase}</p>
    <details><summary>Review request contents</summary><pre>{share.prompt}</pre>
      {share.system !== undefined && <><b>System instructions</b><pre>{share.system}</pre></>}
      {share.outputTokenLimit !== undefined && <p>Answer limit: {share.outputTokenLimit.toLocaleString()} tokens</p>}
      {share.customBrief !== undefined && <><b>Custom instructions</b><pre>{share.customBrief}</pre></>}
      {share.variant !== undefined && <p>Effort: {share.variant}</p>}
      <p className="fy-studio-note">Destination reference: {share.destination}</p></details>
    <label className="fy-studio-consent"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />Share this request with {share.provider}</label>
    <button type="button" className="fy-studio-button fy-studio-button--primary" disabled={!confirmed} onClick={() => { setConfirmed(false); approve(); }}>Approve this request</button>
  </section>;
}
