import { cx } from "./ui.js";

/**
 * The extraction offer: one line under the composer, after a document is attached.
 *
 * Attaching a document is usually a way of saying "this already exists — use it", so the studio
 * offers to read it. The offer comes BEFORE the reading, never after: reading is a model turn,
 * and the button is the consent. See design-system/composer.html §07.
 *
 * It lives under the composer rather than in the transcript, because you have not said anything
 * yet; and beside the chip rather than inside it, because it is about what happens next rather
 * than what the file is. It never blocks typing — ignoring it is a valid answer.
 */

export interface ExtractionOfferProps {
  file: string;
  /** Absent → not asked yet: the offer itself. */
  state?: "reading" | "found" | "nothing" | "no-text" | "stopped" | "unavailable" | "failed";
  found?: number;
  dropped?: number;
  reason?: string;
  onRead: () => void;
  onStop: () => void;
  onReview: () => void;
  onDismiss: () => void;
}

export function ExtractionOffer(props: ExtractionOfferProps) {
  const { file, state, found = 0, dropped = 0, reason, onRead, onStop, onReview, onDismiss } = props;

  const dot = state === "reading" ? "live" : state === "found" ? "done" : "";
  return (
    <div className="fy-off" data-state={state ?? "offered"}>
      <div className="fy-off__row">
        <span className={cx("fy-off__dot", dot && `fy-off__dot--${dot}`)} />
        <span className="fy-off__t">
          {state === undefined && (
            <>
              <strong>{file}</strong>
              {" is filed. Read it for facts?"}
            </>
          )}
          {/* Each sentence is one string rather than text around an expression: it keeps the
              rendered line a single text node, which is what a screen reader wants to read. */}
          {state === "reading" && `Reading ${file}…`}
          {state === "found" && (
            <>
              <strong>{`${found} fact${found === 1 ? "" : "s"}`}</strong>
              {` found in ${file}, each quoting the line it came from.`}
            </>
          )}
          {/* Said plainly: a silent nothing reads as a failure. */}
          {state === "nothing" && `Nothing in ${file} that the canon does not already say.`}
          {state === "no-text" && (reason ?? `There is no text in ${file} we can read.`)}
          {state === "stopped" && `Stopped reading ${file}. It stays filed, unread.`}
          {state === "unavailable" && (reason ?? "Reading needs the writing service running.")}
          {state === "failed" && `Could not read ${file}${reason ? ` — ${reason}` : ""}.`}
        </span>
        <span className="fy-off__acts">
          {state === undefined && (
            <>
              <button type="button" className="fy-off__b fy-off__b--go" onClick={onRead}>
                Read it
              </button>
              <button type="button" className="fy-off__b" onClick={onDismiss}>
                Not now
              </button>
            </>
          )}
          {state === "reading" && (
            <button type="button" className="fy-off__b" onClick={onStop}>
              Stop
            </button>
          )}
          {state === "found" && (
            <button type="button" className="fy-off__b fy-off__b--go" onClick={onReview}>
              Review them
            </button>
          )}
          {(state === "nothing" || state === "no-text" || state === "stopped" || state === "failed" || state === "unavailable") && (
            <button type="button" className="fy-off__b" onClick={onDismiss}>
              Dismiss
            </button>
          )}
        </span>
      </div>
      {/* What the model claimed but could not prove never reaches the offer — but it is counted. */}
      {dropped > 0 && (
        <div className="fy-off__note">
          {`${dropped} more ${dropped === 1 ? "was" : "were"} dropped for not quoting the document`}
        </div>
      )}
    </div>
  );
}
