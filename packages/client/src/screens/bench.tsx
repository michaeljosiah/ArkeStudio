import { planSubjectCharacterAudio } from "@arke-studio/contracts";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router";
import {
  benchMentionsIn,
  benchSourceKey,
  benchSubjectTitle,
  aspectSupport,
  deriveCapabilityAvailability,
  dispatchDuration,
  durationLimitsFor,
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
  type BenchReferenceToken,
  type BenchSession,
  type BenchTake,
  type ManifestModel,
  type SizeTier,
  type TaskMode,
} from "@arke-studio/contracts";
import {
  sendBenchAddReference,
  sendBenchAccept,
  sendBenchClearView,
  sendBenchCompose,
  sendBenchDiscard,
  sendBenchDispatch,
  sendBenchEnhanceBrief,
  sendBenchKeep,
  sendBenchNewSession,
  sendBenchOpen,
  sendBenchOpenSubject,
  sendBenchPresetDelete,
  sendBenchPresetSave,
  sendBenchRebuildSubject,
  sendBenchRemoveReference,
  sendBenchRerun,
  sendBenchSelectTake,
  sendBenchDraftLyrics,
  sendBenchTitle,
  sendBenchUploadReferences,
  subscribeBriefEnhanced,
  subscribeBenchSubjectAccepted,
  subscribeBenchSubjectOpened,
  subscribeLyricsDrafted,
  subscribeQueueResults,
  subscribeVoiceUploadConfirmations,
  useBench,
  useClientState,
  useStore,
  useWorld,
} from "../lib/store.js";
import { Button, Badge, cx } from "../components/ui.js";
import { AppChrome } from "../components/chrome.js";
import { ComposerMic } from "../components/dictation.js";
import { dismissQueueNote } from "../components/queue-toaster.js";
import {
  Book,
  ChevronDown,
  Expand,
  Film,
  Folder,
  Home,
  ImageMark,
  Message,
  PlaySolid,
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
import { droppedMentions, mentionOptions } from "../lib/bench-mention.js";
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
  type PickerSource,
} from "../components/reference-picker.js";

