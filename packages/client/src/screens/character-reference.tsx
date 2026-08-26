import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  compilationIsStale,
  designatedCompilation,
  mainPhotoFor,
  MAX_IMAGE_PREVIEWS,
  stagedReferenceKey,
  type CharacterLook,
  type ManifestModel,
  type ReferenceKit,
  type ReviewDecision,
  type SizeTier,
  type Sheet,
  type Take,
} from "@arke-studio/contracts";
import { resolveModel } from "../components/dispatch-bar.js";
import { authoredPrompt, GenerationDialog } from "../components/generation-dialog.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { Button, Callout, cx } from "../components/ui.js";
import { Loading } from "../components/loading.js";
import { ImageDialog } from "../components/image-dialog.js";
import { ImageDownload } from "../components/image-actions.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import {
  acceptCharacterLook,
  acceptCharacterSheet,
  attachCharacterLook,
  chooseAnchor,
  clearCharacterSheetAcceptance,
  clearMainPhotoAcceptance,
  generateCharacterLooks,
  generateCharacterSheet,
  generateMainPhoto,
  importCharacterSheet,
  importMainPhoto,
  importMainPhotoCandidate,
  clearStagedReference,
  pickStagedReference,
  promoteCharacterLook,
  rejectReferenceTake,
  subscribeQueueResults,
  useCharacterSheetAcceptance,
  useMainPhotoAcceptance,
  useStore,
} from "../lib/store.js";

function CharacterSheetPreview({
  worldSlug,
  path,
  characterName,
}: {
  worldSlug: string;
  path: string;
  characterName: string;
}) {
  return (
    <ImageDialog
      worldSlug={worldSlug}
      path={path}
      label={`${characterName} character sheet`}
      title={characterName}
      subtitle="character sheet"
      triggerLabel={`View larger character sheet for ${characterName}`}
      closeLabel="Close character sheet"
      triggerClassName="fy-character-sheet-preview"
      triggerRadius={0}
      dialogClassName="fy-character-sheet-dialog"
      download
      downloadName={`${characterName} character sheet`}
    />
  );
}

