import { useNavigate } from "react-router";
import { ActivityIcon, ChevronLeft, Cog, Inbox } from "./icons.js";
import { cx } from "./ui.js";
import { useStore } from "../lib/store.js";

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
 * Proposals joined them later and went *before* activity rather than between the two, because
 * that pair's order is the settlement above and splitting it would reopen it. It is the only one
 * of the three that is world-scoped, so it is also the only one that can be absent.
 *
 * This disagrees with the prototype on home, which drew the lockup left. Consistency across
 * forty-one screens is worth more than the one composition it came from.
 */
export function AppChrome({
  back,
  context,
  menu,
  controls = true,
  current,
  divided = true,
}: {
  back?: { label: string; to: string };
  /** Where you are. Optional — the world picker is not "somewhere", it is the top. */
  context?: { label: string; to?: string };
  /** Rendered after the context — the bench's session switcher lives here (design 68b). */
  menu?: React.ReactNode;
  /** Launch is the one screen without them: nothing is set up yet and nothing has happened. */
  controls?: boolean;
  current?: "proposals" | "activity" | "settings";
  divided?: boolean;
}) {
  const navigate = useNavigate();
  const { state } = useStore();
  // The dot is the notification: a job that could not be reconciled, or a queue someone paused.
  // Same source as the Activity screen's "Needs you" — it never lights for anything else.
  const attention =
    (state?.app.jobs.some((j) => j.status === "needs-reconciliation") ?? false) ||
    (state?.app.queues.some((q) => q.paused) ?? false);
  // Proposals are world-scoped, so the icon only exists while a world is open — the same rule the
  // world navigation follows. Its dot means the same thing as activity's: something wants you.
  const openWorldId = state?.world?.meta.worldId;
  const waiting = state?.world?.proposals.length ?? 0;
  return (
    <div className={cx("fy-titlebar", divided && "fy-titlebar--divided")}>
      <div className="fy-titlebar__side">
        {back && (
          <button type="button" className="fy-iconbtn fy-iconbtn--wide" onClick={() => navigate(back.to)}>
            <ChevronLeft size={13} />
            {back.label}
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
      </div>
      <button type="button" className="fy-titlebar__brand" onClick={() => navigate("/worlds")} title="Arke Studio">
        <span className="fy-brand__arke">Arke</span>
        <span className="fy-brand__studio">Studio</span>
      </button>
      <div className="fy-titlebar__side fy-titlebar__side--right">
        {controls && (
          <>
            {/* Proposals sits before activity: AppChrome's own settlement is that activity and
                settings sit together, in that order, so a new icon prepends rather than splits. */}
            {openWorldId && (
              <button
                type="button"
                className={cx("fy-iconbtn", current === "proposals" && "fy-iconbtn--current")}
                title={
                  waiting > 0
                    ? `Proposals — ${waiting} awaiting a decision`
                    : "Proposals — nothing waiting"
                }
                aria-label="Proposals"
                aria-current={current === "proposals" ? "page" : undefined}
                onClick={() => navigate(`/w/${openWorldId}/proposals`)}
              >
                <Inbox size={13} />
                {waiting > 0 && <span className="fy-iconbtn__dot" />}
              </button>
            )}
            <button
              type="button"
              className={cx("fy-iconbtn", current === "activity" && "fy-iconbtn--current")}
              title={attention ? "Activity — something needs you" : "Activity"}
              aria-label="Activity"
              aria-current={current === "activity" ? "page" : undefined}
              onClick={() => navigate("/activity")}
            >
              <ActivityIcon size={13} />
              {attention && <span className="fy-iconbtn__dot" />}
            </button>
            <button
              type="button"
              className={cx("fy-iconbtn", current === "settings" && "fy-iconbtn--current")}
              title="Settings"
              aria-label="Settings"
              aria-current={current === "settings" ? "page" : undefined}
              onClick={() => navigate("/settings/providers")}
            >
              <Cog size={13} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
