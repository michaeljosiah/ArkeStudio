import { useMediaQuery } from "../lib/media-query.js";
import { useNavigate } from "react-router";
import { Bell, ChevronLeft, Cog, Cpu, Message, Sparkle } from "./icons.js";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useGlobalChat } from "./global-chat-context.js";
import { useStudioAssistant } from "./studio-assistant-context.js";
import { AccountControl } from "./account-menu.js";
import { cx } from "./ui.js";
import { useStore } from "../lib/store.js";
import { closeActivityPanel, inboxAttention, openActivityPanel, useActivityPanel, waitingUpdate } from "../lib/activity-panel.js";
import { bundledReleases } from "../lib/releases.js";
import { unreadCount } from "../lib/release-notes.js";
import { arrivedSince, computeNeedsYou, deriveStorageFindings, STORAGE_POLICY, type StorageHealthSnapshot } from "@arke-studio/contracts";
import { closeSystemPanel, openSystemPanel, useSystemPanel } from "../lib/system-panel.js";

/** Expire presentation evidence even in a quiet session. This never requests a host probe. */
function useStorageWarning(health: StorageHealthSnapshot | null | undefined, connected: boolean): boolean {
  const [, invalidate] = useState(0);
  const warning = connected && deriveStorageFindings(health, new Date(Date.now()).toISOString()).some(finding => finding.kind === "storage-pressure");
  useEffect(() => {
    if (!connected || !health) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      const now = Date.now();
      const deadlines = health.roots.flatMap(root => root.state === "measured" && root.capacity?.availableBytes !== null && root.capacity
        ? [root.capacity.measuredAt, ...(root.forecast?.warning ? [root.forecast.to] : [])]
          .filter(at => at <= now && at + STORAGE_POLICY.forecastMaxAgeMs >= now)
          .map(at => at + STORAGE_POLICY.forecastMaxAgeMs + 1) : []);
      if (warning && deadlines.length) timer = setTimeout(wake, Math.min(...deadlines) - now);
    };
    const wake = () => { invalidate(value => value + 1); schedule(); };
    // A render can cross an expiry before its effect installs the timeout.
    if (deriveStorageFindings(health, new Date(Date.now()).toISOString()).some(finding => finding.kind === "storage-pressure") !== warning) invalidate(value => value + 1);
    schedule(); document.addEventListener("visibilitychange", wake);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [health, connected, warning]);
  return warning;
}

/**
 * The app's chrome: one bar, drawn the same way on every screen.
 *
 * Before this there were five of them. The world drew settings and activity as icons on the
 * left and the word "Arke Studio" in the middle; home drew the lockup at top-left and the same
 * two destinations as text buttons on the right; the production bar, the new-world bar and the
 * activity bar each put a bare "Arke" in the top-right and nothing else. Same three things,
 * three placements, so none of them was ever where you reached for it.
 *
 * The settlement, and it is a settlement rather than a preference:
 *   · the wordmark is centred on the *window*, not on the content between the two sides — the
 *     desktop shell parks its native window controls in the top-right ~138px, and centring
 *     within the flex row would push the mark visibly off-centre on desktop and nowhere else.
 *   · activity and settings sit on the right, always, in that order, ahead of those controls.
 *   · the left is for where you are: a way back, and what you are looking at.
 *
 * Turn 240 replaces the world-scoped proposal shortcut with System before Activity. Proposal
 * decisions retain their route, in-context panels and the existing Activity review items.
 *
 * The Arke account (design turn 151) went *after* settings, last of all: it is the one thing in
 * the bar about the person rather than the screen, and every product puts that at the end. The
 * pair stays a pair. Pressed, it opens a menu over this screen, as the bell does, never a page.
 *
 * This disagrees with the prototype on home, which drew the lockup left. Consistency across
 * forty-one screens is worth more than the one composition it came from.
 */