function CharacterHeader({ active }: { active: "reference" | "looks" }) {
  const { worldId, sheetId } = useParams();
  const navigate = useNavigate();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const kit = world?.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const photo = kit ? mainPhotoFor(kit) : null;
  return (
    <header className="fy-character-head">
      <span className="fy-character-head__avatar">
        <Portrait
          worldSlug={world?.meta.slug}
          path={
            photo && sheetId
              ? `references/${sheetId}/${photo.file}`
              : sheetId
                ? sheetPortraitPath(sheetId)
                : ""
          }
          label=""
          radius={99}
        />
      </span>
      <div>
        <h1>{sheet?.name ?? "Character"}</h1>
        <p>{sheet?.role ?? "Character"} · identity reference set</p>
      </div>
      <span className="fy-character-head__push" />
      <nav className="fy-seg fy-character-tabs">
        <button
          type="button"
          className="fy-seg__item"
          onClick={() => navigate(`/w/${worldId}/cast/${sheetId}`)}
        >
          Overview
        </button>
        <button
          type="button"
          className={cx("fy-seg__item", active === "reference" && "fy-seg__item--active")}
          onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/kit`)}
        >
          Reference
        </button>
        <button
          type="button"
          className={cx("fy-seg__item", active === "looks" && "fy-seg__item--active")}
          onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/looks`)}
        >
          More looks
        </button>
        <button
          type="button"
          className="fy-seg__item"
          onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/voice`)}
        >
          Voice
        </button>
      </nav>
    </header>
  );
}

export function mainPhotoPromptFor(sheet: Sheet | null | undefined): string {
  if (!sheet) return "";
  const appearance = sheet.sections.find((section) => section.heading.toLowerCase() === "appearance")?.body.trim();
  const role = sheet.role?.trim();
  return [
    `A clear, grounded head-and-shoulders identity portrait of ${sheet.name}.`,
    role ? `Role: ${role}.` : null,
    appearance ? `Preserve these visible traits: ${appearance}` : "Use the character sheet's established physical identity.",
    "Restrained neutral expression, no text or montage.",
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
}

/**
 * The image model this screen is actually on — the bar's answer, not a second opinion. These
 * hosts gate references and prompts on it, and resolving it differently from the bar meant the
 * screen could compute "no references" against one model while submitting another.
 */
function shownImageModel(state: ReturnType<typeof useStore>["state"], chosenId?: string): ManifestModel | null {
  return resolveModel(state, "image", chosenId).model;
}

/**
 * What the chosen model carries on an identity-dependent surface. Read from the choice rather
 * than the routed default, because the whole point of choosing is that the answer changes — and
 * a model that carries nothing must be refused here, not discovered at dispatch.
 */
function carriesIdentity(model: ManifestModel | null): boolean {
  return model !== null && model.unverified !== true && model.accepts.referenceImages > 0;
}

/**
 * Whether this build can open a file dialog at all. The picker belongs to the host, so in the
 * browser there is nothing to open — and the button says which build has it rather than going
 * quietly dead.
 */
function canPickFiles(): boolean {
  return typeof window !== "undefined" && window.arke !== undefined;
}

const UPLOAD_UNAVAILABLE = "Upload is available in the desktop app";

export function CharacterReferenceScreen() {
  const { worldId, sheetId } = useParams();
  const navigate = useNavigate();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const { state } = useStore();
  const photoUpload = useMainPhotoAcceptance()[sheetId ?? ""];
  const sheetUpload = useCharacterSheetAcceptance()[sheetId ?? ""];
  // A success says itself — the card changes. What it must not do is linger: the replace screen
  // reads this same slot and leaves the moment it sees "accepted", so a success left here would
  // make the next press of Replace bounce straight back.
  useEffect(() => {
    if (sheetId && photoUpload?.status === "accepted") clearMainPhotoAcceptance(sheetId);
  }, [photoUpload?.status, sheetId]);
  useEffect(() => {
    if (sheetId && sheetUpload?.status === "accepted") clearCharacterSheetAcceptance(sheetId);
  }, [sheetUpload?.status, sheetId]);
  if (!world || !sheet || !sheetId) return null;
  const canUpload = canPickFiles();
  // A null status is the press itself: sent, not yet answered. The host's dialog is up, or its
  // bytes are still being read.
  const photoUploading = photoUpload?.status === null;
  const sheetUploading = sheetUpload?.status === null;
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId) ?? null;
  const photo = kit ? mainPhotoFor(kit) : null;
  const compilation = kit ? designatedCompilation(kit) : null;
  const stale = kit && compilation ? compilationIsStale(kit, compilation, sheet.version) : false;
  const pendingSheetTakes = world.referenceTakes
    .filter(
      (take) =>
        take.kind === "sheet" &&
        take.reference?.sheetId === sheetId &&
        !world.referenceReviews.some((review) => review.takeId === take.id),
    )
    .sort((a, b) => (b.completedAt ?? b.dispatchedAt).localeCompare(a.completedAt ?? a.dispatchedAt));
  // Same scoping rules as the main-photo watch below: this world only (sheet slugs recur
  // across worlds), and a job held for reconciliation is not generating.
  const latestSheetJob = [...(state?.app.jobs ?? [])]
    .filter(
      (job) =>
        job.worldId === world.meta.worldId &&
        job.target.kind === "character-sheet" &&
        job.target.id?.startsWith(`${sheetId}/`),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const sheetFinalization = latestSheetJob?.finalization?.status !== "complete" ? latestSheetJob?.finalization : undefined;
  const runningSheet = latestSheetJob
    ? !["succeeded", "failed", "cancelled", "needs-reconciliation"].includes(latestSheetJob.status) ||
      latestSheetJob.finalization?.status === "pending"
    : false;
  const reviewTake = pendingSheetTakes[0] ?? null;
  // Whichever arrived last is what the card is about. A take waiting on review is usually the
  // newest thing here — but not when a sheet has just been uploaded past an older take that was
  // stranded undecided, and showing that one would say the upload did nothing (PR review). The
  // stranded take stays in the review list below either way; it is not being hidden, only
  // out-ranked.
  const showTake =
    reviewTake !== null &&
    (compilation === null || (reviewTake.completedAt ?? reviewTake.dispatchedAt) > compilation.compiledAt);
  const sheetPath = showTake
    ? `references/${sheetId}/takes/${reviewTake.id}/${reviewTake.media}`
    : compilation
      ? `references/${sheetId}/${compilation.file}`
      : null;
  return (
    <div data-screen="reference-kit">
      <CharacterHeader active="reference" />
      <main className="fy-reference-grid">
        <section className="fy-reference-card">
          <div className="fy-reference-card__image fy-reference-card__image--photo fy-imghost">
            <ImageDialog
              worldSlug={world.meta.slug}
              path={photo ? `references/${sheetId}/${photo.file}` : ""}
              label={photo ? `${sheet.name} main photo` : "Main photo outstanding"}
              title={sheet.name}
              subtitle="main photo"
              triggerLabel={`View larger main photo of ${sheet.name}`}
              closeLabel="Close main photo"
              triggerClassName="fy-reference-card__zoom"
              triggerRadius={0}
              download
              downloadName={`${sheet.name} main photo`}
            />
            <span className="fy-reference-card__status">
              {photo ? "ACCEPTED · IDENTITY ANCHOR" : "OUTSTANDING"}
            </span>
          </div>
          <div className="fy-reference-card__foot">
            <div>
              <h2>Main photo</h2>
              <p>the face and physical identity to preserve</p>
            </div>
            <Button
              variant="ghost"
              disabled={!canUpload || photoUploading}
              title={canUpload ? "Use an image from this computer — nothing is generated" : UPLOAD_UNAVAILABLE}
              onClick={() => importMainPhoto(world.meta.worldId, sheetId)}
            >
              {photoUploading ? "Uploading…" : "Upload"}
            </Button>
            <Button onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/main-photo`)}>
              {photo ? "Replace" : "Create"}
            </Button>
          </div>
          {photoUpload?.status === "failed" && (
            <p className="fy-reference-fallback">{photoUpload.reason ?? "The main photo was not changed."}</p>
          )}
        </section>
        <section className="fy-reference-card">
          <div className="fy-reference-card__image fy-reference-card__image--sheet fy-imghost">
            {runningSheet ? (
              <div className="fy-reference-card__generating">
                <Loading label={`Generating character sheet for ${sheet.name}`} size={48} />
                <p>You can leave this page. We’ll notify you when it is ready.</p>
              </div>
            ) : sheetPath ? (
              <CharacterSheetPreview worldSlug={world.meta.slug} path={sheetPath} characterName={sheet.name} />
            ) : (
              <Portrait worldSlug={world.meta.slug} path="" label="Character sheet outstanding" radius={0} />
            )}
            <span className={cx("fy-reference-card__status", stale && !showTake && "fy-reference-card__status--warn")}>
              {runningSheet
                ? "GENERATING"
                : showTake
                  ? "READY FOR REVIEW"
                : stale
                  ? "MAIN PHOTO CHANGED · REGENERATE"
                  : compilation
                    ? "ACCEPTED · CURRENT"
                    : photo
                      ? "READY TO GENERATE"
                      : "WAITING ON MAIN PHOTO"}
            </span>
          </div>
          <div className="fy-reference-card__foot fy-reference-card__foot--sheet">
            <div>
              <h2>Character sheet</h2>
              <p>multiple views · one composite image</p>
            </div>
            {/* Not gated on the main photo, unlike Generate: a sheet drawn elsewhere owes this
                world's identity anchor nothing, and waiting on one would be a rule with no
                purpose behind it. Gated on a generation in flight, though — that one designates
                itself when it lands, and would quietly replace a sheet uploaded while it ran. */}
            <Button
              variant="ghost"
              disabled={!canUpload || runningSheet || sheetUploading}
              title={
                !canUpload
                  ? UPLOAD_UNAVAILABLE
                  : runningSheet
                    ? "A generated sheet is on its way and will take this slot when it lands"
                    : "Use a composite from this computer — nothing is generated"
              }
              onClick={() => importCharacterSheet(world.meta.worldId, sheetId)}
            >
              {sheetUploading ? "Uploading…" : "Upload"}
            </Button>
            <Button disabled={!photo || runningSheet} onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/model-sheet`)}>
              {runningSheet ? "Generating" : compilation ? "Regenerate" : "Generate"}
            </Button>
          </div>
          {sheetUpload?.status === "failed" && (
            <p className="fy-reference-fallback">{sheetUpload.reason ?? "The character sheet was not changed."}</p>
          )}
          {pendingSheetTakes.length > 0 && (
            <div className="fy-reference-candidates">
              <span>{pendingSheetTakes.length} new composite{pendingSheetTakes.length === 1 ? " is" : "s are"} ready for review.</span>
              {pendingSheetTakes.map((take) => (
                <div key={take.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <span className="fy-mono">{take.id} · {new Date(take.completedAt ?? take.dispatchedAt).toLocaleString()}</span>
                  <Button variant="primary" onClick={() => acceptCharacterSheet(world.meta.worldId, sheetId, take.id)}>
                    Accept this sheet
                  </Button>
                  <Button variant="ghost" onClick={() => rejectReferenceTake(world.meta.worldId, take.id, "identity")}>Reject</Button>
                </div>
              ))}
            </div>
          )}
          {sheetFinalization && (
            <p className="fy-reference-fallback">
              {sheetFinalization.status === "pending"
                ? "Generation completed. Preparing the review take."
                : sheetFinalization.error}
            </p>
          )}
          <div className="fy-reference-card__dispatch">
            <span>1 reference: Character sheet</span>
            <span>multiple: Main photo + Character sheet</span>
            <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/looks`)}>
              More looks
            </Button>
          </div>
        </section>
      </main>
    </div>
  );
}

