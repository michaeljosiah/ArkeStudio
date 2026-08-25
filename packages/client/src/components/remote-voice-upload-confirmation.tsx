import { Button, Callout } from "./ui.js";

export function RemoteVoiceUploadConfirmation({
  destinationLabel,
  onCancel,
  onConfirm,
}: {
  destinationLabel: string;
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
            This cloned voice needs its source recording to generate speech. The selected ComfyUI engine is
            remote, so the recording would leave this machine.
          </p>
        </div>
        <Callout tone="warning" title="Destination">
          <span className="fy-mono">{destinationLabel}</span>
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
