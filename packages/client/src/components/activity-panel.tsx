import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate, type NavigateFunction } from "react-router";
import {
  activityJobLabels,
  buildWorkingLine,
  computeNeedsYou,
  computeRunning,
  formatMicroUsd,
  jobActions,
  jobOrigin,
  spendSummary,
  type ClientState,
  type Job,
  type LedgerEntry,
  type NeedsYouEntry,
  type RunningEntry,
  type UpdateState,
} from "@arke-studio/contracts";
import { Badge, Button, Callout, IconButton, Input, cx } from "./ui.js";
import { ChevronLeft, FileText, Trash } from "./icons.js";
import { ProviderCallInspector } from "./provider-calls.js";
import { historyNote, type NoteTone } from "./queue-note.js";
import { mediaUrl } from "../lib/media.js";
import { dayLabel, shortDate, shortDateTime } from "../lib/format.js";
import { bundledReleases } from "../lib/releases.js";
import { compareVersions, newestVersion, RELEASE_PAGE, unreadCount, type ReleaseCard } from "../lib/release-notes.js";
import {
  closeActivityPanel,
  inspectProviderCalls,
  leaveProviderCalls,
  openActivityPanel,
  showActivityTab,
  takeArrival,
  useActivityPanel,
  waitingUpdate,
  type ActivityPanelState,
  type ActivityTab,
} from "../lib/activity-panel.js";
import {
  cancelExport,
  cancelJob,
  checkUpdates,
  deleteJob,
  downloadUpdate,
  installUpdateAndRestart,
  installUpdateOnClose,
  markInboxSeen,
  markWhatsNewSeen,
  openWorld,
  resolveHeldJob,
  retryJobFinalization,
  resumeQueue,
  runBuildItem,
  setSpendThreshold,
  useExports,
  useReconcileReport,
  useStore,
  useUpdateStatus,
  useVoiceSidecar,
} from "../lib/store.js";

/**
 * Activity, as a panel (design turn 136; SPEC-014 R-20–R-27). The bell in the chrome opens it
 * over whatever screen is showing, and everything the retired page held is inside: the needs-you
 * queue, running work, terminal work by day, spend with its threshold and drift, provider calls,
 * deletion, the founding build's rows — and two things the page never had, the release cards the
 * build carries and the spend alert as a queue entry.
 *
 * It is drawn in place rather than through a portal: nothing above it in the tree is transformed,
 * `position: fixed` lands where it says, and server rendering — which the screen tests use — has
 * no portal to give.
 */

const TAB_LABEL: Record<ActivityTab, string> = { new: "What's new", inbox: "Inbox", spend: "Spend" };
const TABS: readonly ActivityTab[] = ["new", "inbox", "spend"];
const TERMINAL = new Set<Job["status"]>(["succeeded", "failed", "cancelled"]);
/** Earlier reaches back this far (R-22); the ledger holds everything beyond it. */
const HISTORY_DAYS = 7;
const HISTORY_ROWS = 50;
const NOT_LANDED = new Set(["failed", "skipped", "unauthorized"]);
const DOT: Record<NoteTone, string> = {
  queued: "fy-ap__dot--queued",
  warning: "fy-ap__dot--warn",
  refused: "fy-ap__dot--fail",
  back: "fy-ap__dot--ok",
};

export function ActivityPanel() {
  const panel = useActivityPanel();
  const { state } = useStore();
  const location = useLocation();
  // The retired route asked for the panel; it opens once the redirect has landed (R-20).
  useEffect(() => {
    if (location.pathname === "/activity") return;
    const tab = takeArrival();
    if (tab) openActivityPanel(tab);
  }, [location.pathname]);
  if (!panel.open || !state) return null;
  return <OpenPanel panel={panel} state={state} />;
}

