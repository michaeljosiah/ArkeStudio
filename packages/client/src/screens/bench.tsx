import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  estimateMicroUsd,
  formatMicroUsd,
  imageOutputFor,
  durationOptions,
  pricedDuration,
  tiersFor,
  type BenchParams,
  type BenchSession,
  type BenchTake,
  type ManifestModel,
  type SizeTier,
} from "@arke-studio/contracts";
import {
  sendBenchAddReference,
  sendBenchClearView,
  sendBenchCompose,
  sendBenchDiscard,
  sendBenchDispatch,
  sendBenchKeep,
  sendBenchNewSession,
  sendBenchOpen,
  sendBenchRemoveReference,
  sendBenchRerun,
  sendBenchSelectTake,
  sendBenchTitle,
  sendBenchUploadReferences,
  subscribeQueueResults,
  useBench,
  useClientState,
  useWorld,
} from "../lib/store.js";
import { Button, Badge, cx } from "../components/ui.js";
import { Portrait } from "../components/portrait.js";
import { mediaUrl } from "../lib/media.js";
import {
  ReferencePickerDialog,
  carriedForPicker,
  sessionPickerSources,
  worldPickerSources,
} from "../components/reference-picker.js";

/**
 * The bench (issue 305; design 68b/68c): one picture or one shot made with no production
 * waiting on it. A session, not a dialog — leaving does not end it, takes are numbered in the
 * order asked for, and selecting an old take restores the request that made it.
 */
export function BenchScreen() {
  const { worldId, sessionId } = useParams();
  const navigate = useNavigate();
  const world = useWorld();
  const bench = useBench();
  const state = useClientState();

  // Open (or resume) on arrival; put the session id in the URL once it is known, so the
  // address is durable and Activity can return here (issue 305 §8).
  useEffect(() => {
    if (worldId) sendBenchOpen(worldId, sessionId);
  }, [worldId, sessionId]);
  useEffect(() => {
    if (worldId && bench && bench.worldId === worldId && sessionId === undefined) {
      void navigate(`/w/${worldId}/artifacts/bench/${bench.session.id}`, { replace: true });
    }
  }, [worldId, sessionId, bench, navigate]);

  const session = bench !== null && bench.worldId === worldId ? bench.session : null;
  if (!worldId || !world || !session) {
    return (
      <div data-screen="bench" style={{ padding: 40 }}>
        <p style={{ color: "var(--muted-foreground)" }}>Opening the bench…</p>
      </div>
    );
  }
  return <BenchWorkspace key={session.id} worldId={worldId} session={session} manifest={state?.app.manifest ?? null} />;
}