export function GenerateCharacterSheetScreen() {
  const { worldId, sheetId } = useParams();
  const navigate = useNavigate();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const { state } = useStore();
  /*
   * The look's own words, in the box, rather than an Override toggle over a hidden default.
   *
   * The screen used to show the world look as a thumbnail and a caption, with an "Override"
   * button that revealed an empty textarea — so the words actually being sent were never on
   * screen, and overriding meant writing a replacement for something you could not read. This is
   * the same gesture key art and the master look already use (design 64): the box opens as what
   * would be sent, and an edit *is* the override.
   */
  const [style, setStyle] = useState<string | null>(null);
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier }>({});
  const [requested, setRequested] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const earlierTakeIds = useRef(new Set<string>());
  const pendingRequestId = useRef<string | null>(null);
  // Which job this dialog is waiting on. Without it the screen watches for "a sheet take it has
  // not seen", and a sheet uploaded by hand while the generation runs answers that description —
  // so the upload would be presented as the paid result and the generation called finished while
  // it was still going (PR review).
  const acceptedJobId = useRef<string | null>(null);
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pendingRequestId.current) return;
        if (result.acceptedJobIds.length > 0) {
          acceptedJobId.current = result.acceptedJobIds[0] ?? null;
          return;
        }
        setDispatchError(
          result.failures.map((failure) => failure.reason).join(" ") || "The character sheet could not be queued.",
        );
      }),
    [],
  );
  if (!world || !sheet || !sheetId) return null;
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const photo = kit ? mainPhotoFor(kit) : null;
  const chosenModel = shownImageModel(state, choice.modelId);
  const referencesAsText = !carriesIdentity(chosenModel);
  // ALL of this sheet's composite takes, reviewed or not. The auto-accept at finalization
  // (the human's-own-action rule) reviews the take the moment it lands, so a screen that only
  // watched the unreviewed set would show "Generating…" forever over a sheet already in.
  const sheetTakes = world.referenceTakes
    .filter((take) => take.kind === "sheet" && take.reference?.sheetId === sheetId)
    .sort((a, b) => (b.completedAt ?? b.dispatchedAt).localeCompare(a.completedAt ?? a.dispatchedAt));
  // Generated only: an uploaded take carries no jobId, so it can never be mistaken for this
  // request's result. Once the queue has named the job, that is the only take this dialog will
  // accept — before then, "new and from some job" is the closest true statement available.
  const generatedTake = requested
    ? sheetTakes.find((take) =>
        acceptedJobId.current !== null
          ? take.jobId === acceptedJobId.current
          : take.jobId !== undefined && !earlierTakeIds.current.has(take.id),
      ) ?? null
    : null;
  const generatedAccepted =
    generatedTake !== null &&
    world.referenceReviews.some((review) => review.takeId === generatedTake.id && review.decision === "accept");
  const generatedPath = generatedTake
    ? `references/${sheetId}/takes/${generatedTake.id}/${generatedTake.media}`
    : null;
  const back = () => navigate(`/w/${worldId}/cast/${sheetId}/kit`);
  const inherited = world.artDirection.description;
  const words = style ?? inherited;
  /*
   * What travels with a character sheet: the accepted main photo, and the look it inherits.
   *
   * Both are facts about this surface rather than choices — the sheet is conditioned on the main
   * photo by definition — so they are shown rather than toggled. What can change is whether the
   * chosen model will actually carry the photo, and that is stated here because it is the one
   * silent downgrade that matters: identity by image, or identity by adjective.
   */
  const travelling = (
    <>
      <div className="fy-gendialog__label">What arrives</div>
      <div className="fy-sheetspec">
        <div className="fy-sheet-layout-sample">
          <i />
          <i />
          <i />
          <i />
        </div>
        <div>
          <strong>Character sheet</strong>
          <p>turnaround + expressions + details in one image</p>
        </div>
      </div>
      <div className="fy-gendialog__label">Identity source</div>
      <div className="fy-gendialog__refs">
        <div className={carriesIdentity(chosenModel) ? undefined : "is-dropped"}>
          <Portrait
            worldSlug={world.meta.slug}
            path={photo ? `references/${sheetId}/${photo.file}` : ""}
            label="Accepted main photo required"
            radius={10}
          />
          <span>{carriesIdentity(chosenModel) ? "MAIN PHOTO" : "MAIN PHOTO · DROPPED"}</span>
        </div>
      </div>
      {!photo && (
        <p className="fy-gendialog__hint">
          {sheet.name} has no accepted main photo yet. A character sheet is generated from one, so
          that comes first.
        </p>
      )}
      {referencesAsText && photo && (
        <Callout tone="warning" title={`${chosenModel?.displayName ?? "This model"} accepts no reference images`}>
          The main photo cannot be sent; identity relies on the character traits carried in the
          prompt.
        </Callout>
      )}
    </>
  );

  const preview = generatedPath
    ? [{ key: generatedTake!.id, path: generatedPath, label: `${sheet.name}'s character sheet` }]
    : [];

  return (
    <div data-screen="model-sheet-generate">
      <GenerationDialog
        open
        onClose={back}
        title="Generate character sheet"
        lede={`${sheet.name} · one composite identity reference · World look · v${world.artDirection.version}`}
        promptLabel="Art direction"
        prompt={words}
        onPrompt={setStyle}
        onResetPrompt={() => setStyle(null)}
        resetTitle="Back to the world look"
        promptHint="Inherited from this world. Edit it and this one generation is made under your words instead — the look itself does not change."
        worldSlug={world.meta.slug}
        reference={world.stagedReferences[stagedReferenceKey("character-sheet", sheetId)] ?? null}
        referenceHint="Optional. A layout, a pose sheet or a style plate to work from. It rides after the main photo, so it is dropped when the model has room for only one image."
        onAttachReference={() => pickStagedReference(world.meta.worldId, stagedReferenceKey("character-sheet", sheetId))}
        onClearReference={() => clearStagedReference(world.meta.worldId, stagedReferenceKey("character-sheet", sheetId))}
        extra={travelling}
        workflow="character-sheet"
        referenceImages={1}
        landscape
        choice={choice}
        onChoice={setChoice}
        submitLabel="Generate"
        submitDisabled={!photo || !carriesIdentity(chosenModel) || (requested && !generatedTake && !dispatchError)}
        {...(dispatchError !== null ? { why: dispatchError } : {})}
        onSubmit={() => {
          // Seeded from ALL takes, reviewed included — a previously accepted composite must not
          // read as this request's result.
          earlierTakeIds.current = new Set(sheetTakes.map((take) => take.id));
          acceptedJobId.current = null;
          const override = authoredPrompt(words, inherited);
          const requestId = generateCharacterSheet(
            world.meta.worldId,
            sheetId,
            override?.trim() ? override.trim() : undefined,
            sheet.name,
            {
              ...(chosenModel ? { modelId: chosenModel.id } : {}),
              ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
            },
          );
          if (requestId) {
            pendingRequestId.current = requestId;
            setDispatchError(null);
            setRequested(true);
          } else {
            setDispatchError("The studio is disconnected. Reconnect and try again.");
          }
        }}
        previews={preview}
        generating={requested && generatedTake === null && dispatchError === null}
        waitingHint={`Completes ${sheet.name}'s reference set. You can close this — it lands here and in Activity.`}
        // One composite, so there is nothing to choose between: the take that came back is the
        // selection. Making somebody click a single tile before they may answer it would be a
        // step that exists only because the column can hold four.
        selected={preview[0]?.key ?? null}
        commit={
          generatedTake === null
            ? undefined
            : generatedAccepted
              ? {
                  // The human's-own-action rule reviewed it as it landed, so there is nothing to
                  // approve — only somewhere to go.
                  label: "Back to the reference set",
                  onCommit: back,
                  note: `It is already part of ${sheet.name}'s reference set. Regenerate from here any time.`,
                }
              : {
                  label: "Accept this sheet",
                  onCommit: () => {
                    acceptCharacterSheet(world.meta.worldId, sheetId, generatedTake.id);
                    back();
                  },
                  note: `Accepting makes this ${sheet.name}'s designated character sheet.`,
                  secondary: {
                    label: "Reject",
                    onAction: () => {
                      rejectReferenceTake(world.meta.worldId, generatedTake.id, "identity");
                      back();
                    },
                  },
                }
        }
      />
    </div>
  );
}

