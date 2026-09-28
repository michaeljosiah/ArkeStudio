import { OnYourPC } from "./on-your-pc.js";
import { isRemoteSession } from "../lib/remote-session.js";
import type { SetupComponent } from "@arke-studio/contracts";
import { setupPause, setupResume } from "../lib/store.js";
import { Pause, Play } from "./icons.js";

/** The transfer's capability is backend-owned; every surface renders the same answer. */
export function SetupTransferControl({ component, showIcon = false }: { component: SetupComponent; showIcon?: boolean }) {
  if (isRemoteSession() && ["paused", "downloading"].includes(component.state)) return <OnYourPC>downloads</OnYourPC>;
  if (component.state === "paused") {
    if (!component.pauseSupported) return <span className="fy-set__state">Cannot be resumed</span>;
    return (
      <button type="button" className="fy-set__link" onClick={() => setupResume(component.id)}>
        {showIcon && <Play size={12} stroke={1.5} />}Resume
      </button>
    );
  }
  if (component.state !== "downloading") return null;
  if (!component.pauseSupported) return <span className="fy-set__state">Cannot be paused</span>;
  return (
    <button type="button" className="fy-set__link" onClick={() => setupPause(component.id)}>
      {showIcon && <Pause size={12} stroke={1.5} />}Pause
    </button>
  );
}
