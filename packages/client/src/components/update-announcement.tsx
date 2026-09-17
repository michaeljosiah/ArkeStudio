import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import type { UpdateState } from "@arke-studio/contracts";
import { EditorDialog } from "./editor-dialog.js";
import { ChevronDown, X } from "./icons.js";
import { Button, IconButton } from "./ui.js";
import { activityPanelOpen, releaseNameOf, updateParagraphs, useActivityPanel } from "../lib/activity-panel.js";
import { isSettingsPath } from "../lib/settings-return.js";
import { downloadUpdate, installUpdateAndRestart, installUpdateOnClose, useStore, useUpdateStatus } from "../lib/store.js";

/**
 * The update announced at launch (design turn 152; SPEC-016 R-20).
 *
 * The updater has checked at every start since 0.2, and what it found had nowhere to be said but
 * a row on About and a card in What's new behind a dot on the bell. This is the ordinary dialog
 * every desktop tool shows instead: the mark, the version, the release's notes, and two ways to
 * take it. It is the editor's sheet, over the screen the app opened on.
 *
 * A version is announced once per run of the app — the first time this window learns of it — and
 * never over the launch plate or the starting screen, which are before the studio is up. Closed,
 * it stays closed for that version until the next launch; What's new carries the same update
 * meanwhile.
 *
 * It never stacks with the Activity panel or the Settings sheet (the turn's rule; Codex on PR
 * 1218): the panel sits above the sheet, Settings is the same sheet rendered later, and either
 * would swallow its Escape. An update that arrives while one of them is open waits for it to
 * close; one opened over the dialog — a notification's click, a receipt's action — wins, and the
 * dialog closes as the X would.
 */

/**
 * Where the run remembers what it announced. Module state alone resets with the renderer, and the
 * desktop process — the run — outlives a reload: the snapshot after one still carries the same
 * `available` update, which would read as unseen. Session storage lives exactly as long as the
 * window does. Read and written behind a guard, because storage can be absent or refuse.
 */
export const ANNOUNCED_KEY = "arke.update-announced";
let announced: string | null | undefined;

function announcedVersion(): string | null {
  if (announced === undefined) {
    try {
      announced = typeof sessionStorage === "undefined" ? null : sessionStorage.getItem(ANNOUNCED_KEY);
    } catch {
      announced = null;
    }
  }
  return announced;
}

function markAnnounced(version: string): void {
  announced = version;
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.setItem(ANNOUNCED_KEY, version);
  } catch {
    // The module keeps it for this renderer; a reload will ask again, which is the lesser wrong.
  }
}

export function __resetUpdateAnnouncementForTest(): void {
  announced = undefined;
  try {
    if (typeof sessionStorage !== "undefined") sessionStorage.removeItem(ANNOUNCED_KEY);
  } catch {
    // nothing stored
  }
}

/** Screens before the studio is up: the launch plate, the starting screen, the founding build's watch surface. */
function beforeTheStudio(pathname: string): boolean {
  return pathname === "/" || pathname === "/starting" || pathname.startsWith("/building/");
}

/** The statuses the dialog has something to show for once it is open. */
function showable(update: UpdateState | null): update is UpdateState & { targetVersion: string } {
  return (
    update !== null &&
    update.targetVersion !== null &&
    (update.status === "available" || update.status === "downloading" || update.status === "ready" || update.status === "error")
  );
}