export function ReplaceMainPhotoScreen() {
  const { worldId, sheetId } = useParams();
  const navigate = useNavigate();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const { state } = useStore();
  const acceptance = useMainPhotoAcceptance()[sheetId ?? ""];
  const [prompt, setPrompt] = useState(() => mainPhotoPromptFor(sheet));
  const [count, setCount] = useState(4);
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier }>({});
  // Whether the accepted main photo rides along as an identity reference. Its own control, and
  // not the upload button's business: one press used to do both, and the refs strip then showed
  // the *current* photo captioned as though it were the file just chosen.
  const [carryIdentity, setCarryIdentity] = useState(false);
  const [worldRef, setWorldRef] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  // The click itself flips the panel: between the press and the
  // first job event there is a round trip, and a panel that waits for it says "Ready when
  // you are" to somebody who just spent money. Cleared when the queue answers either way;
  // the timeout is the backstop for an enqueue that was refused without a job.
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const timer = setTimeout(() => setAsking(false), 20_000);
    return () => clearTimeout(timer);
  }, [asking]);

  useEffect(() => {
    setPrompt(mainPhotoPromptFor(sheet));
  }, [sheet?.id]);

  useEffect(() => {
    if (acceptance?.status === "accepted" && sheetId) {
      clearMainPhotoAcceptance(sheetId);
      navigate(`/w/${worldId}/cast/${sheetId}/kit`);
    }
  }, [acceptance?.status, navigate, sheetId, worldId]);

  /*
   * Previews in flight, the same way the kit page watches sheet jobs. Without this the panel said
   * "Ready when you are" while the money was already being spent — indistinguishable from having
   * pressed nothing.
   *
   * Scoped to THIS world — sheet slugs recur across worlds — and a job held for reconciliation is
   * not generating: nothing runs until the user answers in Activity.
   *
   * Computed above the guard, and so is the effect that reads it. Both used to sit below it, which
   * meant this component ran 29 hooks on a render with no world open and 30 on the next one —
   * React's "rendered more hooks than during the previous render", and a blank screen for anyone
   * who arrived at this address before the world had finished opening. A reload on the route was
   * enough to do it.
   */
  const generatingPreviews = (state?.app.jobs ?? []).filter(
    (job) =>
      job.worldId === world?.meta.worldId &&
      job.target.kind === "main-photo-candidate" &&
      job.target.id?.startsWith(`${sheetId}/`) &&
      (!["succeeded", "failed", "cancelled", "needs-reconciliation"].includes(job.status) ||
        job.finalization?.status === "pending"),
  ).length;
  useEffect(() => {
    if (asking && generatingPreviews > 0) setAsking(false);
  }, [asking, generatingPreviews]);

  if (!world || !sheet || !sheetId) return null;
  const current = world.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const photo = current ? mainPhotoFor(current) : null;
  const generatedCandidates = world.referenceTakes
    .filter(
      (take) =>
        take.kind === "main-photo" &&
        take.reference?.sheetId === sheetId &&
        !world.referenceReviews.some((review) => review.takeId === take.id),
    )
    .sort((a, b) => (a.completedAt ?? a.dispatchedAt).localeCompare(b.completedAt ?? b.dispatchedAt))
    .map((take) => ({
      key: `take:${take.id}`,
      path: `references/${sheetId}/takes/${take.id}/${take.media}`,
      selection: { source: "take" as const, takeId: take.id },
    }));
  const uploadedCandidates = (world.referenceCandidates[sheetId] ?? []).map((path) => ({
    key: `candidate:${path}`,
    path,
    selection: { source: "candidate" as const, file: path.slice(path.lastIndexOf("/") + 1) },
  }));
  const candidates = [...uploadedCandidates, ...generatedCandidates];
  const selectedCandidate = candidates.find((candidate) => candidate.key === selected) ?? null;
  const generating = asking || generatingPreviews > 0;
  // The chosen model decides what can travel, so it decides what this screen shows travelling.
  // A silent downgrade from image identity to text description is the failure the bar exists to
  // prevent, and it has to be visible where the references are, not only in the bar's own line.
  const model = shownImageModel(state, choice.modelId);
  const carriesReferences = model !== null && model.unverified !== true && model.accepts.referenceImages > 0;
  const canImport = canPickFiles();
  const refs = carryIdentity && photo && carriesReferences ? [`references/${sheetId}/${photo.file}`] : [];
  const back = () => navigate(`/w/${worldId}/cast/${sheetId}/kit`);
  /*
   * What travels, as this surface's own controls (design 65).
   *
   * These are the one thing the shared dialog does not own: a main photo can carry the accepted
   * face and the world's look, and whether either actually rides depends on the model chosen in
   * the bar below. They go in the dialog's `extra` slot rather than becoming a fourth arrangement
   * of the three decisions — the words, the model, the size and the count stay exactly where they
   * are on every other surface.
   */
  const travelling = (
    <>
      <div className="fy-gendialog__refbuttons">
        {/* Two different things, so two buttons: one decides what travels with the generation,
            the other brings in a finished image that needs no generation. */}
        <Button
          disabled={!photo}
          title={
            photo
              ? "Carry the accepted main photo into the generation, so the new one keeps the face"
              : "There is no accepted main photo to carry yet"
          }
          onClick={() => setCarryIdentity(!carryIdentity)}
        >
          Use current photo
        </Button>
        <Button onClick={() => setWorldRef(!worldRef)}>Choose from world</Button>
        <Button
          disabled={!canImport}
          title={
            canImport
              ? "Choose an image from this computer; it joins the previews to pick from"
              : UPLOAD_UNAVAILABLE
          }
          onClick={() => importMainPhotoCandidate(world.meta.worldId, sheetId)}
        >
          Upload your own
        </Button>
      </div>
      <div className="fy-gendialog__refs">
        {carryIdentity && photo && (
          <div className={carriesReferences ? undefined : "is-dropped"}>
            <Portrait
              worldSlug={world.meta.slug}
              path={`references/${sheetId}/${photo.file}`}
              label="Identity reference"
              radius={10}
            />
            <span>{carriesReferences ? "IDENTITY" : "IDENTITY · DROPPED"}</span>
          </div>
        )}
        {worldRef && (
          <div>
            <Portrait
              worldSlug={world.meta.slug}
              path={world.artDirection.masterLook ?? world.keyArt ?? ""}
              label="Style reference"
              radius={10}
            />
            <span>STYLE · TEXT FALLBACK</span>
          </div>
        )}
      </div>
      {carryIdentity && !carriesReferences && model && (
        <Callout tone="warning" title={`${model.displayName} accepts no reference images`}>
          {sheet.name}&apos;s main photo will not ride along. The generation sees the written
          description and the world look as text, and nothing of the face.
        </Callout>
      )}
    </>
  );

  return (
    <div data-screen="replace-main-photo">
      <GenerationDialog
        open
        onClose={back}
        title="Replace main photo"
        lede={`${sheet.name} · the accepted identity anchor · World look · v${world.artDirection.version}`}
        promptLabel="Describe the portrait"
        prompt={prompt}
        onPrompt={setPrompt}
        onResetPrompt={() => setPrompt(mainPhotoPromptFor(sheet))}
        resetTitle="Reset from character sheet"
        promptHint="Written from the character sheet. Whatever is here is what the model is asked for."
        worldSlug={world.meta.slug}
        reference={world.stagedReferences[stagedReferenceKey("main-photo", sheetId)] ?? null}
        referenceHint="Optional. A lighting study, a costume plate, a photograph to match. Identity goes first, so this rides only where the model has room for a second image."
        onAttachReference={() => pickStagedReference(world.meta.worldId, stagedReferenceKey("main-photo", sheetId))}
        onClearReference={() => clearStagedReference(world.meta.worldId, stagedReferenceKey("main-photo", sheetId))}
        extra={travelling}
        workflow="main-photo"
        referenceImages={refs.length}
        count={count}
        onCount={setCount}
        choice={choice}
        onChoice={setChoice}
        submitLabel="Generate previews"
        submitDisabled={generating}
        onSubmit={() => {
          setAsking(true);
          generateMainPhoto(world.meta.worldId, sheetId, prompt.trim(), count, refs, {
            ...(model ? { modelId: model.id } : {}),
            ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
          });
        }}
        previews={candidates.slice(-MAX_IMAGE_PREVIEWS).map((candidate, index) => ({
          key: candidate.key,
          path: candidate.path,
          label: `Candidate ${index + 1}`,
        }))}
        generating={generating}
        waitingHint="The selected world look carries as treatment, never subject."
        selected={selected}
        onSelect={setSelected}
        commit={{
          label: acceptance?.status === null ? "Using as main photo…" : "Use as main photo",
          disabled: acceptance?.status === null,
          onCommit: () => {
            if (selectedCandidate) chooseAnchor(world.meta.worldId, sheetId, selectedCandidate.selection);
          },
          note:
            acceptance?.status === "failed"
              ? acceptance.reason
              : "Replacing the main photo makes the current character sheet stale.",
        }}
      />
    </div>
  );
}

