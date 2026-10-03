import { useEffect, useState } from "react";
import { DEFAULT_NARRATOR, freeLimitTail, freePlanStop, GOOGLE_BILLED, GOOGLE_FREE_LIMIT } from "@arke-studio/contracts";
import { setProviderPlan } from "../lib/store.js";
import { isRemoteSession } from "../lib/remote-session.js";

/**
 * The two ways a free plan ends, as a read says them (design turn 182), or null for any other
 * failure — the caller then shows its own words.
 *
 * Google's free daily limit is said with when it resets and how long that is, and offers the
 * shipped narrator for this read; a key marked Free that Google billed offers the switch. Arke
 * never turns the plan off itself: that is the author's statement, and this is where they make it.
 */
export function FreePlanStop({ error, onDefaultNarrator }: { error: string | null | undefined; onDefaultNarrator?: () => void }) {
  const [now, setNow] = useState(() => new Date());
  const stop = freePlanStop(error, now);
  const limited = stop?.kind === "free-limit";
  // The time left is a countdown; a minute's tick keeps it honest without a render per second.
  useEffect(() => {
    if (!limited) return;
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [limited]);
  if (stop === null) return null;
  if (stop.kind === "free-limit") {
    return (
      <span className="fy-freestop" data-testid="free-limit">
        <span className="fy-freestop__warn">{GOOGLE_FREE_LIMIT}</span>
        <span className="fy-freestop__mono">· {freeLimitTail(stop, now)}</span>
        {onDefaultNarrator !== undefined && (
          <button type="button" className="fy-freestop__act" onClick={onDefaultNarrator}>
            Read with {DEFAULT_NARRATOR.label}
          </button>
        )}
      </span>
    );
  }
  return (
    <span className="fy-freestop" data-testid="free-billed">
      <span className="fy-freestop__bad">{GOOGLE_BILLED}</span>
      <span className="fy-freestop__mono">· key looks paid</span>
      {/* The plan is set where the key is; a remote session says what happened and nothing more. */}
      {!isRemoteSession() && (
        <button type="button" className="fy-freestop__act" onClick={() => setProviderPlan("google", "paid")}>
          Turn off Free plan
        </button>
      )}
    </span>
  );
}
