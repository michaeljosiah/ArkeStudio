import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import {
  deriveCapabilityAvailability,
  estimateMicroUsd,
  formatMicroUsd,
  frameTaskModes,
  imageOutputFor,
  durationOptions,
  keyframeAddable,
  keyframeCapacity,
  DELIVERIES,
  keyframePlan,
  modeCapability,
  pricedDuration,
  recipeFault,
  tiersFor,
  type BenchMode,
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
  sendBenchEnhanceBrief,
  sendBenchKeep,
  sendBenchNewSession,
  sendBenchOpen,
  sendBenchRecipeDelete,
  sendBenchRecipeSave,
  sendBenchRemoveReference,
  sendBenchRerun,
  sendBenchSelectTake,
  sendBenchTitle,
  sendBenchUploadReferences,
  subscribeBriefEnhanced,
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
  Speaker,
  Timer,
  Waveform,
  SpeakerOff,
  Sparkle,
  User,
  VideoMark,
  Wand,
  X,
} from "../components/icons.js";
import { Portrait } from "../components/portrait.js";
import { mediaUrl } from "../lib/media.js";
import { durationTrack, durationPillLabel } from "../lib/duration.js";
import { posterNameFor } from "../lib/poster.js";
import { laneRestorePlan } from "../lib/restore.js";
import { setupForMode, type ModeSetup } from "../lib/composer-mode.js";
import { VoicePickerDialog } from "../components/voice-picker.js";
import { usableModels } from "../components/dispatch-bar.js";
import {
  ReferencePickerDialog,
  characterPickerSources,
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
  return (
    <BenchWorkspace
      key={session.id}
      worldId={worldId}
      session={session}
      manifest={state?.app.manifest ?? null}
    />
  );
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
  useEffect(
    () => () => {
      if (pushTimer.current) clearTimeout(pushTimer.current);
    },
    [],
  );

  const models = useMemo(() => usableModels(state, modeCapability(draft.mode)), [state, draft.mode]);
  const model: ManifestModel | null =
    models.find((m) => m.id === draft.model && m.provider === draft.provider) ?? null;
  const modelName = (provider: string, id: string): string =>
    manifest?.models.find((m) => m.provider === provider && m.id === id)?.displayName ?? id;

  // ---- references ----
  const worldSources = useMemo(
    () => worldPickerSources(world?.artifacts ?? [], session),
    [world?.artifacts, session],
  );
  const sessionSources = useMemo(() => sessionPickerSources(session), [session]);
  // The same rows with the OTHER lane's occupancy: what already rides as a keyframe.
  const worldFrameSources = useMemo(
    () => worldPickerSources(world?.artifacts ?? [], session, "keyframe"),
    [world?.artifacts, session],
  );
  const sessionFrameSources = useMemo(() => sessionPickerSources(session, "keyframe"), [session]);
  // Everything under the world's characters — identity, looks, candidates, every take. The
  // artifacts folder is a small corner of the pictures a world actually holds.
  const characterSources = useMemo(
    () => (world ? characterPickerSources(world, session) : []),
    [world, session],
  );
  const characterFrameSources = useMemo(
    () => (world ? characterPickerSources(world, session, "keyframe") : []),
    [world, session],
  );
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
  // The tab exists where the model verifies a frame mode OR frames already ride: what is
  // attached stays visible and removable even under a model that cannot honor it (§3).
  const speaking = draft.mode === "voice";
  const laneTabs = !speaking && (frameModes.length > 0 || (draft.mode === "video" && frames.length > 0));
  const [lane, setLane] = useState<"reference" | "keyframe">("reference");
  useEffect(() => {
    if (!laneTabs && lane === "keyframe") setLane("reference");
  }, [laneTabs, lane]);

  // ---- the breadcrumb's session switcher + the brief's expanded editor ----
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [recipesOpen, setRecipesOpen] = useState(false);
  const [durationOpen, setDurationOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const recipes = state?.app.recipes ?? [];
  // Which providers a stored key actually unlocks, per capability - the recipes menu judges
  // its rows with the same evidence the model dropdown does.
  const unlockedFor = useMemo(() => {
    const availability = deriveCapabilityAvailability(state?.app.providers ?? []);
    return {
      image: availability.find((a) => a.capability === "image")?.via ?? [],
      video: availability.find((a) => a.capability === "video")?.via ?? [],
      voice: availability.find((a) => a.capability === "voice-tts")?.via ?? [],
    } as const;
  }, [state?.app.providers]);
  const [briefExpanded, setBriefExpanded] = useState(false);
  const briefUnder = useRef<HTMLDivElement>(null);

  // ---- the enhancer's round trip: request out, answer in, the author's hand between ----
  const [enhancing, setEnhancing] = useState(false);
  const enhancingRef = useRef<{
    requestId: string;
    sentBrief: string;
    provider: string;
    model: string;
    mode: string;
  } | null>(null);
  const enhanceDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearEnhanceDeadline = () => {
    if (enhanceDeadline.current) clearTimeout(enhanceDeadline.current);
    enhanceDeadline.current = null;
  };
  useEffect(() => clearEnhanceDeadline, []);
  /** The previous words after an auto-apply — one press brings them back. */
  const [enhanceUndo, setEnhanceUndo] = useState<string | null>(null);
  /** An answer that arrived after the words moved — offered, never imposed. */
  const [enhanceOffer, setEnhanceOffer] = useState<string | null>(null);
  const [enhanceNote, setEnhanceNote] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(
    () =>
      subscribeBriefEnhanced((answer) => {
        const pending = enhancingRef.current;
        if (!pending || answer.requestId !== pending.requestId) return;
        enhancingRef.current = null;
        clearEnhanceDeadline();
        setEnhancing(false);
        if (answer.prompt === null) {
          setEnhanceNote(answer.reason ?? "the art director had no answer this time");
          return;
        }
        const unmoved =
          draftRef.current.brief === pending.sentBrief &&
          draftRef.current.provider === pending.provider &&
          draftRef.current.model === pending.model &&
          draftRef.current.mode === pending.mode;
        if (unmoved) {
          // Unmoved words: the enhancement lands, and the originals are one press away.
          setEnhanceUndo(pending.sentBrief);
          compose({ ...draftRef.current, brief: answer.prompt });
        } else {
          setEnhanceOffer(answer.prompt);
        }
      }),
    // compose is re-created per render but only closes over stable senders + refs here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const tokens = useMemo(() => new Set(session.tokenRegistry.map((e) => e.token)), [session.tokenRegistry]);

  // ---- dispatch + its refusal ----
  const [refusal, setRefusal] = useState<string | null>(null);
  const pendingDispatch = useRef<string | null>(null);
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pendingDispatch.current) return;
        pendingDispatch.current = null;
        setRefusal(
          result.disposition === "rejected"
            ? (result.failures[0]?.reason ?? "That could not be dispatched.")
            : null,
        );
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
    // ...and the pictures it was made with. Restoring the words and the settings but not the
    // images gave back a request that could not be re-made: press ⟲ on a take built from a
    // start frame, and you got its prompt over whatever happened to be in the lanes. The
    // snapshot has carried them all along — only this had never read them.
    //
    // Each lane is set to exactly the snapshot's list: what it does not name is dropped, and
    // what it names is re-added. Re-adding a source the registry already knows restores its old
    // token rather than claiming a new one, so the brief's "Image 1" still means Image 1.
    for (const lane of ["reference", "keyframe"] as const) {
      const plan = laneRestorePlan(
        lane === "keyframe" ? take.request.keyframes : take.request.references,
        lane === "keyframe" ? session.composer.keyframeTokens : session.composer.activeTokens,
      );
      for (const token of plan.remove) sendBenchRemoveReference(worldId, session.id, token, lane);
      if (plan.add.length > 0) {
        sendBenchAddReference(worldId, session.id, plan.add.map((entry) => ({ pick: entry.pick })), lane);
      }
    }
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
    if (draft.params.kind === "voice") {
      // Exact, not a ceiling: speech bills per character and the characters are already typed.
      return estimateMicroUsd(model, { characters: draft.brief.length }) * draft.params.count;
    }
    const seconds = draft.params.durationSec ?? model.limits.maxDurationSec ?? 5;
    return estimateMicroUsd(model, {
      durationSec: pricedDuration(model, seconds),
      ...(draft.params.resolution !== undefined ? { resolution: draft.params.resolution } : {}),
    });
  }, [model, draft.params, carried.length]);

  const promptCap = model?.limits.maxPromptChars;
  const overCap = promptCap !== undefined && draft.brief.length > promptCap;

  /**
   * What each mode was last left in, so glancing at the other one costs nothing.
   *
   * Switching used to reset the model and every parameter to the mode's defaults, in both
   * directions. A video setup — the model, its length, whether it makes sound — was therefore
   * destroyed by a single press of *Image* and not restored by pressing *Video* again: the
   * round trip looked free and was not, and nothing said a thing had been lost. Seeded from the
   * stored composer so the mode the session was saved in is remembered from the first press.
   */
  const modeMemory = useRef<Partial<Record<BenchMode, ModeSetup>>>({
    [session.composer.mode]: {
      provider: session.composer.provider,
      model: session.composer.model,
      params: session.composer.params,
    },
  });

  const switchMode = (mode: BenchMode) => {
    if (mode === draft.mode) return;
    modeMemory.current[draft.mode] = { provider: draft.provider, model: draft.model, params: draft.params };
    compose({ ...draft, mode, ...setupForMode(mode, modeMemory.current[mode], usableModels(state, modeCapability(mode))) });
  };

  /** The video half of the draft, narrowed once — the callbacks below lose it otherwise. */
  const videoParams = draft.params.kind === "video" ? draft.params : null;
  /**
   * The lengths this model offers, and where the draft sits among them. Read once: the track,
   * its fill, its end labels and its handle all have to agree, and four calls to the same
   * function is four chances for them to drift apart.
   *
   * `auto` is a state, not a stop. A model that takes "auto" is being asked to choose the
   * length itself, so the track shows no fill and no chosen value — a handle parked on the
   * shortest stop would say the shot is 4 seconds when nobody has said that yet.
   */
  const withReferences = session.composer.activeTokens.length > 0;
  // The track's geometry and its states, worked out in one place so the fill, the ends, the
  // handle and the pill cannot drift apart. See lib/duration.ts for why it has two extra stops.
  const track =
    videoParams !== null && model !== null
      ? durationTrack(model, videoParams.durationSec, { withReferences })
      : null;
  const durationStops = track?.stops ?? [];
  const durationUnset = track?.unset ?? true;
  const durationOverCeiling = track?.overCeiling ?? false;
  const durationMin = track?.min ?? -1;
  const durationMax = track?.max ?? 0;
  const durationValue = track?.value ?? -1;
  const durationFill = track?.fill ?? 0;
  const durationLostToReferences = track?.lostToReferences ?? null;
  const durationPanel =
    model === null ? null : (
      <div className="fy-bench__duration" role="dialog" aria-label="Duration">
        <div className="fy-bench__durationhead">
          <span className="fy-bench__durationlabel">Duration</span>
          {model.limits.durationAuto === true && (
            <button
              type="button"
              className={cx("fy-bench__durationpill", durationUnset && "fy-bench__durationpill--on")}
              data-testid="duration-auto"
              title="Let the model choose the length"
              onClick={() => {
                const { durationSec: _cleared, ...rest } = draft.params as BenchParams & {
                  durationSec?: number;
                };
                compose({ ...draft, params: { ...rest } as BenchParams });
              }}
            >
              Auto
            </button>
          )}
          {/* One value, in one place. Where Auto is offered, the lit pill above already
                  says who is choosing, and a second pill reading "auto" says it twice. Where
                  it is not, "default" is the honest word: no length goes on the wire, and
                  printing the shortest stop would name a length nobody asked for. */}
          {durationUnset ? (
            model.limits.durationAuto !== true && (
              <span
                className="fy-bench__durationpill fy-bench__durationpill--value"
                data-testid="duration-value"
              >
                default
              </span>
            )
          ) : (
            <span
              className={cx(
                "fy-bench__durationpill",
                "fy-bench__durationpill--value",
                "fy-bench__durationpill--on",
                durationOverCeiling && "fy-bench__durationpill--over",
              )}
              data-testid="duration-value"
              {...(durationOverCeiling
                ? { title: `Longer than this model makes with references — at most ${durationStops.at(-1)}s` }
                : {})}
            >
              {`${videoParams?.durationSec} s`}
            </span>
          )}
        </div>
        <input
          type="range"
          className={cx("fy-bench__durationrange", durationUnset && "fy-bench__durationrange--auto")}
          style={{ "--fy-duration-fill": `${durationFill}%` } as CSSProperties}
          aria-label="Duration in seconds"
          aria-valuetext={durationUnset ? "unset — the model chooses" : `${videoParams?.durationSec} seconds`}
          data-testid="duration-range"
          min={durationMin}
          max={durationMax}
          step={1}
          value={durationValue}
          onChange={(e) => {
            const index = Number(e.target.value);
            if (index < 0) {
              // Dragged below the shortest stop: back to unsaid, the same state the Auto
              // pill sets, rather than a length nobody chose.
              const { durationSec: _cleared, ...rest } = draft.params as BenchParams & {
                durationSec?: number;
              };
              compose({ ...draft, params: { ...rest } as BenchParams });
              return;
            }
            // The position past the end exists only to hold an over-ceiling length; landing
            // on it means the ceiling itself.
            const seconds = durationStops[index] ?? durationStops[durationStops.length - 1]!;
            compose({
              ...draft,
              params: { ...draft.params, kind: "video", durationSec: seconds } as BenchParams,
            });
          }}
        />
        <div className="fy-bench__durationends">
          <span>{`${durationStops[0]}s`}</span>
          <span>
            {`${durationStops[durationStops.length - 1]}s`}
            {/* What this model cannot reach, shown struck rather than hidden — either
                    because the references shortened its range, or because it simply runs
                    shorter than the longest model on offer. */}
            {durationLostToReferences !== null ? (
              <s className="fy-bench__durationover" data-testid="duration-lost" title="Without references">
                {`${durationLostToReferences}s`}
              </s>
            ) : (
              longestOffered(models) > durationStops[durationStops.length - 1]! && (
                <s className="fy-bench__durationover" title="Longer than this model runs">
                  {`${longestOffered(models)}s`}
                </s>
              )
            )}
          </span>
        </div>
      </div>
    );
  const aspects = draft.params.kind === "voice" ? [] : (model?.limits.aspects ?? []);
  /** Narrowed once: the size controls belong to the two modes that make a picture. */
  const sizedParams = draft.params.kind === "voice" ? null : draft.params;
  const aspectSelect = (
    <select
      aria-label="Aspect"
      className="fy-bench__chip"
      value={sizedParams?.aspect ?? ""}
      onChange={(e) => {
        // "default" means the key is absent, not the old value carried under a new label.
        if (sizedParams === null) return;
        const { aspect: _cleared, ...rest } = sizedParams;
        compose({
          ...draft,
          params: { ...rest, ...(e.target.value ? { aspect: e.target.value } : {}) } as BenchParams,
        });
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
    <div
      data-screen="bench"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
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
                        if (title !== (session.title ?? ""))
                          sendBenchTitle(worldId, session.id, title.length > 0 ? title : null);
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
              {(["image", "video", "voice"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={draft.mode === mode}
                  onClick={() => switchMode(mode)}
                >
                  {mode === "image" ? <ImageMark size={13} /> : mode === "video" ? <VideoMark size={13} /> : <Waveform size={13} />}
                  {mode === "image" ? "Image" : mode === "video" ? "Video" : "Voice"}
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
          {laneTabs && (
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
          {draft.mode === "video" && model !== null && frameModes.length === 0 && frames.length === 0 && (
            <p className="fy-bench__nolane">{`${model.displayName} takes no keyframes.`}</p>
          )}

          {/* reference tiles */}
          {lane === "reference" && !speaking && (
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
                {model !== null && keyframeAddable(model, frames.length) && (
                  <button
                    type="button"
                    className="fy-bench__reftile fy-bench__reftile--add"
                    onClick={() => openPicker("keyframe")}
                    data-testid="bench-add-keyframe"
                  >
                    <ImageMark size={14} />
                    {frames.length === 0 ? "Start frame" : frames.length === 1 ? "End frame" : "Add frame"}
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
              <ComposerMic
                onText={(text) =>
                  compose({ ...draft, brief: draft.brief.length > 0 ? `${draft.brief}\n${text}` : text })
                }
              />
              {/* The enhancer (asked for 2026-08-16): the art director rewrites the ask for
                  the chosen model, grounded in the world's look and canon. Absent without a
                  model or words — a control that could do nothing does not exist (§3). */}
              {model !== null && !speaking && draft.brief.trim().length > 0 && (
                <button
                  type="button"
                  className={cx("fy-bench__footicon", enhancing && "fy-bench__footicon--busy")}
                  data-testid="bench-enhance"
                  disabled={enhancing}
                  title={`Enhance — the art director rewrites this for ${model.displayName}, grounded in the world's look and canon`}
                  onClick={() => {
                    setEnhanceNote(null);
                    setEnhanceOffer(null);
                    setEnhanceUndo(null);
                    if (pushTimer.current) clearTimeout(pushTimer.current);
                    sendBenchCompose(worldId, session.id, draft);
                    const requestId = sendBenchEnhanceBrief({
                      worldId,
                      sessionId: session.id,
                      brief: draft.brief,
                      provider: model.provider,
                      model: model.id,
                    });
                    if (requestId === null) {
                      setEnhanceNote("not connected - try again");
                      return;
                    }
                    enhancingRef.current = {
                      requestId,
                      sentBrief: draft.brief,
                      provider: model.provider,
                      model: model.id,
                      mode: draft.mode,
                    };
                    setEnhancing(true);
                    // The coordinator's own wall clock is 120s; a lost answer says so rather
                    // than pulsing forever with the button locked.
                    clearEnhanceDeadline();
                    enhanceDeadline.current = setTimeout(() => {
                      if (enhancingRef.current?.requestId !== requestId) return;
                      enhancingRef.current = null;
                      setEnhancing(false);
                      setEnhanceNote("the art director did not answer - try again");
                    }, 130_000);
                  }}
                >
                  <Sparkle size={13} />
                </button>
              )}
              {enhancing && <span className="fy-bench__enhnote">writing…</span>}
              {enhanceUndo !== null && (
                <button
                  type="button"
                  className="fy-bench__enhchip"
                  onClick={() => {
                    compose({ ...draft, brief: enhanceUndo });
                    setEnhanceUndo(null);
                  }}
                >
                  Enhanced · undo
                </button>
              )}
              {enhanceOffer !== null && (
                <>
                  {/* The words moved while the director wrote — applying is the author's call. */}
                  <button
                    type="button"
                    className="fy-bench__enhchip"
                    onClick={() => {
                      setEnhanceUndo(draft.brief);
                      compose({ ...draft, brief: enhanceOffer });
                      setEnhanceOffer(null);
                    }}
                  >
                    Apply enhanced
                  </button>
                  <button
                    type="button"
                    className="fy-bench__footicon"
                    aria-label="Discard the enhanced version"
                    onClick={() => setEnhanceOffer(null)}
                  >
                    <X size={11} />
                  </button>
                </>
              )}
              {enhanceNote !== null && <span className="fy-bench__enhnote">{enhanceNote}</span>}
              <span style={{ flex: 1 }} />
              {/* The counter exists only where the model publishes a cap (issue 305 §5.1). */}
              {promptCap !== undefined && (
                <span
                  data-testid="prompt-counter"
                  className={cx("fy-bench__counter", overCap && "fy-bench__counter--over")}
                >
                  {`${draft.brief.length}/${promptCap}`}
                </span>
              )}
            </div>
          </div>

          {/* the mode's settings row */}
          <div className="fy-bench__settings">
            {!speaking && (
              <button
                type="button"
                className="fy-bench__chip fy-bench__chip--refs"
                onClick={() => openPicker("reference")}
              >
                <Plus size={11} />
                References
              </button>
            )}
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
                      compose({
                        ...draft,
                        params: {
                          ...rest,
                          ...(e.target.value ? { tier: e.target.value as SizeTier } : {}),
                        } as BenchParams,
                      });
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
                  onChange={(e) =>
                    compose({
                      ...draft,
                      params: {
                        ...draft.params,
                        kind: "image",
                        count: Number(e.target.value),
                      } as BenchParams,
                    })
                  }
                >
                  {[1, 2, 3, 4].map((count) => (
                    <option key={count} value={count}>
                      {count === 1 ? "1 take" : `${count} takes`}
                    </option>
                  ))}
                </select>
              </>
            )}
            {model && draft.params.kind === "voice" && (
              <>
                {/* Who reads it. Choosing here never assigns the voice to anybody — that is a
                    separate act on the sheet (design 70). */}
                <button
                  type="button"
                  className="fy-bench__chip"
                  data-testid="voice-pick"
                  onClick={() => setVoiceOpen(true)}
                >
                  <Waveform size={12} />
                  {draft.params.voiceLabel ?? "choose a voice"}
                </button>
                <select
                  aria-label="Delivery"
                  className="fy-bench__chip"
                  value={draft.params.delivery ?? ""}
                  onChange={(e) => {
                    const { delivery: _cleared, ...rest } = draft.params as BenchParams & { delivery?: string };
                    compose({
                      ...draft,
                      params: { ...rest, ...(e.target.value ? { delivery: e.target.value } : {}) } as BenchParams,
                    });
                  }}
                >
                  <option value="">delivery · default</option>
                  {DELIVERIES.map((delivery) => (
                    <option key={delivery} value={delivery}>
                      {delivery}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="How many reads"
                  className="fy-bench__chip"
                  value={draft.params.count}
                  onChange={(e) =>
                    compose({
                      ...draft,
                      params: { ...draft.params, kind: "voice", count: Number(e.target.value) } as BenchParams,
                    })
                  }
                >
                  {[1, 2, 3, 4].map((count) => (
                    <option key={count} value={count}>
                      {count === 1 ? "1 read" : `${count} reads`}
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
                      const { resolution: _cleared, ...rest } = draft.params as BenchParams & {
                        resolution?: string;
                      };
                      compose({
                        ...draft,
                        params: {
                          ...rest,
                          ...(e.target.value ? { resolution: e.target.value } : {}),
                        } as BenchParams,
                      });
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
                {/* Sound exists only where the route publishes the choice. Wan and minimax
                    make audio and offer no switch, and a switch that changed nothing would be
                    a control that lies (issue 305 §3). */}
                {model.limits.soundChoice === true && (
                  <button
                    type="button"
                    className={cx(
                      "fy-bench__chip",
                      "fy-bench__sound",
                      videoParams?.sound === false && "fy-bench__sound--off",
                    )}
                    data-testid="bench-sound"
                    aria-pressed={videoParams?.sound !== false}
                    title={
                      videoParams?.sound === false
                        ? "Sound off — the shot comes back silent"
                        : "Sound on — the model scores the shot"
                    }
                    onClick={() => {
                      const on = videoParams?.sound !== false;
                      compose({
                        ...draft,
                        params: { ...draft.params, kind: "video", sound: !on } as BenchParams,
                      });
                    }}
                  >
                    {videoParams?.sound === false ? <SpeakerOff size={12} /> : <Speaker size={12} />}
                    {videoParams?.sound === false ? "silent" : "sound"}
                  </button>
                )}
                {/* The length sits behind its own pill, the way the other output controls do.
                    The pill carries the answer — a length, "Auto", or "default" — so the row
                    still says what will be made without the panel being open. */}
                {durationStops.length > 0 && (
                  <span className="fy-bench__durationanchor">
                    <button
                      type="button"
                      className={cx(
                        "fy-bench__chip",
                        "fy-bench__durationtrigger",
                        durationOverCeiling && "fy-bench__durationtrigger--over",
                      )}
                      data-testid="duration-open"
                      aria-expanded={durationOpen}
                      aria-haspopup="dialog"
                      onClick={() => setDurationOpen((v) => !v)}
                    >
                      <Timer size={12} />
                      {durationPillLabel(model, videoParams?.durationSec)}
                    </button>
                    {durationOpen && (
                      <>
                        <div className="fy-bench__scrim" onClick={() => setDurationOpen(false)} />
                        {durationPanel}
                      </>
                    )}
                  </span>
                )}
              </>
            )}
          </div>

          {/* dispatch row */}
          <div className="fy-bench__dispatch">
            {/* Recipes (issue 305 §3): saved setups, applied into the draft — the ghost
                trigger the master puts left of the model select (68b). */}
            <span style={{ position: "relative", display: "inline-flex" }}>
              <button
                type="button"
                className="fy-bench__recipes"
                aria-expanded={recipesOpen}
                data-testid="bench-recipes"
                onClick={() => setRecipesOpen((v) => !v)}
              >
                Recipes
                <ChevronDown size={11} />
              </button>
              {recipesOpen && (
                <>
                  <div className="fy-bench__scrim" onClick={() => setRecipesOpen(false)} />
                  <div className="fy-bench__recipemenu" role="menu" aria-label="Recipes">
                    {recipes.length === 0 && <span className="fy-bench__recipenone">No recipes yet.</span>}
                    {recipes.map((recipe) => {
                      const fault = recipeFault(
                        recipe,
                        manifest,
                        state?.app.models.disabled ?? [],
                        unlockedFor[recipe.mode],
                      );
                      return (
                        <div key={recipe.id} className="fy-bench__reciperow">
                          <button
                            type="button"
                            className="fy-bench__sessionrow"
                            disabled={!fault.ok}
                            title={fault.ok ? undefined : fault.reason}
                            onClick={() => {
                              if (!fault.ok) return;
                              setRecipesOpen(false);
                              compose({
                                mode: recipe.mode,
                                provider: recipe.provider,
                                model: recipe.model,
                                params: recipe.params,
                                brief: recipe.brief ?? draft.brief,
                              });
                            }}
                          >
                            <span className="fy-bench__sessionname">{recipe.name}</span>
                            <span className="fy-bench__sessionmeta">
                              {fault.ok ? modelName(recipe.provider, recipe.model) : fault.reason}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="fy-bench__recipedelete"
                            aria-label={`Delete the recipe ${recipe.name}`}
                            onClick={() => sendBenchRecipeDelete(recipe.id)}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      );
                    })}
                    {/* Saving needs a model the manifest can honor — absent otherwise (§3). */}
                    {model !== null && (
                      <input
                        aria-label="Save the current setup as a recipe"
                        className="fy-bench__rename"
                        placeholder="Save current setup as…"
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const name = (e.target as HTMLInputElement).value.trim();
                          if (name.length === 0) return;
                          sendBenchRecipeSave({
                            name,
                            mode: draft.mode,
                            provider: model.provider,
                            model: model.id,
                            params: draft.params,
                            ...(draft.brief.trim().length > 0 ? { brief: draft.brief } : {}),
                          });
                          (e.target as HTMLInputElement).value = "";
                          setRecipesOpen(false);
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </span>
            {models.length === 0 ? (
              /* An empty select is mute; the bar says the repair (dispatch-bar's own words). */
              <span className="fy-bench__nomodel">
                {`No ${draft.mode} model is available — add a provider key in Settings.`}
              </span>
            ) : (
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
            )}
            {models.length > 0 && <span style={{ flex: 1 }} />}
            {estimate !== null && (
              <span data-testid="bench-estimate" className="fy-bench__estimate">
                {speaking ? formatMicroUsd(estimate) : `~${formatMicroUsd(estimate)}`}
              </span>
            )}
            <Button
              variant="primary"
              data-testid="bench-generate"
              disabled={
                model === null ||
                draft.brief.trim().length === 0 ||
                overCap ||
                pendingDispatch.current !== null
              }
              onClick={() => {
                setRefusal(null);
                if (pushTimer.current) clearTimeout(pushTimer.current);
                sendBenchCompose(worldId, session.id, draft);
                pendingDispatch.current = sendBenchDispatch(worldId, session.id);
              }}
            >
              {draft.params.kind === "image" && draft.params.count > 1
                ? `Generate ${draft.params.count}`
                : "Generate"}
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
            {(["all", "filed", "discarded", ...(hasVideoTakes ? (["4k"] as const) : [])] as const).map(
              (f) => (
                <button
                  key={f}
                  type="button"
                  className={cx("fy-bench__tab", wallFilter === f && "fy-bench__tab--active")}
                  onClick={() => setWallFilter(f)}
                >
                  {f === "all" ? "All" : f === "filed" ? "Filed" : f === "discarded" ? "Discarded" : "4K"}
                </button>
              ),
            )}
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
              {selected.request.mode === "voice" ? (
                // A spoken take has nothing to look at. Read as "video or else a picture", this
                // rendered a broken image (design 70).
                worldSlug ? (
                  <div className="fy-bench__voicetake" data-testid="voice-take">
                    <div className="fy-bench__voicehead">
                      <span className="fy-bench__takestate">{`TAKE ${selected.n}`}</span>
                      {selected.request.params.kind === "voice" && selected.request.params.voiceLabel !== undefined && (
                        <span className="fy-bench__voicename">{selected.request.params.voiceLabel}</span>
                      )}
                      {selected.request.params.kind === "voice" && selected.request.params.delivery !== undefined && (
                        <span className="fy-bench__voicedelivery">{selected.request.params.delivery}</span>
                      )}
                    </div>
                    <audio
                      key={selected.id}
                      src={mediaUrl(
                        worldSlug,
                        `.sessions/${session.id}/media/${selected.id}/${selected.media.file}`,
                      )}
                      controls
                    />
                  </div>
                ) : null
              ) : selected.request.mode === "video" ? (
                worldSlug ? (
                  <video
                    key={selected.id}
                    src={mediaUrl(
                      worldSlug,
                      `.sessions/${session.id}/media/${selected.id}/${selected.media.file}`,
                    )}
                    controls
                  />
                ) : null
              ) : worldSlug ? (
                <img
                  src={mediaUrl(
                    worldSlug,
                    `.sessions/${session.id}/media/${selected.id}/${selected.media.file}`,
                  )}
                  alt={`Take ${selected.n}`}
                  style={{ width: "100%", height: "100%", objectFit: "contain" }}
                />
              ) : null}
              <div className="fy-bench__overlaychips">
                <span className="fy-bench__overlaychip fy-bench__overlaychip--name">{`TAKE ${selected.n}`}</span>
                {takeMeta(selected).length > 0 && (
                  <span className="fy-bench__overlaychip">{takeMeta(selected)}</span>
                )}
              </div>
            </div>
          ) : (
            <div className="fy-bench__empty">
              {/* Something to watch while a take is out. Only while it is out: an empty bench
                  and a failed take are both still, because a moving picture reads as work
                  happening and neither of those is work happening. */}
              {selected !== null && inFlight(liveStatus(selected)) && (
                <video
                  className="fy-bench__waiting"
                  data-testid="bench-waiting"
                  src={GENERATING_LOOP}
                  autoPlay={!stillPreferred()}
                  loop
                  muted
                  playsInline
                  aria-hidden
                />
              )}
              <strong style={{ font: "600 15px var(--font-sans)" }}>
                {selected ? statusLine(liveStatus(selected), selected) : "The bench is empty"}
              </strong>
              {selected?.error !== undefined && (
                <span
                  style={{ font: "400 11.5px var(--font-sans)", color: "var(--destructive)", maxWidth: 420 }}
                >
                  {selected.error}
                </span>
              )}
            </div>
          )}

          {/* View latest returns from a scrolled-back selection (design 68b). */}
          {selected !== null && latest !== null && selected.id !== latest.id && (
            <button
              type="button"
              className="fy-bench__viewlatest"
              onClick={() => sendBenchSelectTake(worldId, session.id, latest.id)}
            >
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
                <Button
                  variant="primary"
                  data-testid="bench-keep"
                  onClick={() => sendBenchKeep(worldId, session.id, selected.id)}
                >
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
                    // Its first frame, not the clip: an <img> pointed at an .mp4 cannot decode,
                    // and every video take on this strip was a grey box with a label in it.
                    <Portrait
                      worldSlug={worldSlug}
                      path={`.sessions/${session.id}/media/${take.id}/${posterNameFor(take.media.file)}`}
                      label={`take ${take.n}`}
                      radius={0}
                    />
                  ) : (
                    <span
                      className={cx(
                        "fy-bench__takestate",
                        (status === "failed" || status === "needs-reconciliation") &&
                          "fy-bench__takestate--failed",
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
            <span
              style={{
                font: "400 9.5px var(--font-mono)",
                color: "var(--neutral-400)",
                textAlign: "center",
                marginTop: 8,
              }}
            >
              takes land here
            </span>
          )}
        </div>

        <VoicePickerDialog
          open={voiceOpen}
          worldId={worldId}
          chosenId={draft.params.kind === "voice" ? draft.params.voiceId : undefined}
          onClose={() => setVoiceOpen(false)}
          onPick={(voice) => {
            setVoiceOpen(false);
            compose({
              ...draft,
              // The label rides with the id so a take can name its voice without the catalogue.
              params: { ...draft.params, kind: "voice", voiceId: voice.voiceId, voiceLabel: voice.label } as BenchParams,
              // A voice belongs to a provider, so choosing one may change which model reads it.
              ...(models.some((m) => m.provider === voice.provider)
                ? { provider: voice.provider, model: models.find((m) => m.provider === voice.provider)!.id }
                : {}),
            });
          }}
        />
        {pickerLane === "reference" ? (
          <ReferencePickerDialog
            open={pickerOpen}
            mode="bench"
            worldSlug={worldSlug}
            model={model}
            carried={carried}
            world={worldSources}
            characters={characterSources}
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
            note={
              model !== null && keyframeCapacity(model) > 2
                ? "Frames the shot passes through, in order."
                : "A frame the shot must pass through — start first, then end."
            }
            only="image"
            budget="none"
            worldSlug={worldSlug}
            model={model}
            carried={carried}
            world={worldFrameSources}
            characters={characterFrameSources}
            session={sessionFrameSources}
            onChoose={(pick) => {
              sendBenchAddReference(worldId, session.id, [{ pick }], "keyframe");
              setPickerOpen(false);
            }}
            onUpload={() => {
              sendBenchUploadReferences(worldId, session.id, "keyframe");
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
                  <span
                    className={cx("fy-bench__counter", overCap && "fy-bench__counter--over")}
                    style={{ alignSelf: "center" }}
                  >
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
  const p = take.request.params;
  return [
    p.kind === "image" ? p.tier : p.kind === "video" ? p.resolution : p.voiceLabel,
    p.kind === "voice" ? p.delivery : p.aspect,
    take.request.requestedSeed !== undefined ? `seed ${take.request.requestedSeed}` : undefined,
    take.cost ? formatMicroUsd(take.cost.actualMicroUsd ?? take.cost.estimatedMicroUsd) : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(" · ");
}

/**
 * The longest length any model on offer can reach. The duration track strikes this through
 * when the chosen model stops short, so the ceiling is visible rather than merely missing —
 * the same reason the bench shows a refusal instead of hiding a control.
 */
function longestOffered(models: readonly ManifestModel[]): number {
  return models.reduce((longest, model) => {
    const options = durationOptions(model);
    const last = options[options.length - 1] ?? 0;
    return last > longest ? last : longest;
  }, 0);
}

/** The brief's text with the session's own tokens marked — never token-shaped strangers. */
function briefWithChips(text: string, tokens: Set<string>): ReactNode[] {
  return text.split(/((?:Image|Video|Audio) [1-9][0-9]*)/g).map((part, i) =>
    tokens.has(part) ? (
      <mark key={i} className="fy-bench__briefchip">
        {part}
      </mark>
    ) : (
      part
    ),
  );
}

/**
 * The waiting loop, played in the preview panel while a take is out.
 *
 * In public/ rather than imported, on the setup reel's precedent (shell.tsx): a plain file the
 * bundler copies as-is, so the route tests — which render every screen through node's loader —
 * never have to know how to load an mp4. Relative, because the packaged app opens over file://.
 *
 * Cut forward-then-reversed from the source clip, which makes the loop seamless by construction
 * rather than by crossfade: the last frame IS the first frame. Silent, and 119KB.
 */
const GENERATING_LOOP = "./bench-generating.mp4";

/** Has this machine asked for less movement? Server-rendered tests have no matchMedia. */
function stillPreferred(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

/** The states where work is actually outstanding — the only ones the loop plays for. */
function inFlight(status: BenchTake["status"]): boolean {
  return status === "allocating" || status === "queued" || status === "submitting" || status === "running";
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
