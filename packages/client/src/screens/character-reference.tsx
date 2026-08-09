import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  compilationIsStale,
  designatedCompilation,
  mainPhotoFor,
  type ManifestModel,
  type SizeTier,
  type Sheet,
} from "@arke-studio/contracts";
import { DispatchBar, resolveModel } from "../components/dispatch-bar.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { Button, Callout, cx } from "../components/ui.js";
import { Loading } from "../components/loading.js";
import { ImageDialog } from "../components/image-dialog.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import {
  acceptCharacterLook,
  acceptCharacterSheet,
  attachCharacterLook,
  chooseAnchor,
  clearMainPhotoAcceptance,
  generateCharacterLooks,
  generateCharacterSheet,
  generateMainPhoto,
  importMainPhotoCandidate,
  promoteCharacterLook,
  rejectReferenceTake,
  subscribeQueueResults,
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

export function CharacterReferenceScreen() {
  const { worldId, sheetId } = useParams();
  const navigate = useNavigate();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const { state } = useStore();
  if (!world || !sheet || !sheetId) return null;
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
  const latestSheetJob = [...(state?.app.jobs ?? [])]
    .filter(
      (job) =>
        job.target.kind === "character-sheet" &&
        job.target.id?.startsWith(`${sheetId}/`),
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const sheetFinalization = latestSheetJob?.finalization?.status !== "complete" ? latestSheetJob?.finalization : undefined;
  const runningSheet = latestSheetJob
    ? !["succeeded", "failed", "cancelled"].includes(latestSheetJob.status) ||
      latestSheetJob.finalization?.status === "pending"
    : false;
  const reviewTake = pendingSheetTakes[0] ?? null;
  const sheetPath = reviewTake
    ? `references/${sheetId}/takes/${reviewTake.id}/${reviewTake.media}`
    : compilation
      ? `references/${sheetId}/${compilation.file}`
      : null;
  return (
    <div data-screen="reference-kit">
      <CharacterHeader active="reference" />
      <main className="fy-reference-grid">
        <section className="fy-reference-card">
          <div className="fy-reference-card__image fy-reference-card__image--photo">
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
            <Button onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/main-photo`)}>
              {photo ? "Replace" : "Create"}
            </Button>
          </div>
        </section>
        <section className="fy-reference-card">
          <div className="fy-reference-card__image fy-reference-card__image--sheet">
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
            <span className={cx("fy-reference-card__status", stale && !reviewTake && "fy-reference-card__status--warn")}>
              {runningSheet
                ? "GENERATING"
                : reviewTake
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
            <Button disabled={!photo || runningSheet} onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/model-sheet`)}>
              {runningSheet ? "Generating" : compilation ? "Regenerate" : "Generate"}
            </Button>
          </div>
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
  const [override, setOverride] = useState(false);
  const [style, setStyle] = useState("");
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier }>({});
  const [requested, setRequested] = useState(false);
  const [dispatchError, setDispatchError] = useState<string | null>(null);
  const earlierTakeIds = useRef(new Set<string>());
  const pendingRequestId = useRef<string | null>(null);
  useEffect(
    () =>
      subscribeQueueResults((result) => {
        if (result.requestId !== pendingRequestId.current || result.acceptedJobIds.length > 0) return;
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
  const pendingSheetTakes = world.referenceTakes
    .filter(
      (take) =>
        take.kind === "sheet" &&
        take.reference?.sheetId === sheetId &&
        !world.referenceReviews.some((review) => review.takeId === take.id),
    )
    .sort((a, b) => (b.completedAt ?? b.dispatchedAt).localeCompare(a.completedAt ?? a.dispatchedAt));
  const generatedTake = requested
    ? pendingSheetTakes.find((take) => !earlierTakeIds.current.has(take.id)) ?? null
    : null;
  const generatedPath = generatedTake
    ? `references/${sheetId}/takes/${generatedTake.id}/${generatedTake.media}`
    : null;
  return (
    <div className="fy-generation-scrim" data-screen="model-sheet-generate">
      <div className="fy-sheet-dialog">
        <header>
          <div>
            <h1>Generate character sheet</h1>
            <p>{sheet.name} · one composite identity reference</p>
          </div>
          <button type="button" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/kit`)}>
            ×
          </button>
        </header>
        {requested ? (
          <div className="fy-sheet-dialog__result">
            {dispatchError ? (
              <div className="fy-sheet-dialog__result-message">
                <strong>Couldn’t start generation</strong>
                <p>{dispatchError}</p>
                <Button variant="primary" onClick={() => setRequested(false)}>Back to generation settings</Button>
              </div>
            ) : generatedPath && generatedTake ? (
              <>
                <div className="fy-sheet-dialog__generated-image">
                  <CharacterSheetPreview worldSlug={world.meta.slug} path={generatedPath} characterName={sheet.name} />
                </div>
                <div className="fy-sheet-dialog__result-actions">
                  <div>
                    <strong>Your character sheet is ready</strong>
                    <p>Open it for a larger view, then accept it into {sheet.name}’s reference set.</p>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => {
                      rejectReferenceTake(world.meta.worldId, generatedTake.id, "identity");
                      navigate(`/w/${worldId}/cast/${sheetId}/kit`);
                    }}
                  >
                    Reject
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => {
                      acceptCharacterSheet(world.meta.worldId, sheetId, generatedTake.id);
                      navigate(`/w/${worldId}/cast/${sheetId}/kit`);
                    }}
                  >
                    Accept this sheet
                  </Button>
                </div>
              </>
            ) : (
              <div className="fy-sheet-dialog__result-message">
                <Loading label={`Generating character sheet for ${sheet.name}`} size={56} />
                <p>You can wait here or leave this page. We’ll notify you when it is ready.</p>
                <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/kit`)}>Leave page</Button>
              </div>
            )}
          </div>
        ) : <div className="fy-sheet-dialog__body">
          <section className="fy-sheet-dialog__identity">
            <div>
              <Portrait
                worldSlug={world.meta.slug}
                path={photo ? `references/${sheetId}/${photo.file}` : ""}
                label="Accepted main photo required"
                radius={12}
              />
            </div>
            <strong>Main photo</strong>
            <span>identity source · accepted</span>
          </section>
          <section className="fy-sheet-dialog__spec">
            <div className="fy-sheet-dialog__label">WHAT ARRIVES</div>
            <div className="fy-sheet-dialog__layout">
              <div className="fy-sheet-layout-sample">
                <i />
                <i />
                <i />
                <i />
              </div>
              <div>
                <h2>Character sheet</h2>
                <p>turnaround + expressions + details in one image</p>
              </div>
            </div>
            <div className="fy-sheet-dialog__line" />
            <div className="fy-sheet-dialog__stylehead">
              <span>ART DIRECTION</span>
              <button type="button" onClick={() => setOverride(!override)}>
                Override
              </button>
            </div>
            <div className="fy-sheet-dialog__worldlook">
              <span>
                <Portrait
                  worldSlug={world.meta.slug}
                  path={world.artDirection.masterLook ?? "world-art.png"}
                  label="World look"
                  radius={8}
                />
              </span>
              <div>
                <strong>World look · v{world.artDirection.version}</strong>
                <p>inherited from this world</p>
              </div>
            </div>
            {override && (
              <textarea
                value={style}
                onChange={(event) => setStyle(event.target.value)}
                placeholder="Override this generation only"
              />
            )}
            <div className="fy-sheet-dialog__summary">
              <span>Identity</span>
              <strong>Main photo</strong>
              <span>Style</span>
              <strong>
                {override && style ? "Generation override" : `World look v${world.artDirection.version}`}
              </strong>
            </div>
            {referencesAsText && (
              <p className="fy-reference-fallback">
                {chosenModel?.displayName ?? "This model"} accepts no reference images. The main photo cannot be sent;
                identity relies on the character traits carried in the prompt.
              </p>
            )}
          </section>
        </div>}
        {!requested && <footer>
          <span className="fy-sheetgen__purpose">completes {sheet.name}&apos;s reference set</span>
          <DispatchBar
            workflow="character-sheet"
            referenceImages={1}
            choice={choice}
            onChoice={setChoice}
            onCancel={() => navigate(`/w/${worldId}/cast/${sheetId}/kit`)}
            primaryLabel="Generate"
            primaryDisabled={!photo || !carriesIdentity(chosenModel)}
            onPrimary={(chosen) => {
              earlierTakeIds.current = new Set(pendingSheetTakes.map((take) => take.id));
              const requestId = generateCharacterSheet(
                world.meta.worldId,
                sheetId,
                override && style.trim() ? style.trim() : undefined,
                sheet.name,
                {
                  modelId: chosen.model.id,
                  ...(chosen.tier !== undefined ? { tier: chosen.tier } : {}),
                },
              );
              if (requestId) {
                pendingRequestId.current = requestId;
                setDispatchError(null);
                setRequested(true);
              } else {
                setDispatchError("The studio is disconnected. Reconnect and try again.");
                setRequested(true);
              }
            }}
          />
        </footer>}
      </div>
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
  const [uploaded, setUploaded] = useState(false);
  const [worldRef, setWorldRef] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    setPrompt(mainPhotoPromptFor(sheet));
  }, [sheet?.id]);

  useEffect(() => {
    if (acceptance?.status === "accepted" && sheetId) {
      clearMainPhotoAcceptance(sheetId);
      navigate(`/w/${worldId}/cast/${sheetId}/kit`);
    }
  }, [acceptance?.status, navigate, sheetId, worldId]);

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
  // The chosen model decides what can travel, so it decides what this screen shows travelling.
  // A silent downgrade from image identity to text description is the failure the bar exists to
  // prevent, and it has to be visible where the references are, not only in the bar's own line.
  const model = shownImageModel(state, choice.modelId);
  const carriesReferences = model !== null && model.unverified !== true && model.accepts.referenceImages > 0;
  const canImport = typeof window !== "undefined" && window.arke !== undefined;
  const refs = uploaded && photo && carriesReferences ? [`references/${sheetId}/${photo.file}`] : [];
  return (
    <div className="fy-mainphoto-scrim" data-screen="replace-main-photo">
      <div className="fy-mainphoto-dialog">
        <section className="fy-mainphoto-dialog__composer">
          <div className="fy-mainphoto-dialog__title">
            <div>
              <h1>Replace main photo</h1>
              <p>{sheet.name} · the accepted identity anchor</p>
            </div>
            <span>World look · v{world.artDirection.version}</span>
          </div>
          <label>Describe the portrait</label>
          <div className="fy-mainphoto-dialog__prompt">
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
            <button
              type="button"
              title="Reset from character sheet"
              onClick={() => setPrompt(mainPhotoPromptFor(sheet))}
            >
              Reset
            </button>
          </div>
          <div className="fy-mainphoto-dialog__refbuttons">
            <Button
              disabled={!canImport}
              title={canImport ? "Choose an image from this computer" : "Upload is available in the desktop app"}
              onClick={() => {
                importMainPhotoCandidate(world.meta.worldId, sheetId);
                setUploaded(true);
              }}
            >
              Upload reference
            </Button>
            <Button onClick={() => setWorldRef(!worldRef)}>Choose from world</Button>
          </div>
          <div className="fy-mainphoto-dialog__refs">
            {uploaded && photo && (
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
                  path="world-art.png"
                  label="Style reference"
                  radius={10}
                />
                <span>STYLE · TEXT FALLBACK</span>
              </div>
            )}
          </div>
          {uploaded && !carriesReferences && model && (
            <Callout tone="warning" title={`${model.displayName} accepts no reference images`}>
              {sheet.name}&apos;s main photo will not ride along. The generation sees the written
              description and the world look as text, and nothing of the face.
            </Callout>
          )}
          <DispatchBar
            workflow="main-photo"
            count={count}
            onCount={setCount}
            referenceImages={refs.length}
            choice={choice}
            onChoice={setChoice}
            onCancel={() => navigate(`/w/${worldId}/cast/${sheetId}/kit`)}
            primaryLabel="Generate previews"
            primaryDisabled={!prompt.trim()}
            onPrimary={(chosen) =>
              generateMainPhoto(world.meta.worldId, sheetId, prompt.trim(), count, refs, {
                modelId: chosen.model.id,
                ...(chosen.tier !== undefined ? { tier: chosen.tier } : {}),
              })
            }
          />
        </section>
        <section className="fy-mainphoto-dialog__results">
          <header>
            <span>PREVIEWS</span>
            <strong>{candidates.length ? "ready" : "waiting"}</strong>
          </header>
          {candidates.length === 0 ? (
            <div className="fy-mainphoto-dialog__empty">
              <strong>Ready when you are</strong>
              <span>The selected world look carries as treatment, never subject.</span>
            </div>
          ) : (
            <div className="fy-mainphoto-dialog__grid">
              {candidates.slice(-4).map((candidate, index) => (
                <button
                  type="button"
                  key={candidate.key}
                  className={selected === candidate.key ? "is-selected" : ""}
                  onClick={() => setSelected(candidate.key)}
                >
                  <Portrait
                    worldSlug={world.meta.slug}
                    path={candidate.path}
                    label={`Candidate ${index + 1}`}
                    radius={12}
                  />
                  <span>{selected === candidate.key ? "SELECTED" : `0${index + 1}`}</span>
                </button>
              ))}
            </div>
          )}
          <div className="fy-mainphoto-dialog__commit">
            <span>
              {acceptance?.status === "failed"
                ? acceptance.reason
                : "Replacing the main photo makes the current character sheet stale."}
            </span>
            <Button
              variant="primary"
              disabled={!selectedCandidate || acceptance?.status === null}
              onClick={() => {
                if (selectedCandidate) chooseAnchor(world.meta.worldId, sheetId, selectedCandidate.selection);
              }}
            >
              {acceptance?.status === null ? "Using as main photo…" : "Use as main photo"}
            </Button>
          </div>
        </section>
      </div>
    </div>
  );
}

