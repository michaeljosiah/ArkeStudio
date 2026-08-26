import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import {
  benchMentionsIn,
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
  MUSIC_DURATION_SEC,
  pricedDuration,
  presetFault,
  supportedDeliveries,
  tiersFor,
  unresolvedBenchMentions,
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
  sendBenchPresetDelete,
  sendBenchPresetSave,
  sendBenchRemoveReference,
  sendBenchRerun,
  sendBenchSelectTake,
  sendBenchDraftLyrics,
  sendBenchTitle,
  sendBenchUploadReferences,
  subscribeBriefEnhanced,
  subscribeLyricsDrafted,
  subscribeQueueResults,
  subscribeVoiceUploadConfirmations,
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
  MusicMark,
  Waveform,
  SpeakerOff,
  Sparkle,
  User,
  VideoMark,
  Wand,
  X,
} from "../components/icons.js";
import { Portrait } from "../components/portrait.js";
import { ImageDownload } from "../components/image-actions.js";
import { BenchBrief } from "../components/bench-brief.js";
import { mentionOptions } from "../lib/bench-mention.js";
import { mediaUrl } from "../lib/media.js";
import { durationTrack, durationPillLabel } from "../lib/duration.js";
import { posterNameFor } from "../lib/poster.js";
import { laneRestorePlan } from "../lib/restore.js";
import { setupForMode, type ModeSetup } from "../lib/composer-mode.js";
import { VoicePickerDialog } from "../components/voice-picker.js";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { disabledRecipes, usableModels } from "../components/dispatch-bar.js";
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
  const disabledVoiceRecipes = useMemo(
    () => (draft.mode === "voice" ? disabledRecipes(state, "voice-tts") : []),
    [state, draft.mode],
  );
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
  const singing = draft.mode === "music";
  /**
   * The two modes that make a sound. Everything about pictures — the reference lane, the size
   * controls, the ways of laying results out — is absent for both, and saying so once is why
   * music did not have to re-discover each of those gates one screenshot at a time.
   */
  const soundOnly = speaking || singing;
  const musicParams = draft.params.kind === "music" ? draft.params : null;
  const voiceDeliveries = draft.params.kind === "voice" ? supportedDeliveries(model) : [];
  const laneTabs = !soundOnly && (frameModes.length > 0 || (draft.mode === "video" && frames.length > 0));
  const [lane, setLane] = useState<"reference" | "keyframe">("reference");
  useEffect(() => {
    if (!laneTabs && lane === "keyframe") setLane("reference");
  }, [laneTabs, lane]);

  // ---- the breadcrumb's session switcher + the brief's expanded editor ----
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [presetsOpen, setPresetsOpen] = useState(false);
  const [durationOpen, setDurationOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const presets = state?.app.presets ?? [];
  // Which providers a stored key actually unlocks, per capability - the presets menu judges
  // its rows with the same evidence the model dropdown does.
  const unlockedFor = useMemo(() => {
    const availability = deriveCapabilityAvailability(state?.app.providers ?? []);
    // Read through modeCapability rather than spelling each capability again here. Two of the
    // four modes are named differently from the capability they dispatch against, and a second
    // hand-written copy of that mapping is a second place for it to drift.
    const via = (mode: BenchMode) =>
      availability.find((a) => a.capability === modeCapability(mode))?.via ?? [];
    return { image: via("image"), video: via("video"), voice: via("voice"), music: via("music") } as const;
  }, [state?.app.providers]);
  const [briefExpanded, setBriefExpanded] = useState(false);

  // ---- the lyrics helper's round trip (design turn 73) -------------------
  // Deliberately unlike the enhancer's: that one may auto-apply into the composer when the
  // words have not moved. This one never applies anything. The draft sits in its own dialog
  // beside what the author already has, and only "Use these words" moves it.
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [lyricsAbout, setLyricsAbout] = useState("");
  const [lyricsDraft, setLyricsDraft] = useState<string | null>(null);
  const [lyricsNote, setLyricsNote] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  /** Which model wrote the draft on offer, so the dialog can name it as the design asks. */
  const [lyricsAuthor, setLyricsAuthor] = useState<string | null>(null);
  const draftingRef = useRef<string | null>(null);

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
        // A rewrite that drops "@Image 1" turns an attached picture into words nobody will
        // resolve. The prompt says to keep them; this is what happens when it did not.
        const kept = new Set(benchMentionsIn(answer.prompt).map((m) => m.token));
        const dropped = [...new Set(benchMentionsIn(pending.sentBrief).map((m) => m.token))].filter(
          (token) => !kept.has(token),
        );
        setEnhanceNote(
          dropped.length > 0 ? `${dropped.map((token) => `@${token}`).join(", ")} dropped` : null,
        );
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
  useEffect(
    () =>
      subscribeLyricsDrafted((answer) => {
        if (answer.requestId !== draftingRef.current) return;
        draftingRef.current = null;
        setDrafting(false);
        if (answer.lyrics === null) {
          setLyricsNote(answer.reason ?? "the lyricist had no answer this time");
          return;
        }
        // Held, never applied. Even if the dialog has since been closed the draft is kept, so
        // reopening shows the answer that was paid for rather than starting again.
        setLyricsDraft(answer.lyrics);
      }),
    [],
  );

  const tokens = useMemo(() => new Set(session.tokenRegistry.map((e) => e.token)), [session.tokenRegistry]);

  /**
   * What a citation in the brief may name (issue 476): the references attached RIGHT NOW.
   *
   * Read exactly the way `planBenchDispatch` reads them — a shot carries its frames as well as
   * its references, a picture carries only references, and neither mode that makes a sound
   * carries any. The screen has to agree with the gate to the letter here: a name the composer
   * drew as resolved and dispatch then refused would be a refusal arriving after the press, over
   * words the author had already been told were fine.
   */
  const attachedTokens = useMemo(
    () =>
      soundOnly
        ? []
        : draft.mode === "video"
          ? [...session.composer.activeTokens, ...session.composer.keyframeTokens]
          : session.composer.activeTokens,
    [soundOnly, draft.mode, session.composer.activeTokens, session.composer.keyframeTokens],
  );
  const attached = useMemo(() => new Set(attachedTokens), [attachedTokens]);
  /** The picker's own rows are where a mention gets its thumbnail, its name and its second line. */
  const mentions = useMemo(
    () => mentionOptions(attachedTokens, [...worldSources, ...sessionSources, ...characterSources]),
    [attachedTokens, worldSources, sessionSources, characterSources],
  );
  /** Said in the composer with the same function dispatch refuses with, so the two cannot differ. */
  const lostMentions = useMemo(
    () => unresolvedBenchMentions(draft.brief, attachedTokens),
    [draft.brief, attachedTokens],
  );

  // ---- dispatch + its refusal ----
  const [refusal, setRefusal] = useState<string | null>(null);
  const pendingDispatch = useRef<string | null>(null);
  const pendingDispatchAction = useRef<{ kind: "dispatch" } | { kind: "rerun"; takeId: string } | null>(null);
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    destinationLabel: string;
    confirmationToken: string;
  } | null>(null);
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
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== pendingDispatch.current) return;
        setUploadConfirmation(confirmation);
      }),
    [],
  );

  const dispatchBench = (voiceUploadConfirmedFor?: string) => {
    pendingDispatchAction.current = { kind: "dispatch" };
    pendingDispatch.current = sendBenchDispatch(worldId, session.id, voiceUploadConfirmedFor);
  };
  const rerunBench = (takeId: string, voiceUploadConfirmedFor?: string) => {
    pendingDispatchAction.current = { kind: "rerun", takeId };
    pendingDispatch.current = sendBenchRerun(worldId, session.id, takeId, voiceUploadConfirmedFor);
  };

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
        sendBenchAddReference(
          worldId,
          session.id,
          plan.add.map((entry) => ({ pick: entry.pick })),
          lane,
        );
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
    if (draft.params.kind === "music") {
      // A ceiling, and the only honest kind of number here: the route calls its length an upper
      // bound and stops when the song is done, so this is what the take can cost at most.
      return estimateMicroUsd(model, { durationSec: MUSIC_DURATION_SEC }) * draft.params.count;
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
    compose({
      ...draft,
      mode,
      ...setupForMode(mode, modeMemory.current[mode], usableModels(state, modeCapability(mode))),
    });
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
  /**
   * Narrowed once, and stated as what it IS rather than what it is not: the size controls
   * belong to the two modes that make a picture. Written as `!== "voice"` it silently grew a
   * third member the day music arrived, and a song would have been offered an aspect ratio.
   */
  const sizedParams = draft.params.kind === "image" || draft.params.kind === "video" ? draft.params : null;
  const aspects = sizedParams !== null ? (model?.limits.aspects ?? []) : [];
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
              {(["image", "video", "voice", "music"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={draft.mode === mode}
                  onClick={() => switchMode(mode)}
                >
                  {mode === "image" ? (
                    <ImageMark size={13} />
                  ) : mode === "video" ? (
                    <VideoMark size={13} />
                  ) : mode === "voice" ? (
                    <Waveform size={13} />
                  ) : (
                    <MusicMark size={13} />
                  )}
                  {MODE_LABELS[mode]}
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
          {lane === "reference" && !soundOnly && (
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

          {/* A song asks for two things and no more (design turn 73). This is the first: the
              STYLE, which is a description, and so rides in the brief every other mode uses. */}
          {singing && <div className="fy-bench__eyebrow">STYLE</div>}
          {/* brief — tokens the session knows render as chips inline (issue 305 §3) */}
          <div className={cx("fy-bench__brief", singing && "fy-bench__brief--style")}>
            <BenchBrief
              value={draft.brief}
              onChange={(brief) => compose({ ...draft, brief })}
              options={mentions}
              worldSlug={worldSlug}
              underlay={briefWithChips(draft.brief, tokens, attached)}
              label={singing ? "Style" : "Brief"}
              placeholder={
                singing
                  ? "Instrumentation, mood, arrangement — what the song sounds like, not what it says."
                  : "Say what to make. Type @ to cite a reference."
              }
            />
            <div className="fy-bench__brieffoot">
              <button
                type="button"
                className="fy-bench__footicon"
                title="Write large — the brief in its own window"
                onClick={() => setBriefExpanded(true)}
              >
                <Expand size={13} />
              </button>
              {/* Dictation belongs to a brief. A style line is a few words of instrumentation
                  and the lyrics have their own helper, so a song is not spoken into being. */}
              {!singing && (
                <ComposerMic
                  onText={(text) =>
                    compose({ ...draft, brief: draft.brief.length > 0 ? `${draft.brief}\n${text}` : text })
                  }
                />
              )}
              {/* The enhancer (asked for 2026-08-16): the art director rewrites the ask for
                  the chosen model, grounded in the world's look and canon. Absent without a
                  model or words — a control that could do nothing does not exist (§3). */}
              {model !== null && !soundOnly && draft.brief.trim().length > 0 && (
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
          {/* Said here rather than at dispatch: the coordinator refuses this, and a refusal that
              only arrives on the press is a refusal the author could not have seen coming. */}
          {lostMentions.length > 0 && (
            <p className="fy-bench__refusal" data-testid="bench-lost-mentions">
              {`${lostMentions.map((token) => `@${token}`).join(", ")} — not attached`}
            </p>
          )}

          {/* The second of the two things a song asks for (design turn 73). Its own box, not a
              heading inside the style: one of these is a sentence about instrumentation and the
              other is the words that get sung, and they are not the same kind of writing. */}
          {singing && musicParams !== null && (
            <div className="fy-bench__lyrics">
              <div className="fy-bench__lyricshead">
                <span className="fy-bench__eyebrow">LYRICS</span>
                <span style={{ flex: 1 }} />
                {/* Absent without a harness to ask, the way every other model-backed control
                    is absent without a model — a control that could do nothing does not exist. */}
                <button
                  type="button"
                  className={cx("fy-bench__writelyrics", drafting && "fy-bench__footicon--busy")}
                  data-testid="bench-write-lyrics"
                  disabled={drafting}
                  title="Write for me — describe what the song is about and read the draft before it goes anywhere near the song"
                  onClick={() => {
                    setLyricsNote(null);
                    setLyricsDraft(null);
                    setLyricsAbout("");
                    setLyricsOpen(true);
                  }}
                >
                  Write for me
                </button>
              </div>
              <textarea
                aria-label="Lyrics"
                className="fy-bench__lyricstext"
                value={musicParams.lyrics}
                onChange={(e) => compose({ ...draft, params: { ...musicParams, lyrics: e.target.value } })}
                placeholder="The words to be sung. Tags on their own lines — [verse], [chorus] — tell the model the shape."
              />
              <div className="fy-bench__lyricsfoot">
                {lyricsNote !== null && <span className="fy-bench__enhnote">{lyricsNote}</span>}
                <span style={{ flex: 1 }} />
                {/* Characters, not words: the count is a fact about the box, and it is what the
                    draft dialog states about its own answer too. */}
                <span data-testid="lyrics-counter" className="fy-bench__counter">
                  {`${musicParams.lyrics.length} characters`}
                </span>
              </div>
            </div>
          )}

          {/* the mode's settings row */}
          <div className="fy-bench__settings">
            {!soundOnly && (
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
                {voiceDeliveries.length > 0 ? (
                  <select
                    aria-label="Delivery"
                    className="fy-bench__chip"
                    value={draft.params.delivery ?? ""}
                    onChange={(e) => {
                      const { delivery: _cleared, ...rest } = draft.params as BenchParams & {
                        delivery?: string;
                      };
                      compose({
                        ...draft,
                        params: {
                          ...rest,
                          ...(e.target.value ? { delivery: e.target.value } : {}),
                        } as BenchParams,
                      });
                    }}
                  >
                    <option value="">delivery · default</option>
                    {DELIVERIES.filter((delivery) => voiceDeliveries.includes(delivery)).map((delivery) => (
                      <option key={delivery} value={delivery}>
                        {delivery}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="fy-bench__chip">delivery · default only</span>
                )}
                <select
                  aria-label="How many reads"
                  className="fy-bench__chip"
                  value={draft.params.count}
                  onChange={(e) =>
                    compose({
                      ...draft,
                      params: {
                        ...draft.params,
                        kind: "voice",
                        count: Number(e.target.value),
                      } as BenchParams,
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
            {/* Presets (issue 305 §3): saved setups, applied into the draft — the ghost
                trigger the master puts left of the model select (68b). */}
            <span style={{ position: "relative", display: "inline-flex" }}>
              <button
                type="button"
                className="fy-bench__presets"
                aria-expanded={presetsOpen}
                data-testid="bench-presets"
                onClick={() => setPresetsOpen((v) => !v)}
              >
                Presets
                <ChevronDown size={11} />
              </button>
              {presetsOpen && (
                <>
                  <div className="fy-bench__scrim" onClick={() => setPresetsOpen(false)} />
                  <div className="fy-bench__presetmenu" role="menu" aria-label="Presets">
                    {presets.length === 0 && <span className="fy-bench__presetnone">No presets yet.</span>}
                    {presets.map((preset) => {
                      const fault = presetFault(
                        preset,
                        manifest,
                        state?.app.models.disabled ?? [],
                        unlockedFor[preset.mode],
                      );
                      return (
                        <div key={preset.id} className="fy-bench__presetrow">
                          <button
                            type="button"
                            className="fy-bench__sessionrow"
                            disabled={!fault.ok}
                            title={fault.ok ? undefined : fault.reason}
                            onClick={() => {
                              if (!fault.ok) return;
                              setPresetsOpen(false);
                              compose({
                                mode: preset.mode,
                                provider: preset.provider,
                                model: preset.model,
                                params: preset.params,
                                brief: preset.brief ?? draft.brief,
                              });
                            }}
                          >
                            <span className="fy-bench__sessionname">{preset.name}</span>
                            <span className="fy-bench__sessionmeta">
                              {fault.ok ? modelName(preset.provider, preset.model) : fault.reason}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="fy-bench__presetdelete"
                            aria-label={`Delete the preset ${preset.name}`}
                            onClick={() => sendBenchPresetDelete(preset.id)}
                          >
                            <X size={11} />
                          </button>
                        </div>
                      );
                    })}
                    {/* Saving needs a model the manifest can honor — absent otherwise (§3). */}
                    {model !== null && (
                      <input
                        aria-label="Save the current setup as a preset"
                        className="fy-bench__rename"
                        placeholder="Save current setup as…"
                        onKeyDown={(e) => {
                          if (e.key !== "Enter") return;
                          const name = (e.target as HTMLInputElement).value.trim();
                          if (name.length === 0) return;
                          sendBenchPresetSave({
                            name,
                            mode: draft.mode,
                            provider: model.provider,
                            model: model.id,
                            params: draft.params,
                            ...(draft.brief.trim().length > 0 ? { brief: draft.brief } : {}),
                          });
                          (e.target as HTMLInputElement).value = "";
                          setPresetsOpen(false);
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
                {disabledVoiceRecipes[0]?.reason ??
                  `No ${draft.mode} model is available — add a provider key in Settings.`}
              </span>
            ) : (
              <span className="fy-bench__modelwrap">
                <select
                  aria-label="Model"
                  className="fy-bench__model"
                  value={model ? `${model.provider}/${model.id}` : ""}
                  onChange={(e) => {
                    const chosen = models.find((m) => `${m.provider}/${m.id}` === e.target.value);
                    if (!chosen) return;
                    let params = draft.params;
                    if (
                      params.kind === "voice" &&
                      (params.voiceProvider !== chosen.provider || params.voiceModel !== chosen.id)
                    ) {
                      const {
                        voiceId: _voiceId,
                        voiceProvider: _voiceProvider,
                        voiceModel: _voiceModel,
                        voiceLabel: _voiceLabel,
                        delivery,
                        ...rest
                      } = params;
                      params = {
                        ...rest,
                        ...(delivery !== undefined && chosen.limits.deliveries?.includes(delivery)
                          ? { delivery }
                          : {}),
                      };
                    }
                    compose({ ...draft, provider: chosen.provider, model: chosen.id, params });
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
                  {disabledVoiceRecipes.map(({ model: disabled, reason }) => (
                    <option
                      key={`${disabled.provider}/${disabled.id}`}
                      value={`${disabled.provider}/${disabled.id}`}
                      disabled
                    >
                      {disabled.displayName} · {reason}
                    </option>
                  ))}
                </select>
                <ChevronDown size={12} />
              </span>
            )}
            {models.length > 0 && <span style={{ flex: 1 }} />}
            {estimate !== null && (
              <span data-testid="bench-estimate" className="fy-bench__estimate">
                {/* Exact for speech, because the characters are already typed. A ceiling for a
                    song, because the route stops when the song is done — and a tilde would read
                    as "about", when the truth is "at most". */}
                {speaking
                  ? formatMicroUsd(estimate)
                  : singing
                    ? `up to ${formatMicroUsd(estimate)}`
                    : `~${formatMicroUsd(estimate)}`}
              </span>
            )}
            <Button
              variant="primary"
              data-testid="bench-generate"
              disabled={
                model === null ||
                draft.brief.trim().length === 0 ||
                // A song needs both halves. The coordinator refuses this too — it is the
                // authority — but a Generate that is pressable and always refuses is a lie the
                // button tells, and the missing half is right there on screen.
                (musicParams !== null && musicParams.lyrics.trim().length === 0) ||
                overCap ||
                pendingDispatch.current !== null
              }
              onClick={() => {
                setRefusal(null);
                if (pushTimer.current) clearTimeout(pushTimer.current);
                sendBenchCompose(worldId, session.id, draft);
                dispatchBench();
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
                onClick={() => rerunBench(selected.id)}
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
            <div className="fy-bench__media fy-imghost">
              {selected.request.mode === "voice" || selected.request.mode === "music" ? (
                // A take that is a sound has nothing to look at. Read as "video or else a
                // picture", this rendered a broken image (design 70) — and a song reaching that
                // same branch would have been the identical bug a second time, which is why the
                // condition names both modes that make a sound rather than the one that did.
                worldSlug ? (
                  <div
                    className="fy-bench__voicetake"
                    data-testid={selected.request.mode === "music" ? "music-take" : "voice-take"}
                  >
                    <div className="fy-bench__voicehead">
                      <span className="fy-bench__takestate">{`TAKE ${selected.n}`}</span>
                      {selected.request.params.kind === "voice" &&
                        selected.request.params.voiceLabel !== undefined && (
                          <span className="fy-bench__voicename">{selected.request.params.voiceLabel}</span>
                        )}
                      {selected.request.params.kind === "voice" &&
                        selected.request.params.delivery !== undefined && (
                          <span className="fy-bench__voicedelivery">{selected.request.params.delivery}</span>
                        )}
                      {/* The model, then the length that was actually made — never the ceiling
                          it was asked at (design turn 73). */}
                      {selected.request.params.kind === "music" && (
                        <span className="fy-bench__voicename">
                          {manifest?.models.find((m) => m.id === selected.request.model)?.displayName ??
                            selected.request.model}
                        </span>
                      )}
                      {selected.request.params.kind === "music" && selected.media?.info !== undefined && (
                        <span className="fy-bench__voicedelivery">
                          {`${Math.round(selected.media.info.durationSec)}s`}
                        </span>
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
                <>
                  <img
                    src={mediaUrl(
                      worldSlug,
                      `.sessions/${session.id}/media/${selected.id}/${selected.media.file}`,
                    )}
                    alt={`Take ${selected.n}`}
                    style={{ width: "100%", height: "100%", objectFit: "contain" }}
                  />
                  {/* A take has no name but its number, and that is the name it saves under
                      (issue 478). Keeping a copy is not keeping the take: nothing here files it,
                      discards it, or touches its disposition. */}
                  <ImageDownload
                    worldSlug={worldSlug}
                    path={`.sessions/${session.id}/media/${selected.id}/${selected.media.file}`}
                    name={`Take ${selected.n}`}
                  />
                </>
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
          chosenProvider={
            draft.params.kind === "voice" ? (draft.params.voiceProvider ?? draft.provider) : undefined
          }
          chosenModel={draft.params.kind === "voice" ? (draft.params.voiceModel ?? draft.model) : undefined}
          onClose={() => setVoiceOpen(false)}
          onPick={(voice) => {
            const chosenModel = models.find(
              (candidate) => candidate.provider === voice.provider && candidate.id === voice.model,
            );
            if (!chosenModel) {
              setRefusal("That voice's speech model is unavailable — choose another voice.");
              return;
            }
            setVoiceOpen(false);
            const currentParams =
              draft.params.kind === "voice" ? draft.params : { kind: "voice" as const, count: 1 };
            const { delivery: currentDelivery, ...withoutDelivery } = currentParams;
            const keepDelivery =
              currentDelivery !== undefined &&
              chosenModel?.limits.deliveries?.includes(currentDelivery) === true;
            compose({
              ...draft,
              // The label rides with the id so a take can name its voice without the catalogue.
              params: {
                ...withoutDelivery,
                ...(keepDelivery ? { delivery: currentDelivery } : {}),
                voiceId: voice.voiceId,
                voiceProvider: voice.provider,
                voiceModel: voice.model,
                voiceLabel: voice.label,
              } as BenchParams,
              // A voice belongs to a provider, so choosing one may change which model reads it.
              ...(chosenModel ? { provider: voice.provider, model: chosenModel.id } : {}),
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

        {/* "Write for me" (design turn 73). A description in, a draft out, and nothing reaches
            the song until Use these words is pressed — so a generation never carries words
            nobody read. The draft is shown BESIDE what the author has, never over it. */}
        {lyricsOpen && musicParams !== null && (
          <div className="fy-bench__briefmodal" role="dialog" aria-label="Write lyrics">
            <div className="fy-bench__briefmodalpanel" data-testid="lyrics-dialog">
              <div className="fy-bench__eyebrow">WHAT THE SONG IS ABOUT</div>
              <textarea
                autoFocus
                aria-label="What the song is about"
                value={lyricsAbout}
                onChange={(e) => setLyricsAbout(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setLyricsOpen(false);
                }}
                placeholder="A farewell sung on the harbour wall the night the tide-clock stopped."
              />
              {lyricsDraft !== null && (
                <>
                  <div className="fy-bench__eyebrow">
                    DRAFT
                    {/* Names who wrote it and how long it is, the way every other model-backed
                        control states its model. */}
                    <span className="fy-bench__lyricsauthor">
                      {`${lyricsAuthor ?? "the lyricist"} · ${lyricsDraft.length} characters`}
                    </span>
                  </div>
                  <pre className="fy-bench__lyricsdraft" data-testid="lyrics-draft">
                    {lyricsDraft}
                  </pre>
                </>
              )}
              {lyricsNote !== null && <span className="fy-bench__enhnote">{lyricsNote}</span>}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
                <Button
                  variant="ghost"
                  data-testid="lyrics-ask"
                  disabled={drafting || lyricsAbout.trim().length === 0 || model === null}
                  onClick={() => {
                    if (model === null) return;
                    setLyricsNote(null);
                    const requestId = sendBenchDraftLyrics({
                      worldId,
                      sessionId: session.id,
                      description: lyricsAbout,
                      ...(draft.brief.trim().length > 0 ? { style: draft.brief } : {}),
                      provider: model.provider,
                      model: model.id,
                    });
                    if (requestId === null) {
                      setLyricsNote("not connected - try again");
                      return;
                    }
                    draftingRef.current = requestId;
                    setLyricsAuthor(model.displayName);
                    setDrafting(true);
                  }}
                >
                  {lyricsDraft === null ? "Write" : "Try again"}
                </Button>
                <Button variant="ghost" onClick={() => setLyricsOpen(false)}>
                  Cancel
                </Button>
                {/* The only path from a draft into the song. */}
                <Button
                  variant="primary"
                  data-testid="lyrics-accept"
                  disabled={lyricsDraft === null}
                  onClick={() => {
                    if (lyricsDraft === null) return;
                    compose({ ...draft, params: { ...musicParams, lyrics: lyricsDraft } });
                    setLyricsOpen(false);
                  }}
                >
                  Use these words
                </Button>
              </div>
            </div>
          </div>
        )}
        {briefExpanded && (
          <div className="fy-bench__briefmodal" role="dialog" aria-label="The brief, large">
            <div className="fy-bench__briefmodalpanel">
              <BenchBrief
                variant="large"
                autoFocus
                value={draft.brief}
                onChange={(brief) => compose({ ...draft, brief })}
                options={mentions}
                worldSlug={worldSlug}
                underlay={briefWithChips(draft.brief, tokens, attached)}
                label="Brief"
                onEscape={() => setBriefExpanded(false)}
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
        {uploadConfirmation && (
          <RemoteVoiceUploadConfirmation
            destinationLabel={uploadConfirmation.destinationLabel}
            onCancel={() => {
              pendingDispatch.current = null;
              pendingDispatchAction.current = null;
              setUploadConfirmation(null);
            }}
            onConfirm={() => {
              const action = pendingDispatchAction.current;
              const token = uploadConfirmation.confirmationToken;
              setUploadConfirmation(null);
              if (action?.kind === "rerun") rerunBench(action.takeId, token);
              else if (action?.kind === "dispatch") dispatchBench(token);
            }}
          />
        )}
      </div>
    </div>
  );
}

function is4k(t: BenchTake): boolean {
  return t.request.params.kind === "video" && /4k|2160/i.test(t.request.params.resolution ?? "");
}

/** The word on each mode pill. One place, so the pills and anything naming a mode agree. */
const MODE_LABELS: Record<BenchMode, string> = {
  image: "Image",
  video: "Video",
  voice: "Voice",
  music: "Music",
};

/** The selected take's viewer chip: the request's own facts, nothing invented. */
function takeMeta(take: BenchTake): string {
  const p = take.request.params;
  // A song states its length, and states the MEASURED one — the request only ever carried a
  // ceiling, and a take that repeats the ceiling would be claiming a length nobody made.
  const played = take.media?.info?.durationSec;
  return [
    p.kind === "image"
      ? p.tier
      : p.kind === "video"
        ? p.resolution
        : p.kind === "voice"
          ? p.voiceLabel
          : played !== undefined
            ? `${Math.round(played)}s`
            : undefined,
    p.kind === "voice" ? p.delivery : p.kind === "music" ? undefined : p.aspect,
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

/**
 * The brief's text with its citations marked — never token-shaped strangers.
 *
 * Two kinds, and they are not marked the same. A mention ("@Image 1", issue 476) is a citation
 * the author made deliberately, so one whose source is no longer attached is drawn as visibly
 * lost rather than quietly reading as prose — it is what dispatch will refuse over. A bare
 * "Image 1" is the older spelling and stays as it was: chipped where the session knows the name,
 * and left alone otherwise, because a brief written before mentions existed never claimed it.
 */
function briefWithChips(text: string, tokens: Set<string>, attached: Set<string>): ReactNode[] {
  const out: ReactNode[] = [];
  let key = 0;
  // Everything between the mentions, where only the older bare spelling can be chipped.
  const prose = (slice: string): void => {
    for (const part of slice.split(/((?:Image|Video|Audio) [1-9][0-9]*)/g)) {
      out.push(
        tokens.has(part) ? (
          <mark key={key++} className="fy-bench__briefchip">
            {part}
          </mark>
        ) : (
          part
        ),
      );
    }
  };
  // The spans `benchMentionsIn` finds, not a second regex of the screen's own: a chip drawn
  // where the gate sees no citation is a promise the press then breaks.
  let at = 0;
  for (const mention of benchMentionsIn(text)) {
    prose(text.slice(at, mention.start));
    const lost = !attached.has(mention.token);
    out.push(
      <mark key={key++} className={cx("fy-bench__briefchip", lost && "fy-bench__briefchip--lost")}>
        {text.slice(mention.start, mention.end)}
      </mark>,
    );
    at = mention.end;
  }
  prose(text.slice(at));
  return out;
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
  return (
    typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
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
