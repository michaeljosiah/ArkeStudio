import { useEffect, useState } from "react";
import { ulid, worldImageReferences, type WorldImageReference, type ManifestModel } from "@arke-studio/contracts";
import { browseReferenceImages, pickStagedReference, subscribeReferenceImages, useStore } from "../lib/store.js";
import { ReferencePickerBody, type PickerSource } from "./reference-picker.js";

/** The existing single-image slot, with read-only browsing before the ordinary copy. */
export function StagedReferencePicker({ worldId, referenceKey, onClose, onUpload, model = null }: {
  model?: ManifestModel | null;
  worldId: string; referenceKey: string; onClose: () => void; onUpload: () => void;
}) {
  const { state } = useStore();
  const worlds = state?.worlds ?? [];
  const current = worlds.find(world => world.worldId === worldId);
  const [slug, setSlug] = useState(current?.slug ?? state?.world?.meta.slug ?? "");
  const [images, setImages] = useState<WorldImageReference[]>([]);
  const [status, setStatus] = useState<string | null>("Loading images…");
  useEffect(() => {
    if (!slug || slug === current?.slug) { setStatus(null); return; }
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
  }, [slug, current?.slug]);
  const source = worlds.find(world => world.slug === slug);
  const borrowed = source?.worldId !== worldId;
  const rows: PickerSource[] = (!borrowed && state?.world ? worldImageReferences(state.world) : images).map(image => ({
    key: image.file, kind: "image", name: image.name, imagePath: image.file,
    meta: borrowed ? `${image.role} · from ${source?.name ?? slug}` : image.role,
    group: image.group, durationSec: 0, pick: { source: "world-file", path: image.file },
  }));
  return <ReferencePickerBody key={slug} mode="slot" worldSlug={slug} model={model} budget="model" only="image"
    carried={[]} world={rows} session={[]} note={status ?? "One picture, copied into this world."}
    worldChoices={<label>Browse images <select aria-label="Browse images" value={slug} onChange={event => {
      setImages([]); setSlug(event.target.value);
    }}>
      <option value={current?.slug ?? state?.world?.meta.slug}>This world</option>
      <optgroup label="Other worlds">{worlds.filter(world => world.worldId !== worldId).map(world =>
        <option key={world.worldId} value={world.slug}>{world.name}</option>)}</optgroup>
    </select></label>}
    onChoose={pick => {
      if (pick.source === "world-file") pickStagedReference(worldId, referenceKey, borrowed ? { slug, path: pick.path } : pick.path);
      onClose();
    }} onUpload={onUpload} onClose={onClose} />;
}
