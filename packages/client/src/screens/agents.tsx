import { useEffect, useState } from "react";
import { Button, Textarea, cx } from "../components/ui.js";
import { listHarnessModels, setAgentConfig, useStore } from "../lib/store.js";

/**
 * Settings › Agents.
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
export function SettingsAgentsScreen() {
  const { state } = useStore();
  const agents = state?.app.agents ?? [];
  const models = state?.app.harnessModels ?? [];
  const harnessReady = state?.app.health.harness.status === "healthy";
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  // Ask once when the screen opens: the list is the harness's, and it can change under us.
  useEffect(() => {
    if (harnessReady) listHarnessModels();
  }, [harnessReady]);

  const byProvider = new Map<string, typeof models>();
  for (const m of models) byProvider.set(m.provider, [...(byProvider.get(m.provider) ?? []), m]);

  return (
    <div data-screen="settings-agents" className="fy-set">
      <div className="fy-set__eyebrow">AGENTS</div>
      {agents.map((a) => {
        const open = editing === a.name;
        return (
          <div key={a.name} className="fy-set__row fy-set__row--stack">
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div className="fy-set__name fy-set__name--wide">
                <div className="fy-set__title">{a.name}</div>
                <div className="fy-set__caps">{a.description}</div>
              </div>
              <select
                className="fy-set__pill"
                aria-label={`Model for ${a.name}`}
                value={a.model ?? ""}
                disabled={models.length === 0}
                onChange={(e) => setAgentConfig(a.name, { model: e.target.value === "" ? null : e.target.value })}
              >
                {/* Empty is a real answer, not a missing one: it means the harness decides. */}
                <option value="">
                  {models.length === 0 ? "ask the harness — it is not running" : "whatever OpenCode is set to"}
                </option>
                {[...byProvider.entries()].map(([provider, list]) => (
                  <optgroup key={provider} label={provider}>
                    {list.map((m) => (
                      <option key={`${provider}/${m.id}`} value={`${provider}/${m.id}`}>
                        {m.displayName ?? m.id}
                      </option>
                    ))}
                  </optgroup>
                ))}
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
                />
                <div className="fy-set__note" style={{ marginTop: 8 }}>
                  This is what the agent is for. The rules that keep it inside its folder, off
                  the version fields and away from restating canon are not editable — they are
                  what the accept gate assumes.
                </div>
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
      <div className="fy-set__note">
        a session already running keeps the settings it started with · the next one picks these
        up{models.length > 0 ? ` · ${models.length} models offered by the harness` : ""}
      </div>
    </div>
  );
}
