// Making a new world: the founding conversation, its draft and the build card (issue 2816).
import {
  CODEX_IMAGE_PLAN_LABEL, formatMicroUsd, ulid, type ModelChoices, blueprintCoverage,
  modelForCapability, imagePriceCopy, estimateImageMicroUsd,
} from "@arke-studio/contracts";
import { Working } from "../components/working.js";
import { ApprovedGenesisContent, GenesisContentCards } from "../components/genesis-review.js";
import { genesisMediaUrl } from "../lib/media.js";
import { Button, Callout, cx, Select, Input, Textarea } from "../components/ui.js";
import { useSearchParams, useNavigate } from "react-router";
import { useRef, useState, useEffect } from "react";
import {
  useStore, useGenesis, takeRejectedGenesisChat, listGenesisDrafts, loadGenesisDraft,
  reviewGenesisImports, reviewGenesisDraft, useBuildPlans, genesisChat, createSheetFromSentence,
  openThread, genesisDiscard, reviewGenesisVoices, reviewGenesisImages, planFoundingBuild,
  proposeGenesisWorld, createWorld, resolveGenesisImport, decideGenesisDraft,
  reviewGenesisReadiness, leaveGenesisFinding, generateGenesisVoice, decideGenesisVoice, cancelJob,
  generateGenesisImage, decideGenesisImage, generateLookPreview, beginFoundingBuild,
  genesisAttachFiles, hostCanAttach, attachHostFiles, attachHostText,
} from "../lib/store.js";
import { languageChoiceReason, harnessModelsNeedAWord, HarnessModelStatus } from "../components/harness-models.js";
import { AppChrome } from "../components/chrome.js";
import { ArtStyleGrid, ArtStyleWords } from "../components/art-style-picker.js";
import { seedFrom } from "../lib/art-styles.js";
import { FoundingProgressCard, GenesisReadinessCard } from "../components/genesis-readiness.js";
import { renderInlineMarkdown } from "../components/inline-markdown.js";
import { Loading } from "../components/loading.js";
import { GenesisImportCards } from "../components/genesis-imports.js";
import { GenesisVoiceCards } from "../components/genesis-voices.js";
import { GenesisImageCards } from "../components/genesis-images.js";
import { Composer } from "../components/composer.js";
import { ModelChip } from "../components/model-chip.js";
import { ModelsCard, WORLD_MODEL_CAPABILITIES, withModelChoice } from "../components/models-card.js";

// ---- New world -------------------------------------------------------------

const GENESIS_TONES = ["Quiet dread", "Wonder", "Grim", "Playful"] as const;

/** "Name · one line" → the two halves createSheetFromSentence needs; null until both exist. */
function parseSeed(raw: string): { name: string; sentence: string } | null {
  const m = /^(.*?)(?:·|—|-{2}|,)\s*(.+)$/.exec(raw.trim());
  if (!m) return null;
  const name = m[1]!.trim();
  const sentence = m[2]!.trim();
  return name.length > 0 && sentence.length > 0 ? { name, sentence } : null;
}

/**
 * The review before the press (SPEC-031 R-12): what will be created counted by kind, how
 * many generations that is, spend as one figure — and every precondition that failed,
 * stated on the way in rather than discovered at item nine of fifteen (R-11).
 *
 * A card in the founding conversation, not a route of its own (issue 920). The decision was
 * reached in the thread; a second screen for it was a second stop for a yes already given,
 * and the one spend in the whole flow that left the chat every other decision is made in.
 * The press is still one aggregate authorization (R-13) — the same yes, asked where the
 * author is.
 */
function BuildCard({
  plan: entry,
  startedAt,
  pressed,
  settling,
  onDismiss,
  onBuild,
}: {
  plan: { requestId: string; plan: import("@arke-studio/contracts").BuildReview | null; reason?: string } | undefined;
  startedAt: string | null;
  pressed: boolean;
  /** A turn is in flight: the blueprint under the card is moving, so the press waits. */
  settling: boolean;
  onDismiss: () => void;
  onBuild: () => void;
}) {
  const plan = entry?.plan ?? null;
  const counts: Array<[number, string]> = plan
    ? [
        [plan.counts.characters, plan.counts.characters === 1 ? "character" : "characters"],
        [plan.counts.locations, plan.counts.locations === 1 ? "place" : "places"],
        [plan.counts.factions, plan.counts.factions === 1 ? "faction" : "factions"],
        [plan.counts.canon, plan.counts.canon === 1 ? "canon entry" : "canon entries"],
        [plan.counts.props, plan.counts.props === 1 ? "prop" : "props"],
        [plan.counts.threads, plan.counts.threads === 1 ? "open thread" : "open threads"],
      ]
    : [];
  const includedImages = plan?.imagePlan === "included-plan";
  const estimate = plan === null ? null : includedImages ? CODEX_IMAGE_PLAN_LABEL : `${formatMicroUsd(plan.estimateMicroUsd)} generation budget`;
  return (
    <article
      className="fy-actioncard"
      data-status={entry !== undefined && plan === null ? "failed" : pressed ? "running" : "pending"}
      aria-label={plan ? `Build ${plan.worldName}` : "The founding build"}
    >
      <div className="fy-actioncard__head">
        <div>
          <div className="fy-actioncard__reason">new world · the build</div>
          <h3>{plan ? `One press makes ${plan.worldName}.` : "The founding build"}</h3>
        </div>
        {estimate !== null && <span className="fy-actioncard__status">{estimate}</span>}
      </div>
      {entry === undefined ? (
        <Working label="Sizing the build" startedAt={startedAt} />
      ) : plan === null ? (
        <p className="fy-actioncard__notice">{entry.reason ?? "the build could not be sized"}</p>
      ) : (
        <>
          {plan.approvedContent && <ApprovedGenesisContent blueprint={plan.approvedContent} />}
          {plan.approvedContent?.selectedImages?.map(selection => <details key={selection.target}>
            <summary>Reuse {selection.candidate.label} for {selection.target}</summary>
            <img className="fy-actioncard__media" src={genesisMediaUrl(plan.genesisId, selection.candidate.file)} alt={selection.candidate.label} />
          </details>)}
          {plan.approvedContent?.selectedVoices?.map(selection => <p key={selection.plan.intent.target}>
            Assign {selection.plan.voice.label} ({selection.plan.voice.provider}) to {selection.plan.title}; no new audition.
          </p>)}
          {plan.work && <details><summary>Work and reused selections</summary>{plan.work.map(item => <p key={item.key}>
            {item.name} · {item.kind.replaceAll("-", " ")} · {item.authorized ? includedImages && ["main-photo", "establishing-view", "sheet-image", "key-art"].includes(item.kind) ? CODEX_IMAGE_PLAN_LABEL : formatMicroUsd(item.estimatedMicroUsd) : "not authorized"}
          </p>)}</details>}
          <p className="fy-actioncard__consequence">
            {counts
              .filter(([count]) => count > 0)
              .map(([count, label]) => `${count} ${label}`)
              .join(" · ")}
          </p>
          <div className="fy-mono" style={{ fontSize: 10 }}>
            {plan.generations} GENERATION{plan.generations === 1 ? "" : "S"}
            {plan.imageModel ? ` · ${plan.imageModel.toUpperCase()}` : ""}
          </div>
          <p className="fy-actioncard__notice">Work that would exceed this estimate is skipped.</p>
          {plan.notes.map((note, index) => (
            <p key={index} className="fy-actioncard__notice">
              {note}
            </p>
          ))}
        </>
      )}
      <div className="fy-actioncard__actions">
        {plan !== null && (
          <Button variant="primary" disabled={pressed || settling} onClick={onBuild}>
            {pressed
              ? "Building…"
              : plan.generations === 0
                ? `Build ${plan.worldName}`
                : `Build ${plan.worldName} · ${includedImages ? "ChatGPT plan" : `~${formatMicroUsd(plan.estimateMicroUsd)}`}`}
          </Button>
        )}
        <Button variant="ghost" disabled={pressed} onClick={onDismiss}>
          Not yet
        </Button>
      </div>
    </article>
  );
}