/** One gallery tile: a promoted look, or an unreviewed exploration take awaiting its decision. */
export type LookGalleryEntry = {
  key: string;
  path: string;
  label: string;
  /** When it arrived (takes) or was accepted (looks); the gallery's ordering key. */
  at: string;
  look?: CharacterLook;
  take?: Take;
};

/** How many tiles the gallery leads with; the rest stay one press away, never unreachable. */
export const RECENT_LOOKS = 5;

const LOOK_KIND_LABELS: Record<string, string> = {
  costume: "Costume",
  "pose-expression": "Pose / expression",
  "condition-age": "Condition / age",
};

/**
 * The tile caption is the user's own words, not the composed dispatch prompt — the composed
 * one leads with the world style, so every caption would open identically. Kept short enough
 * for the pill; the full text stays available as the tile's title.
 */
function lookTileLabel(prompt: string | undefined, kind: string | undefined): string {
  const text = prompt?.trim();
  if (!text) return LOOK_KIND_LABELS[kind ?? ""] ?? "Exploration";
  return text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text;
}

/**
 * Everything explorable for this character, newest first: promoted looks and every
 * unreviewed look take. Unreviewed takes each cost money and stay promotable, so the read
 * model never drops one — any windowing is the gallery's presentation, not existence.
 * Newest-first also puts fresh arrivals at the front of the grid, in sight, rather than
 * beyond a cut-off.
 */
