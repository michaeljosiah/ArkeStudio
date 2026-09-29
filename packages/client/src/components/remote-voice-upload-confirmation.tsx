import { Button, Callout } from "./ui.js";

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
