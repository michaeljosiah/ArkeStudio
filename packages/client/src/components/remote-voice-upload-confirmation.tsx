import { useEffect, useRef, useState } from "react";
import { subscribeVoiceUploadConfirmations } from "../lib/store.js";
import { Button, Callout } from "./ui.js";

/**
 * The vendor's question on a single read (issue 1215), kept as `usePageRead` keeps it for a
 * page: a cloned narrator's recording is asked about by request before anything is priced, the
 * answer is held for the run — the price asked next is answered by the same frame — and dropped
 * with the read. `live` says which request the screen is reading now, so a question for an
 * older one, or another screen's, is not this screen's to answer.
 */
export function useVoiceUploadAsk(live: () => string | null): {
  /** The question on the table, or null. */
  asked: { destination: string; token: string; notice?: string } | null;
  /** The token the last yes gave, for every later frame of the same read. */
  allowed: () => string | undefined;
  /** Yes: hold the token and clear the dialog; the caller re-sends the read with it. */
  answer: () => string | null;
  /** The read is over, cancelled or replaced: nothing held. */
  drop: () => void;
} {
  const [asked, setAsked] = useState<{ destination: string; token: string; notice?: string } | null>(null);
  const held = useRef<string | null>(null);
  const liveRef = useRef(live);
  liveRef.current = live;
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== liveRef.current()) return;
        setAsked({
          destination: confirmation.destinationLabel,
          token: confirmation.confirmationToken,
          ...(confirmation.destinationNotice !== undefined ? { notice: confirmation.destinationNotice } : {}),
        });
      }),
    [],
  );
  return {
    asked,
    allowed: () => held.current ?? undefined,
    answer: () => {
      if (asked === null) return null;
      held.current = asked.token;
      setAsked(null);
      return asked.token;
    },
    drop: () => {
      held.current = null;
      setAsked(null);
    },
  };
}

/**
 * A cloned voice's recording is about to leave this machine — for a remote ComfyUI engine, or
 * for a hosted reader (SPEC-046 R-16). The destination names where; the notice, when a vendor is
 * the destination, says what it does with the clip in the vendor's own terms and no more (R-17).
 * Asked once per engine per request, and once per voice per vendor.
 */
export function RemoteVoiceUploadConfirmation({
  destinationLabel,
  destinationNotice,
  onCancel,
  onConfirm,
}: {
  destinationLabel: string;
  destinationNotice?: string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      className="fy-update-transition"
      role="dialog"
      aria-modal="true"
      aria-labelledby="remote-voice-upload-title"
      data-testid="remote-voice-upload-confirmation"
    >
      <div className="fy-dialog" style={{ maxWidth: 520, textAlign: "left" }}>
        <div>
          <h2 id="remote-voice-upload-title" style={{ margin: 0 }}>
            Send this voice recording?
          </h2>
          <p style={{ color: "var(--muted-foreground)", lineHeight: 1.55, marginBottom: 0 }}>
            This cloned voice needs its source recording to generate speech, and the reader is not
            on this machine: the recording would leave it.
          </p>
        </div>
        <Callout tone="warning" title="Destination">
          <span className="fy-mono">{destinationLabel}</span>
          {destinationNotice !== undefined ? (
            <p style={{ margin: "8px 0 0", lineHeight: 1.5 }} data-testid="remote-voice-upload-notice">
              {destinationNotice}
            </p>
          ) : null}
        </Callout>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onCancel}>
            Not now
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Send recording
          </Button>
        </div>
      </div>
    </div>
  );
}