export function CharacterLooksScreen() {
  const { worldId, sheetId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const { state } = useStore();
  const [kind, setKind] = useState<"costume" | "pose-expression" | "condition-age">("costume");
  const [mode, setMode] = useState<"stay-close" | "push-it">("stay-close");
  const [prompt, setPrompt] = useState(
    "Formal Ebb Council coat, storm-dark wool, sea-glass clasp and salt at the hem.",
  );
  const navigate = useNavigate();
  const [choice, setChoice] = useState<{ modelId?: string; tier?: SizeTier }>({});
  // Four was hard-coded at the call site while the frame already carried a count — the estimate
  // said four and there was no way to ask for fewer.
  const [count, setCount] = useState(4);
  const [selected, setSelected] = useState<string | null>(null);
  if (!world || !sheet || !sheetId) return null;
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const photo = kit ? mainPhotoFor(kit) : null;
  const chosenModel = shownImageModel(state, choice.modelId);
  const pendingLooks = world.referenceTakes.filter(
    (take) =>
      take.kind === "look" &&
      take.reference?.sheetId === sheetId &&
      !world.referenceReviews.some((review) => review.takeId === take.id),
  );
  const sortedPendingLooks = [...pendingLooks].sort((a, b) =>
    (a.completedAt ?? a.dispatchedAt).localeCompare(b.completedAt ?? b.dispatchedAt),
  );
  const images = [
    ...(kit?.looks ?? []).map((look) => ({
      key: `look:${look.id}`,
      path: `references/${sheetId}/${look.file}`,
      look,
    })),
    ...sortedPendingLooks.map((take) => ({
      key: `take:${take.id}`,
      path: `references/${sheetId}/takes/${take.id}/${take.media}`,
      take,
    })),
  ];
  const selectedImage = images.find((image) => image.key === selected);
  const selectedLook = selectedImage && "look" in selectedImage ? selectedImage.look : undefined;
  const selectedTake = selectedImage && "take" in selectedImage ? selectedImage.take : undefined;
  return (
    <div data-screen="character-looks">
      <CharacterHeader active="looks" />
      <main className="fy-looks-grid">
        <section className="fy-looks-composer">
          <div>
            <h2>Explore more looks</h2>
            <p>Optional visual exploration, outside the identity package.</p>
          </div>
          <label>TYPE</label>
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
          <label>DIRECTION</label>
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
          <label>Describe the look</label>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          <DispatchBar
            workflow="character-look"
            count={count}
            onCount={setCount}
            referenceImages={1}
            choice={choice}
            onChoice={setChoice}
            onCancel={() => navigate(`/w/${worldId}/cast/${sheetId}/kit`)}
            primaryLabel="Explore"
            primaryDisabled={!prompt.trim() || !photo || !carriesIdentity(chosenModel)}
            onPrimary={(chosen) =>
              generateCharacterLooks(world.meta.worldId, sheetId, kind, mode, prompt.trim(), chosen.count ?? count, {
                modelId: chosen.model.id,
                ...(chosen.tier !== undefined ? { tier: chosen.tier } : {}),
              })
            }
          />
        </section>
        <section className="fy-looks-results">
          {images.length === 0 ? (
            <div className="fy-mainphoto-dialog__empty">
              <strong>Explore to promote a result</strong>
              <span>Looks remain optional until you accept one.</span>
            </div>
          ) : (
            <div className="fy-looks-results__grid">
              {images.slice(-5).map((image, index) => (
                <button
                  type="button"
                  key={image.key}
                  className={selected === image.key ? "is-selected" : ""}
                  onClick={() => setSelected(image.key)}
                >
                  <Portrait worldSlug={world.meta.slug} path={image.path} label={`Look ${index + 1}`} radius={12} />
                  <span>
                    {
                      [
                        "Council coat",
                        "Calling the tide",
                        "Twenty years later",
                        "Dry dock clothes",
                        "After the third verse",
                      ][index]
                    }
                  </span>
                </button>
              ))}
            </div>
          )}
          <footer>
            <span>{sortedPendingLooks.length ? "new variations ready" : "Looks never carry by default"}</span>
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
