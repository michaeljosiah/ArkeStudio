import { useEffect } from "react";
import { useNavigate, useParams } from "react-router";
import type { FoundingBuildState } from "@arke-studio/contracts";
import { AppChrome } from "../components/chrome.js";
import { Button } from "../components/ui.js";
import { Loading } from "../components/loading.js";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { stopFoundingBuild, useClientState } from "../lib/store.js";

/**
 * The screen the author watches while their world is made (SPEC-031 §1.8).
 *
 * Everything on it is the coordinator's fold, projected: five stages mapped one-to-one onto
 * the run's phases, a progress figure that is items terminal over items authorized — a real
 * fraction of known work, never an estimate of elapsed time — and a working line that names
 * the item in flight, not the stage. The header names the world; the stages name the work
 * (issue 930). The accent is the system's — the fill and the active stage are the foreground token,
 * and the reference art's teal and gold stay in the reference art.
 */

/** The build this screen watches, running or freshly ended, newest first. */
export function buildFor(
  builds: readonly FoundingBuildState[] | undefined,
  worldId: string | undefined,
): FoundingBuildState | null {
  if (!worldId) return null;
  return builds?.find((build) => build.worldId === worldId) ?? null;
}

export function BuildingScreen() {
  const { worldId } = useParams<{ worldId: string }>();
  const navigate = useNavigate();
  const state = useClientState();
  // The driver runs while its world is the open one; this screen is what keeps it open.
  useOpenWorldGuard(worldId);
  const build = buildFor(state?.app.builds, worldId);

  // The run ends on the world screen with everything it made already in place (R-24).
  // Stopping leaves the world open and usable too (R-35) — same arrival, fewer things on it.
  // Nothing navigates before the snapshot arrives: a deep link would otherwise bounce to the
  // world and straight back once the running build landed in state.
  useEffect(() => {
    if (!worldId || state === null) return;
    if (build === null || build.status === "completed" || build.status === "stopped") {
      navigate(`/w/${worldId}`, { replace: true });
    }
  }, [state === null, build === null ? "gone" : build.status, worldId, navigate]);

  if (!build) {
    return (
      <div className="fy-app" data-screen="building">
        <AppChrome context={{ label: "building" }} />
        <Loading label="opening the world" />
      </div>
    );
  }

  const percent =
    build.progress.authorized === 0
      ? 100
      : Math.round((build.progress.terminal / build.progress.authorized) * 100);
  const working = build.working[0] ?? "…";

  return (
    <div className="fy-app" data-screen="building">
      <AppChrome context={{ label: `building · ${build.worldName}` }} />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 26,
          padding: "40px 24px",
        }}
      >
        <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: 8 }}>
          <h1 style={{ font: "650 30px/1.15 var(--font-sans)", letterSpacing: "-0.02em", margin: 0 }}>
            Building {build.worldName}
          </h1>
        </div>

        <Loading size={72} />

        <div style={{ width: "min(560px, 100%)", display: "flex", flexDirection: "column", gap: 7 }}>
          {/* The item in flight, named (R-41) — "Nadia · main photo", never "Creating characters". */}
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ font: "400 12.5px var(--font-sans)", color: "var(--muted-foreground)" }}>{working}</span>
            <span style={{ flex: 1 }} />
            <span className="fy-mono" style={{ fontSize: 10.5 }}>
              {build.progress.terminal} / {build.progress.authorized}
            </span>
          </div>
          <div className="fy-setupbar">
            <div className="fy-setupbar__fill" style={{ width: `${percent}%` }} />
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "flex-start", gap: 0, marginTop: 8 }}>
          {build.stages.map((stage, index) => (
            <div key={stage.id} style={{ display: "flex", alignItems: "flex-start" }}>
              {index > 0 && (
                <div
                  aria-hidden="true"
                  style={{
                    width: 56,
                    borderTop: "1.5px dotted var(--border)",
                    marginTop: 14,
                  }}
                />
              )}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8, width: 112 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 999,
                    boxSizing: "border-box",
                    border:
                      stage.state === "pending" ? "1.5px solid var(--border)" : "1.5px solid var(--foreground)",
                    background: stage.state === "complete" ? "var(--foreground)" : "var(--background)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    font: "600 11px var(--font-sans)",
                    color: stage.state === "complete" ? "var(--background)" : "var(--foreground)",
                    opacity: stage.state === "pending" ? 0.6 : 1,
                  }}
                >
                  {stage.state === "complete" ? "✓" : index + 1}
                </span>
                <span
                  style={{
                    font: stage.state === "active" ? "600 10.5px/1.35 var(--font-sans)" : "400 10.5px/1.35 var(--font-sans)",
                    color: stage.state === "pending" ? "var(--muted-foreground)" : "var(--foreground)",
                    textAlign: "center",
                  }}
                >
                  {stage.label}
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Stop is the author's, and the only halt there is (R-35, R-42). */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, marginTop: 6 }}>
          <Button variant="ghost" onClick={() => worldId && stopFoundingBuild(worldId)}>
            Stop
          </Button>
          <span className="fy-mono" style={{ fontSize: 9.5, color: "var(--muted-foreground)" }}>
            what is made is kept
          </span>
        </div>
      </div>
    </div>
  );
}