export function lookGallery(
  kit: ReferenceKit | null | undefined,
  takes: Take[],
  reviews: ReviewDecision[],
  sheetId: string,
): LookGalleryEntry[] {
  const promoted: LookGalleryEntry[] = (kit?.looks ?? []).map((look) => ({
    key: `look:${look.id}`,
    path: `references/${sheetId}/${look.file}`,
    label: lookTileLabel(look.prompt, look.kind),
    at: look.acceptedAt,
    look,
  }));
  const pending: LookGalleryEntry[] = takes
    .filter(
      (take) =>
        take.kind === "look" &&
        take.reference?.sheetId === sheetId &&
        !reviews.some((review) => review.takeId === take.id),
    )
    .map((take) => ({
      key: `take:${take.id}`,
      path: `references/${sheetId}/takes/${take.id}/${take.media}`,
      label: lookTileLabel(
        typeof take.params["lookPrompt"] === "string" ? take.params["lookPrompt"] : take.prompt,
        typeof take.params["lookKind"] === "string" ? take.params["lookKind"] : undefined,
      ),
      at: take.completedAt ?? take.dispatchedAt,
      take,
    }));
  return [...promoted, ...pending].sort((a, b) => b.at.localeCompare(a.at));
}

export function CharacterLooksScreen() {
  const { worldId, sheetId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const { state } = useStore();
  const [kind, setKind] = useState<"costume" | "pose-expression" | "condition-age">("costume");
  const [mode, setMode] = useState<"stay-close" | "push-it">("stay-close");
  const [prompt, setPrompt] = useState("");
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier }>({});
  // Four was hard-coded at the call site while the frame already carried a count — the estimate
  // said four and there was no way to ask for fewer.
  const [count, setCount] = useState(4);
  const [selected, setSelected] = useState<string | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [exploring, setExploring] = useState(false);
  const resultsRef = useRef<HTMLDivElement>(null);
  const exploreRef = useRef<HTMLButtonElement>(null);
  if (!world || !sheet || !sheetId) return null;
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const photo = kit ? mainPhotoFor(kit) : null;
  const chosenModel = shownImageModel(state, choice.modelId);
  const images = lookGallery(kit, world.referenceTakes, world.referenceReviews, sheetId);
  // The window is presentation only: the newest lead, and the rest — money already spent,
  // still promotable — expand in place rather than falling off the end of a slice.
  const visible = showOlder ? images : images.slice(0, RECENT_LOOKS);
  const older = images.length - RECENT_LOOKS;
  const pendingCount = images.reduce((n, image) => n + (image.take !== undefined ? 1 : 0), 0);
  const selectedImage = images.find((image) => image.key === selected);
  const selectedLook = selectedImage?.look;
  const selectedTake = selectedImage?.take;
  return (
    <div data-screen="character-looks">
      <CharacterHeader active="looks" />
      <main className="fy-looks-grid">
        {/*
          The ask is a dialog now (design 66); the gallery is the page.

          The composer used to hold a permanent column beside the results, which made a page whose
          subject is everything this character has spend half its width on the form for adding one
          more. The dialog carries no preview column of its own — `previews` undefined is "this
          offer is answered elsewhere", and elsewhere is the gallery right here, where a look is
          accepted, promoted to main photo, or attached to a production.
        */}
        <section className="fy-looks-composer">
          <div>
            <h2>Explore more looks</h2>
            <p>Optional visual exploration, outside the identity package.</p>
          </div>
          <Button ref={exploreRef} variant="primary" onClick={() => setExploring(true)}>
            Explore more looks
          </Button>
          <p className="fy-looks-composer__note">
            {photo
              ? "Anchored to the accepted main photo, so an exploration is still this character."
              : `${sheet.name} has no accepted main photo yet — a look is explored from one.`}
          </p>
        </section>
        <GenerationDialog
          open={exploring}
          onClose={() => setExploring(false)}
          returnFocus={exploreRef}
          title="Explore more looks"
          lede={`${sheet.name} · optional visual exploration, outside the identity package`}
          promptLabel="Describe the look"
          prompt={prompt}
          onPrompt={setPrompt}
          promptPlaceholder={
            kind === "costume"
              ? "A formal occasion, work clothes, festival dress…"
              : kind === "pose-expression"
                ? "Mid-laugh, guard up, lost in thought…"
                : "Years later, soaked through, after the fight…"
          }
          promptHint="The main photo rides along, so what comes back is still this character wearing your words."
          worldSlug={world.meta.slug}
          reference={world.stagedReferences[stagedReferenceKey("look", sheetId)] ?? null}
          referenceHint="Optional. A garment, a pose, a photograph to work from. The main photo goes first, so this rides only where the model has room for a second image."
          onAttachReference={() => pickStagedReference(world.meta.worldId, stagedReferenceKey("look", sheetId))}
          onClearReference={() => clearStagedReference(world.meta.worldId, stagedReferenceKey("look", sheetId))}
          extra={
            <>
              <div className="fy-gendialog__label">Type</div>
              <div className="fy-look-options">
                {[
                  ["costume", "Costume"],
                  ["pose-expression", "Pose / expression"],
                  ["condition-age", "Condition / age"],
                ].map(([id, label]) => (
                  <button
                    type="button"
                    className={kind === id ? "is-active" : ""}
                    key={id}
                    onClick={() => setKind(id as typeof kind)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="fy-gendialog__label">Direction</div>
              <div className="fy-look-modes">
                <button
                  type="button"
                  className={mode === "stay-close" ? "is-active" : ""}
                  onClick={() => setMode("stay-close")}
                >
                  Stay close
                </button>
                <button
                  type="button"
                  className={mode === "push-it" ? "is-active" : ""}
                  onClick={() => setMode("push-it")}
                >
                  Push it
                </button>
              </div>
            </>
          }
          workflow="character-look"
          referenceImages={1}
          count={count}
          onCount={setCount}
          choice={choice}
          onChoice={setChoice}
          submitLabel="Explore"
          submitDisabled={!photo || !carriesIdentity(chosenModel)}
          {...(!photo
            ? { why: `${sheet.name} has no accepted main photo yet — a look is explored from one.` }
            : !carriesIdentity(chosenModel)
              ? {
                  why: `${chosenModel?.displayName ?? "This model"} accepts no reference images, so the main photo cannot anchor the exploration.`,
                }
              : {})}
          onSubmit={() => {
            generateCharacterLooks(world.meta.worldId, sheetId, kind, mode, prompt.trim(), count, {
              ...(chosenModel ? { modelId: chosenModel.id } : {}),
              ...(choice.tier !== undefined ? { tier: choice.tier } : {}),
            });
            setExploring(false);
          }}
        />
        <section className="fy-looks-results">
          {images.length === 0 ? (
            <div className="fy-mainphoto-dialog__empty">
              <strong>Explore to promote a result</strong>
              <span>Looks remain optional until you accept one.</span>
            </div>
          ) : (
            <>
              <div className="fy-looks-results__grid" ref={resultsRef}>
                {visible.map((image) => (
                  /* The cell, not the choice: selecting a look and saving a copy of one are two
                     controls, and neither may sit inside the other (issue 478). The selected
                     modifier moves out here with the frame, because it is the cell that spans. */
                  <div
                    key={image.key}
                    className={cx("fy-imghost", selected === image.key && "is-selected")}
                  >
                    <button
                      type="button"
                      className={selected === image.key ? "is-selected" : ""}
                      title={image.take?.prompt ?? image.look?.prompt}
                      onClick={() => setSelected(image.key)}
                    >
                      <Portrait worldSlug={world.meta.slug} path={image.path} label={image.label} radius={12} />
                      <span>{image.label}</span>
                    </button>
                    <ImageDownload worldSlug={world.meta.slug} path={image.path} name={image.label} />
                  </div>
                ))}
              </div>
              {older > 0 && (
                <button
                  type="button"
                  className="fy-looks-results__older"
                  onClick={() => setShowOlder(!showOlder)}
                >
                  {showOlder ? `Show the newest ${RECENT_LOOKS}` : `Show ${older} older look${older === 1 ? "" : "s"}`}
                </button>
              )}
            </>
          )}
          <footer>
            {pendingCount > 0 ? (
              /* A control, not an announcement: pressing it selects the freshest arrival —
                 enlarging it and surfacing its Accept — instead of leaving the reader to
                 hunt for what "ready" refers to. */
              <button
                type="button"
                className="fy-looks-results__fresh"
                onClick={() => {
                  const fresh = images.find((image) => image.take !== undefined);
                  if (fresh) setSelected(fresh.key);
                  resultsRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                }}
              >
                {pendingCount} new variation{pendingCount === 1 ? "" : "s"} ready
              </button>
            ) : (
              <span>Looks never carry by default</span>
            )}
            {selectedTake && (
              <Button onClick={() => acceptCharacterLook(world.meta.worldId, sheetId, selectedTake.id)}>
                Accept look
              </Button>
            )}
            {selectedLook && (
              <>
                <Button onClick={() => promoteCharacterLook(world.meta.worldId, sheetId, selectedLook.id)}>
                  Use as main photo
                </Button>
                <select
                  value={
                    selectedLook.attachedTo?.kind === "production"
                      ? `production:${selectedLook.attachedTo.productionId}`
                      : selectedLook.attachedTo?.kind === "scene"
                        ? `scene:${selectedLook.attachedTo.productionId}:${selectedLook.attachedTo.sceneId}`
                        : ""
                  }
                  onChange={(event) => {
                    const [scope, productionId, sceneId] = event.target.value.split(":");
                    attachCharacterLook(
                      world.meta.worldId,
                      sheetId,
                      selectedLook.id,
                      scope === "production" && productionId
                        ? { kind: "production", productionId }
                        : scope === "scene" && productionId && sceneId
                          ? { kind: "scene", productionId, sceneId }
                          : null,
                    );
                  }}
                >
                  <option value="">Not attached</option>
                  {world.productions.map((production) => (
                    <optgroup key={production.meta.id} label={production.meta.title}>
                      <option value={`production:${production.meta.id}`}>Entire production</option>
                      {production.scenes.map((scene) => (
                        <option key={scene.id} value={`scene:${production.meta.id}:${scene.id}`}>
                          Scene {scene.number} · {scene.title}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </>
            )}
          </footer>
        </section>
      </main>
    </div>
  );
}
