import { useEffect, useState } from "react";
import { ulid, type WorldImageReference, type ManifestModel } from "@arke-studio/contracts";
import { browseReferenceImages, pickStagedReference, subscribeReferenceImages, useStore, type StudioPicture } from "../lib/store.js";
import { PageSheet } from "./page-sheet.js";
import { ReferencePickerBody, type PickerSource } from "./reference-picker.js";

/**
 * This world's pictures, or another world's, for one pick. Read-only until the pick: browsing
 * another world never opens it, and the coordinator checks the chosen picture again before
 * copying it (issue 972).
 */
function WorldPictureBrowser({ worldId, model, title, confirm, note, meta, onPick, onUpload, onClose }: {
  worldId: string;
  /** The model the picture would ride to, when it rides to one; null budgets nothing. */
  model: ManifestModel | null;
  title?: string;
  confirm?: { label: string };
  /** What the foot says once the pictures are in. */
  note?: string;
  meta: (image: WorldImageReference, from: string | null) => string;
  onPick: (picture: StudioPicture, borrowed: boolean) => void;
  onUpload?: () => void;
  onClose: () => void;
}) {
  const { state } = useStore();
  const worlds = state?.worlds ?? [];
  const current = worlds.find(world => world.worldId === worldId);
  const [slug, setSlug] = useState(current?.slug ?? state?.world?.meta.slug ?? "");
  const [images, setImages] = useState<WorldImageReference[]>([]);
  const [status, setStatus] = useState<string | null>("Loading images…");
  useEffect(() => {
    if (!slug) { setStatus(null); return; }
    setImages([]);
    setStatus("Loading images…");
    const requestId = ulid();
    const unsubscribe = subscribeReferenceImages(result => {
      if (result.requestId !== requestId) return;
      setImages(result.images);
      setStatus(result.error ?? (result.images.length ? null : "No images in this world."));
    });
    browseReferenceImages(slug, requestId);
    return unsubscribe;
  }, [slug]);
  const source = worlds.find(world => world.slug === slug);
  const borrowed = source?.worldId !== worldId;
  const rows: PickerSource[] = images.map(image => ({
    key: image.file, kind: "image", name: image.name, imagePath: image.file,
    meta: meta(image, borrowed ? source?.name ?? slug : null),
    group: image.group, durationSec: 0, pick: { source: "world-file", path: image.file },
  }));
  const said = status ?? note;
  return <ReferencePickerBody key={slug} mode="slot" worldSlug={slug} model={model} budget={model === null ? "none" : "model"} only="image"
    {...(title !== undefined ? { title } : {})} {...(confirm !== undefined ? { confirm } : {})} {...(said !== undefined ? { note: said } : {})}
    carried={[]} world={rows} session={[]}
    worldChoices={<label>Browse images <select aria-label="Browse images" value={slug} onChange={event => {
      setImages([]); setSlug(event.target.value);
    }}>
      <option value={current?.slug ?? state?.world?.meta.slug}>This world</option>
      <optgroup label="Other worlds">{worlds.filter(world => world.worldId !== worldId).map(world =>
        <option key={world.worldId} value={world.slug}>{world.name}</option>)}</optgroup>
    </select></label>}
    onChoose={pick => {
      if (pick.source === "world-file") onPick({ slug, path: pick.path }, borrowed);
      onClose();
    }} {...(onUpload !== undefined ? { onUpload } : {})} onClose={onClose} />;
}

/** The existing single-image slot, with read-only browsing before the ordinary copy. */
export function StagedReferencePicker({ worldId, referenceKey, onClose, onUpload, model = null }: {
  model?: ManifestModel | null;
  worldId: string; referenceKey: string; onClose: () => void; onUpload: () => void;
}) {
  return <WorldPictureBrowser worldId={worldId} model={model} note="One picture, copied into this world."
    meta={(image, from) => from === null ? image.role : `${image.role} · from ${from}`}
    onPick={(picture, borrowed) => pickStagedReference(worldId, referenceKey, borrowed ? picture : picture.path)}
    onUpload={onUpload} onClose={onClose} />;
}

/**
 * The same pictures, used as the picture itself rather than as a reference for a generated one
 * (issue 3146): a finished main photo or character sheet that already exists somewhere in the
 * studio. Kept apart from the reference slot on purpose. A reference only steers a generation,
 * and a face that must not change cannot be left to one, so this picker has its own title, is
 * never budgeted against a model, and asks before it acts.
 */
export function StudioPicturePicker({ worldId, title, confirmLabel, onChoose, onUpload, onClose }: {
  worldId: string;
  title: string;
  confirmLabel: string;
  onChoose: (picture: StudioPicture) => void;
  onUpload?: () => void;
  onClose: () => void;
}) {
  return <WorldPictureBrowser worldId={worldId} model={null} title={title} confirm={{ label: confirmLabel }}
    meta={(image, from) => from === null ? image.group : `from ${from}`}
    onPick={(picture) => onChoose(picture)} {...(onUpload !== undefined ? { onUpload } : {})} onClose={onClose} />;
}

/**
 * The picker in a sheet of its own, for a slot that has no dialog to lend it one. Headless: the
 * picker draws its own title and close, and a second head over it would name it twice.
 */
export function StudioPictureSheet(picker: Parameters<typeof StudioPicturePicker>[0]) {
  return (
    <PageSheet open headless title={picker.title} onClose={picker.onClose} className="fy-picture-sheet">
      <StudioPicturePicker {...picker} />
    </PageSheet>
  );
}
