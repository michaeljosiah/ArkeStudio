import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import {
  CLONED_VOICE_MODEL,
  CLONED_VOICE_PROVIDER,
  designatedVoiceSample,
  formatMicroUsd,
  isClonedVoice,
  legacyVoiceModel,
  mainPhotoFor,
  orderedShots,
  voiceTargetKey,
  type ReferenceKit,
  type Sheet,
  type VoiceCandidate,
  type WorldBundle,
} from "@arke-studio/contracts";
import { CharacterHeader } from "./character-reference.js";
import { CloneVoiceDialog } from "../components/clone-voice-dialog.js";
import { VoiceSampleFlow } from "../components/character-voice-sample.js";
import { DegradedBanner } from "../components/layout.js";
import { PerformanceBiblePanel } from "../components/performance-bible-panel.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { ClipPlayButton } from "../components/player.js";
import { Button, Callout, cx } from "../components/ui.js";
import { Loading } from "../components/loading.js";
import { Cloud, Mic, Monitor, Upload, VideoMark, Waveform } from "../components/icons.js";
import { mediaUrl } from "../lib/media.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import {
  assignVoice,
  providerIdOf,
  requestVoiceCandidates,
  requestVoicePreview,
  subscribeVoiceAssignmentResults,
  subscribeVoiceUploadConfirmations,
  useStore,
  useVoiceAudio,
  useVoiceCandidates,
  useVoicePreviews,
  useVoiceSidecar,
  type VoiceCandidatesState,
} from "../lib/store.js";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";

/**
 * The character's voice (design 132; issue 1011).
 *
 * A character carries two voice authorities and they are not interchangeable. `sheet.voice` is
 * the text-to-speech assignment that voiced reads, table reads, performances and voice takes
 * speak with. The designated voice sample is a clip of the character actually speaking, which a
 * speech-capable video route carries when she speaks on screen. Both are load-bearing and
 * neither can be derived from the other.
 *
 * They used to be drawn as two panels stacked in one dialog, which is what made the
 * text-to-speech half read as a stray settings control and the page read as two competing
 * screens. Here they are one voice with two uses: the hero names it, and a row each says what is
 * set and where it came from. The authorities underneath are untouched — their rights, quality
 * checks and attestations all still belong to the flow that sets them.
 */

/** Which use an entrance sets. The same two words the rows use, so a tile can be read against them. */
type Use = "reads" | "on screen";

/**
 * Which sheet is open, carried in the address rather than in state (the same shape the cut's
 * export sheet uses). A flow interrupted by a reload comes back where it was, and each one is
 * reachable as a link — from a dispatch that refused for want of a voice, say.
 */
const OVERLAYS = ["choose", "record", "sample"] as const;
type Overlay = (typeof OVERLAYS)[number];

/** The written voice the picker ranks against — prose the author wrote, not provider metadata. */
function writtenVoice(sheet: Sheet): string | null {
  const section = sheet.sections.find((candidate) => candidate.heading.startsWith("Voice"));
  const body = section?.body.trim();
  if (!body) return null;
  return body;
}

/**
 * What the reads row says about the assigned voice. The catalogue is what knows whether a
 * concrete target is local and what it costs, so the line is precise once candidates arrive and
 * falls back to the provider's name before then rather than guessing.
 */
function readsSource(sheet: Sheet, world: WorldBundle, candidates: VoiceCandidatesState | undefined): {
  label: string;
  detail: string;
  local: boolean | null;
} | null {
  const voice = sheet.voice;
  if (!voice) return null;
  const model = voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, world.clonedVoices ?? []);
  const match = model
    ? candidates?.ranked.find(({ candidate }) => voiceTargetKey(candidate) === voiceTargetKey({ ...voice, model }))
        ?.candidate
    : undefined;
  const label = voice.label ?? match?.label ?? voice.voiceId;
  const engine = match?.provider ?? voice.provider;
  const cost = match ? (match.local ? "free" : "priced a line at a time") : null;
  return {
    label,
    detail: [engine, cost].filter(Boolean).join(" · "),
    local: match ? match.local : null,
  };
}