function BenchWorkspace({
  worldId,
  session,
  manifest,
}: {
  worldId: string;
  session: BenchSession;
  manifest: NonNullable<ReturnType<typeof useClientState>>["app"]["manifest"] | null;
}) {
  const world = useWorld();
  const state = useClientState();
  const worldSlug = world?.meta.slug;

  // ---- the composer draft: local while typing, pushed debounced, restored by selection ----
  const [draft, setDraft] = useState(() => ({
    mode: session.composer.mode,
    provider: session.composer.provider,
    model: session.composer.model,
    params: session.composer.params,
    brief: session.composer.brief,
  }));
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compose = (next: typeof draft) => {
    setDraft(next);
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => {
      sendBenchCompose(worldId, session.id, next);
    }, 350);
  };
  useEffect(() => () => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
  }, []);

  const models = useMemo(() => {
    const disabled = new Set(state?.app.models.disabled ?? []);
    return (manifest?.models ?? []).filter((m) => m.capability === draft.mode && !disabled.has(m.id));
  }, [manifest, draft.mode, state?.app.models.disabled]);
  const model: ManifestModel | null =
    models.find((m) => m.id === draft.model && m.provider === draft.provider) ?? null;

  // ---- references ----
  const worldSources = useMemo(() => worldPickerSources(world?.artifacts ?? [], session), [world?.artifacts, session]);
  const sessionSources = useMemo(() => sessionPickerSources(session), [session]);
  const carried = useMemo(
    () => carriedForPicker(session, worldSources, sessionSources),
    [session, worldSources, sessionSources],
  );
  const [pickerOpen, setPickerOpen] = useState(false);

  // ---- dispatch + its refusal ----
  const [refusal, setRefusal] = useState<string | null>(null);
  const pendingDispatch = useRef<string | null>(null);
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pendingDispatch.current) return;
        pendingDispatch.current = null;
        setRefusal(result.disposition === "rejected" ? (result.failures[0]?.reason ?? "That could not be dispatched.") : null);
      }),
    [],
  );

  // ---- selection ----
  const selected: BenchTake | null =
    session.takes.find((t) => t.id === session.selectedTakeId) ?? session.takes[session.takes.length - 1] ?? null;
  const jobs = new Map((state?.app.jobs ?? []).map((j) => [j.id, j]));
  /** The queue's own vocabulary, live — the durable log only records terminal states. */
  const liveStatus = (take: BenchTake): BenchTake["status"] => {
    const job = take.jobId ? jobs.get(take.jobId) : undefined;
    return job ? job.status : take.status;
  };

  const [wallFilter, setWallFilter] = useState<"all" | "filed" | "discarded">("all");
  const wallTakes = session.takes.filter(
    (t) =>
      t.clearedFromView !== true &&
      (wallFilter === "all" ? true : wallFilter === "filed" ? t.disposition === "filed" : t.disposition === "discarded"),
  );

  const restore = (take: BenchTake) => {
    sendBenchSelectTake(worldId, session.id, take.id);
    // Selection restores the immutable snapshot into the composer (issue 305 §3).
    compose({
      mode: take.request.mode,
      provider: take.request.provider,
      model: take.request.model,
      params: take.request.params,
      brief: take.request.brief,
    });
  };

  // ---- the estimate, from the manifest row and the controls above it ----
  const estimate = useMemo(() => {
    if (!model) return null;
    if (draft.params.kind === "image") {
      const output = imageOutputFor(model, {
        landscape: true,
        ...(draft.params.tier !== undefined ? { tier: draft.params.tier } : {}),
        ...(draft.params.aspect !== undefined ? { aspect: draft.params.aspect } : {}),
      });
      const each = estimateMicroUsd(model, {
        images: 1,
        megapixels: (output.width * output.height) / 1_000_000,
        referenceImages: carried.length,
        ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
      });
      return each * draft.params.count;
    }
    const seconds = draft.params.durationSec ?? model.limits.maxDurationSec ?? 5;
    return estimateMicroUsd(model, {
      durationSec: pricedDuration(model, seconds),
      ...(draft.params.resolution !== undefined ? { resolution: draft.params.resolution } : {}),
    });
  }, [model, draft.params, carried.length]);

  const promptCap = model?.limits.maxPromptChars;
  const overCap = promptCap !== undefined && draft.brief.length > promptCap;

  const switchMode = (mode: "image" | "video") => {
    if (mode === draft.mode) return;
    const disabled = new Set(state?.app.models.disabled ?? []);
    const first = (manifest?.models ?? []).find((m) => m.capability === mode && !disabled.has(m.id));
    const params: BenchParams = mode === "image" ? { kind: "image", count: 1 } : { kind: "video" };
    compose({
      ...draft,
      mode,
      params,
      provider: first?.provider ?? "",
      model: first?.id ?? "",
    });
  };

  return (
    <div
      data-screen="bench"
      style={{
        display: "grid",
        gridTemplateColumns: "380px minmax(0, 1fr) 116px",
        gap: 0,
        height: "calc(100vh - 44px)",
        minHeight: 0,
      }}
    >
      {/* ---- composer ---------------------------------------------------- */}
      <div style={{ borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", minHeight: 0, padding: "12px 14px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="fy-filterrow" style={{ marginTop: 0 }}>
            {(["image", "video"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                className={cx("fy-filterchip", draft.mode === mode && "fy-filterchip--active")}
                onClick={() => switchMode(mode)}
              >
                {mode === "image" ? "Image" : "Video"}
              </button>
            ))}
          </div>
          <span style={{ flex: 1 }} />
          <input
            aria-label="Session title"
            className="scr-input"
            style={{ width: 150, height: 28, font: "500 12px var(--font-sans)" }}
            placeholder="Untitled session"
            defaultValue={session.title ?? ""}
            onBlur={(e) => {
              const title = e.target.value.trim();
              if (title !== (session.title ?? "")) sendBenchTitle(worldId, session.id, title.length > 0 ? title : null);
            }}
          />
          <button
            type="button"
            className="fy-filterchip"
            title="Clear the bench — a new session; this one keeps running"
            onClick={() => sendBenchNewSession(worldId)}
          >
            ⟲
          </button>
        </div>

        {/* reference tiles */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 12 }}>
          {session.composer.activeTokens.map((token) => {
            const source = [...worldSources, ...sessionSources].find((s) => s.existingToken === token);
            return (
              <div key={token} style={{ position: "relative", height: 66, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
                {source?.imagePath ? (
                  <Portrait worldSlug={worldSlug} path={source.imagePath} label={token} radius={0} />
                ) : (
                  <div style={{ width: "100%", height: "100%", background: "var(--muted)", display: "flex", alignItems: "center", justifyContent: "center", font: "400 10px var(--font-mono)", color: "var(--muted-foreground)" }}>
                    {source?.kind ?? "missing"}
                  </div>
                )}
                <span style={{ position: "absolute", left: 5, bottom: 5, padding: "2px 6px", borderRadius: 5, background: "color-mix(in srgb, var(--media-overlay-bg) 66%, transparent)", color: "var(--media-overlay-fg)", font: "500 9.5px var(--font-sans)" }}>
                  {token}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${token}`}
                  onClick={() => sendBenchRemoveReference(worldId, session.id, token)}
                  style={{ position: "absolute", right: 3, top: 3, width: 18, height: 18, borderRadius: 5, border: 0, background: "color-mix(in srgb, var(--media-overlay-bg) 66%, transparent)", color: "var(--media-overlay-fg)", cursor: "pointer", font: "400 11px var(--font-sans)" }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            data-testid="bench-add-reference"
            style={{ height: 66, border: "1.5px dashed var(--neutral-300)", borderRadius: 8, background: "transparent", color: "var(--muted-foreground)", font: "400 10.5px var(--font-sans)", cursor: "pointer" }}
          >
            Reference
          </button>
        </div>

        {/* brief */}
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", marginTop: 11, border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
          <textarea
            aria-label="Brief"
            value={draft.brief}
            onChange={(e) => compose({ ...draft, brief: e.target.value })}
            placeholder="Say what to make. Reference tokens — Image 1, Audio 2 — may be cited by name."
            style={{ flex: 1, minHeight: 120, resize: "none", border: 0, outline: "none", padding: "11px 12px", font: "400 12px/1.65 var(--font-sans)", background: "var(--background)", color: "var(--foreground)" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderTop: "1px solid var(--border)" }}>
            <span style={{ flex: 1 }} />
            {/* The counter exists only where the model publishes a cap (issue 305 §5.1). */}
            {promptCap !== undefined && (
              <span data-testid="prompt-counter" style={{ font: "400 10.5px var(--font-mono)", color: overCap ? "var(--destructive)" : "var(--muted-foreground)" }}>
                {`${draft.brief.length}/${promptCap}`}
              </span>
            )}
          </div>
        </div>

        {/* the mode's settings row */}
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 10, flexWrap: "wrap" }}>
          {model && draft.params.kind === "image" && (
            <>
              {tiersFor(model).length > 0 && (
                <select
                  aria-label="Size"
                  className="scr-input"
                  style={{ height: 26, font: "400 10.5px var(--font-mono)" }}
                  value={draft.params.tier ?? ""}
                  onChange={(e) =>
                    compose({
                      ...draft,
                      params: { ...draft.params, kind: "image", ...(e.target.value ? { tier: e.target.value as SizeTier } : {}) } as BenchParams,
                    })
                  }
                >
                  <option value="">size · default</option>
                  {tiersFor(model).map((tier) => (
                    <option key={tier} value={tier}>
                      {tier}
                    </option>
                  ))}
                </select>
              )}
              <span style={{ display: "inline-flex", gap: 3 }} role="group" aria-label="How many takes">
                {[1, 2, 3, 4].map((count) => (
                  <button
                    key={count}
                    type="button"
                    className={cx("fy-filterchip", draft.params.kind === "image" && draft.params.count === count && "fy-filterchip--active")}
                    onClick={() => compose({ ...draft, params: { ...draft.params, kind: "image", count } as BenchParams })}
                  >
                    {count}
                  </button>
                ))}
              </span>
            </>
          )}
          {model && draft.params.kind === "video" && (
            <>
              {(model.limits.resolutions ?? []).length > 0 && (
                <select
                  aria-label="Resolution"
                  className="scr-input"
                  style={{ height: 26, font: "400 10.5px var(--font-mono)" }}
                  value={draft.params.resolution ?? ""}
                  onChange={(e) =>
                    compose({
                      ...draft,
                      params: { ...draft.params, kind: "video", ...(e.target.value ? { resolution: e.target.value } : {}) } as BenchParams,
                    })
                  }
                >
                  <option value="">resolution · default</option>
                  {(model.limits.resolutions ?? []).map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              )}
              {durationOptions(model).length > 0 && (
                <select
                  aria-label="Duration"
                  className="scr-input"
                  style={{ height: 26, font: "400 10.5px var(--font-mono)" }}
                  value={draft.params.durationSec ?? ""}
                  onChange={(e) =>
                    compose({
                      ...draft,
                      params: {
                        ...draft.params,
                        kind: "video",
                        ...(e.target.value ? { durationSec: Number(e.target.value) } : {}),
                      } as BenchParams,
                    })
                  }
                >
                  <option value="">length · default</option>
                  {durationOptions(model).map((s) => (
                    <option key={s} value={s}>
                      {s}s
                    </option>
                  ))}
                </select>
              )}
            </>
          )}
        </div>

        {/* dispatch row */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 11 }}>
          <select
            aria-label="Model"
            className="scr-input"
            style={{ height: 30, maxWidth: 170, font: "500 12px var(--font-sans)" }}
            value={model ? `${model.provider}/${model.id}` : ""}
            onChange={(e) => {
              const chosen = models.find((m) => `${m.provider}/${m.id}` === e.target.value);
              if (chosen) compose({ ...draft, provider: chosen.provider, model: chosen.id });
            }}
          >
            <option value="" disabled>
              choose a model
            </option>
            {models.map((m) => (
              <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                {m.displayName}
              </option>
            ))}
          </select>
          <span style={{ flex: 1 }} />
          {estimate !== null && (
            <span data-testid="bench-estimate" style={{ font: "400 11px var(--font-mono)", color: "var(--muted-foreground)" }}>
              {`~${formatMicroUsd(estimate)}`}
            </span>
          )}
          <Button
            data-testid="bench-generate"
            disabled={model === null || draft.brief.trim().length === 0 || overCap || pendingDispatch.current !== null}
            onClick={() => {
              setRefusal(null);
              if (pushTimer.current) clearTimeout(pushTimer.current);
              sendBenchCompose(worldId, session.id, draft);
              pendingDispatch.current = sendBenchDispatch(worldId, session.id);
            }}
          >
            {draft.params.kind === "image" && draft.params.count > 1 ? `Generate ${draft.params.count}` : "Generate"}
          </Button>
        </div>
        {refusal !== null && (
          <p role="alert" style={{ margin: "8px 0 0", font: "400 11.5px var(--font-sans)", color: "var(--destructive)" }}>
            {refusal}
          </p>
        )}
      </div>

      {/* ---- the wall ----------------------------------------------------- */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, background: "var(--muted)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 14px 8px" }}>
          {(["all", "filed", "discarded"] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={cx("fy-filterchip", wallFilter === f && "fy-filterchip--active")}
              onClick={() => setWallFilter(f)}
            >
              {f === "all" ? "All" : f === "filed" ? "Filed" : "Discarded"}
            </button>
          ))}
          <span style={{ flex: 1 }} />
          {selected && (
            <span style={{ font: "400 11px var(--font-mono)", color: "var(--muted-foreground)" }}>
              {`take ${selected.n} · ${selected.request.model} · ${liveStatus(selected)}`}
            </span>
          )}
        </div>

        {selected && selected.media ? (
          <div style={{ flex: 1, minHeight: 0, margin: "0 14px", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--neutral-950)", position: "relative" }}>
            {selected.request.mode === "video" ? (
              worldSlug ? (
                <video
                  key={selected.id}
                  src={mediaUrl(worldSlug, `.sessions/${session.id}/media/${selected.id}/${selected.media.file}`)}
                  controls
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
              ) : null
            ) : (
              <Portrait
                worldSlug={worldSlug}
                path={`.sessions/${session.id}/media/${selected.id}/${selected.media.file}`}
                label={`Take ${selected.n}`}
                radius={0}
              />
            )}
            <div style={{ position: "absolute", left: 12, top: 12, display: "flex", gap: 7 }}>
              <span style={{ padding: "3px 9px", borderRadius: 999, background: "color-mix(in srgb, var(--media-overlay-bg) 66%, transparent)", color: "var(--media-overlay-fg)", font: "500 9.5px var(--font-mono)", letterSpacing: ".1em" }}>
                {`TAKE ${selected.n}`}
              </span>
              {selected.cost && (
                <span style={{ padding: "3px 9px", borderRadius: 999, background: "color-mix(in srgb, var(--media-overlay-bg) 66%, transparent)", color: "var(--media-overlay-fg)", font: "400 9.5px var(--font-mono)" }}>
                  {formatMicroUsd(selected.cost.actualMicroUsd ?? selected.cost.estimatedMicroUsd)}
                </span>
              )}
            </div>
          </div>
        ) : (
          <div style={{ flex: 1, minHeight: 0, margin: "0 14px", border: "1px dashed var(--border)", borderRadius: 12, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, textAlign: "center", padding: 24 }}>
            <strong style={{ font: "600 15px var(--font-sans)" }}>
              {selected ? statusLine(liveStatus(selected), selected) : "The bench is empty"}
            </strong>
            {selected?.error !== undefined && (
              <span style={{ font: "400 11.5px var(--font-sans)", color: "var(--destructive)", maxWidth: 420 }}>{selected.error}</span>
            )}
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px 12px" }}>
          {selected && (
            <>
              <Button variant="ghost" onClick={() => restore(selected)} title="Restore this take's brief and settings">
                Restore brief
              </Button>
              <Button variant="ghost" onClick={() => (pendingDispatch.current = sendBenchRerun(worldId, session.id, selected.id))}>
                Re-run
              </Button>
              <Button variant="ghost" onClick={() => sendBenchClearView(worldId, session.id, selected.id)}>
                Clear from view
              </Button>
            </>
          )}
          <span style={{ flex: 1 }} />
          {selected && selected.disposition === "filed" && <Badge tone="neutral">filed as artifact</Badge>}
          {selected && selected.disposition === "discarded" && <Badge tone="neutral">discarded</Badge>}
          {selected && selected.disposition === "open" && selected.media && (
            <>
              <Button variant="outline" onClick={() => sendBenchDiscard(worldId, session.id, selected.id)}>
                Discard
              </Button>
              <Button data-testid="bench-keep" onClick={() => sendBenchKeep(worldId, session.id, selected.id)}>
                Keep · file as artifact
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ---- the strip ---------------------------------------------------- */}
      <div style={{ borderLeft: "1px solid var(--border)", padding: 8, display: "flex", flexDirection: "column", gap: 6, overflowY: "auto" }}>
        {wallTakes.map((take) => {
          const status = liveStatus(take);
          return (
            <button
              key={take.id}
              type="button"
              data-testid="strip-take"
              onClick={() => sendBenchSelectTake(worldId, session.id, take.id)}
              style={{ display: "flex", alignItems: "center", gap: 6, background: "transparent", border: 0, padding: 0, cursor: "pointer" }}
            >
              <span style={{ width: 16, textAlign: "right", font: `${take.id === selected?.id ? 500 : 400} 10px var(--font-mono)`, color: take.id === selected?.id ? "var(--foreground)" : "var(--neutral-400)" }}>
                {take.n}
              </span>
              <span
                style={{
                  position: "relative",
                  flex: 1,
                  height: 34,
                  borderRadius: 5,
                  overflow: "hidden",
                  border: take.id === selected?.id ? "2px solid var(--foreground)" : "1px solid var(--border)",
                  background: "var(--muted)",
                }}
              >
                {take.media ? (
                  <Portrait
                    worldSlug={worldSlug}
                    path={`.sessions/${session.id}/media/${take.id}/${take.media.file}`}
                    label={`take ${take.n}`}
                    radius={0}
                  />
                ) : (
                  <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", font: "400 8.5px var(--font-mono)", color: status === "failed" || status === "needs-reconciliation" ? "var(--destructive)" : "var(--neutral-400)" }}>
                    {status === "allocating" || status === "queued" ? "queued" : status}
                  </span>
                )}
              </span>
            </button>
          );
        })}
        {wallTakes.length === 0 && (
          <span style={{ font: "400 9.5px var(--font-mono)", color: "var(--neutral-400)", textAlign: "center", marginTop: 8 }}>
            takes land here
          </span>
        )}
      </div>

      <ReferencePickerDialog
        open={pickerOpen}
        mode="bench"
        worldSlug={worldSlug}
        model={model}
        carried={carried}
        world={worldSources}
        session={sessionSources}
        onAdd={(pick, replace) => {
          sendBenchAddReference(worldId, session.id, pick, replace);
        }}
        onUpload={() => {
          sendBenchUploadReferences(worldId, session.id);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}

function statusLine(status: BenchTake["status"], take: BenchTake): string {
  switch (status) {
    case "allocating":
    case "queued":
      return `Take ${take.n} is queued`;
    case "submitting":
    case "running":
      return `Take ${take.n} is running`;
    case "failed":
      return `Take ${take.n} failed`;
    case "cancelled":
      return `Take ${take.n} was cancelled`;
    case "needs-reconciliation":
      return `Take ${take.n} needs reconciliation — see Activity`;
    default:
      return `Take ${take.n}`;
  }
}
