import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { compilationIsStale, designatedCompilation, mainPhotoFor } from "@arke-studio/contracts";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { Button, cx } from "../components/ui.js";
import { formatMicroUsd } from "@arke-studio/contracts";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import {
  acceptCharacterLook,
  acceptCharacterSheet,
  attachCharacterLook,
  chooseAnchor,
  generateCharacterLooks,
  generateCharacterSheet,
  generateMainPhoto,
  importMainPhotoCandidate,
  promoteCharacterLook,
  rejectReferenceTake,
  useStore,
} from "../lib/store.js";

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
  const pendingSheetTake = [...world.referenceTakes]
    .reverse()
    .find(
      (take) =>
        take.kind === "sheet" &&
        take.reference?.sheetId === sheetId &&
        !world.referenceReviews.some((review) => review.takeId === take.id),
    );
  const runningSheet = (state?.app.jobs ?? []).some(
    (job) =>
      job.target.kind === "character-sheet" &&
      job.target.id?.startsWith(`${sheetId}/`) &&
      !["succeeded", "failed", "cancelled"].includes(job.status),
  );
  return (
    <div data-screen="reference-kit">
      <CharacterHeader active="reference" />
      <main className="fy-reference-grid">
        <section className="fy-reference-card">
          <div className="fy-reference-card__image fy-reference-card__image--photo">
            <Portrait
              worldSlug={world.meta.slug}
              path={photo ? `references/${sheetId}/${photo.file}` : ""}
              label={photo ? `${sheet.name} main photo` : "Main photo outstanding"}
              radius={0}
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
            <Portrait
              worldSlug={world.meta.slug}
              path={compilation ? `references/${sheetId}/${compilation.file}` : ""}
              label={compilation ? `${sheet.name} character sheet` : "Character sheet outstanding"}
              radius={0}
            />
            <span className={cx("fy-reference-card__status", stale && "fy-reference-card__status--warn")}>
              {runningSheet
                ? "QUEUED"
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
            <Button disabled={!photo} onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/model-sheet`)}>
              {compilation ? "Regenerate" : "Generate"}
            </Button>
          </div>
          {pendingSheetTake && (
            <div className="fy-reference-candidates">
              <span>One new composite is ready for review.</span>
              <Button
                variant="primary"
                onClick={() =>
                  acceptCharacterSheet(
                    world.meta.worldId,
                    sheetId,
                    `references/${sheetId}/takes/${pendingSheetTake.id}/${pendingSheetTake.media}`,
                  )
                }
              >
                Accept character sheet
              </Button>
              <Button
                variant="ghost"
                onClick={() => rejectReferenceTake(world.meta.worldId, pendingSheetTake.id, "identity")}
              >
                Reject
              </Button>
            </div>
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
  if (!world || !sheet || !sheetId) return null;
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const photo = kit ? mainPhotoFor(kit) : null;
  const model = state?.app.manifest?.models.find((candidate) => candidate.capability === "image");
  const referencesAsText = (model?.accepts.referenceImages ?? 0) === 0;
  const estimate = model
    ? formatMicroUsd(model.pricing.kind === "perImage" ? model.pricing.microUsdPerImage : 0)
    : "cost unavailable";
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
        <div className="fy-sheet-dialog__body">
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
                {model?.displayName ?? "This model"} accepts no reference images. The world look and main-photo
                identity are translated into the prompt before generation.
              </p>
            )}
          </section>
        </div>
        <footer>
          <span>
            {model?.displayName ?? "Image model"} · {estimate}
          </span>
          <span>completes {sheet.name}'s reference set</span>
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/kit`)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!photo}
            onClick={() => {
              generateCharacterSheet(
                world.meta.worldId,
                sheetId,
                override && style.trim() ? style.trim() : undefined,
              );
              navigate(`/w/${worldId}/cast/${sheetId}/kit`);
            }}
          >
            Generate
          </Button>
        </footer>
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
  const [prompt, setPrompt] = useState(
    "A clear, grounded portrait that preserves her salt-worn face, pale grey eyes and wet braids.",
  );
  const [count, setCount] = useState(4);
  const [uploaded, setUploaded] = useState(false);
  const [worldRef, setWorldRef] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
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
    .map((take) => `references/${sheetId}/takes/${take.id}/${take.media}`);
  const candidates = [...(world.referenceCandidates[sheetId] ?? []), ...generatedCandidates].filter(
    (file, index, all) => all.indexOf(file) === index,
  );
  const model = state?.app.manifest?.models.find((candidate) => candidate.capability === "image");
  const canImport = typeof window !== "undefined" && window.arke !== undefined;
  const refs = uploaded && photo ? [`references/${sheetId}/${photo.file}`] : [];
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
              title="Refine with AI"
              onClick={() =>
                setPrompt(
                  "A clear, grounded head-and-shoulders identity portrait of Maren Kest. Preserve her pale grey eyes, salt-worn skin, wet dark braids and weathered storm coat; restrained neutral expression, soft fog depth and one warm practical light; no text or montage.",
                )
              }
            >
              ✦
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
              <div>
                <Portrait
                  worldSlug={world.meta.slug}
                  path={`references/${sheetId}/${photo.file}`}
                  label="Identity reference"
                  radius={10}
                />
                <span>IDENTITY</span>
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
          <div className="fy-mainphoto-dialog__count">
            <span>Previews</span>
            {[1, 2, 3, 4].map((value) => (
              <button
                type="button"
                className={count === value ? "is-active" : ""}
                key={value}
                onClick={() => setCount(value)}
              >
                {value}
              </button>
            ))}
          </div>
          <div className="fy-mainphoto-dialog__generate">
            <span>
              {(model?.accepts.referenceImages ?? 0) === 0
                ? `${model?.displayName ?? "Model"} · look carries as text`
                : "up to 4 previews"}
            </span>
            <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/cast/${sheetId}/kit`)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!prompt.trim()}
              onClick={() => generateMainPhoto(world.meta.worldId, sheetId, prompt.trim(), count, refs)}
            >
              Generate previews
            </Button>
          </div>
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
              {candidates.slice(-4).map((file, index) => (
                <button
                  type="button"
                  key={file}
                  className={selected === file ? "is-selected" : ""}
                  onClick={() => setSelected(file)}
                >
                  <Portrait
                    worldSlug={world.meta.slug}
                    path={file}
                    label={`Candidate ${index + 1}`}
                    radius={12}
                  />
                  <span>{selected === file ? "SELECTED" : `0${index + 1}`}</span>
                </button>
              ))}
            </div>
          )}
          <div className="fy-mainphoto-dialog__commit">
            <span>Replacing the main photo makes the current character sheet stale.</span>
            <Button
              variant="primary"
              disabled={!selected}
              onClick={() => {
                if (selected)
                  chooseAnchor(world.meta.worldId, sheetId, selected.replace(`references/${sheetId}/`, ""));
                navigate(`/w/${worldId}/cast/${sheetId}/kit`);
              }}
            >
              Use as main photo
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
  const [kind, setKind] = useState<"costume" | "pose-expression" | "condition-age">("costume");
  const [mode, setMode] = useState<"stay-close" | "push-it">("stay-close");
  const [prompt, setPrompt] = useState(
    "Formal Ebb Council coat, storm-dark wool, sea-glass clasp and salt at the hem.",
  );
  const [selected, setSelected] = useState<string | null>(null);
  if (!world || !sheet || !sheetId) return null;
  const kit = world.referenceKits.find((candidate) => candidate.sheetId === sheetId);
  const pendingLooks = world.referenceTakes.filter(
    (take) =>
      take.kind === "look" &&
      take.reference?.sheetId === sheetId &&
      !world.referenceReviews.some((review) => review.takeId === take.id),
  );
  const pending = pendingLooks.map((take) => `references/${sheetId}/takes/${take.id}/${take.media}`);
  const images = [...(kit?.looks ?? []).map((look) => `references/${sheetId}/${look.file}`), ...pending];
  const selectedLook = kit?.looks?.find((look) => `references/${sheetId}/${look.file}` === selected);
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
          <div className="fy-looks-composer__foot">
            <span>4 variations · ~4 credits</span>
            <Button
              variant="primary"
              disabled={!prompt.trim()}
              onClick={() =>
                generateCharacterLooks(world.meta.worldId, sheetId, kind, mode, prompt.trim(), 4)
              }
            >
              Explore
            </Button>
          </div>
          <p className="fy-looks-note">Explorations do not automatically join the identity package.</p>
        </section>
        <section className="fy-looks-results">
          {images.length === 0 ? (
            <div className="fy-mainphoto-dialog__empty">
              <strong>Explore to promote a result</strong>
              <span>Looks remain optional until you accept one.</span>
            </div>
          ) : (
            <div className="fy-looks-results__grid">
              {images.slice(-5).map((file, index) => (
                <button
                  type="button"
                  key={file}
                  className={selected === file ? "is-selected" : ""}
                  onClick={() => setSelected(file)}
                >
                  <Portrait worldSlug={world.meta.slug} path={file} label={`Look ${index + 1}`} radius={12} />
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
            <span>{pending.length ? "new variations ready" : "Looks never carry by default"}</span>
            {selected && !selectedLook && (
              <Button
                onClick={() => acceptCharacterLook(world.meta.worldId, sheetId, selected, kind, prompt)}
              >
                Accept look
              </Button>
            )}
            {selectedLook && (
              <>
                <Button onClick={() => promoteCharacterLook(world.meta.worldId, sheetId, selectedLook.id)}>
                  Use as main photo
                </Button>
                <select
                  defaultValue=""
                  onChange={(event) => {
                    const productionId = event.target.value;
                    attachCharacterLook(
                      world.meta.worldId,
                      sheetId,
                      selectedLook.id,
                      productionId ? { kind: "production", productionId } : null,
                    );
                  }}
                >
                  <option value="">Not attached</option>
                  {world.productions.map((production) => (
                    <option key={production.meta.id} value={production.meta.id}>
                      Attach to {production.meta.title}
                    </option>
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