function OpenPanel({ panel, state }: { panel: ActivityPanelState; state: ClientState }) {
  const location = useLocation();
  const root = useRef<HTMLDivElement>(null);
  const [scope, setScope] = useState<"active" | "all">("active");
  const sidecar = useVoiceSidecar();
  const exportsState = useExports();
  const update = useUpdateStatus();
  const waiting = waitingUpdate(update);

  // Closes when the screen behind it changes — its own actions navigate, and so does the user.
  const path = `${location.pathname}${location.search}`;
  const openedOver = useRef(path);
  useEffect(() => {
    if (openedOver.current !== path) closeActivityPanel();
  }, [path]);

  // An outside press or Escape closes it. The bell is not outside: it is the toggle, and taking
  // its press here would close the panel a beat before the bell's own handler reopened it.
  useEffect(() => {
    const opener = document.activeElement;
    root.current?.focus({ preventScroll: true });
    const press = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || root.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-activity-bell]")) return;
      closeActivityPanel();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopImmediatePropagation();
      closeActivityPanel();
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("keydown", key, true);
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // The two remembered facts (R-25), stamped by the coordinator's clock when a tab is looked at.
  // Reading What's new marks the newest thing on it — the waiting update when there is one, so
  // its count clears once read rather than standing until it is installed.
  const releases = bundledReleases();
  const seen = state.app.activitySeen;
  const mark = newestVersion(releases, waiting?.targetVersion ?? null);
  useEffect(() => {
    if (panel.tab === "inbox" && panel.calls === undefined) markInboxSeen();
  }, [panel.tab, panel.calls]);
  useEffect(() => {
    if (panel.tab !== "new" || mark === null) return;
    if (seen.whatsNewSeenVersion === null || compareVersions(mark, seen.whatsNewSeenVersion) > 0) markWhatsNewSeen(mark);
  }, [panel.tab, mark, seen.whatsNewSeenVersion]);

  const activeWorldId = state.world?.meta.worldId ?? null;
  const scoped = <T extends { worldId?: string }>(items: T[]): T[] =>
    scope === "all" || activeWorldId === null
      ? items
      : items.filter((item) => item.worldId === undefined || item.worldId === activeWorldId);
  const running = scoped(computeRunning(state, { sidecar, exports: exportsState }));
  const needsYou = scoped(computeNeedsYou(state));
  const unread = unreadCount(releases, seen.whatsNewSeenVersion, waiting?.targetVersion ?? null);
  const needs = needsYou.length;
  const status =
    running.length === 0 && needs === 0
      ? "nothing running · nothing waiting"
      : `${running.length} running · ${needs} need${needs === 1 ? "s" : ""} you`;
  const label = (tab: ActivityTab): string => {
    const count = tab === "new" ? unread : tab === "inbox" ? needs : 0;
    return count > 0 ? `${TAB_LABEL[tab]} · ${count}` : TAB_LABEL[tab];
  };

  return (
    <div className="fy-ap" role="dialog" aria-label="Activity" ref={root} tabIndex={-1} data-tab={panel.tab}>
      <div className="fy-ap__head">
        {panel.calls === undefined ? (
          <span className="fy-ap__title">Activity</span>
        ) : (
          <button type="button" className="fy-ap__back" onClick={() => leaveProviderCalls()}>
            <ChevronLeft size={13} />
            {TAB_LABEL[panel.tab]}
          </button>
        )}
        <span className="fy-ap__push" />
        <button type="button" className="fy-ap__close" aria-label="Close" onClick={() => closeActivityPanel()}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
      {panel.calls === undefined && (
        <>
          <div className="fy-ap__tabs">
            <div className="fy-seg" role="tablist">
              {TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={panel.tab === tab}
                  className={cx("fy-seg__item", panel.tab === tab && "fy-seg__item--active")}
                  onClick={() => showActivityTab(tab)}
                >
                  {label(tab)}
                </button>
              ))}
            </div>
          </div>
          {panel.tab !== "new" && (
            <div className="fy-ap__status">
              <span>{status}</span>
              <span className="fy-ap__push" />
              {activeWorldId && (
                <span className="fy-ap__scope">
                  <button type="button" aria-pressed={scope === "active"} onClick={() => setScope("active")}>
                    this world
                  </button>
                  <span>·</span>
                  <button type="button" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
                    all worlds
                  </button>
                </span>
              )}
            </div>
          )}
        </>
      )}
      <div className="fy-ap__body">
        {panel.calls !== undefined ? (
          <ProviderCallInspector jobId={panel.calls} />
        ) : panel.tab === "new" ? (
          <WhatsNew releases={releases} update={waiting} />
        ) : panel.tab === "inbox" ? (
          <Inbox state={state} needsYou={needsYou} running={running} scope={scope} activeWorldId={activeWorldId} />
        ) : (
          <Spend state={state} scope={scope} activeWorldId={activeWorldId} />
        )}
      </div>
    </div>
  );
}

