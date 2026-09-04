import type { SetupComponent } from "@arke-studio/contracts";
import { setupPause, setupResume } from "../lib/store.js";

/** The transfer's capability is backend-owned; every surface renders the same answer. */
export function SetupTransferControl({ component }: { component: SetupComponent }) {
  if (component.state === "paused") {
    if (!component.pauseSupported) return <span className="fy-set__state">Cannot be resumed</span>;
    return (
      <button type="button" className="fy-set__link" onClick={() => setupResume(component.id)}>
        Resume
      </button>
    );
  }
  if (component.state !== "downloading") return null;
  if (!component.pauseSupported) return <span className="fy-set__state">Cannot be paused</span>;
  return (
    <button type="button" className="fy-set__link" onClick={() => setupPause(component.id)}>
      Pause
    </button>
  );
}