export function UpdateAnnouncement() {
  const update = useUpdateStatus();
  const { connection } = useStore();
  const { pathname } = useLocation();
  const activity = useActivityPanel();
  const [open, setOpen] = useState(false);
  // "Update now" pressed: the dialog holds the intent, and presses Install and restart itself when
  // the download lands — while it is still open. Closing the dialog drops the intent and keeps the
  // download, so nothing restarts on its own once the dialog is gone.
  const [intent, setIntent] = useState<"now" | null>(null);
  const installing = useRef(false);

  // Another sheet up: the announcement waits for it, and leaves for it.
  const covered = activity.open || isSettingsPath(pathname);
  const version = update?.status === "available" ? update.targetVersion : null;
  const arrived = version !== null && !beforeTheStudio(pathname) && !covered;
  useEffect(() => {
    // The panel is read again at effect time: the retired /activity route opens it from the
    // panel's own effect, earlier in this same commit, and this render still saw it closed.
    if (!arrived || version === announcedVersion() || activityPanelOpen()) return;
    markAnnounced(version);
    installing.current = false;
    setIntent(null);
    setOpen(true);
  }, [arrived, version]);

  // The dialog leaves with the update: armed for the close, being installed, gone, or up to date.
  // And it leaves for the other sheet, which wins whatever opened it.
  const visible = open && showable(update);
  useEffect(() => {
    if (open && (!showable(update) || covered)) {
      setIntent(null);
      setOpen(false);
    }
  }, [open, update, covered]);

  useEffect(() => {
    if (!visible || intent !== "now" || update.status !== "ready" || installing.current) return;
    // A press that did not leave — the coordinator away — is tried again on the next frame.
    installing.current = installUpdateAndRestart();
  }, [visible, intent, update]);

  if (!visible) return null;

  // A press that the store cannot send leaves the dialog where it is; closing on it would mark
  // the version announced with nothing asked for. The buttons say so while the coordinator is away.
  const connected = connection === "open";
  const close = () => {
    setIntent(null);
    setOpen(false);
  };
  const now = () => {
    if (update.status === "ready") {
      if (installing.current) return;
      installing.current = installUpdateAndRestart();
      if (installing.current) setIntent("now");
      return;
    }
    if (downloadUpdate()) setIntent("now");
  };
  const nextStart = () => {
    if (!installUpdateOnClose()) return;
    setIntent(null);
    setOpen(false);
  };

  const name = releaseNameOf(update);
  const paragraphs = updateParagraphs(update);
  const percent = update.status === "downloading" ? Math.round(update.progressPercent ?? 0) : 100;
  const downloading = update.status === "downloading" || (update.status === "ready" && intent === "now");

  return (
    <EditorDialog open onClose={close} width={440} labelledBy="fy-upd-title" panelClassName="fy-upd">
      <div className="fy-upd__top">
        <img className="fy-upd__mark" src="./marks/arke.ico" alt="" />
        <h1 className="fy-upd__title" id="fy-upd-title">
          Update available
        </h1>
        <div className="fy-upd__version">
          v{update.targetVersion}
          {name ? ` · ${name}` : ""}
        </div>
        {paragraphs.length > 0 && (
          <>
            <div className="fy-upd__eyebrow">What's new</div>
            <Notes paragraphs={paragraphs} />
          </>
        )}
      </div>
      <div className="fy-upd__foot">
        {update.status === "error" && <div className="fy-upd__why">The download failed.</div>}
        {downloading ? (
          <div className="fy-upd__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Downloading">
            <span>Downloading · {percent}%</span>
            <span className="fy-upd__bar">
              <span style={{ width: `${percent}%` }} />
            </span>
          </div>
        ) : (
          <Button variant="primary" size="lg" className="fy-upd__btn" onClick={now} disabled={!connected}>
            {update.status === "error" ? "Try again" : "Update now"}
          </Button>
        )}
        {/* The hint rides above the button: it is the sheet's last control, and a bubble below it
            would be cut by the panel's own clipping edge. */}
        <Button size="lg" className="fy-upd__btn fy-tip--up" onClick={nextStart} disabled={!connected} hint="Downloads now, installs after you close">
          Next start
        </Button>
      </div>
      <IconButton label="Close" className="fy-upd__close" onClick={close}>
        <X size={13} />
      </IconButton>
    </EditorDialog>
  );
}

/**
 * The notes in a recessed pane that scrolls, with a fade and a chevron at its foot while there is
 * more below the fold. The chevron is the same disclosure every other one in the app draws, and a
 * press on it pages the pane down.
 */
function Notes({ paragraphs }: { paragraphs: string[] }) {
  const pane = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = () => {
    const el = pane.current;
    if (!el) return;
    setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 2);
  };
  useEffect(measure, [paragraphs]);
  return (
    <div className="fy-upd__notes">
      <div ref={pane} className="fy-upd__pane" onScroll={measure}>
        {paragraphs.map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
      {more && (
        <button
          type="button"
          className="fy-upd__more"
          aria-label="More"
          // A pointer convenience, not a stop on the tab ring: the pane scrolls from the keyboard
          // on its own, and the ring should land on Update now first.
          tabIndex={-1}
          onClick={() => pane.current?.scrollBy({ top: pane.current.clientHeight - 24, behavior: "smooth" })}
        >
          <ChevronDown size={14} />
        </button>
      )}
    </div>
  );
}
