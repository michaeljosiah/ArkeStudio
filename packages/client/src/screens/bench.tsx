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
import { AppChrome } from "../components/chrome.js";
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
 *
 * Layout is the master's: a fixed workspace with its own breadcrumb chrome — 380px composer,
 * the wall, a 116px take strip — never the hero-and-scroll shape the world pages use.
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
  const latest = session.takes[session.takes.length - 1] ?? null;
  const selected: BenchTake | null = session.takes.find((t) => t.id === session.selectedTakeId) ?? latest;
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
    <div data-screen="bench" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <AppChrome
        back={{ label: "Artifacts", to: `/w/${worldId}/artifacts` }}
        context={{ label: `${world?.meta.name ?? ""} · ${session.title ?? "Untitled session"}` }}
      />
      <div className="fy-bench">
        {/* ---- composer -------------------------------------------------- */}
        <div className="fy-bench__composer">
          <div className="fy-bench__composerbar">
            <div className="fy-bench__mode" role="group" aria-label="What to make">
              {(["image", "video"] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={draft.mode === mode} onClick={() => switchMode(mode)}>
                  {mode === "image" ? "Image" : "Video"}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <input
              aria-label="Session title"
              className="fy-bench__title"
              placeholder="Untitled session"
              defaultValue={session.title ?? ""}
              onBlur={(e) => {
                const title = e.target.value.trim();
                if (title !== (session.title ?? "")) sendBenchTitle(worldId, session.id, title.length > 0 ? title : null);
              }}
            />
            <button
              type="button"
              className="fy-bench__clear"
              title="Clear the bench — a new session; this one keeps running"
              onClick={() => sendBenchNewSession(worldId)}
            >
              ⟲
            </button>
          </div>

          {/* reference tiles */}
          <div className="fy-bench__refgrid">
            {session.composer.activeTokens.map((token) => {
              const source = [...worldSources, ...sessionSources].find((s) => s.existingToken === token);
              return (
                <div key={token} className="fy-bench__reftile">
                  {source?.imagePath ? (
                    <Portrait worldSlug={worldSlug} path={source.imagePath} label={token} radius={0} />
                  ) : (
                    <span className="fy-bench__takestate">{source?.kind ?? "missing"}</span>
                  )}
                  <span className="fy-bench__tokenchip">{token}</span>
                  <button
                    type="button"
                    className="fy-bench__tokenremove"
                    aria-label={`Remove ${token}`}
                    onClick={() => sendBenchRemoveReference(worldId, session.id, token)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              className="fy-bench__reftile fy-bench__reftile--add"
              onClick={() => setPickerOpen(true)}
              data-testid="bench-add-reference"
            >
              Reference
            </button>
          </div>

          {/* brief */}
          <div className="fy-bench__brief">
            <textarea
              aria-label="Brief"
              value={draft.brief}
              onChange={(e) => compose({ ...draft, brief: e.target.value })}
              placeholder="Say what to make. Reference tokens — Image 1, Audio 2 — may be cited by name."
            />
            <div className="fy-bench__brieffoot">
              {/* The counter exists only where the model publishes a cap (issue 305 §5.1). */}
              {promptCap !== undefined && (
                <span data-testid="prompt-counter" className={cx("fy-bench__counter", overCap && "fy-bench__counter--over")}>
                  {`${draft.brief.length}/${promptCap}`}
                </span>
              )}
            </div>
          </div>

          {/* the mode's settings row */}
          <div className="fy-bench__settings">
            {model && draft.params.kind === "image" && (
              <>
                {tiersFor(model).length > 0 && (
                  <select
                    aria-label="Size"
                    className="fy-bench__chip"
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
                <span className="fy-bench__count" role="group" aria-label="How many takes">
                  {[1, 2, 3, 4].map((count) => (
                    <button
                      key={count}
                      type="button"
                      aria-pressed={draft.params.kind === "image" && draft.params.count === count}
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
                    className="fy-bench__chip"
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
                    className="fy-bench__chip"
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
                        {`${s}s`}
                      </option>
                    ))}
                  </select>
                )}
              </>
            )}
          </div>

          {/* dispatch row */}
          <div className="fy-bench__dispatch">
            <select
              aria-label="Model"
              className="fy-bench__model"
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
              <span data-testid="bench-estimate" className="fy-bench__estimate">
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
            <p role="alert" className="fy-bench__refusal">
              {refusal}
            </p>
          )}
        </div>

        {/* ---- the wall --------------------------------------------------- */}
        <div className="fy-bench__wall">
          <div className="fy-bench__wallbar">
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
              <span className="fy-bench__wallmeta">
                {`take ${selected.n} · ${selected.request.model} · ${liveStatus(selected)}`}
              </span>
            )}
          </div>

          {selected && selected.media ? (
            <div className="fy-bench__media">
              {selected.request.mode === "video" ? (
                worldSlug ? (
                  <video
                    key={selected.id}
                    src={mediaUrl(worldSlug, `.sessions/${session.id}/media/${selected.id}/${selected.media.file}`)}
                    controls
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
              <div className="fy-bench__overlaychips">
                <span className="fy-bench__overlaychip fy-bench__overlaychip--name">{`TAKE ${selected.n}`}</span>
                {selected.cost && (
                  <span className="fy-bench__overlaychip">
                    {formatMicroUsd(selected.cost.actualMicroUsd ?? selected.cost.estimatedMicroUsd)}
                  </span>
                )}
              </div>
            </div>
          ) : (
            <div className="fy-bench__empty">
              <strong style={{ font: "600 15px var(--font-sans)" }}>
                {selected ? statusLine(liveStatus(selected), selected) : "The bench is empty"}
              </strong>
              {selected?.error !== undefined && (
                <span style={{ font: "400 11.5px var(--font-sans)", color: "var(--destructive)", maxWidth: 420 }}>{selected.error}</span>
              )}
            </div>
          )}

          {/* View latest returns from a scrolled-back selection (design 68b). */}
          {selected !== null && latest !== null && selected.id !== latest.id && (
            <button type="button" className="fy-bench__viewlatest" onClick={() => sendBenchSelectTake(worldId, session.id, latest.id)}>
              View latest ↓
            </button>
          )}

          <div className="fy-bench__wallactions">
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

        {/* ---- the strip -------------------------------------------------- */}
        <div className="fy-bench__strip">
          {wallTakes.map((take) => {
            const status = liveStatus(take);
            return (
              <button
                key={take.id}
                type="button"
                className="fy-bench__take"
                data-testid="strip-take"
                aria-current={take.id === selected?.id}
                onClick={() => sendBenchSelectTake(worldId, session.id, take.id)}
              >
                <span className="fy-bench__taken">{take.n}</span>
                <span className="fy-bench__takeframe">
                  {take.media ? (
                    <Portrait
                      worldSlug={worldSlug}
                      path={`.sessions/${session.id}/media/${take.id}/${take.media.file}`}
                      label={`take ${take.n}`}
                      radius={0}
                    />
                  ) : (
                    <span
                      className={cx(
                        "fy-bench__takestate",
                        (status === "failed" || status === "needs-reconciliation") && "fy-bench__takestate--failed",
                      )}
                    >
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