function Eyebrow({ children, first = false }: { children: ReactNode; first?: boolean }) {
  return <div className={cx("fy-ap__eyebrow", first && "fy-ap__eyebrow--first")}>{children}</div>;
}

// ---- Inbox --------------------------------------------------------------------------------------

function Inbox({
  state,
  needsYou,
  running,
  scope,
  activeWorldId,
}: {
  state: ClientState;
  needsYou: NeedsYouEntry[];
  running: RunningEntry[];
  scope: "active" | "all";
  activeWorldId: string | null;
}) {
  const navigate = useNavigate();
  const reconcileReport = useReconcileReport();
  const [confirming, setConfirming] = useState<string | null>(null);
  const inScope = (worldId: string | undefined): boolean =>
    scope === "all" || activeWorldId === null || worldId === undefined || worldId === activeWorldId;
  const jobs = [...state.app.jobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const cutoff = Date.now() - HISTORY_DAYS * 86_400_000;
  // A job whose generation succeeded but whose result is still being prepared is Running, and
  // one whose preparation failed is Needs you (class 1); neither is finished, and a `ready`
  // row beside either would say the output is there to use (codex, PR 1087).
  const settled = (job: Job): boolean =>
    TERMINAL.has(job.status) && !(job.status === "succeeded" && job.finalization !== undefined && job.finalization.status !== "complete");
  const history = jobs
    .filter((job) => settled(job) && inScope(job.worldId) && Date.parse(job.updatedAt) >= cutoff)
    .slice(0, HISTORY_ROWS);
  // Founding-build items that did not land (SPEC-031 R-48): rows derived from the build record's
  // own keys, so an item never dispatched — no route, no credential — is as visible and as
  // runnable as a failed one. Held items are deliberately absent: their queue rows are already
  // here, and resuming the lane is that row's action.
  const buildMissing = state.app.builds
    .filter((build) => build.status !== "running" && inScope(build.worldId))
    .map((build) => ({ build, missing: build.items.filter((item) => NOT_LANDED.has(item.state)) }))
    .filter(({ missing }) => missing.length > 0);
  /** The build item a failed job belongs to, for the retry that lands as the build would (R-49). */
  const buildOwner = (jobId: string) => {
    for (const build of state.app.builds) {
      const item = build.items.find((candidate) => candidate.jobId === jobId);
      if (item) return { build, item };
    }
    return null;
  };
  const quiet = running.length === 0 && needsYou.length === 0;
  const worldSlug = state.world?.meta.slug ?? null;

  const rows: ReactNode[] = [];
  let day: string | null = null;
  for (const job of history) {
    const label = dayLabel(job.updatedAt);
    if (label !== day) {
      rows.push(<Eyebrow key={`day:${label}`}>{label}</Eyebrow>);
      day = label;
    }
    rows.push(
      <HistoryRow
        key={job.id}
        job={job}
        state={state}
        worldSlug={worldSlug}
        confirming={confirming}
        setConfirming={setConfirming}
        owner={buildOwner(job.id)}
        navigate={navigate}
      />,
    );
  }

  return (
    <>
      {reconcileReport && reconcileReport.length > 0 && (
        <Callout title="What recovery did">
          {reconcileReport.map((r) => `${r.jobId.slice(0, 8)}… ${r.action}`).join(" · ")}
        </Callout>
      )}
      {quiet ? (
        <div className="fy-ap__empty">Nothing running, nothing waiting on you</div>
      ) : (
        <>
          {needsYou.length > 0 && <Eyebrow first>Needs you · {needsYou.length}</Eyebrow>}
          {needsYou.map((entry, i) => (
            <NeedsYouRow
              key={`${entry.kind}-${entry.ref ?? entry.worldId ?? i}`}
              entry={entry}
              isJob={entry.ref !== undefined && jobs.some((job) => job.id === entry.ref)}
              navigate={navigate}
            />
          ))}
          {running.length > 0 && <Eyebrow first={needsYou.length === 0}>Running · {running.length}</Eyebrow>}
          {running.map((entry) => (
            <RunningRow key={entry.ref} entry={entry} activeWorldId={activeWorldId} />
          ))}
        </>
      )}
      {buildMissing.map(({ build, missing }) => (
        <div key={build.buildId}>
          <Eyebrow>
            The founding build · {missing.length} not landed
          </Eyebrow>
          {missing.length > 1 && (
            <div className="fy-ap__row">
              <span className="fy-ap__dot fy-ap__dot--queued" />
              <div className="fy-ap__main">
                <div className="fy-ap__rowtitle">
                  <span>{build.worldName} · everything outstanding</span>
                </div>
              </div>
              <div className="fy-ap__end">
                <Button size="sm" onClick={() => runBuildItem(build.worldId)}>
                  Run all {missing.length}
                </Button>
              </div>
            </div>
          )}
          {missing.map((item) => (
            <div key={item.key} className="fy-ap__row">
              <span className="fy-ap__dot fy-ap__dot--warn" />
              <div className="fy-ap__main">
                <div className="fy-ap__rowtitle">
                  <span>{buildWorkingLine(item)}</span>
                </div>
                {item.detail && <div className="fy-ap__rowsub">{item.detail}</div>}
              </div>
              <div className="fy-ap__end">
                {/* Lands exactly as the build would have — settled, anchored, designated (R-49). */}
                <Button size="sm" onClick={() => runBuildItem(build.worldId, item.key)}>
                  Run
                </Button>
              </div>
            </div>
          ))}
        </div>
      ))}
      {rows}
      <div className="fy-ap__foot">
        {history.length > 0 ? `last ${HISTORY_DAYS} days` : `nothing finished in the last ${HISTORY_DAYS} days · the ledger holds everything`}
      </div>
    </>
  );
}

function NeedsYouRow({ entry, isJob, navigate }: { entry: NeedsYouEntry; isJob: boolean; navigate: NavigateFunction }) {
  const ref = entry.ref;
  return (
    <div className="fy-ap__row fy-ap__row--top">
      <span className="fy-ap__dot fy-ap__dot--warn" />
      <div className="fy-ap__main">
        <div className="fy-ap__rowtitle">
          <span>{entry.title}</span>
          {entry.asOf && <Badge tone="outline">as of {shortDateTime(entry.asOf)} — not current</Badge>}
        </div>
        <div className="fy-ap__rowsub">{entry.detail}</div>
        <div className="fy-ap__actions">
          {isJob && ref && (
            <IconButton label="Provider calls" onClick={() => inspectProviderCalls(ref)}>
              <FileText />
            </IconButton>
          )}
          {entry.actions.includes("resolve") && ref && (
            <>
              <Button size="sm" onClick={() => resolveHeldJob(ref, "resubmit")}>
                Resubmit · may charge again
              </Button>
              <Button size="sm" variant="ghost" onClick={() => resolveHeldJob(ref, "discard")}>
                Abandon · prior cost unknown
              </Button>
            </>
          )}
          {entry.actions.includes("retry-finalization") && ref && (
            <Button size="sm" onClick={() => retryJobFinalization(ref)}>
              Retry finalization · no regeneration or charge
            </Button>
          )}
          {entry.actions.includes("settings") && ref && (
            <>
              <Button size="sm" onClick={() => resumeQueue(ref)}>
                Resume {ref}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate("/settings/providers")}>
                Settings
              </Button>
            </>
          )}
          {entry.actions.includes("reconcile") && entry.worldId && (
            <Button size="sm" onClick={() => navigate(`/w/${entry.worldId}`)}>
              Open world
            </Button>
          )}
          {entry.actions.includes("review") && entry.worldId && (
            <Button size="sm" onClick={() => navigate(entry.reviewPath ?? `/w/${entry.worldId}/productions`)}>
              Review
            </Button>
          )}
          {entry.actions.includes("open-proposal") && entry.worldId && (
            <Button size="sm" onClick={() => navigate(`/w/${entry.worldId}/proposals`)}>
              Review
            </Button>
          )}
          {entry.actions.includes("open-world") && entry.worldId && (
            <Button
              size="sm"
              onClick={() => {
                // Opening makes the counts precise (R-7).
                openWorld(entry.worldId!);
                navigate(`/w/${entry.worldId}`);
              }}
            >
              Open — items become precise
            </Button>
          )}
          {entry.actions.includes("spend") && (
            <Button size="sm" onClick={() => showActivityTab("spend")}>
              Spend
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function RunningRow({ entry, activeWorldId }: { entry: RunningEntry; activeWorldId: string | null }) {
  const queued = /\b(queued|submitting)$/.test(entry.detail);
  return (
    <div className="fy-ap__row">
      <span className={cx("fy-ap__dot", queued ? "fy-ap__dot--queued" : "fy-ap__dot--live")} />
      <div className="fy-ap__main">
        <div className="fy-ap__rowtitle" title={entry.diagnostic}>
          <span>{entry.title}</span>
        </div>
        <div className="fy-ap__rowsub">{entry.kind === "job" ? entry.detail : `${entry.kind.replaceAll("-", " ")} · ${entry.detail}`}</div>
      </div>
      <div className="fy-ap__end">
        {entry.percent !== null && <span className="fy-ap__meta">{Math.round(entry.percent)}%</span>}
        {entry.cancellable && entry.kind === "job" && (
          <Button size="sm" variant="ghost" onClick={() => cancelJob(entry.ref)}>
            Cancel
          </Button>
        )}
        {entry.cancellable && entry.kind === "export" && activeWorldId && (
          <Button size="sm" variant="ghost" onClick={() => cancelExport(activeWorldId, entry.ref)}>
            Cancel
          </Button>
        )}
        {entry.kind === "job" && (
          <IconButton label="Provider calls" onClick={() => inspectProviderCalls(entry.ref)}>
            <FileText />
          </IconButton>
        )}
      </div>
    </div>
  );
}

/**
 * A finished job, said the way its receipt said it (design turn 79), with the place R-19 asks
 * for on the mono line — the receipt could leave the path out because the user was standing on
 * it; a panel opened from anywhere cannot.
 */
function HistoryRow({
  job,
  state,
  worldSlug,
  confirming,
  setConfirming,
  owner,
  navigate,
}: {
  job: Job;
  state: ClientState;
  worldSlug: string | null;
  confirming: string | null;
  setConfirming: (id: string | null) => void;
  owner: { build: { worldId: string }; item: { key: string } } | null;
  navigate: NavigateFunction;
}) {
  const note = historyNote(job, state.app.manifest);
  const labels = activityJobLabels(state, job);
  const thumb =
    note.thumb && worldSlug && state.world?.meta.worldId === note.thumb.worldId ? mediaUrl(worldSlug, note.thumb.path) : null;
  const actions = jobActions(job);
  const retry = actions.includes("retry");
  const origin = retry ? jobOrigin(job) : null;
  const diagnostic = [job.id, job.target.id, `${job.provider}/${job.model}`].filter(Boolean).join(" · ");
  const sub = [note.meta, labels.place].filter((part) => part.length > 0).join(" · ");
  return (
    <div className={cx("fy-ap__row", (note.reason || retry || confirming === job.id) && "fy-ap__row--top")}>
      {thumb ? <img className="fy-ap__thumb" src={thumb} alt="" /> : <span className={cx("fy-ap__dot", DOT[note.tone])} />}
      <div className="fy-ap__main">
        <div className="fy-ap__rowtitle" title={diagnostic}>
          <span>{note.title}</span>
        </div>
        <div className="fy-ap__rowsub">{sub}</div>
        {note.reason && <div className="fy-ap__reason">{note.reason}</div>}
        {/* Where this one is re-run from, which is not one place (issue 226): a founding-build job
            retries through the build's own landing (SPEC-031 R-49), reference work from the
            screen that owns its dialog, and a kind nobody can place says so rather than naming
            somewhere wrong. */}
        {retry &&
          (owner ? (
            <div className="fy-ap__actions">
              <span className="fy-ap__hint">failed — runs again and lands settled</span>
              <Button size="sm" variant="ghost" onClick={() => runBuildItem(owner.build.worldId, owner.item.key)}>
                Run again
              </Button>
            </div>
          ) : origin ? (
            <div className="fy-ap__actions">
              <span className="fy-ap__hint">failed — run it again from {origin.where}</span>
              <Button size="sm" variant="ghost" onClick={() => navigate(origin.path)}>
                {origin.label}
              </Button>
            </div>
          ) : (
            <div className="fy-ap__actions">
              <span className="fy-ap__hint">failed — run it again from wherever you started it</span>
            </div>
          ))}
        {/* Two presses and no dialog: the second press is the consent, and the words say what
            survives it. Offered only where the state permits it (R-13). */}
        {actions.includes("delete") && confirming === job.id && (
          <div className="fy-ap__actions">
            <span className="fy-ap__hint">
              Remove from this history? The ledger entry and anything it produced stay — spend does not move.
            </span>
            <Button
              size="sm"
              onClick={() => {
                deleteJob(job.id);
                setConfirming(null);
              }}
            >
              Delete
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(null)}>
              Keep
            </Button>
          </div>
        )}
      </div>
      <div className="fy-ap__end">
        <IconButton label="Provider calls" onClick={() => inspectProviderCalls(job.id)}>
          <FileText />
        </IconButton>
        {actions.includes("delete") && confirming !== job.id && (
          <IconButton label="Delete" onClick={() => setConfirming(job.id)}>
            <Trash />
          </IconButton>
        )}
      </div>
    </div>
  );
}

// ---- What's new -------------------------------------------------------------------------------

function WhatsNew({ releases, update }: { releases: ReleaseCard[]; update: UpdateState | null }) {
  return (
    <>
      {update && (
        <>
          <Eyebrow first>Available</Eyebrow>
          <UpdateCard update={update} />
        </>
      )}
      {releases.map((card, index) => (
        <div key={card.tag}>
          <Eyebrow first={index === 0 && !update}>{dayLabel(card.date)}</Eyebrow>
          <ReleaseCardView card={card} />
        </div>
      ))}
      {releases.length === 0 && !update && <div className="fy-ap__empty">Nothing new</div>}
    </>
  );
}

/** A release name often repeats the version it names; the card already says the version. */
function releaseNameOf(update: UpdateState): string | null {
  const name = update.releaseName?.replace(/^v?\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?\s*[—–\-·:]*\s*/, "").trim() ?? "";
  return name.length > 0 ? name : null;
}

function UpdateCard({ update }: { update: UpdateState }) {
  const [all, setAll] = useState(false);
  const name = releaseNameOf(update);
  const paragraphs = (update.releaseNotes ?? "")
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);
  const line =
    update.status === "downloading"
      ? `downloading${update.progressPercent !== null ? ` · ${Math.round(update.progressPercent)}%` : ""}`
      : update.status === "ready"
        ? "ready to install"
        : update.status === "install-on-close"
          ? "installs when you close"
          : update.status === "error" || update.status === "install-failed"
            ? (update.detail ?? "needs attention")
            : "available";
  return (
    <div className="fy-ap__card">
      <div className="fy-ap__rtitle">
        v{update.targetVersion}
        {name ? ` · ${name}` : ""}
      </div>
      <div className="fy-ap__stamp">{line}</div>
      {paragraphs.slice(0, all ? undefined : 1).map((paragraph, i) => (
        <div key={i} className="fy-ap__para">
          {paragraph}
        </div>
      ))}
      {paragraphs.length > 1 && !all && (
        <div className="fy-ap__rlinks">
          <button type="button" className="fy-ap__readall" onClick={() => setAll(true)}>
            Read all · {paragraphs.length - 1} more
          </button>
        </div>
      )}
      <div className="fy-ap__actions">
        {update.status === "available" && (
          <Button size="sm" variant="primary" onClick={() => downloadUpdate()}>
            Download
          </Button>
        )}
        {update.status === "ready" && (
          <>
            <Button size="sm" variant="primary" onClick={() => installUpdateAndRestart()}>
              Install and restart
            </Button>
            <Button size="sm" variant="ghost" onClick={() => installUpdateOnClose()}>
              Install when I close
            </Button>
          </>
        )}
        {(update.status === "error" || update.status === "install-failed") && (
          <Button size="sm" onClick={() => checkUpdates()}>
            Check again
          </Button>
        )}
      </div>
    </div>
  );
}

function ReleaseCardView({ card }: { card: ReleaseCard }) {
  const [all, setAll] = useState(false);
  const shown = all ? card.paragraphs : card.paragraphs.slice(0, 1);
  const more = card.paragraphs.length - 1;
  return (
    <div className="fy-ap__release">
      {card.picture && <img className="fy-ap__picture" src={card.picture} alt="" />}
      <div className="fy-ap__stamp">
        v{card.version} · {shortDate(card.date)}
      </div>
      <div className="fy-ap__rtitle">{card.title}</div>
      {shown.map((paragraph, i) => (
        <div key={i} className="fy-ap__para">
          {paragraph}
        </div>
      ))}
      <div className="fy-ap__rlinks">
        {more > 0 && !all && (
          <button type="button" className="fy-ap__readall" onClick={() => setAll(true)}>
            Read all · {more} more
          </button>
        )}
        <span className="fy-ap__push" />
        <a className="fy-ap__ext" href={`${RELEASE_PAGE}${card.tag}`} target="_blank" rel="noreferrer">
          GitHub ↗
        </a>
      </div>
    </div>
  );
}

// ---- Spend --------------------------------------------------------------------------------------

function Spend({ state, scope, activeWorldId }: { state: ClientState; scope: "active" | "all"; activeWorldId: string | null }) {
  const navigate = useNavigate();
  // The alert threshold, set where it is reported (26a). Closed until asked for: the note says
  // what the alert is, and most visits are not about changing it.
  const [editing, setEditing] = useState(false);
  const [threshold, setThreshold] = useState<string | null>(null);
  const [period, setPeriod] = useState<string | null>(null);
  const spendStatus = state.app.spend;
  const thresholdValue = threshold ?? String((spendStatus?.settings.thresholdMicroUsd ?? 0) / 1_000_000);
  const periodValue = period ?? String(spendStatus?.settings.periodDays ?? 7);
  // Spend obeys the panel's scope like every other collection here (issue 305 §8). The ledger
  // cannot use a plain world match, because a founding look preview is paid for before any world
  // exists and its entry keeps the genesis it was spent under (SPEC-031 R-55); the build holds
  // the join, and the map the coordinator harvested before pruning keeps it after a restart
  // (issue 531). Neither ever names another world's genesis as this one's.
  const genesisForActiveWorld = new Set([
    ...state.app.builds.filter((b) => b.worldId === activeWorldId).map((b) => b.genesisId),
    ...Object.entries(state.app.worldGenesis)
      .filter(([worldId]) => worldId === activeWorldId)
      .map(([, genesisId]) => genesisId),
  ]);
  const inScope = (entry: LedgerEntry): boolean =>
    scope === "all" || activeWorldId === null || entry.worldId === activeWorldId || genesisForActiveWorld.has(entry.worldId);
  const spend = spendSummary(state.app.ledger.filter(inScope), spendStatus?.settings.periodDays ?? 7, new Date());
  const spendThreshold = spendStatus?.settings.thresholdMicroUsd ?? 0;
  // The source-quality slot, and a failed read is the loudest source fact there is: the figure
  // beside it sums only what survived the read, a lower bound wearing the shape of a total.
  const sourceNote = state.app.ledgerUnavailable
    ? "ledger could not be read"
    : spend.mixed
      ? `mixed · ${spend.reportedEntries} measured, ${spend.derivedEntries} derived`
      : spend.derivedEntries > 0
        ? "derived from the manifest"
        : "provider-reported";
  // A fired alert outranks everything: `alerted` is only ever computed from entries that were
  // read, so the crossing is real even when a later read failed. Then the un-evaluated case — a
  // status whose read failed has an un-fired alert, which is not an all-clear (SPEC-008 R-19).
  // A zero threshold stays `off` throughout: an alert that is off asks nothing of the ledger.
  const alertWindow = `Alert at ${formatMicroUsd(spendThreshold)} / ${spend.periodDays}d`;
  const alertNote = spendStatus?.alerted
    ? `Over the threshold: ${formatMicroUsd(spendStatus.rollingMicroUsd)} against ${formatMicroUsd(spendThreshold)}.`
    : spendThreshold === 0
      ? `${alertWindow} · off`
      : spendStatus?.ledgerUnavailable
        ? `${alertWindow} · not evaluated`
        : alertWindow;
  return (
    <>
      <Eyebrow first>
        Last {spend.periodDays} days{activeWorldId ? (scope === "active" ? " · this world" : " · all worlds") : ""}
      </Eyebrow>
      <div className="fy-ap__total">
        {formatMicroUsd(spend.totalMicroUsd)} <span className="fy-mono">{sourceNote}</span>
      </div>
      {spend.byProvider
        .filter((p) => !p.unmetered)
        .map((p) => (
          <div key={p.provider} className="fy-spendbar">
            <span className="fy-spendbar__label">{p.provider}</span>
            <div className="fy-spendbar__track">
              <div
                className="fy-spendbar__fill"
                style={{ width: `${spend.totalMicroUsd > 0 ? Math.max(Math.round((p.microUsd / spend.totalMicroUsd) * 100), 2) : 0}%` }}
              />
            </div>
            <span className="fy-spendbar__value">{formatMicroUsd(p.microUsd)}</span>
          </div>
        ))}
      {spend.unmeteredRuns > 0 && (
        <div className="fy-mono" style={{ marginTop: 12 }}>
          {spend.unmeteredRuns} unmetered run{spend.unmeteredRuns === 1 ? "" : "s"}
        </div>
      )}
      <div className="fy-notecard" style={{ background: "var(--background)" }}>
        <span className={`fy-dot fy-dot--${spendStatus?.alerted ? "warn" : "sketch"}`} />
        {alertNote}
        <button type="button" className="fy-spendalert__toggle" aria-expanded={editing} onClick={() => setEditing((open) => !open)}>
          {editing ? "Close" : "Set"}
        </button>
      </div>
      {editing && (
        <div className="fy-spendalert">
          <span className="fy-spendalert__label">alert at $</span>
          <Input aria-label="Alert threshold in dollars" style={{ maxWidth: 92 }} value={thresholdValue} onChange={(e) => setThreshold(e.target.value)} />
          <span className="fy-spendalert__label">over</span>
          <Input aria-label="Alert window in days" style={{ maxWidth: 62 }} value={periodValue} onChange={(e) => setPeriod(e.target.value)} />
          <span className="fy-spendalert__label">days</span>
          <Button
            size="sm"
            onClick={() => {
              const usdValue = Number.parseFloat(thresholdValue);
              const days = Number.parseInt(periodValue, 10);
              if (Number.isFinite(usdValue) && usdValue >= 0 && Number.isFinite(days) && days >= 1) {
                setSpendThreshold(Math.round(usdValue * 1_000_000), Math.min(days, 365));
                setThreshold(null);
                setPeriod(null);
                setEditing(false);
              }
            }}
          >
            Save
          </Button>
        </div>
      )}
      {state.app.drift.map((d) => (
        <div key={d.modelId} className="fy-ap__drift">
          <Callout tone="warning" title={`${d.modelId} estimates are drifting`}>
            ~{(d.medianDivergencePerMille / 10).toFixed(0)}% off across {d.samples} provider-reported charges — the shipped
            manifest needs an update.
          </Callout>
        </div>
      ))}
      <div className="fy-ap__doors">
        <Button onClick={() => navigate("/settings/providers")}>Providers &amp; keys</Button>
        <Button variant="ghost" onClick={() => inspectProviderCalls(null)}>
          All provider calls
        </Button>
      </div>
    </>
  );
}
