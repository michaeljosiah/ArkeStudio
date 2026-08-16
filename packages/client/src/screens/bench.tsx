import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import {
  estimateMicroUsd,
  formatMicroUsd,
  frameTaskModes,
  imageOutputFor,
  durationOptions,
  keyframeCapacity,
  keyframePlan,
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
import { ComposerMic } from "../components/dictation.js";
import {
  Book,
  ChevronDown,
  Expand,
  Film,
  Folder,
  Home,
  ImageMark,
  Message,
  Plus,
  Scroll,
  User,
  VideoMark,
  Wand,
  X,
} from "../components/icons.js";
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
 * Layout is the master's: a fixed workspace with its own breadcrumb chrome — a 44px
 * destination rail, a 380px composer, the wall, a 116px take strip — never the
 * hero-and-scroll shape the world pages use.
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

/** The 44px destination rail (issue 305 §3): the world's places, by mark alone. */
const DESTINATIONS = [
  ["", "Overview", Home],
  ["art-direction", "Art direction", Wand],
  ["cast", "Cast", User],
  ["bible", "Bible", Book],
  ["canon", "Canon", Scroll],
  ["chat", "World Chat", Message],
  ["artifacts", "Artifacts", Folder],
  ["productions", "Productions", Film],
] as const;

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
  const navigate = useNavigate();
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
  const modelName = (provider: string, id: string): string =>
    manifest?.models.find((m) => m.provider === provider && m.id === id)?.displayName ?? id;

  // ---- references ----
  const worldSources = useMemo(() => worldPickerSources(world?.artifacts ?? [], session), [world?.artifacts, session]);
  const sessionSources = useMemo(() => sessionPickerSources(session), [session]);
  // The same rows with the OTHER lane's occupancy: what already rides as a keyframe.
  const worldFrameSources = useMemo(
    () => worldPickerSources(world?.artifacts ?? [], session, "keyframe"),
    [world?.artifacts, session],
  );
  const sessionFrameSources = useMemo(() => sessionPickerSources(session, "keyframe"), [session]);
  const carried = useMemo(
    () => carriedForPicker(session, worldSources, sessionSources),
    [session, worldSources, sessionSources],
  );
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Which lane the open picker fills — the tabs choose what a picked picture is FOR. */
  const [pickerLane, setPickerLane] = useState<"reference" | "keyframe">("reference");
  const openPicker = (l: "reference" | "keyframe") => {
    setPickerLane(l);
    setPickerOpen(true);
  };

  // ---- the Keyframe lane (issue 305 §3): exists only where the model verifies a frame mode ----
  const frameModes = useMemo(
    () => (model !== null && draft.mode === "video" ? frameTaskModes(model) : []),
    [model, draft.mode],
  );
  const frames = session.composer.keyframeTokens;
  const [lane, setLane] = useState<"reference" | "keyframe">("reference");
  useEffect(() => {
    if (frameModes.length === 0 && lane === "keyframe") setLane("reference");
  }, [frameModes.length, lane]);

  // ---- the breadcrumb's session switcher + the brief's expanded editor ----
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [briefExpanded, setBriefExpanded] = useState(false);
  const briefUnder = useRef<HTMLDivElement>(null);
  const tokens = useMemo(() => new Set(session.tokenRegistry.map((e) => e.token)), [session.tokenRegistry]);

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

  // 4K joins the wall only when the session has video to answer for it (issue 305 §3).
  const hasVideoTakes = session.takes.some((t) => t.request.mode === "video");
  const [wallFilter, setWallFilter] = useState<"all" | "filed" | "discarded" | "4k">("all");
  const wallTakes = session.takes.filter(
    (t) =>
      t.clearedFromView !== true &&
      (wallFilter === "all"
        ? true
        : wallFilter === "filed"
          ? t.disposition === "filed"
          : wallFilter === "discarded"
            ? t.disposition === "discarded"
            : is4k(t)),
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

  const aspects = model?.limits.aspects ?? [];
  const aspectSelect = (
    <select
      aria-label="Aspect"
      className="fy-bench__chip"
      value={draft.params.aspect ?? ""}
      onChange={(e) => {
        // "default" means the key is absent, not the old value carried under a new label.
        const { aspect: _cleared, ...rest } = draft.params;
        compose({ ...draft, params: { ...rest, ...(e.target.value ? { aspect: e.target.value } : {}) } as BenchParams });
      }}
    >
      <option value="">aspect · default</option>
      {aspects.map((a) => (
        <option key={a} value={a}>
          {a}
        </option>
      ))}
    </select>
  );

  return (
    <div data-screen="bench" style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <AppChrome
        back={{ label: world?.meta.name ?? "Artifacts", to: `/w/${worldId}/artifacts` }}
        menu={
          <span className="fy-bench__crumb">
            <span className="fy-bench__crumbsep">/</span>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <button
                type="button"
                className="fy-bench__session"
                aria-expanded={sessionsOpen}
                onClick={() => setSessionsOpen((v) => !v)}
              >
                {session.title ?? "Untitled session"}
                <ChevronDown size={12} />
              </button>
              {sessionsOpen && (
                <>
                  <div className="fy-bench__scrim" onClick={() => setSessionsOpen(false)} />
                  <div className="fy-bench__sessionmenu" role="menu" aria-label="Bench sessions">
                    <input
                      aria-label="Session title"
                      className="fy-bench__rename"
                      placeholder="Name this session"
                      defaultValue={session.title ?? ""}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                      }}
                      onBlur={(e) => {
                        const title = e.target.value.trim();
                        if (title !== (session.title ?? "")) sendBenchTitle(worldId, session.id, title.length > 0 ? title : null);
                      }}
                    />
                    {(world?.benchSessions ?? []).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="fy-bench__sessionrow"
                        aria-current={s.id === session.id}
                        onClick={() => {
                          setSessionsOpen(false);
                          if (s.id === session.id) return;
                          // The open is sent here, not left to the URL effect: the address may
                          // already read this id (the workspace moved on without it), and a
                          // same-path navigate re-fires nothing.
                          sendBenchOpen(worldId, s.id);
                          void navigate(`/w/${worldId}/artifacts/bench/${s.id}`, { replace: true });
                        }}
                      >
                        <span className="fy-bench__sessionname">{s.title ?? "Untitled session"}</span>
                        <span className="fy-bench__sessionmeta">
                          {`${s.takeCount} take${s.takeCount === 1 ? "" : "s"}`}
                        </span>
                      </button>
                    ))}
                    <button
                      type="button"
                      className="fy-bench__sessionrow fy-bench__sessionrow--new"
                      onClick={() => {
                        setSessionsOpen(false);
                        sendBenchNewSession(worldId);
                        // Back to the id-less address: the fresh session's id fills it in when
                        // the workspace arrives, so the URL never names a session it left.
                        void navigate(`/w/${worldId}/artifacts/bench`, { replace: true });
                      }}
                    >
                      <Plus size={12} />
                      New session
                    </button>
                  </div>
                </>
              )}
            </span>
          </span>
        }
      />
      <div className="fy-bench">
        {/* ---- the destination rail --------------------------------------- */}
        <nav className="fy-bench__rail" aria-label="World destinations">
          <button
            type="button"
            className="fy-bench__railnew"
            title="Clear the bench — a new session; this one keeps running"
            onClick={() => {
              sendBenchNewSession(worldId);
              void navigate(`/w/${worldId}/artifacts/bench`, { replace: true });
            }}
          >
            <Plus size={14} />
          </button>
          {DESTINATIONS.map(([slug, label, Mark]) => (
            <button
              key={slug}
              type="button"
              className="fy-bench__raildest"
              aria-current={slug === "artifacts"}
              title={label}
              onClick={() => void navigate(`/w/${worldId}${slug ? `/${slug}` : ""}`)}
            >
              <Mark size={15} />
            </button>
          ))}
        </nav>

        {/* ---- composer -------------------------------------------------- */}
        <div className="fy-bench__composer">
          <div className="fy-bench__composerbar">
            <div className="fy-bench__mode" role="group" aria-label="What to make">
              {(["image", "video"] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={draft.mode === mode} onClick={() => switchMode(mode)}>
                  {mode === "image" ? <ImageMark size={13} /> : <VideoMark size={13} />}
                  {mode === "image" ? "Image" : "Video"}
                </button>
              ))}
            </div>
            <span style={{ flex: 1 }} />
            <button
              type="button"
              className="fy-bench__clear"
              title="Clear the bench — a new session; this one keeps running"
              onClick={() => sendBenchNewSession(worldId)}
            >
              ⟲
            </button>
          </div>

          {/* The lane tabs (issue 305 §3): Keyframe exists only where the model verifies a
              frame task mode; a model that takes no keyframes shows no tab, and the composer
              says so in a line rather than a tooltip (design 68b's dv-rule). */}
          {frameModes.length > 0 && (
            <div className="fy-bench__lanes" role="tablist" aria-label="What the pictures are for">
              {(["reference", "keyframe"] as const).map((l) => (
                <button
                  key={l}
                  type="button"
                  role="tab"
                  aria-selected={lane === l}
                  onClick={() => setLane(l)}
                >
                  {l === "reference" ? "Reference" : "Keyframe"}
                </button>
              ))}
            </div>
          )}
          {draft.mode === "video" && model !== null && frameModes.length === 0 && (
            <p className="fy-bench__nolane">{`${model.displayName} takes no keyframes.`}</p>
          )}

          {/* reference tiles */}
          {lane === "reference" && (
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
                onClick={() => openPicker("reference")}
                data-testid="bench-add-reference"
              >
                <ImageMark size={14} />
                Reference
              </button>
            </div>
          )}

          {/* keyframe tiles — the pictures the shot must pass through, in order */}
          {lane === "keyframe" && (
            <>
              <div className="fy-bench__refgrid" data-testid="keyframe-lane">
                {frames.map((token, index) => {
                  const source = [...worldSources, ...sessionSources].find((s) => s.existingToken === token);
                  return (
                    <div key={token} className="fy-bench__reftile">
                      {source?.imagePath ? (
                        <Portrait worldSlug={worldSlug} path={source.imagePath} label={token} radius={0} />
                      ) : (
                        <span className="fy-bench__takestate">{source?.kind ?? "missing"}</span>
                      )}
                      {frames.length <= 2 && (
                        <span className="fy-bench__slotchip">{index === 0 ? "start" : "end"}</span>
                      )}
                      <span className="fy-bench__tokenchip">{token}</span>
                      <button
                        type="button"
                        className="fy-bench__tokenremove"
                        aria-label={`Remove ${token} from the keyframes`}
                        onClick={() => sendBenchRemoveReference(worldId, session.id, token, "keyframe")}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
                {/* At the lane's ceiling the tile leaves — absent, not disabled (§3). */}
                {model !== null && frames.length < keyframeCapacity(model) && (
                  <button
                    type="button"
                    className="fy-bench__reftile fy-bench__reftile--add"
                    onClick={() => openPicker("keyframe")}
                    data-testid="bench-add-keyframe"
                  >
                    <ImageMark size={14} />
                    {frames.length === 0 ? "Start frame" : "End frame"}
                  </button>
                )}
              </div>
              {/* The same plan dispatch will run, said before Generate is pressed. */}
              {model !== null && frames.length > 0 && !keyframePlan(model, frames.length).ok && (
                <p className="fy-bench__refusal">
                  {(keyframePlan(model, frames.length) as { ok: false; reason: string }).reason}
                </p>
              )}
            </>
          )}

          {/* brief — tokens the session knows render as chips inline (issue 305 §3) */}
          <div className="fy-bench__brief">
            <div className="fy-bench__briefstack">
              <div ref={briefUnder} className="fy-bench__briefunder" aria-hidden>
                {briefWithChips(draft.brief, tokens)}
                {"​"}
              </div>
              <textarea
                aria-label="Brief"
                className="fy-bench__brieftext"
                value={draft.brief}
                onChange={(e) => compose({ ...draft, brief: e.target.value })}
                onScroll={(e) => {
                  if (briefUnder.current) briefUnder.current.scrollTop = e.currentTarget.scrollTop;
                }}
                placeholder="Say what to make. Reference tokens — Image 1, Audio 2 — may be cited by name."
              />
            </div>
            <div className="fy-bench__brieffoot">
              <button
                type="button"
                className="fy-bench__footicon"
                title="Write large — the brief in its own window"
                onClick={() => setBriefExpanded(true)}
              >
                <Expand size={13} />
              </button>
              <ComposerMic onText={(text) => compose({ ...draft, brief: draft.brief.length > 0 ? `${draft.brief}\n${text}` : text })} />
              <span style={{ flex: 1 }} />
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
            <button type="button" className="fy-bench__chip fy-bench__chip--refs" onClick={() => openPicker("reference")}>
              <Plus size={11} />
              References
            </button>
            {model && draft.params.kind === "image" && (
              <>
                {aspects.length > 0 && aspectSelect}
                {tiersFor(model).length > 0 && (
                  <select
                    aria-label="Size"
                    className="fy-bench__chip"
                    value={draft.params.tier ?? ""}
                    onChange={(e) => {
                      const { tier: _cleared, ...rest } = draft.params as BenchParams & { tier?: SizeTier };
                      compose({ ...draft, params: { ...rest, ...(e.target.value ? { tier: e.target.value as SizeTier } : {}) } as BenchParams });
                    }}
                  >
                    <option value="">size · default</option>
                    {tiersFor(model).map((tier) => (
                      <option key={tier} value={tier}>
                        {tier}
                      </option>
                    ))}
                  </select>
                )}
                <select
                  aria-label="How many takes"
                  className="fy-bench__chip"
                  value={draft.params.count}
                  onChange={(e) => compose({ ...draft, params: { ...draft.params, kind: "image", count: Number(e.target.value) } as BenchParams })}
                >
                  {[1, 2, 3, 4].map((count) => (
                    <option key={count} value={count}>
                      {count === 1 ? "1 take" : `${count} takes`}
                    </option>
                  ))}
                </select>
              </>
            )}
            {model && draft.params.kind === "video" && (
              <>
                {aspects.length > 0 && aspectSelect}
                {(model.limits.resolutions ?? []).length > 0 && (
                  <select
                    aria-label="Resolution"
                    className="fy-bench__chip"
                    value={draft.params.resolution ?? ""}
                    onChange={(e) => {
                      const { resolution: _cleared, ...rest } = draft.params as BenchParams & { resolution?: string };
                      compose({ ...draft, params: { ...rest, ...(e.target.value ? { resolution: e.target.value } : {}) } as BenchParams });
                    }}
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
                    onChange={(e) => {
                      const { durationSec: _cleared, ...rest } = draft.params as BenchParams & { durationSec?: number };
                      compose({ ...draft, params: { ...rest, ...(e.target.value ? { durationSec: Number(e.target.value) } : {}) } as BenchParams });
                    }}
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
            <span className="fy-bench__modelwrap">
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
              <ChevronDown size={12} />
            </span>
            <span style={{ flex: 1 }} />
            {estimate !== null && (
              <span data-testid="bench-estimate" className="fy-bench__estimate">
                {`~${formatMicroUsd(estimate)}`}
              </span>
            )}
            <Button
              variant="primary"
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
            {(["all", "filed", "discarded", ...(hasVideoTakes ? (["4k"] as const) : [])] as const).map((f) => (
              <button
                key={f}
                type="button"
                className={cx("fy-bench__tab", wallFilter === f && "fy-bench__tab--active")}
                onClick={() => setWallFilter(f)}
              >
                {f === "all" ? "All" : f === "filed" ? "Filed" : f === "discarded" ? "Discarded" : "4K"}
              </button>
            ))}
          </div>

          {/* The selected take's request, said back (design 68b): model · brief, then its
              actions as quiet marks — restore, re-run, clear from view. */}
          {selected && (
            <div className="fy-bench__briefrow">
              <span className="fy-bench__briefline">
                {`${modelName(selected.request.provider, selected.request.model)} · ${selected.request.brief}`}
              </span>
              <button
                type="button"
                className="fy-bench__rowicon"
                title="Restore this take's brief and settings"
                onClick={() => restore(selected)}
              >
                ⟲
              </button>
              <button
                type="button"
                className="fy-bench__rowicon"
                title="Re-run — a new take from this snapshot"
                onClick={() => (pendingDispatch.current = sendBenchRerun(worldId, session.id, selected.id))}
              >
                ↻
              </button>
              <button
                type="button"
                className="fy-bench__rowicon"
                title="Clear from view — the take keeps its number"
                onClick={() => sendBenchClearView(worldId, session.id, selected.id)}
              >
                <X size={12} />
              </button>
            </div>
          )}

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
                worldSlug ? (
                  <img
                    src={mediaUrl(worldSlug, `.sessions/${session.id}/media/${selected.id}/${selected.media.file}`)}
                    alt={`Take ${selected.n}`}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                ) : null
              )}
              <div className="fy-bench__overlaychips">
                <span className="fy-bench__overlaychip fy-bench__overlaychip--name">{`TAKE ${selected.n}`}</span>
                {takeMeta(selected).length > 0 && <span className="fy-bench__overlaychip">{takeMeta(selected)}</span>}
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
            <span style={{ flex: 1 }} />
            {selected && selected.disposition === "filed" && <Badge tone="neutral">filed as artifact</Badge>}
            {selected && selected.disposition === "discarded" && <Badge tone="neutral">discarded</Badge>}
            {selected && selected.disposition === "open" && selected.media && (
              <>
                <Button variant="outline" onClick={() => sendBenchDiscard(worldId, session.id, selected.id)}>
                  Discard
                </Button>
                <Button variant="primary" data-testid="bench-keep" onClick={() => sendBenchKeep(worldId, session.id, selected.id)}>
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

        {pickerLane === "reference" ? (
          <ReferencePickerDialog
            open={pickerOpen}
            mode="bench"
            worldSlug={worldSlug}
            model={model}
            carried={carried}
            world={worldSources}
            session={sessionSources}
            onAdd={(picks) => {
              sendBenchAddReference(worldId, session.id, picks);
            }}
            onUpload={() => {
              sendBenchUploadReferences(worldId, session.id);
            }}
            onClose={() => setPickerOpen(false)}
          />
        ) : (
          /* The keyframe pick is one slot at a time — start, then end — and frames are not
             budgeted references, so the picker carries no capacity arithmetic here. */
          <ReferencePickerDialog
            open={pickerOpen}
            mode="slot"
            title="Add a keyframe"
            note="A frame the shot must pass through — start first, then end."
            only="image"
            budget="none"
            worldSlug={worldSlug}
            model={model}
            carried={carried}
            world={worldFrameSources}
            session={sessionFrameSources}
            onChoose={(pick) => {
              sendBenchAddReference(worldId, session.id, [{ pick }], "keyframe");
              setPickerOpen(false);
            }}
            onUpload={() => {
              sendBenchUploadReferences(worldId, session.id);
            }}
            onClose={() => setPickerOpen(false)}
          />
        )}

        {briefExpanded && (
          <div className="fy-bench__briefmodal" role="dialog" aria-label="The brief, large">
            <div className="fy-bench__briefmodalpanel">
              <textarea
                autoFocus
                aria-label="Brief"
                value={draft.brief}
                onChange={(e) => compose({ ...draft, brief: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setBriefExpanded(false);
                }}
              />
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                {promptCap !== undefined && (
                  <span className={cx("fy-bench__counter", overCap && "fy-bench__counter--over")} style={{ alignSelf: "center" }}>
                    {`${draft.brief.length}/${promptCap}`}
                  </span>
                )}
                <Button variant="ghost" onClick={() => setBriefExpanded(false)}>
                  Done
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function is4k(t: BenchTake): boolean {
  return t.request.params.kind === "video" && /4k|2160/i.test(t.request.params.resolution ?? "");
}

/** The selected take's viewer chip: the request's own facts, nothing invented. */
function takeMeta(take: BenchTake): string {
  return [
    take.request.params.kind === "image" ? take.request.params.tier : take.request.params.resolution,
    take.request.params.aspect,
    take.request.requestedSeed !== undefined ? `seed ${take.request.requestedSeed}` : undefined,
    take.cost ? formatMicroUsd(take.cost.actualMicroUsd ?? take.cost.estimatedMicroUsd) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/** The brief's text with the session's own tokens marked — never token-shaped strangers. */
function briefWithChips(text: string, tokens: Set<string>): ReactNode[] {
  return text
    .split(/((?:Image|Video|Audio) [1-9][0-9]*)/g)
    .map((part, i) =>
      tokens.has(part) ? (
        <mark key={i} className="fy-bench__briefchip">
          {part}
        </mark>
      ) : (
        part
      ),
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
