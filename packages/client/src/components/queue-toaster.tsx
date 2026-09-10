import { memo, useEffect, useMemo, useRef, type CSSProperties } from "react";
import { useNavigate } from "react-router";
import { toast, Toaster } from "sonner";
import type { Job, ModelManifest } from "@arke-studio/contracts";
import {
  acknowledgeUpdate,
  subscribeJobReady,
  isOwnSceneCreate,
  subscribeQueueResults,
  subscribeCommandFailures,
  subscribeSceneCreateResults,
  subscribeSceneRefusals,
  useStore,
  useUpdateStatus,
  type QueueEnqueueResult,
  isOwnChapterCreate,
  subscribeChapterCreateResults,
} from "../lib/store.js";
import { mediaUrl } from "../lib/media.js";
import { enqueueNote, failedNote, queueNoteId, readyNote, type QueueNote } from "./queue-note.js";
import { openActivityPanel } from "../lib/activity-panel.js";
import { Button, cx } from "./ui.js";

/**
 * The notification that follows a dispatch (design turn 79). It is the Activity row for that
 * work, arriving early — so the bands, the dot and the copy are 26a's.
 */

/**
 * Take back the notification raised for one request (issue 507). This one rides above every
 * screen, so a refusal left standing after its cause is repaired is read over screens that could
 * not have caused it. The surface that made the request is the only thing that knows the cause
 * has gone, which is why the withdrawal is offered rather than inferred here.
 */
export function dismissQueueNote(requestId: string): void {
  toast.dismiss(queueNoteId(requestId));
}

/**
 * The picture that came back stands where the dot would be (79g). Only the open world's slug is
 * known, so a job from another world keeps the dot rather than pointing at a path that would 404.
 */
function useThumb(note: QueueNote): string | null {
  const world = useStore().state?.world?.meta;
  if (!note.thumb || !world || world.worldId !== note.thumb.worldId) return null;
  return mediaUrl(world.slug, note.thumb.path);
}

