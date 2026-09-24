import { useEffect, useRef, useState } from "react";
import { Button, Textarea, cx } from "../components/ui.js";
import { listHarnessModels, setAgentConfig, useStore } from "../lib/store.js";
import { HarnessModelOptions, HarnessModelStatus } from "../components/harness-models.js";

/**
 * The writing agents, behind Advanced on Harness (design 54b — this was a settings tab
 * of its own until Settings asked "which model does this work" on two tabs in two vocabularies).
 *
 * Six assistants do the writing in this app, and until now which model ran them was nobody's
 * business — not even the app's. It never set one, so the harness used whatever it was
 * configured with, and no screen said what that was.
 *
 * Two things are editable here and one is not. The model is a choice among what the harness
 * says it can actually run. The brief — what the agent is for — is the user's to rewrite. The
 * confinement rules are neither shown nor editable: stay inside the working directory, never
 * restate canon, never stamp versions. The accept gate assumes them, so an agent talked out of
 * them fails in ways that look like application bugs rather than like a changed setting.
 */
export function AgentsPanel({ focusAgent }: { focusAgent?: string } = {}) {
  const { state } = useStore();
  const agents = state?.app.agents ?? [];
  const harnessReady = state?.app.health.harness.status === "healthy";
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const focusTarget = useRef<HTMLSelectElement | null>(null);
  const focusedAgent = useRef<string | undefined>(undefined);
  const catalogStatus = state?.app.harnessModelStatus?.status;

  // Ask once when the screen opens: the list is the harness's, and it can change under us.
  useEffect(() => {
    if (harnessReady) listHarnessModels();
  }, [harnessReady, state?.app.harnessInfo?.generation]);

  useEffect(() => {
    if (focusAgent === undefined) { focusedAgent.current = undefined; return; }
    if (focusedAgent.current === focusAgent || catalogStatus !== "ready" && catalogStatus !== "error") return;
    if (!focusTarget.current) return;
    focusedAgent.current = focusAgent;
    focusTarget.current.focus({ preventScroll: true });
    focusTarget.current.scrollIntoView({ block: "nearest" });
  }, [focusAgent, catalogStatus, agents.length]);

  return (
    <>
      <HarnessModelStatus state={state} />
      {agents.map((a) => {
        const open = editing === a.name;
        return (
          <div key={a.name} className="fy-set__row fy-set__row--stack">
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
              <div className="fy-set__name fy-set__name--wide">
                <div className="fy-set__title">{a.name}</div>
                <div className="fy-set__caps">{a.description}</div>
              </div>
              <select
                className="fy-set__pill"
                ref={a.name === focusAgent ? focusTarget : undefined}
                style={{ minWidth: 0, maxWidth: "100%", flex: "1 1 180px" }}
                aria-label={`Model for ${a.name}`}
                title="A running session keeps the model it started with; the next one picks this up"
                value={a.model ?? ""}
                onChange={(e) => setAgentConfig(a.name, { model: e.target.value === "" ? null : e.target.value })}
              >
                {/* Empty is a real answer, not a missing one: it means the harness decides. */}
                <option value="">Ask the harness</option>
                <HarnessModelOptions state={state} selected={a.model} needsImages={a.name === "stage-designer"} />
              </select>
              <button
                type="button"
                className="fy-set__link"
                onClick={() => {
                  setEditing(open ? null : a.name);
                  setDraft(a.brief);
                }}
              >
                {open ? "Close" : a.edited ? "Brief · edited" : "Brief"}
              </button>
              <span className={cx("fy-set__dot", (a.model || a.edited) && "fy-set__dot--ok")} />
            </div>
            {open && (
              <div style={{ marginTop: 10 }}>
                <Textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{ minHeight: 160, font: "400 12px/1.6 var(--font-mono)" }}
                  aria-label={`What ${a.name} is for`}
                  title="A running session keeps the brief it started with; the next one picks this up"
                />
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <Button
                    disabled={draft.trim().length === 0 || draft === a.brief}
                    onClick={() => {
                      setAgentConfig(a.name, { brief: draft.trim() });
                      setEditing(null);
                    }}
                  >
                    Save brief
                  </Button>
                  <button
                    type="button"
                    className="fy-set__link"
                    disabled={!a.edited}
                    onClick={() => {
                      setAgentConfig(a.name, { brief: null });
                      setDraft(a.shippedBrief);
                      setEditing(null);
                    }}
                  >
                    Reset to shipped
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
