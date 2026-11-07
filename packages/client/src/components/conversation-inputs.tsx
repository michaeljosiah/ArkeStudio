import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { WorldChatInputRequestSchema, type WorldChatInputRequest, type WorldChatWorkspace } from "@arke-studio/contracts";
import { continueWorldChatInputs, removeWorldChatInput, sendWorldChatInput, subscribeWorldChatInputResults,
  useStore, worldChatInputStatus } from "../lib/store.js";
import { Button } from "./ui.js";

type Pending = { draft: string; input: WorldChatInputRequest };
function retained(key: string | null): Pending | null {
  try {
    const raw = key && sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw);
    return typeof value.draft === "string" ? { draft: value.draft, input: WorldChatInputRequestSchema.parse(value.input) } : null;
  } catch { return null; }
}

/** Each window retains its own unacknowledged submission across reloads. The snapshot owns the queue. */
export function useConversationInputs(worldId: string | undefined, workspace: WorldChatWorkspace | null,
  setDraft: Dispatch<SetStateAction<string>>, onAccepted?: (input: WorldChatInputRequest, draft: string) => void) {
  const accepted = useRef(onAccepted); accepted.current = onAccepted;
  const { connection, rejoins } = useStore();
  const id = workspace?.conversationId;
  const key = worldId && id ? `arke.pending-input:${worldId}:${id}` : null;
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef<Pending | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const checking = useRef(false);
  const control = useRef<string | null>(null);
  const [controlling, setControlling] = useState(false);
  const queue = workspace?.inputQueue;
  const rows = queue?.inputs.filter(row => !["included", "promoted", "removed"].includes(row.status)) ?? [];
  const queueing = !!workspace && !workspace.productionSetup && (workspace.runStatus === "running" || rows.length > 0 || pending !== null);
  const check = () => {
    if (worldId && id && pendingRef.current) {
      checking.current = true;
      worldChatInputStatus(worldId, id, pendingRef.current.input.submissionId);
    }
  };
  useEffect(() => {
    const saved = retained(key);
    pendingRef.current = saved; setPending(saved); setNotice(null);
    control.current = null; setControlling(false);
    if (saved) setDraft(current => current || saved.draft);
    return subscribeWorldChatInputResults(result => {
      if (result.worldId !== worldId || result.conversationId !== id) return;
      if (control.current === result.requestId) {
        control.current = null; setControlling(false);
        setNotice(result.admitted ? null : result.detail ?? "The queue changed. Look again before continuing.");
      }
      const sent = pendingRef.current;
      if (!sent || sent.input.submissionId !== result.requestId) return;
      if (result.admitted || checking.current && !result.uncertain) {
        if (result.admitted) { setDraft(current => current === sent.draft ? "" : current); accepted.current?.(sent.input, sent.draft); }
        try { if (key) sessionStorage.removeItem(key); } catch { /* The same identity is still safe to query on reload. */ }
        pendingRef.current = null; setPending(null); checking.current = false;
        setNotice(result.admitted ? null : result.detail ?? "Not queued. Your draft is retained.");
      } else {
        setNotice(result.detail ?? "The receipt is unclear. Check before trying again.");
        if (!checking.current) check();
        else checking.current = false;
      }
    });
  }, [key, worldId, id, setDraft]);
  useEffect(() => {
    control.current = null; setControlling(false);
    if (connection === "open") check();
  }, [key, connection, rejoins]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendNext = (input: Omit<WorldChatInputRequest, "submissionId" | "delivery" | "expectedRunId">, draft: string) => {
    if (!worldId || !id || !key || connection !== "open") { setNotice("Reconnect before sending. Your draft is retained."); return; }
    if (pendingRef.current) { check(); return; }
    const saved: Pending = { draft, input: { ...input, submissionId: crypto.randomUUID(), delivery: "next", expectedRunId: workspace?.runId ?? null } };
    const parsed = WorldChatInputRequestSchema.safeParse(saved.input);
    if (!parsed.success) { setNotice("Use at most 16,000 characters and 20 attachments. Your draft is retained."); return; }
    // Save identity before transmission, so reload/reconnect can ask about this exact send.
    try { sessionStorage.setItem(key, JSON.stringify(saved)); }
    catch { setNotice("The pending message could not be saved on this device. Your draft is retained."); return; }
    checking.current = false; pendingRef.current = saved; setPending(saved); setNotice(null);
    if (!sendWorldChatInput(worldId, id, saved.input)) setNotice("Reconnect to check this message. Your draft is retained.");
  };
  const runControl = (request: () => string | null) => {
    if (controlling) return;
    control.current = request(); setControlling(control.current !== null);
    setNotice(control.current ? null : "Reconnect before changing the queue.");
  };
  const paused = queue?.pauseReason != null;
  const panel = rows.length > 0 || pending || notice ? <section aria-label="Queued messages" style={{ marginBlock: 10 }}>
    {rows.length > 0 && <div className="fy-draftcard" style={{ padding: 12, maxHeight: 260, overflow: "auto" }}>
      <b>{paused ? "Next reply paused" : `Queued for next reply · ${rows.length}`}</b>
      {paused && <p>Your queued message is saved. Continue when you’re ready.</p>}
      {rows.map(row => <div key={row.input.messageId} style={{ marginBlock: 8 }}>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{row.input.request.text}</p>
        {row.input.request.attachmentIds.length > 0 && <small>{row.input.request.attachmentIds.length} attached</small>}
        {row.removable ? <Button variant="ghost" disabled={controlling || connection !== "open"}
          onClick={() => runControl(() => removeWorldChatInput(worldId!, id!, row.input.messageId, queue!.revision))}>Remove</Button> : <span>Delivery unclear</span>}
      </div>)}
      {paused && queue?.resumeRouting && rows.every(row => row.removable) && <>
        <p className="fy-mono">Continue with {queue.resumeRouting.adapter} · {queue.resumeRouting.modelId ?? "current default model"}</p>
        <Button disabled={controlling || connection !== "open" || workspace?.runStatus === "running"}
          onClick={() => runControl(() => continueWorldChatInputs(worldId!, id!, queue.revision, queue.resumeRouting!))}>Continue</Button>
      </>}
    </div>}
    {pending && <p role="status">Checking message receipt… <Button variant="ghost" disabled={connection !== "open"} onClick={check}>Check status</Button></p>}
    {notice && <p role="status">{notice}</p>}
  </section> : null;
  return { queueing, paused, pending: pending !== null, sendNext, panel };
}