/** World genesis (prototype 12a): the whole window is the surface — form beside the world-so-far rail. */
export function NewWorldScreen() {
  const [params] = useSearchParams();
  const freshId = useRef(`gen-${ulid().toLowerCase()}`);
  const draftId = params.get("draft") ?? freshId.current;
  return <NewWorldDraft key={draftId} draftId={draftId} />;
}

function NewWorldDraft({ draftId }: { draftId: string }) {
  const { state, connection } = useStore();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [name, setName] = useState("");
  const [logline, setLogline] = useState("");
  const [tone, setTone] = useState("");
  const [genre, setGenre] = useState("");
  const [firstCharacter, setFirstCharacter] = useState("");
  const [firstLocation, setFirstLocation] = useState("");
  const [submittedName, setSubmittedName] = useState<string | null>(null);
  // The look is asked for, never inferred from the logline (design turn 38). It is the last
  // thing before the world exists, because it is the one answer that applies to every image the
  // world will ever make, and asking it while the logline is still being written would be asking
  // about a world nobody has described yet.
  const [step, setStep] = useState<"draft" | "look" | "words">("draft");
  const [presetId, setPresetId] = useState<string | null>(null);
  const [look, setLook] = useState("");
  // The founding build (SPEC-031): a conversation that settled a name is sized into a card in
  // the thread and founded in one press there; a bare form still creates and seeds the old way.
  const [lookForBuild, setLookForBuild] = useState("");
  const [buildPressed, setBuildPressed] = useState(false);
  const [generateImages, setGenerateImages] = useState(true);
  const [planRequestId, setPlanRequestId] = useState<string | null>(null);
  const [planStartedAt, setPlanStartedAt] = useState<string | null>(null);
  const buildCardRef = useRef<HTMLDivElement>(null);
  const [buildRequestId, setBuildRequestId] = useState<string | null>(null);
  const buildRequestRef = useRef<string | null>(null);
  // Where the words came from: the conversation's own proposal, or a preset seed. The look
  // step arrives pre-filled with the agent's words when it proposed some (SPEC-031 R-3) —
  // the preset grid stays one press away as the override, never the only way in.
  const [lookSource, setLookSource] = useState<"conversation" | "preset" | null>(null);
  const conversationLookRef = useRef<string | null>(null);
  const seededRef = useRef(false);
  // The world's own models, chosen on the card before the world exists (design turn 153). Held
  // here and sent with every frame that spends or founds — the preview, the review, the press —
  // so the price reviewed is the model the build runs on. Absent entries follow Settings.
  const [models, setModels] = useState<ModelChoices | undefined>(undefined);
  const [genMode, setGenMode] = useState<"form" | "chat">("form");
  const modeTouchedRef = useRef(false);
  const genesisIdRef = useRef(draftId);
  const genesisId = genesisIdRef.current;
  const [message, setMessage] = useState("");
  const harnessReady = state?.app.health.harness.status === "healthy";
  const drafts = useGenesis();
  const g = drafts[genesisId];
  const [writingModel, setWritingModel] = useState<string | undefined>(g?.writingModel);
  const writingModelReason = languageChoiceReason(state, writingModel, true);
  useEffect(() => {
    if (g?.rejectedChat === undefined) return;
    const text = takeRejectedGenesisChat(genesisId);
    if (text !== undefined) setMessage(previous => previous ? `${text}\n\n${previous}` : text);
  }, [g?.rejectedChat, genesisId]);
  useEffect(() => { if (g?.status === "failed") setSubmittedName(null); }, [g?.status]);
  // Shown wherever the press was made: the form and the look screens refused a creation in
  // silence, since only the conversation drew it (issue 2777).
  const foundingFailure = g?.status === "failed" && g.detail ? <Callout title="The conversation needs attention">{g.detail}</Callout> : null;
  useEffect(() => {
    if (!g?.founding) return;
    setModels(g.frozenModels);
    setGenerateImages(g.frozenGenerateImages ?? true);
    setLook(g.blueprint?.look ?? "");
    setLookForBuild(g.blueprint?.look ?? "");
    setGenMode("chat");
  }, [g?.founding, g?.frozenModels, g?.frozenGenerateImages, g?.blueprint?.look]);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => {
    if (connection !== "open") return;
    listGenesisDrafts();
    if (params.has("draft")) loadGenesisDraft(genesisId);
  }, [connection, genesisId]);
  const canViewChat = harnessReady || Boolean(g?.blueprint || g?.turns.length);
  const turns = g?.turns ?? [];
  const chatRunning = !!g?.chatPending || g?.status === "running";
  const blueprint = g?.blueprint ?? null;
  useEffect(() => {
    if (g && connection === "open" && !chatRunning && !g.worldId && !g.founding) reviewGenesisImports(genesisId);
  }, [connection, chatRunning, blueprint, g?.attachments, genesisId]);
  useEffect(() => {
    if (connection === "open" && blueprint && !chatRunning && !g?.worldId && !g?.founding) reviewGenesisDraft(genesisId);
  }, [connection, blueprint, chatRunning, g?.worldId, g?.founding, genesisId]);

  // With a healthy harness, talking is the front door (prototype 12a) — unless the author
  // already picked the form themselves.
  useEffect(() => {
    if (canViewChat && !modeTouchedRef.current) setGenMode("chat");
  }, [canViewChat]);

  // A name typed alone is still a character: its one line is its name until one is written,
  // the fallback the conversation's own drafts get below. It was dropped instead (issue 2777).
  const bareCharacter = firstCharacter.trim();
  const charSeed = parseSeed(firstCharacter) ?? (bareCharacter ? { name: bareCharacter, sentence: bareCharacter } : null);
  const locSeed = parseSeed(firstLocation);
  const shownName = name.trim() || blueprint?.name?.trim() || "";
  const shownLogline = logline.trim() || blueprint?.logline?.trim() || "";
  const shownTone = tone.trim() || blueprint?.tone?.trim() || "";
  const shownGenre = genre.trim() || blueprint?.genre?.trim() || "";
  // Never empty: a sentence of "" fails the frame's schema and the character named in
  // conversation would silently not exist in the created world (SPEC-031 R-8).
  const oneLine = (e: { name: string; line?: string; description?: string }) =>
    e.line ?? e.description ?? e.name;
  const hasBrief = (e: { brief?: object }) => e.brief !== undefined && Object.keys(e.brief).length > 0;
  const draftCharacters = (blueprint?.characters ?? []).filter((c) => c.name !== charSeed?.name);
  const draftLocations = (blueprint?.locations ?? []).filter((l) => l.name !== locSeed?.name);
  const railCharacters = [
    ...(charSeed ? [{ ...charSeed, brief: false, neverDepicted: false }] : []),
    ...draftCharacters.map((c) => ({
      name: c.name,
      sentence: oneLine(c),
      brief: hasBrief(c),
      neverDepicted: c.neverDepicted === true,
    })),
  ];
  const railLocations = [
    ...(locSeed ? [{ ...locSeed, brief: false }] : []),
    ...draftLocations.map((l) => ({ name: l.name, sentence: oneLine(l), brief: hasBrief(l) })),
  ];
  const railFactions = (blueprint?.factions ?? []).map((f) => ({ name: f.name, sentence: oneLine(f) }));
  const coverage = blueprint ? blueprintCoverage(blueprint) : null;
  // A conversation that settled a name builds; anything less creates and seeds the old way.
  const buildMode = blueprint?.name !== undefined;
  const buildPlans = useBuildPlans();
  const reviewPlan = planRequestId === null ? undefined : buildPlans[genesisId]?.[planRequestId];
  const buildResponse = buildRequestId === null ? undefined : buildPlans[genesisId]?.[buildRequestId];
  const visibleBuildPlan = buildResponse?.plan === null ? buildResponse : reviewPlan;
  const myBuild = state?.app.builds.find((build) => build.genesisId === genesisId) ?? null;
  // The look preview (SPEC-031 §1.10): conversation-scoped jobs fold like any other, so the
  // rail reads the queue rather than keeping a private channel.
  const previewJob =
    (state?.app.jobs ?? [])
      .filter((job) => job.worldId === genesisId && job.target.kind === "look-preview")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const previewFile = previewJob?.status === "succeeded" ? previewJob.landedFiles?.[0] : undefined;
  const previewStale =
    previewJob !== null &&
    typeof previewJob.params["lookText"] === "string" &&
    previewJob.params["lookText"] !== blueprint?.look;
  const previewRunning =
    previewJob !== null &&
    (previewJob.status === "queued" || previewJob.status === "submitting" || previewJob.status === "running");
  // The estimate is on the control (R-51): a conversation that could spend by talking would
  // be a way to spend somebody's money by talking.
  const previewEstimate = (() => {
    const manifest = state?.app.manifest;
    if (!manifest) return null;
    const routed = modelForCapability(manifest, { ...state?.app.routing.defaults, ...models }, "image");
    if (!routed || state?.app.models.disabled.includes(routed.id)) return null;
    return imagePriceCopy(routed, estimateImageMicroUsd(routed, { landscape: true }));
  })();
  const sendGenesis = () => {
    if (!harnessReady || chatRunning || myBuild?.status === "running" || g?.worldId || message.trim().length === 0) return;
    if (writingModelReason || !genesisChat(genesisId, message.trim(), writingModel)) return;
    if (!params.has("draft")) setParams({ draft: genesisId }, { replace: true });
    setMessage("");
  };

  // Attachments here have no artifact id — there is no world to hold one yet. The sandbox
  // de-collides the names, so the name is the identity until Begin turns them into artifacts.
  const attachTarget = { kind: "genesis-attach", genesisId } as const;
  const handed = (g?.attachments ?? []).map((a) => ({ id: a.name, file: a.name, kind: a.kind }));

  // The coordinator opens the new world and re-snapshots; when it lands, seed the optional
  // first sheets through the same gate everything else uses, then go there.
  useEffect(() => {
    if (!submittedName || !state?.world || state.world.meta.name !== submittedName) return;
    const worldId = state.world.meta.worldId;
    if (!seededRef.current) {
      seededRef.current = true;
      // Settled, not proposed. Pressing Begin was the yes; being asked again once per
      // character and once per place is a toll on a decision already made, and a sheet is a
      // sketch that changes by typing in it.
      for (const c of railCharacters.slice(0, 4)) createSheetFromSentence(worldId, "character", c.name, c.sentence, true);
      for (const l of railLocations.slice(0, 4)) createSheetFromSentence(worldId, "location", l.name, l.sentence, true);
      for (const f of railFactions.slice(0, 4)) createSheetFromSentence(worldId, "faction", f.name, f.sentence, true);
      for (const t of (blueprint?.threads ?? []).slice(0, 4)) {
        openThread(worldId, t.length > 80 ? `${t.slice(0, 77)}…` : t, t, []);
      }
      if (!turns.length) genesisDiscard(genesisId);
    }
    if (!turns.length) navigate(`/w/${worldId}`, { replace: true });
  }, [submittedName, state?.world, navigate, railCharacters, railLocations, railFactions, blueprint, genesisId]);

  // The build begins server-side from one frame (SPEC-031 R-17); the screen's whole job is
  // to follow it to the building screen the moment the coordinator names the world.
  useEffect(() => {
    const worldId = myBuild?.worldId ?? g?.worldId;
    if (worldId && g?.formHandoff === "completed" && !turns.length) {
      navigate(`/w/${worldId}`, { replace: true });
    } else if (worldId && g?.conversationId && (myBuild?.status === "completed" || myBuild?.status === "stopped" || g?.formHandoff === "completed")) {
      navigate(`/w/${worldId}/chat/${g.conversationId}`, { replace: true });
    }
    if (buildPressed && myBuild) setStep("draft");
  }, [buildPressed, myBuild, g?.worldId, g?.conversationId, g?.formHandoff, turns.length, navigate]);
  // A begin the coordinator refused answers with a reasoned plan; the press un-arms so the
  // refusal can be read and the author can go back — never a button stuck on "Building…".
  useEffect(() => {
    if (buildPressed && buildResponse?.plan === null) {
      buildRequestRef.current = null;
      setBuildPressed(false);
    }
  }, [buildPressed, buildResponse]);

  // The card is open once a plan has been asked for. It sits in the thread, so the
  // conversation goes on under it.
  const buildCardOpen = planRequestId !== null;
  const sizingBuild = buildCardOpen && visibleBuildPlan === undefined;
  useEffect(() => {
    if (buildCardOpen) buildCardRef.current?.scrollIntoView({ block: "start" });
  }, [buildCardOpen, planRequestId, visibleBuildPlan]);
  // A plan is a picture of one blueprint and one preview state, and the card must never state
  // a count or a loss the build is about to contradict: an unsettled preview carries if it
  // lands before the press (SPEC-031 R-54), and a blueprint that moved under the card is
  // exactly what the coordinator would refuse the press for. Either change asks the plan
  // again. A look the conversation proposed follows the conversation; words the author edited
  // or chose from a preset stay theirs.
  // What the build's image route resolves from, as one comparable string: the card's choice or
  // the Settings default it follows, whether that model is switched off, and its provider's key.
  // Any of them can change behind an open card — the gear goes to Settings and back — and the
  // review must be asked again, or it shows one model and price while the press spends on another.
  const imageRoute = (() => {
    // Resolved the way the build resolves it: the card's choice, else what Settings routes —
    // which, with no saved default, is the manifest's first image model, not nothing.
    const manifest = state?.app.manifest;
    const id = models?.image ?? (manifest ? modelForCapability(manifest, state?.app.routing.defaults, "image")?.id : undefined);
    const model = id === undefined ? undefined : manifest?.models.find((m) => m.id === id);
    const provider = model === undefined ? undefined : state?.app.providers.find((p) => p.id === model.provider);
    return [
      id ?? "",
      model === undefined ? "missing" : "listed",
      id !== undefined && state?.app.models.disabled.includes(id) ? "off" : "on",
      provider?.configured === true ? "keyed" : "unkeyed",
      provider?.validation ?? "",
    ].join("|");
  })();
  const imageJobs = (state?.app.jobs ?? []).filter(job => job.worldId === genesisId && job.target.kind === "genesis-image");
  const imageJobsKey = imageJobs.map(job => `${job.id}:${job.status}`).join("|");
  const voiceJobs = (state?.app.jobs ?? []).filter(job => job.worldId === genesisId && job.params["purpose"] === "genesis-voice");
  const voiceJobsKey = voiceJobs.map(job => `${job.id}:${job.status}`).join("|");
  useEffect(() => {
    if (connection === "open" && blueprint && !chatRunning && !g?.worldId) reviewGenesisVoices(genesisId);
  }, [connection, blueprint, chatRunning, g?.worldId, genesisId, voiceJobsKey]);
  useEffect(() => {
    if (connection === "open" && blueprint && !chatRunning && !g?.worldId) reviewGenesisImages(genesisId, models);
  }, [connection, blueprint, chatRunning, g?.worldId, g?.attachments, genesisId, models, imageJobsKey, imageRoute]);
  const plannedAgainst = useRef<{ blueprint: typeof blueprint; review: (typeof drafts)[string]["review"]; images: (typeof drafts)[string]["images"]; voices: (typeof drafts)[string]["voices"]; preview: string | null; route: string } | null>(null);
  useEffect(() => {
    if (!buildCardOpen || buildPressed) return;
    const preview = previewJob?.status ?? null;
    const last = plannedAgainst.current;
    if (last !== null && last.blueprint === blueprint && last.review === g?.review && last.images === g?.images && last.voices === g?.voices && last.preview === preview && last.route === imageRoute) return;
    let lookText = lookForBuild;
    if (lookSource === "conversation" && look.trim() === conversationLookRef.current) {
      lookText = blueprint?.look?.trim() ?? "";
      conversationLookRef.current = lookText;
      setLook(lookText);
      setLookForBuild(lookText);
    }
    plannedAgainst.current = { blueprint, review: g?.review, images: g?.images, voices: g?.voices, preview, route: imageRoute };
    const requestId = ulid();
    setPlanRequestId(requestId);
    setPlanStartedAt(new Date().toISOString());
    // A refusal answered the blueprint that moved; the fresh plan is the review it asked for.
    setBuildRequestId(null);
    planFoundingBuild(genesisId, requestId, lookText, models, generateImages);
  }, [buildCardOpen, buildPressed, previewJob?.status, blueprint, g?.review, g?.images, g?.voices, lookForBuild, look, lookSource, genesisId, models, imageRoute, generateImages]);

  const openBuildCard = (lookText: string) => {
    setLookForBuild(lookText);
    setBuildRequestId(null);
    plannedAgainst.current = { blueprint, review: g?.review, images: g?.images, voices: g?.voices, preview: previewJob?.status ?? null, route: imageRoute };
    const requestId = ulid();
    setPlanRequestId(requestId);
    setPlanStartedAt(new Date().toISOString());
    planFoundingBuild(genesisId, requestId, lookText, models, generateImages);
    setStep("draft");
  };

  // Back from the look steps, or the card set aside: the conversation is untouched either way.
  const leaveBuild = () => {
    if (buildPressed) return;
    // A proposal copied verbatim is conversation state, not an override. Let the next turn's
    // proposal replace it; words the author edited or chose from a preset remain their choice.
    if (lookSource === "conversation" && look.trim() === conversationLookRef.current) {
      setLook("");
      setLookSource(null);
      conversationLookRef.current = null;
    }
    plannedAgainst.current = null;
    setPlanRequestId(null);
    setBuildRequestId(null);
    setStep("draft");
  };

  const canCreate = connection === "open" && shownName.length > 0 && submittedName === null && !chatRunning;

  const begin = (artDirection?: string) => {
    if (turns.length || buildMode) {
      proposeGenesisWorld(genesisId, {
        name: shownName, ...(shownLogline ? { logline: shownLogline } : {}),
        ...(shownTone ? { tone: shownTone } : {}), ...(shownGenre ? { genre: shownGenre } : {}),
        ...(artDirection?.trim() ? { look: artDirection.trim() } : {}),
        characters: charSeed ? [{ name: charSeed.name, line: charSeed.sentence }] : [],
        locations: locSeed ? [{ name: locSeed.name, line: locSeed.sentence }] : [],
        threads: blueprint?.threads ?? [],
      });
      setGenMode("chat");
      setStep("draft");
      return;
    }
    setSubmittedName(shownName);
    createWorld({
      name: shownName,
      ...(shownLogline ? { logline: shownLogline } : {}),
      ...(shownTone ? { tone: shownTone.toLowerCase() } : {}),
      ...(shownGenre ? { genre: shownGenre.toLowerCase() } : {}),
      ...(artDirection && artDirection.trim().length > 0 ? { artDirection: artDirection.trim() } : {}),
      // The conversation's own prose, kept as the world's bible. Not shown on this screen and
      // not confirmed separately: pressing Begin is the yes, and the bible is the one file the
      // author can rewrite immediately without asking anyone.
      ...(blueprint?.bible && blueprint.bible.trim().length > 0 ? { bible: blueprint.bible.trim() } : {}),
      // Whatever was handed to the conversation follows it in. Sent always, not only when
      // something is attached: the sandbox is the source of truth for what is waiting, and the
      // screen's idea of it can lag an event behind.
      genesisId,
      ...(models !== undefined ? { models } : {}),
    });
  };

  if (step !== "draft") {
    return (
      <div className="fy-app" data-screen="new-world-art-direction">
        <AppChrome
          back={{
            label: genMode === "chat" ? "Back to chat" : "Back to form",
            onClick: leaveBuild,
          }}
          context={{ label: "new world · art direction" }}
        />
        <div className="fy-artstep">
          {step === "look" ? (
            <>
              <div className="fy-artstep__head">
                <div>
                  <div className="fy-artstep__steps">
                    <span className="fy-eyebrow-sm">NEW WORLD · STEP 3 OF 3</span>
                    <i />
                    <i />
                    <i />
                  </div>
                  <h1 className="fy-artstep__h1">How should {shownName || "this world"} look?</h1>
                  <p className="fy-artstep__lede">Pick a starting look.</p>
                </div>
                <div className="fy-artstep__aside">
                  <div className="fy-artstep__asidehead">SAME SCENE, NINE TREATMENTS</div>
                </div>
              </div>
              <ArtStyleGrid
                selectedId={presetId}
                onSelect={(preset) => {
                  setPresetId(preset?.id ?? null);
                  // The preset seeds the words and is then forgotten. Re-picking the same one
                  // rewrites the draft; that is what picking it again means.
                  setLook(seedFrom(preset));
                  setLookSource("preset");
                  setStep("words");
                }}
              />
              {foundingFailure}
              <div className="fy-artstep__foot">
                <span className="fy-artstep__note">
                  Nothing is generated yet. The look is recorded with the world and rides along
                  from here.
                </span>
                <span style={{ flex: 1 }} />
                {/* Skippable, but not hidden: a world with no look is a real state, and it is
                    better said out loud than arrived at by closing a screen. */}
                <Button variant="ghost" disabled={!canCreate} onClick={() => (buildMode && genMode !== "form" ? openBuildCard("") : begin())}>
                  Decide later
                </Button>
              </div>
            </>
          ) : (
            <>
              <div className="fy-artstep__steps">
                <span className="fy-eyebrow-sm">NEW WORLD · STEP 3 OF 3</span>
                <i />
                <i />
                <i />
              </div>
              <h1 className="fy-artstep__h1">
                {lookSource === "conversation" ? "The conversation proposed this look." : "The preset writes a first draft."}
              </h1>
              <p className="fy-artstep__lede">
                {lookSource === "conversation"
                  ? "Drawn from the tone, genre and story you just settled. These words ride along with every generation — edit them, replace them, or pick a preset instead."
                  : "These are the words that ride along with every generation. Edit them, or replace them entirely. A preset seeds the text; it never locks it."}
              </p>
              <ArtStyleWords
                selectedId={presetId}
                value={look}
                onChange={setLook}
                {...(lookSource === "conversation" ? { provenance: "PROPOSED IN CONVERSATION" } : {})}
              />
              <div className="fy-artstep__reaches">
                <div className="fy-prov__eyebrow">WHAT THIS LOOK REACHES</div>
                <div>The world image · generated later, from the hub</div>
                <div>Every character kit · main photo and sheet</div>
                <div>Every location and every artifact</div>
                <div>Every shot in every production · unless a production overrides</div>
              </div>
              {foundingFailure}
              <div className="fy-artstep__foot">
                <Button variant="ghost" onClick={() => setStep("look")}>
                  Back
                </Button>
                <span style={{ flex: 1 }} />
                <Button
                  variant="primary"
                  disabled={!canCreate || look.trim().length === 0}
                  onClick={() => (buildMode && genMode !== "form" ? openBuildCard(look.trim()) : begin(look))}
                >
                  {submittedName ? "Creating…" : "Looks right"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fy-app" data-screen="new-world">
      <AppChrome back={{ label: "Back", to: "/worlds" }} context={{ label: "new world" }} />
      <div className="fy-gate" style={{ flex: 1, minHeight: 0 }}>
        <div className="fy-gate__main">
          <div className="fy-gate__head">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fy-eyebrow-sm">NEW WORLD</div>
              <h1 className="fy-story__h1">
                {genMode === "chat" ? "Start talking. It starts existing." : "Write it down. It starts existing."}
              </h1>
            </div>
            <span className="fy-seg" style={{ marginTop: 4 }}>
              <button
                type="button"
                className={cx("fy-seg__item", genMode === "chat" && "fy-seg__item--active")}
                disabled={!canViewChat}
                style={canViewChat ? undefined : { cursor: "not-allowed", opacity: 0.55 }}
                title={canViewChat ? undefined : "Chat needs the harness running — the form drafts the same world"}
                onClick={() => {
                  modeTouchedRef.current = true;
                  setGenMode("chat");
                }}
              >
                Chat
              </button>
              <button
                type="button"
                className={cx("fy-seg__item", genMode === "form" && "fy-seg__item--active")}
                onClick={() => {
                  modeTouchedRef.current = true;
                  setGenMode("form");
                }}
              >
                Form
              </button>
            </span>
          </div>
          <div className="fy-gate__body" style={{ gap: 14 }}>
            {Object.entries(drafts).some(([, draft]) => (draft.turns.length || draft.blueprint?.name || draft.attachments.length) && !draft.worldId) && (
              <details>
                <summary>Earlier drafts</summary>
                <Select label="Continue a draft" value={genesisId} disabled={chatRunning || myBuild?.status === "running"}
                  onChange={event => setParams({ draft: event.target.value })}>
                  <option value={genesisId}>{blueprint?.name ?? "This conversation"}</option>
                  {Object.entries(drafts).filter(([id, draft]) => id !== genesisId && (draft.turns.length || draft.blueprint?.name || draft.attachments.length) && !draft.worldId)
                    .map(([id, draft]) => <option key={id} value={id}>{draft.blueprint?.name ?? draft.turns[0]?.text.slice(0, 80) ?? "Untitled world"}</option>)}
                </Select>
              </details>
            )}
            {(turns.length > 0 || blueprint?.name || handed.length > 0) && !g?.worldId && !g?.founding && !myBuild && (
              <Button variant="ghost" style={{ alignSelf: "flex-start" }} disabled={chatRunning} onClick={() => {
                if (!confirmDiscard) { setConfirmDiscard(true); return; }
                genesisDiscard(genesisId);
                setParams({ draft: `gen-${ulid().toLowerCase()}` });
              }}>{confirmDiscard ? "Discard this conversation and its uploads" : "Discard draft"}</Button>
            )}
            {myBuild && <FoundingProgressCard build={myBuild} />}
            {genMode === "chat" ? (
              <>
                {/* 12a opens with Arke already talking. It opened here with sixty-six words of
                    instructions instead — what the screen is, where the draft goes, what is
                    locked — which is the dv-rule read out loud (design turn 69, issue 1008). */}
                {turns.length === 0 && <div className="fy-bubble--gate">What is this world?</div>}
                {turns.map((turn, i) => (
                  <div key={i} className={turn.role === "user" ? "fy-bubble--user" : "fy-bubble--gate"} style={{ whiteSpace: "pre-wrap" }}>
                    {/* The author's words are shown exactly as typed; only Arke writes markdown (issue 911). */}
                    {turn.role === "user" ? turn.text : renderInlineMarkdown(turn.text)}
                  </div>
                ))}
                {g?.reviewError && <Callout title="Content review needs attention">{g.reviewError}</Callout>}
                {g?.readinessError && <Callout title="Readiness review needs attention">{g.readinessError}</Callout>}
                {g?.decisionPending === "voice" && <Loading inline label="working on the voice" />}
                {g?.voiceError && <Callout title="Voice review needs attention">{g.voiceError}</Callout>}
                {g?.importError && <Callout title="Import review needs attention">{g.importError}</Callout>}
                {g?.imports && <GenesisImportCards imports={g.imports} blueprint={blueprint} busy={!!g.decisionPending || !!g.readinessPending || chatRunning || buildPressed || !!g.worldId || !!g.founding}
                  onResolve={resolution => resolveGenesisImport(genesisId, resolution)}
                  onRefresh={() => reviewGenesisImports(genesisId)}
                  onExtract={name => setMessage(`Please extract reviewable worldbuilding proposals from attachments/${name}. Cite exact source quotes; keep interpretations and suggested relationships separate from the evidence.`)} />}
                {g?.review && <GenesisContentCards review={g.review} busy={!!g.decisionPending || !!g.readinessPending || !!g.reviewPending || chatRunning || buildPressed || !!g?.founding || !!g?.worldId || myBuild?.status === "running"}
                  onDecide={(cards, decision) => decideGenesisDraft(genesisId, cards.map(card => ({ key: card.key, digest: card.digest })), decision)}
                  onRevise={title => setMessage(`Please revise ${title}: `)} />}
                {!!g?.review?.cards.some(card => card.status === "approved" || card.previous !== undefined) && !g?.worldId && <GenesisReadinessCard review={g?.readiness} busy={!!g?.decisionPending || !!g?.reviewPending || chatRunning || buildPressed || !!g?.founding || !!g?.readinessPending}
                  onRefresh={() => reviewGenesisReadiness(genesisId)} onFix={setMessage}
                  onLeave={(id, digest) => leaveGenesisFinding(genesisId, id, digest)} />}
                {g?.voices && <GenesisVoiceCards genesisId={genesisId} voices={g.voices} jobs={voiceJobs} models={state?.app.manifest?.models} busy={!!g.decisionPending || !!g.readinessPending || chatRunning || buildPressed || !!g.founding || !!g.worldId}
                  onGenerate={(intentId, digest) => generateGenesisVoice(genesisId, intentId, digest)}
                  onDecide={(target, decision, candidate) => decideGenesisVoice(genesisId, target, decision, candidate)}
                  onRevise={setMessage} onRefresh={() => reviewGenesisVoices(genesisId)} onCancel={cancelJob} />}
                {g?.imageError && <Callout title="Image request needs attention">{g.imageError}</Callout>}
                {g?.images && blueprint && <GenesisImageCards genesisId={genesisId} blueprint={blueprint} images={g.images} jobs={imageJobs}
                  busy={!!g.decisionPending || !!g.readinessPending || chatRunning || buildPressed || !!g.founding || myBuild?.status === "running" || !!g.worldId}
                  onGenerate={(intentId, digest) => generateGenesisImage(genesisId, intentId, digest, models)}
                  onDecide={(target, decision, candidate) => decideGenesisImage(genesisId, target, decision, candidate)}
                  onCancel={cancelJob} onRevise={setMessage} />}
                {/* The look, previewable while the conversation is still a conversation (SPEC-031
                    §1.10): the agent proposed the words; the press and the spend are the author's.
                    Asked in the thread, not in the rail beside it — spend is decided where every
                    other decision here is (issue 920). Build mode only: the legacy create path
                    sweeps the sandbox without a carry, and the card must not promise one. */}
                {buildMode && blueprint?.look !== undefined && (
                  <article
                    className="fy-actioncard"
                    data-status={previewFile !== undefined && !previewStale ? "completed" : "pending"}
                    aria-label="The look"
                  >
                    <div className="fy-actioncard__head">
                      <div>
                        <div className="fy-actioncard__reason">proposed in conversation</div>
                        <h3>The look</h3>
                      </div>
                    </div>
                    <p className="fy-actioncard__consequence">{blueprint.look}</p>
                    {previewFile !== undefined && (
                      <>
                        <img
                          className="fy-actioncard__media"
                          src={genesisMediaUrl(genesisId, previewFile)}
                          alt="The look, previewed"
                        />
                        {previewStale && (
                          <div className="fy-mono" style={{ fontSize: 9.5 }}>the look changed since this was made</div>
                        )}
                      </>
                    )}
                    {previewRunning && <Loading inline label="making the look" />}
                    {(previewJob?.status === "failed" ||
                      previewJob?.status === "cancelled" ||
                      previewJob?.status === "needs-reconciliation") && (
                      <div className="fy-mono" style={{ fontSize: 9.5 }}>
                        {previewJob.status === "cancelled"
                          ? "the preview was cancelled"
                          : previewJob.status === "needs-reconciliation"
                            ? "the preview is held in Activity"
                            : `the preview failed${previewJob.error ? ` — ${previewJob.error}` : ""}`}
                      </div>
                    )}
                    {!previewRunning &&
                      (previewJob === null || previewJob.status === "failed" || previewJob.status === "cancelled" || previewStale) && (
                        <>
                          {/* The build never makes a master look (SPEC-031 R-18): the world gets
                              this preview or none. Said beside the control that answers it, not
                              left for an empty plate on Art direction months later (issue 521). */}
                          <div className="fy-mono" style={{ fontSize: 9.5 }}>
                            without one, this world has no master look
                          </div>
                          <div className="fy-actioncard__actions" style={{ alignItems: "center" }}>
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={previewEstimate === null || !!g?.founding || buildPressed}
                              onClick={() => generateLookPreview(genesisId, models)}
                            >
                              See the look{previewEstimate !== null ? ` · ${previewEstimate}` : ""}
                            </Button>
                            {previewEstimate === null && (
                              <span className="fy-mono" style={{ fontSize: 9.5 }}>
                                needs an image provider
                              </span>
                            )}
                          </div>
                        </>
                      )}
                  </article>
                )}
                {buildMode && buildCardOpen && (
                  <div ref={buildCardRef}>
                    <label><input type="checkbox" checked={generateImages} disabled={buildPressed || g?.founding}
                      onChange={event => { setGenerateImages(event.target.checked); plannedAgainst.current = null; }} /> Generate remaining images</label>
                    <BuildCard
                      plan={visibleBuildPlan}
                      startedAt={planStartedAt}
                      pressed={buildPressed}
                      settling={chatRunning || !!g?.decisionPending || !!g?.readinessPending || !!g?.reviewPending || plannedAgainst.current?.review !== g?.review || plannedAgainst.current?.images !== g?.images || plannedAgainst.current?.voices !== g?.voices}
                      onDismiss={leaveBuild}
                      onBuild={() => {
                        if (g?.decisionPending || g?.readinessPending || g?.reviewPending || plannedAgainst.current?.review !== g?.review || plannedAgainst.current?.images !== g?.images || plannedAgainst.current?.voices !== g?.voices || !visibleBuildPlan?.plan) return;
                        if (buildRequestRef.current === null) buildRequestRef.current = ulid();
                        setBuildRequestId(buildRequestRef.current);
                        setBuildPressed(true);
                        beginFoundingBuild(genesisId, buildRequestRef.current, lookForBuild, models, visibleBuildPlan?.plan?.approvalDigest, generateImages);
                      }}
                    />
                  </div>
                )}
                {/* The turn in flight, verb by verb — the same working surface world chat has.
                    A silent stretch while the model reads and writes is indistinguishable from
                    a hang, and this is the first conversation anyone has with the studio. */}
                {chatRunning && <Working label={g?.working ?? null} startedAt={g?.runStartedAt ?? null} />}
                {foundingFailure}
                {g?.chatError && <Callout title="Your message was held">{g.chatError}</Callout>}
                <div style={{ marginTop: "auto" }}>
                  {harnessModelsNeedAWord(state) && <HarnessModelStatus state={state} />}
                  <Composer
                    value={message}
                    onChange={setMessage}
                    onSubmit={sendGenesis}
                    placeholder={turns.length === 0 ? "Describe your world, or ask Arke to surprise you…" : "Keep going…"}
                    agentLabel="Arke"
                    disabledReason={writingModelReason}
                    busy={chatRunning || buildPressed || !!g?.founding || myBuild?.status === "running" || sizingBuild || !!g?.decisionPending || !!g?.readinessPending}
                    busyLabel={buildPressed ? "founding the world…" : sizingBuild ? "sizing the build…" : "shaping the draft…"}
                    onAttach={() => genesisAttachFiles(genesisId)}
                    onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
                    // A world that does not exist yet has nowhere to remember a model, so the chip
                    // picks for this conversation only, and letting go of it is the author's default.
                    modelControl={<ModelChip state={state} value={writingModel ?? state?.app.agents.find(agent => agent.name === "world-author")?.model ?? state?.app.agents.find(agent => agent.name === "story-writer")?.model ?? undefined} set={writingModel !== undefined}
                      onPick={setWritingModel} needsTools unsetLabel="Use the default"
                      disabled={chatRunning || buildPressed || !!g?.founding} />}
                    {...(hostCanAttach()
                      ? {
                          onAttachFiles: (files: readonly File[]) => attachHostFiles(attachTarget, files),
                          onAttachText: (text: string) => attachHostText(attachTarget, text, "pasted-note.txt"),
                        }
                      : {})}
                    attachments={handed}
                    refusals={g?.refusals ?? []}
                  />
                </div>
              </>
            ) : (
              <>
            {/*
              Placeholders say the shape of an answer, never an answer (issue 230). Every field
              here used to hold the sample world's real values — "The Undersong", its logline,
              its genre, Maren Kest, The Vigil — sitting exactly where the user's own words go,
              so an entirely empty form looked filled in and Begin read as ready to press. They
              also anchored the author to one world's genre and naming at the moment they were
              meant to be inventing their own, and made that world's fiction feel like part of
              the app rather than one example among the worlds they could write.
            */}
            <div>
              <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Name</div>
              <Input
                placeholder="What this world is called"
                aria-label="What this world is called"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Logline</div>
              <Textarea
                placeholder="One sentence about this world"
                aria-label="One sentence about this world"
                value={logline}
                onChange={(e) => setLogline(e.target.value)}
                style={{ minHeight: 52 }}
              />
            </div>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Tone</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {GENESIS_TONES.map((t) => (
                    <button
                      key={t}
                      type="button"
                      className={cx("fy-filterchip", tone === t && "fy-filterchip--active")}
                      style={{ border: tone === t ? "none" : "1px solid var(--border)" }}
                      onClick={() => setTone(tone === t ? "" : t)}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <Input
                  placeholder="or your own words"
                  aria-label="or your own words"
                  value={GENESIS_TONES.includes(tone as (typeof GENESIS_TONES)[number]) ? "" : tone}
                  onChange={(e) => setTone(e.target.value)}
                  style={{ marginTop: 6 }}
                />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>Genre</div>
                <Input aria-label="A genre" placeholder="A genre" value={genre} onChange={(e) => setGenre(e.target.value)} />
              </div>
            </div>
            <div style={{ display: "flex", gap: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>
                  First character <span className="fy-mono">optional</span>
                </div>
                {/* The separator is load-bearing — parseSeed splits on it — so the shape has to
                    teach it where the example used to demonstrate it. */}
                <Input
                  placeholder="Their name · one line about them"
                  aria-label="Their name · one line about them"
                  value={firstCharacter}
                  onChange={(e) => setFirstCharacter(e.target.value)}
                />
                {firstCharacter.trim().length > 0 && !parseSeed(firstCharacter) && (
                  <span className="fy-mono" style={{ display: "block", marginTop: 4 }}>
                    name · one line — the separator splits who they are from what they are
                  </span>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ font: "600 12.5px var(--font-sans)", marginBottom: 6 }}>
                  First location <span className="fy-mono">optional</span>
                </div>
                <Input
                  placeholder="Its name · one line about it"
                  aria-label="Its name · one line about it"
                  value={firstLocation}
                  onChange={(e) => setFirstLocation(e.target.value)}
                />
              </div>
            </div>
            {foundingFailure}
            <div style={{ marginTop: "auto" }} className="fy-mono">
              a world is a folder under ArkeStudio\worlds — readable by hand, portable, never dependent on this app to
              exist
            </div>
              </>
            )}
          </div>
        </div>
        <div className="fy-gate__side">
          <div style={{ font: "600 15px var(--font-sans)" }}>The world so far</div>
          {/* Coverage (SPEC-031 R-7): what is covered and what is open, as labels and counts.
              The world's one image is on the list so a missing key-art brief is visible while
              it can still be answered, not as a line on the completion notice. */}
          {coverage && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {(
                [
                  { label: "premise", covered: coverage.premise },
                  { label: `cast ${coverage.cast}`, covered: coverage.cast > 0 },
                  { label: `places ${coverage.places}`, covered: coverage.places > 0 },
                  // Not on R-7's list, so present only once one exists — never an open chip.
                  ...(coverage.factions > 0 ? [{ label: `factions ${coverage.factions}`, covered: true }] : []),
                  { label: "through-line", covered: coverage.throughLine },
                  { label: "look", covered: coverage.look },
                  { label: "key image", covered: coverage.keyArt },
                ] as const
              ).map((c) => (
                <span
                  key={c.label}
                  className="fy-pill"
                  style={c.covered ? undefined : { opacity: 0.55 }}
                >
                  {c.label}
                </span>
              ))}
            </div>
          )}
          <div className="fy-draftcard" style={{ padding: "10px 10px 16px" }}>
            {/*
              Semantic tokens only (issue 911). Painted from the neutral ramp this was the
              brightest thing on the world door in dark mode — .dark leaves --neutral-* alone,
              so a ramp surface stays white on a near-black page. Same dashed-and-unfilled
              language as the pending frames, which paint from the same two tokens.
            */}
            <div
              style={{
                height: 118,
                borderRadius: 8,
                border: "1.5px dashed var(--border)",
                background: "var(--muted)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 7,
              }}
            >
              {/*
                A picture and no control: an image job needs a world folder to land in, and on this
                screen there is no world yet (issue 1008).
              */}
              <img className="fy-portrait fy-portrait--plate" src="./worlds/new-world.webp" alt="" />
            </div>
            <div style={{ padding: "12px 8px 0" }}>
              {/* Arke offers a working name; until it has, typing one is what lets Begin go (issue 2552). */}
              {genMode === "chat" && (!shownName || name) ? (
                <Input placeholder="Name this world" aria-label="Name this world" value={name} onChange={(e) => setName(e.target.value)} />
              ) : (
                <div style={{ font: "650 20px var(--font-sans)", letterSpacing: "-0.02em" }}>{shownName || "Unnamed world"}</div>
              )}
              <div style={{ font: "400 12.5px/1.55 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 5 }}>
                {shownLogline}
              </div>
              {(shownTone || shownGenre) && (
                <div style={{ display: "flex", gap: 7, marginTop: 10, flexWrap: "wrap" }}>
                  {shownTone && <span className="fy-pill">tone · {shownTone.toLowerCase()}</span>}
                  {shownGenre && <span className="fy-pill">{shownGenre.toLowerCase()}</span>}
                </div>
              )}
            </div>
          </div>
          {(railCharacters.length > 0 || railLocations.length > 0) && (
            <div style={{ display: "flex", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              {railCharacters.slice(0, 2).map((c) => (
                <div key={c.name} className="fy-draftcard" style={{ flex: 1, minWidth: 150, marginTop: 0, padding: "12px 14px" }}>
                  <div className="fy-mono" style={{ fontSize: 10 }}>
                    CHARACTER
                  </div>
                  <div style={{ font: "600 13.5px var(--font-sans)", marginTop: 6 }}>{c.name}</div>
                  <div style={{ font: "400 11.5px/1.5 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 2 }}>
                    {c.sentence}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
                    <span className="fy-dot fy-dot--sketch" style={{ width: 5, height: 5 }} />
                    <span className="fy-mono" style={{ fontSize: 9.5 }}>
                      {/*
                       * "no face yet" promises a face, which is the opposite of the rule for a
                       * character the author has ruled out (issue 945). The build card names the
                       * same rule as "never depicted"; the two surfaces say it the same way.
                       */}
                      {c.neverDepicted ? "sketch · never depicted" : c.brief ? "sketch · brief kept" : "sketch · no face yet"}
                    </span>
                  </div>
                </div>
              ))}
              {railLocations.slice(0, 2).map((l) => (
                <div key={l.name} className="fy-draftcard" style={{ flex: 1, minWidth: 150, marginTop: 0, padding: "12px 14px" }}>
                  <div className="fy-mono" style={{ fontSize: 10 }}>
                    LOCATION
                  </div>
                  <div style={{ font: "600 13.5px var(--font-sans)", marginTop: 6 }}>{l.name}</div>
                  <div style={{ font: "400 11.5px/1.5 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 2 }}>
                    {l.sentence}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
                    <span className="fy-dot fy-dot--sketch" style={{ width: 5, height: 5 }} />
                    <span className="fy-mono" style={{ fontSize: 9.5 }}>
                      {l.brief ? "sketch · brief kept" : "sketch"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {(blueprint?.threads.length ?? 0) > 0 && (
            <div className="fy-draftcard" style={{ padding: "12px 16px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="fy-dot fy-dot--warn" style={{ width: 6, height: 6 }} />
                <span style={{ font: "600 12.5px var(--font-sans)" }}>Open threads</span>
              </div>
              <div style={{ font: "400 12px/1.7 var(--font-sans)", color: "var(--muted-foreground)", marginTop: 7 }}>
                {blueprint!.threads.slice(0, 4).map((t, i) => (
                  <div key={i}>{t}</div>
                ))}
              </div>
            </div>
          )}
          <div style={{ flex: 1, minHeight: 16 }} />
          {/* The models this world will make with, chosen where the world is begun (design turn
              153) — last in the world so far, above the press that spends on them. Locked once
              the build is pressed: the run froze its route. Folded: most worlds keep the defaults. */}
          <details>
            <summary className="fy-set__link">Models</summary>
            <ModelsCard
              state={state}
              capabilities={WORLD_MODEL_CAPABILITIES}
              choices={models}
              scopeWord="this world"
              disabled={buildPressed || submittedName !== null || !!g?.founding}
              onChange={(capability, modelId) => setModels((current) => withModelChoice(current, capability, modelId))}
            />
          </details>
          <div style={{ display: "grid", gap: 8 }}>
            <Button
              variant="primary"
              disabled={!canCreate || buildCardOpen}
              onClick={() => {
                // Begin is the author's yes to what is proposed. Left pending, it ran through the look
                // to "approve … in the conversation" and a disabled Begin (issue 2482).
                const pending = g?.review?.cards.filter(card => card.status === "pending") ?? [];
                if (pending.length > 0) decideGenesisDraft(genesisId, pending.slice(0, 300).map(card => ({ key: card.key, digest: card.digest })), "approve");
                const proposed = blueprint?.look?.trim();
                const approvedLook = look.trim() || proposed;
                if (approvedLook) {
                  // Begin is the answer to a look already chosen here or proposed in chat. Keep
                  // new proposal words ready for an optional edit, but do not ask for approval twice.
                  if (look.trim().length === 0) {
                    setLook(approvedLook);
                    setLookSource("conversation");
                    conversationLookRef.current = approvedLook;
                    setPresetId(null);
                  }
                  if (buildMode && genMode !== "form") openBuildCard(approvedLook);
                  else begin(approvedLook);
                } else {
                  setStep("look");
                }
              }}
            >
              {submittedName ? "Creating…" : "Begin in this world"}
            </Button>
            {/* A bound is stated, never enforced in silence (SPEC-031 R-8). */}
            {(railCharacters.length > 4 || railLocations.length > 4 || railFactions.length > 4) && (
              <div className="fy-mono" style={{ textAlign: "center", color: "var(--warning)" }}>
                Begin seeds the first 4 of each · the rest are let go
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