/**
 * The bench (issue 305; design 68b/68c): one picture or one shot made with no production
 * waiting on it. A session, not a dialog — leaving does not end it, takes are numbered in the
 * order asked for, and selecting an old take restores the request that made it.
 *
 * Layout is the master's: a fixed workspace with its own breadcrumb chrome — a 44px
 * destination rail, a 380px composer, the wall, a 116px take strip — never the
 * hero-and-scroll shape the world pages use.
 *
 * Under a production subject (SPEC-036 R-23..R-25) the same screen wears the scene
 * workspace's generation-session dress: no rail (the chrome's back is the way out), a
 * 392px column, and a 152px rail of thumbnails. Every one of those differences is keyed on
 * `session.subject`, because R-23 binds the world bench to change by nothing.
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
    if (
      worldId &&
      bench &&
      bench.worldId === worldId &&
      bench.session.subject === undefined &&
      sessionId === undefined
    ) {
      void navigate(`/w/${worldId}/artifacts/bench/${bench.session.id}`, { replace: true });
    }
  }, [worldId, sessionId, bench, navigate]);

  /**
   * A subject session's other mode is a different session (SPEC-036 R-23): the Image / Video
   * tabs ask the coordinator to prepare the shot in that mode and move there when it answers.
   * The wait lives here rather than in the workspace because the coordinator broadcasts the
   * prepared session BEFORE its correlated answer — the moment it does, the address below no
   * longer names the session in the store, the workspace that asked is unmounted, and a
   * listener kept there would never hear the id it was waiting for. This component stays.
   */
  const connection = useStore().connection;
  const pendingSubjectOpen = useRef<string | null>(null);
  const [subjectOpening, setSubjectOpening] = useState(false);
  const [subjectOpenNote, setSubjectOpenNote] = useState<string | null>(null);
  useEffect(
    () =>
      subscribeBenchSubjectOpened((answer) => {
        if (answer.worldId !== worldId || answer.requestId !== pendingSubjectOpen.current) return;
        pendingSubjectOpen.current = null;
        setSubjectOpening(false);
        if (answer.sessionId === null) {
          setSubjectOpenNote(answer.reason ?? "That mode could not be opened.");
          return;
        }
        setSubjectOpenNote(null);
        void navigate(`/w/${worldId}/artifacts/bench/${answer.sessionId}`);
      }),
    [worldId, navigate],
  );
  useEffect(() => {
    if (connection === "open" || pendingSubjectOpen.current === null) return;
    pendingSubjectOpen.current = null;
    setSubjectOpening(false);
    setSubjectOpenNote("Connection lost - try again.");
  }, [connection]);
  const openSubject = (input: Parameters<typeof sendBenchOpenSubject>[0]) => {
    if (pendingSubjectOpen.current !== null) return;
    const requestId = sendBenchOpenSubject(input);
    if (requestId === null) {
      setSubjectOpenNote("Not connected - try again.");
      return;
    }
    pendingSubjectOpen.current = requestId;
    setSubjectOpening(true);
    setSubjectOpenNote(null);
  };

  const session =
    bench !== null &&
    bench.worldId === worldId &&
    (sessionId === undefined ? bench.session.subject === undefined : bench.session.id === sessionId)
      ? bench.session
      : null;
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
      subjectOpen={{ open: openSubject, pending: subjectOpening, note: subjectOpenNote }}
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
  subjectOpen,
}: {
  worldId: string;
  session: BenchSession;
  manifest: NonNullable<ReturnType<typeof useClientState>>["app"]["manifest"] | null;
  /** The screen's own wait for a subject opened in another mode — see BenchScreen for why it is not here. */
  subjectOpen: {
    open: (input: Parameters<typeof sendBenchOpenSubject>[0]) => void;
    pending: boolean;
    note: string | null;
  };
}) {
  const world = useWorld();
  const state = useClientState();
  const connection = useStore().connection;
  const navigate = useNavigate();
  const worldSlug = world?.meta.slug;
  const subject = session.subject;

  // ---- the composer draft: local while typing, pushed debounced, restored by selection ----
  const [draft, setDraft] = useState(() => ({
    mode: session.composer.mode,
    provider: session.composer.provider,
    model: session.composer.model,
    params: session.composer.params,
    brief: session.composer.brief,
  }));
  const pendingRebuild = useRef<string | null>(null);
  const [rebuiltSession, setRebuiltSession] = useState<string | null>(null);
  const [rebuildNote, setRebuildNote] = useState<string | null>(null);
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
  useEffect(
    () =>
      subscribeBenchSubjectOpened((answer) => {
        if (answer.worldId !== worldId || answer.requestId !== pendingRebuild.current) return;
        pendingRebuild.current = null;
        if (answer.sessionId === null) {
          setRebuildNote(answer.reason ?? "The subject could not be rebuilt.");
          return;
        }
        setRebuildNote(null);
        setRebuiltSession(answer.sessionId);
      }),
    [worldId],
  );
  useEffect(() => {
    if (connection === "open" || pendingRebuild.current === null) return;
    pendingRebuild.current = null;
    setRebuildNote("Connection lost - try again.");
  }, [connection]);
  /**
   * The Image / Video tabs of a subject session (R-23; design 2616). The off tab is not a
   * mode change on this session: the shot in the other mode is a different prefill — its
   * video words carry the staging beats and the playblast rides — so the tab asks the
   * coordinator for that session, the way the Stage's "Render with this" does, and the
   * screen moves there when it answers. A board is video by definition and has no other tab.
   */
  const switchSubjectMode = (mode: "image" | "video") => {
    if (subject?.kind !== "shot" || mode === draft.mode) return;
    // Words typed in the last third of a second are still waiting on the debounce; they go now,
    // or the tab drops them on the floor.
    if (pushTimer.current) {
      clearTimeout(pushTimer.current);
      pushTimer.current = null;
      sendBenchCompose(worldId, session.id, draft);
    }
    subjectOpen.open({
      worldId,
      productionId: subject.productionId,
      sceneId: subject.sceneId,
      subject: { kind: "shot", shotId: subject.shotId },
      mode,
    });
  };
  useEffect(() => {
    if (rebuiltSession !== session.id) return;
    // The coordinator broadcasts the rebuilt workspace before its correlated answer. Applying
    // that answer here replaces the local typing draft without making every ordinary echo do so.
    setDraft({
      mode: session.composer.mode,
      provider: session.composer.provider,
      model: session.composer.model,
      params: session.composer.params,
      brief: session.composer.brief,
    });
    setRebuiltSession(null);
  }, [rebuiltSession, session]);

  const models = useMemo(() => usableModels(state, modeCapability(draft.mode)), [state, draft.mode]);
  const disabledVoiceRecipes = useMemo(
    () => (draft.mode === "voice" ? disabledRecipes(state, "voice-tts") : []),
    [state, draft.mode],
  );
  const subjectModelFault = (candidate: ManifestModel): string | null => {
    if (subject === undefined) return null;
    if (!aspectSupport(candidate, subject.aspect).ok) {
      return `does not make ${subject.aspect}`;
    }
    // A board, and a shot in video mode, are filed as covering an authored length: a model that
    // cannot make that length is a fault here, not a refusal after the button.
    if (subject.kind === "board" || (subject.kind === "shot" && draft.mode === "video")) {
      const duration = dispatchDuration(candidate, subject.durationSec, {
        taskMode: taskModeForKeyframes(candidate, session.composer.keyframeTokens.length),
        withReferences: session.composer.activeTokens.length > 0,
      });
      if (duration.kind === "over-cap") return `runs at most ${duration.longest}s`;
      if (duration.kind === "provider-default") return "does not offer a fixed duration";
    }
    return null;
  };
  const model: ManifestModel | null =
    models.find(
      (candidate) =>
        candidate.id === draft.model &&
        candidate.provider === draft.provider &&
        subjectModelFault(candidate) === null,
    ) ?? null;
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
  /**
   * Every row a token could have come from, as ONE list (issue 505).
   *
   * A token is resolved back to its row in four places — the tiles of both lanes, the mention
   * menu, and the carried set — and each used to concatenate its own lists. The tiles were
   * written before the Characters tab existed, so anything picked from a character resolved to
   * nothing: the tile said `missing` while the mention menu one line below named the same
   * picture (issue 505). The lane split is about occupancy alone — a lookup by `existingToken`
   * reads neither `active` nor the lane — so one list serves both lanes, and a fourth source
   * can now only be added in one place.
   */
  const tokenSources = useMemo(() => {
    const rows = [...worldSources, ...sessionSources, ...characterSources];
    if (subject === undefined) return rows;

    const byKey = new Map(rows.map((source) => [source.key, source]));
    const active = new Set(session.composer.activeTokens);
    for (const entry of session.tokenRegistry) {
      const referenceSource = entry.source;
      const key = benchSourceKey(referenceSource);
      const existing = byKey.get(key);
      const imagePath =
        existing?.imagePath ??
        (entry.kind !== "image"
          ? undefined
          : referenceSource.source === "world-file"
            ? referenceSource.path
            : referenceSource.source === "artifact"
              ? (() => {
                  const artifact = world?.artifacts.find(
                    (candidate) => candidate.id === referenceSource.artifactId,
                  );
                  return artifact === undefined ? undefined : `artifacts/${artifact.file}`;
                })()
              : (() => {
                  const take = session.takes.find((candidate) => candidate.id === referenceSource.takeId);
                  return take?.media === undefined
                    ? undefined
                    : `.sessions/${session.id}/media/${take.id}/${take.media.file}`;
                })());
      const pick: PickerSource["pick"] =
        referenceSource.source === "artifact"
          ? { source: "artifact", artifactId: referenceSource.artifactId }
          : referenceSource.source === "take"
            ? { source: "take", takeId: referenceSource.takeId }
            : { source: "world-file", path: referenceSource.path };
      byKey.set(key, {
        ...existing,
        key,
        kind: entry.kind,
        name: entry.label ?? existing?.name ?? entry.token,
        ...(imagePath !== undefined ? { imagePath } : {}),
        meta: entry.detail ?? existing?.meta ?? entry.kind,
        durationSec: entry.kind === "image" ? 0 : (entry.durationSec ?? existing?.durationSec ?? null),
        existingToken: entry.token,
        active: active.has(entry.token),
        pick,
      });
    }
    return [...byKey.values()];
  }, [worldSources, sessionSources, characterSources, subject, session, world?.artifacts]);
  const carried = useMemo(() => carriedForPicker(session, tokenSources), [session, tokenSources]);
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
        const dropped = droppedMentions(pending.sentBrief, answer.prompt);
        setEnhanceNote(
          dropped.length > 0 ? `${dropped.map((token) => `@${token}`).join(", ")} dropped` : null,
        );
        const unmoved =
          draftRef.current.brief === pending.sentBrief &&
          draftRef.current.provider === pending.provider &&
          draftRef.current.model === pending.model &&
          draftRef.current.mode === pending.mode;
        // A rewrite that lost one is never applied for you, however still the words have been.
        // Auto-apply is a convenience that rests on the answer meaning what the ask meant, and
        // a brief whose citation has gone means something else — it will not dispatch, and if
        // it did it would be a paid take grounded on a picture nobody asked it to look at. It
        // is offered instead, beside a note naming what went, and applying it is the author's.
        if (unmoved && dropped.length === 0) {
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
    () => mentionOptions(attachedTokens, tokenSources),
    [attachedTokens, tokenSources],
  );
  /** Said in the composer with the same function dispatch refuses with, so the two cannot differ. */
  const lostMentions = useMemo(
    () => unresolvedBenchMentions(draft.brief, attachedTokens),
    [draft.brief, attachedTokens],
  );

  // ---- dispatch + its refusal ----
  /**
   * What the last press was refused with, and the request it was refused for. The request is
   * carried because the same sentence is also raised as a notification over every screen, and
   * withdrawing that one needs its id (issue 507). A refusal the screen raised for itself — a
   * voice whose model is not here — has no request behind it.
   */
  const [refusal, setRefusal] = useState<{ reason: string; requestId: string | null } | null>(null);
  const pendingDispatch = useRef<string | null>(null);
  const pendingDispatchAction = useRef<
    { kind: "dispatch"; composer: typeof draft } | { kind: "rerun"; takeId: string } | null
  >(null);
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
            ? {
                reason: result.failures[0]?.reason ?? "That could not be dispatched.",
                requestId: result.requestId,
              }
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

  /**
   * A refusal does not outlive its cause (issue 507).
   *
   * It was said about particular words and particular pictures — "the brief cites @Image 1, which
   * is not attached" names both. Once either has moved it is a sentence about a request nobody is
   * holding any more: the words on screen no longer say what it quotes, and a refusal still stated
   * after the repair has been made is how people learn to stop reading refusals. Cleared from the
   * same two inputs the composer's own early warning recomputes from, so the two cannot disagree
   * about when the citation is settled. The notification raised for the same press carries the
   * same sentence over every other screen, and goes with it.
   */
  const composedFor = JSON.stringify([draft.brief, attachedTokens]);
  const standingRefusal = useRef(refusal);
  standingRefusal.current = refusal;
  /** Take back both surfaces at once, from the effect below and from the next press alike. */
  const clearRefusal = () => {
    const standing = standingRefusal.current;
    if (standing === null) return;
    setRefusal(null);
    if (standing.requestId !== null) dismissQueueNote(standing.requestId);
  };
  useEffect(() => {
    clearRefusal();
    // The refusal is read through a ref, so this runs when the words or the pictures move and
    // at no other time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composedFor]);

  const dispatchBench = (composer: typeof draft, voiceUploadConfirmedFor?: string) => {
    pendingDispatchAction.current = { kind: "dispatch", composer };
    pendingDispatch.current = sendBenchDispatch(worldId, session.id, composer, voiceUploadConfirmedFor);
  };
  const rerunBench = (takeId: string, voiceUploadConfirmedFor?: string) => {
    pendingDispatchAction.current = { kind: "rerun", takeId };
    pendingDispatch.current = sendBenchRerun(worldId, session.id, takeId, voiceUploadConfirmedFor);
  };

  // ---- selection ----
  const latest = session.takes[session.takes.length - 1] ?? null;
  const selected: BenchTake | null = session.takes.find((t) => t.id === session.selectedTakeId) ?? latest;
  const [pendingAccept, setPendingAccept] = useState<{ requestId: string; takeId: string } | null>(null);
  const pendingAcceptRef = useRef<{ requestId: string; takeId: string } | null>(null);
  const [acceptNote, setAcceptNote] = useState<string | null>(null);
  useEffect(
    () =>
      subscribeBenchSubjectAccepted((answer) => {
        if (
          answer.worldId !== worldId ||
          answer.sessionId !== session.id ||
          answer.requestId !== pendingAcceptRef.current?.requestId
        ) {
          return;
        }
        pendingAcceptRef.current = null;
        setPendingAccept(null);
        setAcceptNote(answer.accepted ? null : (answer.reason ?? "That take could not be filed."));
      }),
    [worldId, session.id],
  );
  useEffect(() => {
    if (connection === "open" || pendingAcceptRef.current === null) return;
    pendingAcceptRef.current = null;
    setPendingAccept(null);
    setAcceptNote("Connection lost - check production before trying again.");
  }, [connection]);
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
      params: bindSubjectParams(take.request.params),
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
  /**
   * A function of the row rather than a number for the chosen one, because a subject session
   * prices every model it offers (R-23's priced presets): each option in the select carries
   * what one take would cost under it, and the figure beside Generate is this same function
   * applied to the chosen row — so the two cannot disagree (R-25).
   */
  const estimateFor = (candidate: ManifestModel): number => {
    if (draft.params.kind === "image") {
      const output = imageOutputFor(candidate, {
        landscape: true,
        ...(draft.params.tier !== undefined ? { tier: draft.params.tier } : {}),
        ...(draft.params.aspect !== undefined ? { aspect: draft.params.aspect } : {}),
      });
      const each = estimateMicroUsd(candidate, {
        images: 1,
        megapixels: (output.width * output.height) / 1_000_000,
        referenceImages: carried.length,
        ...(output.resolution !== undefined ? { resolution: output.resolution } : {}),
      });
      return each * draft.params.count;
    }
    if (draft.params.kind === "voice") {
      // Exact, not a ceiling: speech bills per character and the characters are already typed.
      return estimateMicroUsd(candidate, { characters: draft.brief.length }) * draft.params.count;
    }
    if (draft.params.kind === "music") {
      // A ceiling, and the only honest kind of number here: the route calls its length an upper
      // bound and stops when the song is done, so this is what the take can cost at most.
      return estimateMicroUsd(candidate, { durationSec: MUSIC_DURATION_SEC }) * draft.params.count;
    }
    const taskMode = taskModeForKeyframes(candidate, session.composer.keyframeTokens.length);
    const seconds = draft.params.durationSec ?? durationLimitsFor(candidate, taskMode).maxDurationSec ?? 5;
    return estimateMicroUsd(candidate, {
      durationSec: pricedDuration(candidate, seconds, {
        taskMode,
        withReferences: session.composer.activeTokens.length > 0,
      }),
      ...(draft.params.resolution !== undefined ? { resolution: draft.params.resolution } : {}),
    });
  };
  const estimate = model === null ? null : estimateFor(model);

  const promptCap = model?.limits.maxPromptChars;
  const overCap = promptCap !== undefined && draft.brief.length > promptCap;
  const estimateCopy =
    estimate === null
      ? null
      : speaking
        ? formatMicroUsd(estimate)
        : singing
          ? `up to ${formatMicroUsd(estimate)}`
          : `~${formatMicroUsd(estimate)}`;

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
    if (mode === draft.mode || subject !== undefined) return;
    modeMemory.current[draft.mode] = { provider: draft.provider, model: draft.model, params: draft.params };
    compose({
      ...draft,
      mode,
      ...setupForMode(mode, modeMemory.current[mode], usableModels(state, modeCapability(mode))),
    });
  };

  function bindSubjectParams(params: BenchParams): BenchParams {
    if (subject === undefined) return params;
    if (subject.kind === "shot") {
      return params.kind === "image" ? { ...params, aspect: subject.aspect } : session.composer.params;
    }
    return params.kind === "video"
      ? {
          ...params,
          aspect: subject.aspect,
          durationSec: subject.durationSec,
          sound: true,
        }
      : session.composer.params;
  }

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
  const taskMode = model === null ? "generate" : taskModeForKeyframes(model, session.composer.keyframeTokens.length);
  const characterAudio = world && model && subject && draft.params.kind === "video" ? planSubjectCharacterAudio({
    world, subject, model, imageCount: session.composer.keyframeTokens.length || carried.length,
    taskMode, disabled: draft.params.audioReferencesDisabled }) : null;
  // The track's geometry and its states, worked out in one place so the fill, the ends, the
  // handle and the pill cannot drift apart. See lib/duration.ts for why it has two extra stops.
  const track =
    videoParams !== null && model !== null
      ? durationTrack(model, videoParams.durationSec, { taskMode, withReferences })
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
              longestOffered(models, session.composer.keyframeTokens.length, withReferences) >
                durationStops[durationStops.length - 1]! && (
                <s className="fy-bench__durationover" title="Longer than this model runs">
                  {`${longestOffered(models, session.composer.keyframeTokens.length, withReferences)}s`}
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
  const sessionTitle =
    subject === undefined ? (session.title ?? "Untitled session") : (session.title ?? benchSubjectTitle(subject));
  /**
   * The chain as the design splits it (R-24; design 2609-2612): a mono crumb, the subject, its
   * own line, and what this screen is. One bold string in a switcher button was the world
   * bench's shape; a subject session has no sessions to switch between, so the slot names
   * where you are instead.
   */
  const provenance =
    subject === undefined
      ? null
      : {
          crumb: [
            subject.productionTitle,
            subject.episode ? `episode ${subject.episode.order}` : null,
            `scene ${subject.sceneNumber}`,
          ]
            .filter((part): part is string => part !== null)
            .join(" · "),
          title: subject.kind === "shot" ? `Shot ${subject.shotNumber}` : `Board ${subject.letter}`,
          sub:
            subject.kind === "shot"
              ? subject.shotTitle
              : `${subject.members.length} shots · ${subject.durationSec}s · one pass`,
        };
  const back =
    subject === undefined
      ? { label: world?.meta.name ?? "Artifacts", to: `/w/${worldId}/artifacts` }
      : {
          label: `Scene ${subject.sceneNumber}`,
          to: `/w/${worldId}/p/${subject.productionId}/scenes/${subject.sceneId}`,
        };
  const referenceTokens =
    subject === undefined
      ? session.composer.activeTokens
      : [
          ...new Set([
            ...session.composer.activeTokens,
            ...session.tokenRegistry
              .filter(
                (entry) =>
                  session.subjectTokens.includes(entry.token) &&
                  entry.label !== undefined &&
                  !session.composer.keyframeTokens.includes(entry.token),
              )
              .map((entry) => entry.token),
          ]),
        ];
  const registryEntry = (token: string): BenchReferenceToken | undefined =>
    session.tokenRegistry.find((entry) => entry.token === token);
  /** The corner chip: the token, which is also the name the brief cites the picture by. */
  const refChip = (entry: BenchReferenceToken | undefined): ReactNode =>
    entry === undefined ? null : <span className="fy-bench__tokenchip">{entry.token}</span>;
  /**
   * Under a subject session's tile (design 2655): the name with its sheet version, then the
   * detail. R-23 asks for a reference the route cannot carry to be *named* as not riding, never
   * merely dimmed, so that word stays on the second line even though the design draws none.
   */
  const refName = (entry: BenchReferenceToken | undefined, riding: boolean): ReactNode => {
    if (subject === undefined || entry?.label === undefined) return null;
    const version =
      entry.sheetVersion === undefined || entry.label.includes(`v${entry.sheetVersion}`)
        ? ""
        : ` · v${entry.sheetVersion}`;
    const meta = [entry.detail, riding ? undefined : "not riding"].filter(
      (part): part is string => part !== undefined,
    );
    return (
      <span className="fy-bench__refname">
        <span className="fy-bench__reflabel">{`${entry.label}${version}`}</span>
        {meta.length > 0 && <span className="fy-bench__refmeta">{meta.join(" · ")}</span>}
      </span>
    );
  };
  /** A tile in a subject session is a column — the box, then its name — where the world bench's is the box alone. */
  const refColumn = (token: string, riding: boolean, tile: ReactNode, name: ReactNode): ReactNode =>
    subject === undefined ? (
      tile
    ) : (
      <div key={token} className="fy-bench__ref" data-riding={riding ? "true" : "false"}>
        {tile}
        {name}
      </div>
    );
  /** The design groups the references and the prompt with their eyebrows; the world bench has neither. */
  const subjectGroup = (children: ReactNode, extra?: string): ReactNode =>
    subject === undefined ? children : <div className={cx("fy-bench__group", extra)}>{children}</div>;
  const rebuild = () => {
    if (pushTimer.current) clearTimeout(pushTimer.current);
    const requestId = sendBenchRebuildSubject(worldId, session.id);
    if (requestId === null) {
      setRebuildNote("Not connected - try again.");
      return;
    }
    pendingRebuild.current = requestId;
    setRebuildNote("Rebuilding…");
  };

  return (
    <div
      data-screen="bench"
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <AppChrome
        back={back}
        menu={
          provenance !== null ? (
            <span className="fy-bench__crumb fy-bench__crumb--subject" data-testid="bench-provenance">
              <span className="fy-bench__crumbsep">/</span>
              <span className="fy-bench__provenance">{provenance.crumb}</span>
              <span className="fy-bench__subjectname">{provenance.title}</span>
              <span className="fy-bench__subjectsub">{provenance.sub}</span>
              <span className="fy-bench__sessionkind">generation session</span>
            </span>
          ) : (
          <span className="fy-bench__crumb">
            <span className="fy-bench__crumbsep">/</span>
            <span style={{ position: "relative", display: "inline-flex" }}>
              <button
                type="button"
                className="fy-bench__session"
                aria-expanded={sessionsOpen}
                onClick={() => setSessionsOpen((v) => !v)}
              >
                {sessionTitle}
                <ChevronDown size={12} />
              </button>
              {sessionsOpen && (
                <>
                  <div className="fy-bench__scrim" onClick={() => setSessionsOpen(false)} />
                  <div className="fy-bench__sessionmenu" role="menu" aria-label="Bench sessions">
                    {subject === undefined && (
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
                    )}
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
          )
        }
      />
      <div className={cx("fy-bench", subject !== undefined && "fy-bench--subject")}>
        {/* ---- the destination rail — the world's places; a subject session's way out is the
            chrome's back, so it has none (design 2614) ------------------------ */}
        {subject === undefined && (
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
        )}

        {/* ---- composer -------------------------------------------------- */}
        <div className="fy-bench__composer">
          {draft.mode === "video" && subject?.kind === "shot" && session.tokenRegistry.some(ref => ref.label?.startsWith("Staging")) ? (
            <p role="status" data-testid="stage-guidance-mode">
              {session.tokenRegistry.some(ref => ref.kind === "video" && ref.label?.startsWith("Staging") && session.composer.activeTokens.includes(ref.token))
                ? "Camera guidance: motion video and timed instructions. Review the generated take for adherence."
                : session.tokenRegistry.some(ref=>ref.kind==="image" && ref.label?.startsWith("Staging") && [...session.composer.activeTokens,...session.composer.keyframeTokens].includes(ref.token))
                  ? "Camera guidance: opening frame and timed instructions only. This route is not receiving the motion video."
                  : "Camera guidance: timed instructions only. This route is not receiving Stage images or motion video."}
            </p>
          ) : null}
          <div className="fy-bench__composerbar">
            {subject !== undefined ? (
              /* Two text tabs on the design's track (2616-2621). A shot's other tab opens the
                 shot in that mode; a board has only the one. */
              <div className="fy-bench__mode fy-bench__mode--subject" role="group" aria-label="What to make">
                {(subject.kind === "shot" ? (["image", "video"] as const) : (["video"] as const)).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    aria-pressed={draft.mode === mode}
                    disabled={subjectOpen.pending && draft.mode !== mode}
                    onClick={() => switchSubjectMode(mode)}
                  >
                    {MODE_LABELS[mode]}
                  </button>
                ))}
              </div>
            ) : (
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
            )}
            {subject === undefined && (
              <>
                <span style={{ flex: 1 }} />
                <button
                  type="button"
                  className="fy-bench__clear"
                  title="Clear the bench — a new session; this one keeps running"
                  onClick={() => sendBenchNewSession(worldId)}
                >
                  ⟲
                </button>
              </>
            )}
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
          {lane === "reference" && !soundOnly && subjectGroup(
            <>
              {subject !== undefined && (
                <div className="fy-bench__eyebrow fy-bench__eyebrow--refs" data-testid="bench-references-eyebrow">
                  References
                  <span className="fy-bench__refcount">{`${referenceTokens.length} referenced`}</span>
                </div>
              )}
            <div className="fy-bench__refgrid">
              {referenceTokens.map((token) => {
                const source = tokenSources.find((s) => s.existingToken === token);
                const entry = registryEntry(token);
                const riding = session.composer.activeTokens.includes(token);
                const tile = (
                  <div key={token} className="fy-bench__reftile" data-riding={riding ? "true" : "false"}>
                    {source?.imagePath ? (
                      <Portrait
                        worldSlug={worldSlug}
                        path={source.imagePath}
                        label={subject === undefined ? token : source.name}
                        radius={0}
                      />
                    ) : entry?.kind === "audio" ? (
                      <span className="fy-bench__wave" aria-label={entry.detail ?? entry.label ?? "audio reference"}>
                        <Waveform size={18} />
                        <span aria-hidden="true" />
                        <span aria-hidden="true" />
                        <span aria-hidden="true" />
                      </span>
                    ) : entry?.kind === "video" && subject !== undefined ? (
                      /* A clip has no poster on the shelf. The staging playblast is the one
                         that reaches a subject session, and the design draws it as three
                         greybox figures on a floor (2634-2641) rather than the word "video". */
                      <span className="fy-bench__blockstand" role="img" aria-label={entry.label ?? "video reference"}>
                        <i />
                        <i />
                        <i />
                      </span>
                    ) : (
                      <span className="fy-bench__takestate">{source?.kind ?? "missing"}</span>
                    )}
                    {refChip(entry)}
                    {riding && (
                      <button
                        type="button"
                        className="fy-bench__tokenremove"
                        aria-label={`Remove ${token}`}
                        onClick={() => sendBenchRemoveReference(worldId, session.id, token)}
                      >
                        ×
                      </button>
                    )}
                  </div>
                );
                return refColumn(token, riding, tile, refName(entry, riding));
              })}
              <button
                type="button"
                className="fy-bench__reftile fy-bench__reftile--add"
                onClick={() => openPicker("reference")}
                data-testid="bench-add-reference"
              >
                {subject !== undefined ? <Plus size={14} /> : <ImageMark size={14} />}
                {subject !== undefined ? "reference" : "Reference"}
              </button>
            </div>
            </>,
          )}

          {/* keyframe tiles — the pictures the shot must pass through, in order */}
          {lane === "keyframe" && (
            <>
              <div className="fy-bench__refgrid" data-testid="keyframe-lane">
                {frames.map((token, index) => {
                  const source = tokenSources.find((s) => s.existingToken === token);
                  const entry = registryEntry(token);
                  const tile = (
                    <div key={token} className="fy-bench__reftile">
                      {source?.imagePath ? (
                        <Portrait worldSlug={worldSlug} path={source.imagePath} label={token} radius={0} />
                      ) : (
                        <span className="fy-bench__takestate">{source?.kind ?? "missing"}</span>
                      )}
                      {frames.length <= 2 && (
                        <span className="fy-bench__slotchip">{index === 0 ? "start" : "end"}</span>
                      )}
                      {refChip(entry)}
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
                  return refColumn(token, true, tile, refName(entry, true));
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
          {/* brief — tokens the session knows render as chips inline (issue 305 §3). Under a
              subject it wears the design's eyebrow, with Rebuild at its right, and says
              once beneath the box that @ reaches the world (2665-2670). */}
          {subjectGroup(
            <>
              {subject !== undefined && (
                <div className="fy-bench__eyebrow fy-bench__eyebrow--refs">
                  Prompt
                  <button
                    type="button"
                    className="fy-sblink"
                    data-testid="bench-rebuild"
                    disabled={pendingRebuild.current !== null}
                    onClick={rebuild}
                  >
                    Rebuild
                  </button>
                </div>
              )}
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
              {subject !== undefined && (
                <span className="fy-bench__athint">type @ to bring in anything from the world</span>
              )}
            </>,
            "fy-bench__group--prompt",
          )}
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

          {/* the mode's settings row. Under a subject the production's context chips lead it
              (design 2672-2676) and the add-reference chip is absent — the dashed tile above
              is the add there. */}
          <div
            className={subject === undefined ? "fy-bench__settings" : "fy-bench__subjectcontext"}
            {...(subject !== undefined
              ? { "data-testid": "bench-subject-context", "aria-label": "Production context" }
              : {})}
          >
            {subject !== undefined && (
              <>
                <span>{`aspect · ${subject.aspect}`}</span>
                <span>{`duration · ${subject.durationSec}s`}</span>
                <span>{draft.mode === "video" ? "sound · on" : "seed · auto"}</span>
              </>
            )}
            {subject === undefined && !soundOnly && (
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
                {subject === undefined && aspects.length > 0 && aspectSelect}
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
                {subject === undefined && aspects.length > 0 && aspectSelect}
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
                {subject === undefined && model.limits.soundChoice === true && (
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
                {subject === undefined && durationStops.length > 0 && (
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
            {subject !== undefined && (rebuildNote ?? subjectOpen.note) !== null && (
              <span className="fy-bench__subjectnote">{rebuildNote ?? subjectOpen.note}</span>
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
                      const wrongSubjectMode = subject !== undefined && preset.mode !== draft.mode;
                      const presetModel = manifest?.models.find(
                        (candidate) => candidate.provider === preset.provider && candidate.id === preset.model,
                      );
                      const subjectFault = presetModel === undefined ? null : subjectModelFault(presetModel);
                      return (
                        <div key={preset.id} className="fy-bench__presetrow">
                          <button
                            type="button"
                            className="fy-bench__sessionrow"
                            disabled={!fault.ok || wrongSubjectMode || subjectFault !== null}
                            title={
                              wrongSubjectMode
                                ? `This ${preset.mode} preset does not match the ${draft.mode} subject`
                                : subjectFault !== null
                                  ? `${presetModel?.displayName ?? preset.model} ${subjectFault}`
                                : fault.ok
                                  ? undefined
                                  : fault.reason
                            }
                            onClick={() => {
                              if (!fault.ok || wrongSubjectMode) return;
                              setPresetsOpen(false);
                              compose({
                                mode: preset.mode,
                                provider: preset.provider,
                                model: preset.model,
                                params: bindSubjectParams(preset.params),
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
                    compose({
                      ...draft,
                      provider: chosen.provider,
                      model: chosen.id,
                      params: bindSubjectParams(params),
                    });
                  }}
                >
                  <option value="" disabled>
                    choose a model
                  </option>
                  {models.map((candidate) => {
                    const fault = subjectModelFault(candidate);
                    // Each row a subject session can spend on carries its price (R-23, R-25).
                    const price =
                      subject !== undefined && fault === null ? ` · ~${formatMicroUsd(estimateFor(candidate))}` : "";
                    return (
                      <option
                        key={`${candidate.provider}/${candidate.id}`}
                        value={`${candidate.provider}/${candidate.id}`}
                        disabled={fault !== null}
                      >
                        {candidate.displayName}{fault === null ? price : ` · ${fault}`}
                      </option>
                    );
                  })}
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
            {estimateCopy !== null && (
              <span data-testid="bench-estimate" className="fy-bench__estimate">
                {/* Exact for speech, because the characters are already typed. A ceiling for a
                    song, because the route stops when the song is done — and a tilde would read
                    as "about", when the truth is "at most". A subject session says what the
                    figure is for (design 2684). */}
                {subject === undefined ? estimateCopy : `${estimateCopy} a take`}
              </span>
            )}
            {characterAudio && <div aria-label="Character audio references" style={{ flexBasis: "100%" }}>
              <label><input type="checkbox" checked={!characterAudio.disabled} onChange={e => compose({ ...draft,
                params: { ...draft.params, kind: "video", audioReferencesDisabled: !e.target.checked } as BenchParams })} /> Use assigned character voice references for this dispatch</label>
              {characterAudio.references.map(r => <p key={r.label}>{r.characterName} · {r.label} · {("sample" in r ? r.sample : "master" in r ? r.prepared : r.performance).provenance.outputTechnical.durationSec?.toFixed(1)}s · voice guidance, new scene dialogue</p>)}
              {characterAudio.references.length > 0 && <p>The model generates synchronized audio. Voice identity and cadence are guidance, not guaranteed reproduction.</p>}
              {characterAudio.problems.map((problem, i) => <p key={i} role="alert">{problem}</p>)}
            </div>}
            <Button
              variant="primary"
              size={subject === undefined ? "default" : "sm"}
              data-testid="bench-generate"
              disabled={
                (characterAudio?.problems.length ?? 0) > 0 ||
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
                clearRefusal();
                if (pushTimer.current) clearTimeout(pushTimer.current);
                dispatchBench(draft);
              }}
            >
              {draft.params.kind === "image" && draft.params.count > 1
                ? `Generate ${draft.params.count}${subject !== undefined && estimateCopy !== null ? ` · ${estimateCopy}` : ""}`
                : `Generate${subject !== undefined && estimateCopy !== null ? ` · ${estimateCopy}` : ""}`}
            </Button>
          </div>
          {refusal !== null && (
            <p role="alert" className="fy-bench__refusal">
              {refusal.reason}
            </p>
          )}
        </div>

        {/* ---- the wall --------------------------------------------------- */}
        <div className="fy-bench__wall">
          <div className="fy-bench__wallbar">
            {/* R-24: a subject session's filter is All / Filed / Discarded, on the design's
                track (2690-2695); the world bench keeps 4K where it has video to answer for it. */}
            {subjectGroup(
              (
                [
                  "all",
                  "filed",
                  "discarded",
                  ...(hasVideoTakes && subject === undefined ? (["4k"] as const) : []),
                ] as const
              ).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={cx("fy-bench__tab", wallFilter === f && "fy-bench__tab--active")}
                  onClick={() => setWallFilter(f)}
                >
                  {f === "all" ? "All" : f === "filed" ? "Filed" : f === "discarded" ? "Discarded" : "4K"}
                </button>
              )),
              "fy-bench__filters",
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
              {subject === undefined ? (
                <strong style={{ font: "600 15px var(--font-sans)" }}>
                  {selected ? statusLine(liveStatus(selected), selected) : "The bench is empty"}
                </strong>
              ) : selected === null ? (
                /* The design's two mono states (2704-2715): nothing yet, and rendering. */
                <>
                  <ImageMark size={22} />
                  <span className="fy-bench__emptyline">no takes yet · generate to see one here</span>
                </>
              ) : inFlight(liveStatus(selected)) ? (
                <span className="fy-bench__rendering" data-testid="bench-rendering">
                  <span className="fy-bench__emptyline">rendering…</span>
                  <span className="fy-bench__emptysub">
                    {`${modelName(selected.request.provider, selected.request.model)} · take ${selected.n}`}
                  </span>
                </span>
              ) : (
                <span className="fy-bench__emptyline">{statusLine(liveStatus(selected), selected)}</span>
              )}
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
            {subject !== undefined && selected?.disposition === "open" && selected.media !== undefined && (
              <span className="fy-bench__acceptoutcome">
                {subject.kind === "shot"
                  ? `accepting files the ${draft.mode === "video" ? "clip" : "frame"} onto shot ${subject.shotNumber}`
                  : `accepting files the clip onto ${subject.members.length} shots`}
              </span>
            )}
            <span style={{ flex: 1 }} />
            {selected && selected.disposition === "filed" && (
              <Badge tone="neutral">
                {subject === undefined
                  ? "filed as artifact"
                  : subject.kind === "shot"
                    ? `filed on shot ${subject.shotNumber}`
                    : `filed on ${subject.members.length} shots`}
              </Badge>
            )}
            {selected && selected.disposition === "discarded" && <Badge tone="neutral">discarded</Badge>}
            {selected && selected.disposition === "open" && selected.media && (
              <>
                {/* Under a subject, Discard is the quiet text beside a small Accept (design
                    2743-2744): it files nothing anywhere, and its weight says so. */}
                <Button
                  variant={subject === undefined ? "outline" : "ghost"}
                  size={subject === undefined ? "default" : "sm"}
                  disabled={pendingAccept?.takeId === selected.id}
                  onClick={() => sendBenchDiscard(worldId, session.id, selected.id)}
                >
                  Discard
                </Button>
                {subject === undefined ? (
                  <Button
                    variant="primary"
                    data-testid="bench-keep"
                    onClick={() => sendBenchKeep(worldId, session.id, selected.id)}
                  >
                    Keep · file as artifact
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    data-testid="bench-accept"
                    disabled={
                      selected.request.filing === undefined || pendingAccept?.takeId === selected.id
                    }
                    onClick={() => {
                      setAcceptNote(null);
                      const requestId = sendBenchAccept(worldId, session.id, selected.id);
                      if (requestId === null) {
                        setAcceptNote("Not connected - try again.");
                        return;
                      }
                      pendingAcceptRef.current = { requestId, takeId: selected.id };
                      setPendingAccept(pendingAcceptRef.current);
                    }}
                  >
                    {pendingAccept?.takeId === selected.id ? "Accepting…" : "Accept"}
                  </Button>
                )}
              </>
            )}
            {acceptNote !== null && (
              <span role="alert" className="fy-bench__acceptnote">
                {acceptNote}
              </span>
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
                {subject === undefined && <span className="fy-bench__taken">{take.n}</span>}
                <span
                  className="fy-bench__takeframe"
                  data-inflight={subject !== undefined && inFlight(status) ? "true" : undefined}
                >
                  {take.media ? (
                    <>
                      {/* Its first frame, not the clip: an <img> pointed at an .mp4 cannot decode,
                          and every video take on this strip was a grey box with a label in it. */}
                      <Portrait
                        worldSlug={worldSlug}
                        path={`.sessions/${session.id}/media/${take.id}/${posterNameFor(take.media.file)}`}
                        label={`take ${take.n}`}
                        radius={0}
                      />
                      {subject !== undefined && take.request.mode === "video" && (
                        <span className="fy-bench__takeplay" aria-hidden="true">
                          <span>
                            <PlaySolid size={11} />
                          </span>
                        </span>
                      )}
                    </>
                  ) : subject !== undefined && inFlight(status) ? (
                    /* R-24: a generating take is a hatched placeholder with a spinner. */
                    <span className="fy-bench__takespin" role="img" aria-label="rendering" />
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
                {subject !== undefined && (
                  <span className="fy-bench__takeline">
                    <span className="fy-bench__taken">{`take ${take.n}`}</span>
                    <span className="fy-bench__takestatus">
                      {inFlight(status) ? "rendering" : status === "succeeded" ? "ready" : status}
                    </span>
                  </span>
                )}
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
              setRefusal({
                reason: "That voice's speech model is unavailable — choose another voice.",
                requestId: null,
              });
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
              else if (action?.kind === "dispatch") dispatchBench(action.composer, token);
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
function taskModeForKeyframes(model: ManifestModel, count: number): TaskMode {
  if (count === 0) return "generate";
  const plan = keyframePlan(model, count);
  return plan.ok ? plan.mode : "generate";
}

function longestOffered(models: readonly ManifestModel[], keyframes: number, withReferences: boolean): number {
  return models.reduce((longest, model) => {
    const options = durationOptions(model, {
      taskMode: taskModeForKeyframes(model, keyframes),
      withReferences,
    });
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