/** What the on-screen row says about the designated clip: its length and what was attested of it. */
function screenSource(kit: ReferenceKit | undefined): string | null {
  const sample = kit?.designatedVoiceSample;
  if (!sample) return null;
  if (!("schemaVersion" in sample)) return "legacy clip · review before cloud reuse";
  const seconds = sample.provenance.outputTechnical.durationSec;
  const attested = sample.attestations.map((attestation) => attestation.kind);
  return [
    "this clip",
    seconds === undefined || seconds === null ? null : `${seconds.toFixed(1)} s`,
    attested.includes("single-speaker") ? "one speaker" : null,
    attested.includes("no-music") ? "no music" : null,
    sample.acknowledgementId ? null : "local only",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The single line a catalogue row carries on its right. Ordered by what stops you: a target that
 * cannot run, then a preview that failed, then one still being made, and only then what the voice
 * already is to this world.
 */
function rowNote(input: {
  candidate: VoiceCandidate;
  error: string | null | undefined;
  step: { stage: string; done: number; total: number } | null | undefined;
  current: boolean;
  shared: string[] | undefined;
}): string {
  if (input.candidate.unavailableReason !== undefined) return `unavailable · ${input.candidate.unavailableReason}`;
  if (input.error) return input.error;
  if (input.step) return `${input.step.stage} · step ${input.step.done} of ${input.step.total}`;
  if (input.current) return "current";
  return input.shared ? `used by ${input.shared.join(", ")}` : "";
}

function UseRow({
  name,
  glyph,
  source,
  empty,
  meta,
  play,
  onSet,
}: {
  name: string;
  glyph: React.ReactNode;
  source: string | null;
  /** What reads the character while this use is unset — a state, never an apology. */
  empty: string;
  meta: string | null;
  play?: React.ReactNode;
  onSet: () => void;
}) {
  const set = source !== null;
  return (
    <div className={cx("fy-voiceuse", !set && "fy-voiceuse--empty")}>
      {play ?? <span className="fy-voiceuse__noplay" />}
      <span className="fy-voiceuse__name">{name}</span>
      <span className="fy-voiceuse__source">
        {glyph}
        {source ?? empty}
      </span>
      {meta !== null && <span className="fy-mono fy-voiceuse__meta">{meta}</span>}
      {/* Nothing to change until something is set, and the press says which it is doing. */}
      <Button variant="outline" onClick={onSet}>
        {set ? "Change" : "Set"}
      </Button>
    </div>
  );
}

function EntranceTile({
  icon,
  title,
  what,
  where,
  sets,
  onOpen,
}: {
  icon: React.ReactNode;
  title: string;
  what: string;
  where: string;
  sets: readonly Use[];
  onOpen: () => void;
}) {
  return (
    <button type="button" className="fy-voicetile" onClick={onOpen}>
      <span className="fy-voicetile__icon">{icon}</span>
      <span className="fy-voicetile__title">{title}</span>
      <span className="fy-mono fy-voicetile__what">{what}</span>
      <span className="fy-mono fy-voicetile__where">{where}</span>
      <span className="fy-voicetile__sets">
        {(["reads", "on screen"] as const).map((use) => (
          <span key={use} className={cx("fy-usebadge", sets.includes(use) && "fy-usebadge--on")}>
            {use}
          </span>
        ))}
      </span>
    </button>
  );
}

export function CharacterVoiceScreen() {
  const { worldId, sheetId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const candidates = useVoiceCandidates()[sheetId ?? ""];
  const sidecar = useVoiceSidecar();
  const [params, setParams] = useSearchParams();
  const overlay = OVERLAYS.find((name) => params.get(name) === "1") ?? null;
  const open = (name: Overlay) => setParams({ [name]: "1" }, { replace: true });
  const close = () => setParams({}, { replace: true });
  const [refusal, setRefusal] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const clearingRequest = useRef<string | null>(null);
  // Matching is what the page is for rather than a step inside it, so the catalogue is asked for
  // on arrival: the hero can only name the engine and the cost once the catalogue has answered.
  useEffect(() => {
    if (worldId && sheetId) requestVoiceCandidates(worldId, sheetId);
  }, [worldId, sheetId]);
  useEffect(
    () =>
      subscribeVoiceAssignmentResults((result) => {
        if (result.requestId !== clearingRequest.current) return;
        clearingRequest.current = null;
        setClearing(false);
        setRefusal(result.status === "refused" ? (result.reason ?? "The voice could not be changed.") : null);
      }),
    [],
  );
  if (!world || !sheet || !sheetId) return null;
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const photo = kit ? mainPhotoFor(kit) : null;
  const portrait = photo ? `references/${sheetId}/${photo.file}` : sheetPortraitPath(sheetId);
  const written = writtenVoice(sheet);
  const reads = readsSource(sheet, world, candidates);
  const screen = screenSource(kit);
  // Both sample shapes store a basename beneath `references/<sheetId>/`, and only the resolver
  // knows it. Reading `sample.file` straight asks the world root for a file that is not there.
  const sampleFile = designatedVoiceSample(kit ?? null)?.file ?? null;
  const sheetPath = `characters/${sheet.id}.md`;
  // What a change is about to reach: the dialogue authored for this character, not the
  // recordings that happen to exist. A scene with lines and no performance yet still speaks with
  // the assignment, and a frozen performance keeps the one it was made with.
  const speaking = world.productions.filter((production) =>
    production.scenes.some(
      (scene) =>
        scene.script?.blocks.some((block) => block.kind === "dialogue" && block.speaker === sheetId) ||
        orderedShots(scene).some((shot) => shot.audio?.speaker === sheetId),
    ),
  ).length;
  // Zero productions is not worth a clause: what a change reaches is only interesting once a
  // change would reach something.
  // Which engines the catalogue actually reaches, named on the tile: "58 voices" says nothing
  // about whether any of them can run here without a key.
  const engines = [...new Set((candidates?.ranked ?? []).map(({ candidate }) => candidate.provider))].slice(0, 3);
  // Delivery examples live beside the performance they were taken from (design 132). The one
  // case that surface cannot reach is a slot whose production or scene has since gone: nothing
  // resolves this character as a speaker any more, so the panel appears here to be cleared.
  const orphanedExamples =
    (world.performanceBibles ?? []).some((bible) => bible.sheetId === sheetId && bible.events.length > 0) &&
    !world.productions.some((production) =>
      production.performances.some(
        (performance) =>
          performance.target.speakerSheetId === sheetId &&
          production.performanceReview.reviews.filter((review) => review.performanceId === performance.id).at(-1)
            ?.decision === "accept",
      ),
    );
  const usage =
    speaking === 0
      ? reads
        ? "used by nothing yet"
        : "the narrator reads their lines"
      : `${speaking} production${speaking === 1 ? "" : "s"}${reads ? " · replanned on change" : " · read by the narrator"}`;
  return (
    <div data-screen="character-voice">
      <CharacterHeader active="voice" />
      <main className="fy-voicepage">
        <DegradedBanner component="voice" />
        {sidecar && sidecar.state !== "ready" && (
          <Callout tone="warning" title={`Local voice — ${sidecar.state}`}>
            {sidecar.detail}
          </Callout>
        )}
        {refusal !== null && <p className="fy-refusal">{refusal}</p>}
        <section className="fy-voicehero" aria-label="This character's voice">
          <div className="fy-voicehero__art">
            <Portrait worldSlug={world.meta.slug} path={portrait} label="" radius={0} />
            <span className="fy-voicehero__pill">{reads ? reads.detail : "written voice only"}</span>
          </div>
          <div className="fy-voicehero__body">
            <div className="fy-voicehero__top">
              <div className="fy-voicehero__naming">
                <h1 className={cx("fy-voicehero__name", !reads && "fy-voicehero__name--empty")}>
                  {reads ? reads.label : "No voice yet"}
                </h1>
                {written !== null && <p className="fy-voicehero__written">{written}</p>}
              </div>
              {sheet.voice && (
                <Button
                  variant="ghost"
                  disabled={clearing}
                  onClick={() => {
                    if (!worldId) return;
                    setClearing(true);
                    setRefusal(null);
                    clearingRequest.current = assignVoice(worldId, sheetPath, null);
                    if (clearingRequest.current === null) {
                      setClearing(false);
                      setRefusal("The studio is disconnected — the voice was not changed.");
                    }
                  }}
                >
                  {clearing ? <Loading inline label="Clearing…" /> : "Clear voice"}
                </Button>
              )}
            </div>
            <div className="fy-voicehero__uses">
              <UseRow
                name="Reads lines"
                glyph={
                  reads?.local === null || reads === null ? null : reads.local ? <Monitor size={12} /> : <Cloud size={12} />
                }
                source={reads ? `${reads.label} · ${reads.detail}` : null}
                empty="not set · the narrator reads their lines"
                meta={reads ? usage : null}
                onSet={() => open("choose")}
              />
              <UseRow
                name="On screen"
                glyph={<VideoMark size={12} />}
                source={screen}
                empty="not set"
                meta={null}
                play={
                  sampleFile !== null ? (
                    <ClipPlayButton
                      small
                      clip={{
                        id: `${world.meta.worldId}/${sampleFile}`,
                        url: mediaUrl(world.meta.slug, sampleFile),
                        title: `${sheet.name} · voice sample`,
                        sub: "on screen",
                      }}
                    />
                  ) : undefined
                }
                onSet={() => open("sample")}
              />
            </div>
            {candidates && (
              <p className="fy-mono fy-voicehero__line">
                {candidates.previewLine.source === "own-line"
                  ? "own line"
                  : candidates.previewLine.source === "drafted"
                    ? "drafted line"
                    : "stock line"}
                <span>{`“${candidates.previewLine.text}”`}</span>
              </p>
            )}
          </div>
        </section>
        <div className="fy-voiceways__head">
          <h2>Get a voice</h2>
          <span className="fy-mono">versions the sheet · {usage}</span>
        </div>
        <div className="fy-voiceways">
          <EntranceTile
            icon={<Waveform size={18} />}
            title="Choose a voice"
            what={candidates ? `${candidates.ranked.length} voices` : "reading the catalogue…"}
            where={engines.length > 0 ? engines.join(" · ") : "cloud and on this machine"}
            sets={["reads"]}
            onOpen={() => open("choose")}
          />
          <EntranceTile
            icon={<Mic size={18} />}
            title="Clone a voice"
            what="record · 3 seconds or more"
            where="wav · mp3"
            sets={["reads"]}
            onOpen={() => open("record")}
          />
          <EntranceTile
            icon={<Upload size={18} />}
            title="Upload a recording"
            what="a file on this machine"
            where="wav · mp3"
            sets={["reads"]}
            onOpen={() => open("record")}
          />
          <EntranceTile
            icon={<VideoMark size={18} />}
            title="Generate a speaking sample"
            what="from the accepted photo"
            where="priced before it runs"
            sets={["on screen"]}
            onOpen={() => open("sample")}
          />
        </div>
      </main>
      {overlay === "choose" && (
        <ChooseVoiceDialog
          world={world}
          sheet={sheet}
          candidates={candidates}
          onClose={() => close()}
        />
      )}
      {overlay === "record" && (
        <CloneVoiceDialog
          open
          worldId={world.meta.worldId}
          sheetId={sheetId}
          onClose={() => close()}
          onCloned={(voiceId) => {
            // A clone that leaves the character it was made for still unvoiced is the flow
            // stopping one press short: the voice exists in the world and nothing reads with it.
            clearingRequest.current = assignVoice(world.meta.worldId, sheetPath, {
              provider: CLONED_VOICE_PROVIDER,
              model: CLONED_VOICE_MODEL,
              voiceId,
            });
            if (clearingRequest.current === null) setRefusal("The studio is disconnected — the voice was not assigned.");
            close();
          }}
        />
      )}
      {overlay === "sample" && (
        <VoiceSampleFlow world={world} sheet={sheet} onClose={() => close()} />
      )}
      {orphanedExamples && (
        <div className="fy-voicepage__orphans">
          <PerformanceBiblePanel world={world} sheet={sheet} />
        </div>
      )}
    </div>
  );
}

/**
 * The catalogue (design 132c), ranked against the written voice.
 *
 * A row is chosen and then assigned, rather than assigned where it sits: the previous list put
 * a Preview and an Assign on all fifty rows, and the two presses at the same weight made the
 * cheap one and the one that versions the sheet look alike. Here the circle previews — with its
 * price stated on the row beside it — and one press at the foot assigns what is chosen.
 */
function ChooseVoiceDialog({
  world,
  sheet,
  candidates,
  onClose,
}: {
  world: WorldBundle;
  sheet: Sheet;
  candidates: VoiceCandidatesState | undefined;
  onClose: () => void;
}) {
  const previews = useVoicePreviews();
  const voiceAudio = useVoiceAudio();
  const jobs = useStore().state?.app.jobs ?? [];
  const [where, setWhere] = useState<"all" | "cloud" | "local" | "mine">("all");
  const [pick, setPick] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [requests, setRequests] = useState<Record<string, string>>({});
  const requestKeys = useRef(new Map<string, string>());
  const assigningRequest = useRef<string | null>(null);
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    destinationLabel: string;
    confirmationToken: string;
    key: string;
  } | null>(null);
  const assignedModel = sheet.voice
    ? (sheet.voice.model ?? legacyVoiceModel(sheet.voice.provider, sheet.voice.voiceId, world.clonedVoices ?? []))
    : null;
  const assignedKey =
    sheet.voice && assignedModel
      ? voiceTargetKey({ provider: sheet.voice.provider, model: assignedModel, voiceId: sheet.voice.voiceId })
      : null;
  useEffect(
    () =>
      subscribeVoiceAssignmentResults((result) => {
        if (result.requestId !== assigningRequest.current) return;
        assigningRequest.current = null;
        setAssigning(false);
        if (result.status === "refused") setRefusal(result.reason ?? "The voice could not be assigned.");
        else onClose();
      }),
    [onClose],
  );
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        const key = requestKeys.current.get(confirmation.requestId);
        if (!key) return;
        setUploadConfirmation({
          destinationLabel: confirmation.destinationLabel,
          confirmationToken: confirmation.confirmationToken,
          key,
        });
      }),
    [],
  );
  // Whom this world already gives a voice to. Data on the row, not a warning: assigning it here
  // changes nothing about them, and two characters may legitimately share one voice.
  const usedBy = useMemo(() => {
    const byKey = new Map<string, string[]>();
    for (const other of world.sheets) {
      if (!other.voice || other.id === sheet.id || other.retired) continue;
      const model =
        other.voice.model ?? legacyVoiceModel(other.voice.provider, other.voice.voiceId, world.clonedVoices ?? []);
      if (!model) continue;
      const key = voiceTargetKey({ provider: other.voice.provider, model, voiceId: other.voice.voiceId });
      byKey.set(key, [...(byKey.get(key) ?? []), other.name]);
    }
    return byKey;
  }, [world.sheets, world.clonedVoices, sheet.id]);
  const rows = (candidates?.ranked ?? []).filter(({ candidate }) =>
    where === "all"
      ? true
      : where === "mine"
        ? isClonedVoice(candidate)
        : where === "local"
          ? candidate.local
          : !candidate.local,
  );
  const counts = {
    all: candidates?.ranked.length ?? 0,
    cloud: (candidates?.ranked ?? []).filter(({ candidate }) => !candidate.local).length,
    local: (candidates?.ranked ?? []).filter(({ candidate }) => candidate.local).length,
    mine: (candidates?.ranked ?? []).filter(({ candidate }) => isClonedVoice(candidate)).length,
  };
  const chosen = rows.find(({ candidate }) => voiceTargetKey(candidate) === pick)?.candidate;
  const startPreview = (candidate: VoiceCandidate, confirmedFor?: string) => {
    const provider = providerIdOf(candidate.provider);
    if (!provider) return;
    const key = voiceTargetKey(candidate);
    const requestId = requestVoicePreview(
      world.meta.worldId,
      sheet.id,
      provider,
      candidate.model,
      candidate.voiceId,
      confirmedFor,
    );
    for (const [older, mapped] of requestKeys.current) if (mapped === key) requestKeys.current.delete(older);
    requestKeys.current.set(requestId, key);
    setRequests((current) => ({ ...current, [key]: requestId }));
  };
  return (
    <>
      <div className="fy-voicescrim" onClick={onClose} />
      <div className="fy-voicesheet" role="dialog" aria-label="Choose a voice" data-testid="voice-catalogue">
        <header className="fy-voicesheet__head">
          <span className="fy-voicesheet__avatar">
            <Portrait worldSlug={world.meta.slug} path={sheetPortraitPath(sheet.id)} label="" radius={99} />
          </span>
          <div>
            <strong>{`Choose ${sheet.name.split(" ")[0]}'s voice`}</strong>
            <span className="fy-mono">ranked against their written voice</span>
          </div>
        </header>
        <div className="fy-voicesheet__filters">
          <div className="fy-seg">
            {(["all", "cloud", "local", "mine"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                className={cx("fy-seg__item", where === tab && "fy-seg__item--active")}
                data-testid={`voice-tab-${tab}`}
                onClick={() => setWhere(tab)}
              >
                {`${
                  tab === "all" ? "All" : tab === "cloud" ? "Cloud" : tab === "local" ? "On this machine" : "Mine"
                } ${counts[tab]}`}
              </button>
            ))}
          </div>
          <span className="fy-mono">
            {candidates
              ? `previews read ${
                  candidates.previewLine.source === "own-line"
                    ? "their own line"
                    : candidates.previewLine.source === "drafted"
                      ? "a drafted line"
                      : "a stock line"
                }`
              : "reading the catalogue…"}
          </span>
        </div>
        {refusal !== null && <p className="fy-refusal">{refusal}</p>}
        {uploadConfirmation && (
          <RemoteVoiceUploadConfirmation
            destinationLabel={uploadConfirmation.destinationLabel}
            onCancel={() => {
              setRequests((current) => {
                const next = { ...current };
                delete next[uploadConfirmation.key];
                return next;
              });
              for (const [requestId, key] of requestKeys.current) {
                if (key === uploadConfirmation.key) requestKeys.current.delete(requestId);
              }
              setUploadConfirmation(null);
            }}
            onConfirm={() => {
              const candidate = rows.find(({ candidate }) => voiceTargetKey(candidate) === uploadConfirmation.key)
                ?.candidate;
              if (candidate) startPreview(candidate, uploadConfirmation.confirmationToken);
              setUploadConfirmation(null);
            }}
          />
        )}
        {candidates === undefined && <p className="fy-voicesheet__none">Reading the catalogue…</p>}
        {candidates !== undefined && rows.length === 0 && (
          <p className="fy-voicesheet__none">No voices here — add a key in Providers, or install a local runtime.</p>
        )}
        {/* The catalogue scrolls in its own pane rather than growing the sheet: fifty cloud
            voices would otherwise push the press that spends money below the fold. */}
        <div className="fy-voicelist">
          {rows.map(({ candidate }) => {
            const key = voiceTargetKey(candidate);
            const requestId = requests[key];
            const result = requestId ? voiceAudio[requestId] : undefined;
            const error = result?.error ?? previews[key]?.error;
            const price = candidates?.previewMicroUsdByVoice[key] ?? candidates?.cloudPreviewMicroUsd;
            const shared = usedBy.get(key);
            const step = requestId
              ? jobs.find((job) => job.params["requestId"] === requestId)?.step
              : undefined;
            return (
              <div
                key={key}
                className={cx(
                  "fy-voicerow",
                  pick === key && "fy-voicerow--picked",
                  assignedKey === key && "fy-voicerow--selected",
                )}
              >
                <ClipPlayButton
                  small
                  busy={candidate.unavailableReason === undefined && Boolean(requestId && !result)}
                  label={candidate.local ? "Preview · free" : "Preview"}
                  clip={
                    result?.status === "ready" && result.file
                      ? {
                          id: result.requestId,
                          url: mediaUrl(world.meta.slug, result.file),
                          title: candidate.label,
                          sub: `preview · ${candidate.provider}`,
                        }
                      : null
                  }
                  onStart={
                    candidate.unavailableReason === undefined ? () => startPreview(candidate) : undefined
                  }
                />
                <button
                  type="button"
                  className="fy-voicerow__pick"
                  disabled={candidate.unavailableReason !== undefined}
                  onClick={() => setPick(key)}
                >
                  <span className="fy-voicerow__name">{candidate.label}</span>
                  <span className="fy-voicerow__sub">
                    {candidate.attributes.length > 0
                      ? candidate.attributes.join(", ")
                      : isClonedVoice(candidate)
                        ? "cloned here"
                        : ""}
                  </span>
                </button>
                <span className="fy-voicerow__where">
                  {candidate.local ? <Monitor size={12} /> : <Cloud size={12} />}
                  {/* One expression, so the engine and its price stay one text node: split in
                      two, React puts a comment between them and the pair cannot be read. */}
                  <span className="fy-mono">
                    {`${candidate.provider}${
                      candidate.local
                        ? " · free"
                        : price !== null && price !== undefined
                          ? ` · ${formatMicroUsd(price)} preview`
                          : ""
                    }`}
                  </span>
                </span>
                <span className="fy-mono fy-voicerow__note">
                  {rowNote({ candidate, error, step, current: assignedKey === key, shared })}
                </span>
              </div>
            );
          })}
        </div>
        <footer className="fy-voicesheet__foot">
          <span className="fy-mono">sets reads · versions the sheet</span>
          <span className="fy-voicesheet__push" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="voice-assign"
            disabled={chosen === undefined || assigning || pick === assignedKey}
            onClick={() => {
              if (!chosen) return;
              const provider = providerIdOf(chosen.provider);
              if (!provider) return;
              setAssigning(true);
              setRefusal(null);
              assigningRequest.current = assignVoice(world.meta.worldId, `characters/${sheet.id}.md`, {
                provider,
                model: chosen.model,
                voiceId: chosen.voiceId,
                label: chosen.label,
              });
              if (assigningRequest.current === null) {
                setAssigning(false);
                setRefusal("The studio is disconnected — the voice was not changed.");
              }
            }}
          >
            {assigning ? <Loading inline label="Assigning…" /> : `Assign to ${sheet.name.split(" ")[0]}`}
          </Button>
        </footer>
      </div>
    </>
  );
}