export function Note({ note, onAct, onDismiss }: { note: QueueNote; onAct: () => void; onDismiss: () => void }) {
  const thumb = useThumb(note);
  return (
    <div className={cx("fy-note", `fy-note--${note.tone}`)} role="status">
      {thumb ? (
        <img className="fy-note__thumb" src={thumb} alt="" />
      ) : (
        <span className={cx("fy-note__dot", note.live && "fy-note__dot--live")} aria-hidden />
      )}
      <div className="fy-note__body">
        <div className="fy-note__title">{note.title}</div>
        {note.meta && <div className="fy-note__meta">{note.meta}</div>}
        {note.reason && <div className="fy-note__reason">{note.reason}</div>}
      </div>
      <div className="fy-note__end">
        {note.action && (
          <Button variant="outline" size="sm" onClick={onAct}>
            {note.action.label}
          </Button>
        )}
        <button type="button" className="fy-note__close" aria-label="Dismiss" onClick={onDismiss}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * One job, one notification, updated in place (79's fourth binding). A notification that covers
 * exactly one job becomes that job's row: `queued` turns into `running` and then into what came
 * back, in the same box. `job.ready` only fires on success, so this reads `state.app.jobs` — which
 * every transition already folds into — rather than waiting for an event that never arrives for a
 * failure. A batch notification is about the batch, not a job, so it is left as it was raised.
 */
export function noteNow(
  result: QueueEnqueueResult,
  jobs: readonly Job[],
  manifest: ModelManifest | null,
): QueueNote | null {
  const seed = enqueueNote(result, jobs, manifest);
  if (!seed || result.acceptedJobIds.length !== 1) return seed;
  const job = jobs.find((candidate) => candidate.id === result.acceptedJobIds[0]);
  if (!job) return seed;
  if (job.status === "succeeded") return readyNote(job, manifest, seed.id);
  if (job.status === "failed" || job.status === "needs-reconciliation") {
    return failedNote(job, manifest, seed.id);
  }
  return seed;
}

/**
 * Re-rendering on every store frame rewrote the notification's DOM while nothing about it had
 * changed, and each rewrite restarted sonner's entrance transition — measured on a real dispatch
 * as a notification that never finished arriving for as long as its job kept polling (opacity
 * creeping 0.46 → 0.63 over six seconds). The derived copy is the identity: same words, same
 * element, transition left alone.
 */
const StableNote = memo(Note);

/** Receipts expire even if Sonner's hover/drag state stays paused (issue 1001). */
function ToastNote({ note, onAct, onDismiss, receipt = note }: Parameters<typeof Note>[0] & { receipt?: QueueNote }) {
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    // A new outcome gets its own reading time. Store frames and navigation do not renew it.
    const timer = setTimeout(() => dismiss.current(), note.tone === "refused" ? 12000 : 6000);
    return () => clearTimeout(timer);
  }, [receipt, note.tone]);
  return <StableNote note={note} onAct={onAct} onDismiss={onDismiss} />;
}

/** Re-derives from the store, so the row follows the job it is about. */
function LiveNote({
  result,
  seed,
  onAct,
  onDismiss,
}: {
  result: QueueEnqueueResult;
  seed: QueueNote;
  onAct: (note: QueueNote) => void;
  onDismiss: () => void;
}) {
  const { state } = useStore();
  const derived = noteNow(result, state?.app.jobs ?? [], state?.app.manifest ?? null) ?? seed;
  const key = JSON.stringify([derived.tone, derived.title, derived.meta, derived.reason, derived.live, derived.action?.label]);
  const note = useMemo(() => derived, [key]);
  return <ToastNote note={note} receipt={seed} onAct={() => onAct(note)} onDismiss={onDismiss} />;
}

export function QueueToaster() {
  const navigate = useNavigate();
  useEffect(() => subscribeCommandFailures((event) => {
    toast.custom((id) => (
      <ToastNote
        note={{ id: String(id), tone: "refused", title: "That action could not be completed", meta: "", reason: event.reason }}
        onAct={() => toast.dismiss(id)}
        onDismiss={() => toast.dismiss(id)}
      />
    ), { id: event.requestId ?? undefined, duration: Infinity });
  }), []);
  const update = useUpdateStatus();
  const { state } = useStore();

  // Subscriptions register once; the callbacks read the latest jobs through a ref rather than
  // re-subscribing on every store frame.
  const store = useRef<{ jobs: readonly Job[]; manifest: ModelManifest | null }>({ jobs: [], manifest: null });
  store.current = { jobs: state?.app.jobs ?? [], manifest: state?.app.manifest ?? null };

  /** jobId → receipt for work announced by this window, retained until its outcome arrives. */
  const noteFor = useRef(new Map<string, string>());

  useEffect(() => {
    if (update?.status !== "updated" || !update.targetVersion) return;
    toast.success(`Arke Studio updated to v${update.targetVersion}`, {
      id: `update:${update.targetVersion}`,
      // The release's own card is one press away (design turn 136, R-21).
      action: { label: "What's new", onClick: () => openActivityPanel("new") },
      classNames: {
        toast: "fy-toast",
        title: "fy-toast__title",
        description: "fy-toast__description",
        actionButton: "fy-toast__action",
        closeButton: "fy-toast__close",
      },
    });
    acknowledgeUpdate();
  }, [update]);

  useEffect(
    () =>
      /*
       * A refused scene save was silent (review 2026-08-22): the coordinator emits
       * scene.write-refused, and until now nothing listened — an edit could quietly not land
       * and the storyboard kept showing the text the person typed. Raised here rather than on
       * the storyboard because every screen that saves scenes should say the same thing the
       * same way.
       */
      subscribeSceneRefusals((event) => {
        const note: QueueNote = {
          id: `scene-refusal:${event.productionId}/${event.sceneFile}`,
          tone: "refused",
          title: "That edit was not saved",
          meta: `scene ${event.sceneFile}`,
          reason: event.reason,
        };
        toast.custom(
          (id) => <ToastNote note={note} onAct={() => toast.dismiss(id)} onDismiss={() => toast.dismiss(id)} />,
          { id: note.id, duration: Infinity },
        );
      }),
    [],
  );

  useEffect(
    () =>
      // A scene that could not be made is said the same way a refused edit is: the button that
      // asked only comes back, and the reason is worded here, above whichever screen pressed it.
      // Only for a press this window made: the answer is broadcast to every window (codex, PR 708).
      subscribeSceneCreateResults((result) => {
        if (result.disposition !== "failed" || !isOwnSceneCreate(result.requestId)) return;
        const note: QueueNote = {
          id: `scene-create:${result.requestId}`,
          tone: "refused",
          title: "That scene was not created",
          meta: `production ${result.productionId}`,
          reason: result.reason ?? "the scene could not be created",
        };
        toast.custom(
          (id) => <ToastNote note={note} onAct={() => toast.dismiss(id)} onDismiss={() => toast.dismiss(id)} />,
          { id: note.id, duration: Infinity },
        );
      }),
    [],
  );

  useEffect(
    () =>
      // The same for a chapter that could not be made (codex, PR 879): the press comes back and
      // the reason is said here, whichever screen pressed it.
      subscribeChapterCreateResults((result) => {
        if (result.disposition !== "failed" || !isOwnChapterCreate(result.requestId)) return;
        const note: QueueNote = {
          id: `chapter-create:${result.requestId}`,
          tone: "refused",
          title: "That chapter was not created",
          meta: `production ${result.productionId}`,
          reason: result.reason ?? "the chapter could not be created",
        };
        toast.custom(
          (id) => <ToastNote note={note} onAct={() => toast.dismiss(id)} onDismiss={() => toast.dismiss(id)} />,
          { id: note.id, duration: Infinity },
        );
      }),
    [],
  );

  useEffect(() => {
    const act = (note: QueueNote, id: string | number) => {
      // Activity is a panel over this screen, not a place to go (design turn 136, R-20).
      if (note.action?.to === "/activity") openActivityPanel("inbox");
      else if (note.action) navigate(note.action.to);
      toast.dismiss(id);
    };
    return subscribeQueueResults((result) => {
      const seed = enqueueNote(result, store.current.jobs, store.current.manifest);
      if (!seed) return;
      for (const jobId of result.acceptedJobIds) {
        noteFor.current.set(jobId, result.acceptedJobIds.length === 1 ? seed.id : `job:${jobId}`);
      }
      toast.custom(
        (id) => (
          <LiveNote
            result={result}
            seed={seed}
            onAct={(note) => act(note, id)}
            onDismiss={() => toast.dismiss(id)}
          />
        ),
        { id: seed.id, duration: Infinity },
      );
    });
  }, [navigate]);

  useEffect(() => {
    // The enqueue receipt can expire before a job fails. Keep following the jobs it announced
    // here, so a late failure still gets a fresh refusal without replaying historical failures.
    for (const job of state?.app.jobs ?? []) {
      const existing = noteFor.current.get(job.id);
      if (!existing) continue;
      if (job.status === "cancelled" || job.deletedAt) {
        noteFor.current.delete(job.id);
      } else if (job.status === "failed" || job.status === "needs-reconciliation") {
        noteFor.current.delete(job.id);
        const note = failedNote(job, store.current.manifest, existing);
        toast.custom((id) => (
          <ToastNote note={note} onAct={() => {
            if (note.action) navigate(note.action.to);
            toast.dismiss(id);
          }} onDismiss={() => toast.dismiss(id)} />
        ), { id: note.id, duration: Infinity });
      }
    }
  }, [state?.app.jobs, navigate]);

  useEffect(
    () =>
      subscribeJobReady((job) => {
        // A single-job notification still on screen already shows this outcome, and re-raising it
        // under the same id replaces that row rather than stacking a second one beside it.
        const existing = noteFor.current.get(job.id);
        noteFor.current.delete(job.id);
        const note = readyNote(job, store.current.manifest, existing);
        toast.custom(
          (id) => (
            <ToastNote
              note={note}
              onAct={() => {
                if (note.action) navigate(note.action.to);
                toast.dismiss(id);
              }}
              onDismiss={() => toast.dismiss(id)}
            />
          ),
          { id: note.id, duration: Infinity },
        );
      }),
    [navigate],
  );

  return (
    <Toaster
      position="top-center"
      offset={{ top: "calc(44px + var(--space-3))" }}
      // Sonner sizes its own centred column from `--width` (356px by default) and does not shrink
      // a wider child into it — a 390px notification simply overhangs the right edge, which
      // measures as 34px off-centre on a real dispatch. One number, so the two agree.
      style={{ "--width": "390px" } as CSSProperties}
      // Sonner skips its own close button on a custom toast (`closeButton && !toast.jsx`), so this
      // reaches the update notice and never doubles up on a queue notification's own dismiss.
      closeButton
      hotkey={["altKey", "KeyT"]}
      /*
       * Dressing every wrapper as `.fy-toast` put its 16px padding and 1px border around the
       * notification's own box too — measured as a 17px inset in both axes on a real dispatch.
       * The queue notification draws itself, so only the update notice asks for that shell.
       */
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: "fy-toast",
          title: "fy-toast__title",
          description: "fy-toast__description",
          actionButton: "fy-toast__action",
          closeButton: "fy-toast__close",
          error: "fy-toast--error",
          success: "fy-toast--success",
        },
      }}
    />
  );
}