export function AppChrome({
  back,
  context,
  menu,
  aside,
  controls = true,
  current,
  divided = true,
}: {
  back?: { label: string; to: string; disabled?: boolean } | { label: string; onClick: () => void; disabled?: boolean };
  /** Where you are. Optional — the world picker is not "somewhere", it is the top. */
  context?: { label: string; to?: string };
  /** Rendered after the context — the bench's session switcher lives here (design 68b). */
  menu?: React.ReactNode;
  /**
   * Rendered at the right, before the app's own icons — the Bench's subject and its session
   * spend as pills (design 142a). Facts about the screen, not controls, so they sit apart from
   * the buttons rather than among them.
   */
  aside?: React.ReactNode;
  /** Launch is the one screen without them: nothing is set up yet and nothing has happened. */
  controls?: boolean;
  current?: "proposals" | "activity";
  divided?: boolean;
}) {
  const navigate = useNavigate();
  const phone = useMediaQuery("(max-width: 599px)");
  const { state, connection } = useStore();
  const chat = useGlobalChat();
  const contextualView = useSyncExternalStore(chat?.subscribe ?? (() => () => {}), chat?.getSnapshot ?? (() => null), () => null);
  const contextual = chat?.forPage();
  const studio = useStudioAssistant();
  const studioView = useSyncExternalStore(studio?.subscribe ?? (() => () => {}), studio?.getSnapshot ?? (() => null), () => null);
  const chatRunning = !!studioView?.state?.busy;
  // Same derivation as Activity: rare unattended proposals must light this from every screen,
  // alongside reconciliation, paused providers, external edits and paid work awaiting review.
  const attention = state ? inboxAttention(state, computeNeedsYou(state), state.app.audiobookActivity ?? []).count > 0 : false;
  // The second dot (design turn 136, R-24): something to read rather than decide — work that came
  // back since the Inbox was last opened, a release not yet read, or one the updater has found
  // and the person does not have yet. Warning wins when both apply.
  const seen = state?.app.activitySeen ?? { inboxSeenAt: null, whatsNewSeenVersion: null };
  const fresh = state
    ? arrivedSince(state.app.jobs, seen.inboxSeenAt, state.app.audiobookActivity) ||
      unreadCount(bundledReleases(), seen.whatsNewSeenVersion, waitingUpdate(state.app.update)?.targetVersion ?? null) > 0
    : false;
  const panel = useActivityPanel();
  const system = useSystemPanel();
  const storageWarning = useStorageWarning(state?.app.storageHealth, connection === "open");
  return (
    <div className={cx("fy-titlebar", divided && "fy-titlebar--divided")}>
      <div className="fy-titlebar__side">
        {back && (
          <button
            type="button"
            className="fy-iconbtn fy-iconbtn--wide"
            disabled={back.disabled}
            onClick={() => ("onClick" in back ? back.onClick() : navigate(back.to))}
          >
            <ChevronLeft size={13} />
            <span className="fy-titlebar__back-label">{back.label}</span>
          </button>
        )}
        {context &&
          (context.to ? (
            <button type="button" className="fy-titlebar__context" onClick={() => navigate(context.to!)}>
              {context.label}
            </button>
          ) : (
            <span className="fy-titlebar__context">{context.label}</span>
          ))}
        {menu}
        {controls && contextual && <button type="button" className="fy-iconbtn" title={contextual.title} aria-label={`Open ${contextual.title}`}
          aria-expanded={contextualView?.open === true && contextualView.selected?.key === contextual.key}
          data-contextual-chat-trigger="" data-global-chat-trigger=""
          onClick={() => { closeSystemPanel(); studio?.close(); chat?.open(contextual); }}><Sparkle size={13} /></button>}
      </div>
      <button type="button" className="fy-titlebar__brand" onClick={() => navigate("/worlds")} title="Arke Studio">
        <span className="fy-brand__arke">Arke</span>
        <span className="fy-brand__studio">Studio</span>
      </button>
      <div className="fy-titlebar__side fy-titlebar__side--right">
        {aside}
        {controls && (
          <>
            <button type="button" className={cx("fy-iconbtn", studioView?.open && "fy-iconbtn--current")} title="Chat" aria-label="Chat"
              aria-haspopup="dialog" aria-expanded={studioView?.open ?? false} data-studio-chat-trigger=""
              onClick={() => { closeSystemPanel(); if (studioView?.open) studio?.close(); else { chat?.close(); closeActivityPanel(); studio?.open(); } }}>
              <Message size={13} />{chatRunning && <span className="fy-iconbtn__dot fy-iconbtn__dot--new" />}
            </button>
            {/* Turn 240 replaces the shortcut only. Proposal routes and review remain intact. */}
            <button type="button" className={cx("fy-iconbtn", system && "fy-iconbtn--current")}
              title={storageWarning ? "System — storage needs attention" : "System"}
              aria-label={storageWarning ? "System — storage needs attention" : "System"}
              aria-haspopup="dialog" aria-expanded={system} data-system-trigger=""
              onClick={() => { if (system) closeSystemPanel(); else { studio?.close(); chat?.close(); openSystemPanel(); } }}>
              <Cpu size={13} />{storageWarning && <span className="fy-iconbtn__dot" />}
            </button>
            {/* The bell opens Activity over this screen rather than leaving it (design turn 136,
                R-20): Inbox while anything needs you, What's new otherwise (R-21). Pressed again,
                it closes; the panel's own outside-press rule leaves the bell alone for that. */}
            <button
              type="button"
              className={cx("fy-iconbtn", (current === "activity" || panel.open) && "fy-iconbtn--current")}
              title={attention ? "Activity — something needs you" : fresh ? "Activity — something new" : "Activity"}
              aria-label={attention ? "Activity — something needs you" : fresh ? "Activity — something new" : "Activity"}
              aria-expanded={panel.open}
              data-activity-bell=""
              onClick={() => { closeSystemPanel(); if (panel.open) closeActivityPanel(); else { studio?.stepAside(); openActivityPanel(attention ? "inbox" : "new"); } }}
            >
              <Bell size={13} />
              {attention ? (
                <span className="fy-iconbtn__dot" />
              ) : fresh ? (
                <span className="fy-iconbtn__dot fy-iconbtn__dot--new" />
              ) : null}
            </button>
            <button
              type="button"
              className="fy-iconbtn"
              title="Settings"
              aria-label="Settings"
              // Where it was pressed from is what renders behind the Settings sheet and where the
              // sheet returns you (SPEC-042 R-6, design turn 150) — remembered by the app on every
              // change of address, so a remedy's button into Settings counts the same as this one.
              // The sheet carries its own close; no surface under it ever shows a gear to leave by.
              onClick={() => navigate(phone ? "/settings" : "/settings/providers")}
            >
              <Cog size={13} />
            </button>
            <AccountControl />
          </>
        )}
      </div>
    </div>
  );
}
