import { mediaExtension, orderedShots, type ArtifactSidecar, type WorldBundle } from "@arke-studio/contracts";

/** Advisory uses from the live snapshot. Retirement never depends on this being a history index. */
export function artifactUses(world: WorldBundle, artifact: ArtifactSidecar): string[] {
  const identities = new Set([artifact.id, `artifacts/${artifact.file}`]);
  if (artifact.generation?.source === "character-reference") {
    identities.add(artifact.generation.sourceFile);
    if (artifact.generation.takeId) identities.add(artifact.generation.takeId);
  }
  const cites = (value: unknown, base: string): boolean => {
    if (typeof value === "string") {
      const path = value.replaceAll("\\", "/");
      return identities.has(path) || identities.has(`${base}/${path}`);
    }
    if (Array.isArray(value)) return value.some(item => cites(item, base));
    return value !== null && typeof value === "object" && Object.values(value).some(item => cites(item, base));
  };
  const uses: string[] = [];
  const add = (label: string, value: unknown, base = "") => { if (cites(value, base)) uses.push(label); };
  add("World key art", world.keyArt);
  add("Art direction", world.artDirection);
  add("World bible", world.bible);
  for (const link of artifact.links) uses.push(`Filed against: ${world.sheets.find(sheet => sheet.id === link)?.name ?? world.canon.find(entry => entry.id === link)?.title ?? link}`);
  for (const sheet of world.sheets) add(`${sheet.type}: ${sheet.name}`, sheet);
  for (const entry of world.canon) add(`Canon: ${entry.title}`, entry);
  for (const kit of world.referenceKits) add(`Reference kit: ${world.sheets.find(sheet => sheet.id === kit.sheetId)?.name ?? kit.sheetId}`, kit, `references/${kit.sheetId}`);
  for (const prop of world.props) add(`Prop: ${prop.name}`, prop);
  for (const production of world.productions) {
    const name = production.meta.title;
    add(`${name}: key art`, production.meta);
    add(`${name}: Library`, production.timeline?.status === "ready" ? production.timeline.timeline.library : null);
    if (production.timeline?.status === "ready") for (const track of production.timeline.timeline.tracks) {
      for (const clip of track.clips) add(`${name}: ${track.name} · ${clip.source.label || clip.id} (${clip.id})`, clip);
    }
    add(`${name}: audio and overlays`, production.cut);
    add(`${name}: master track`, production.spine);
    for (const scene of production.scenes) for (const shot of orderedShots(scene)) {
      add(`${name}: ${scene.title} · shot ${shot.id}`, [shot, production.selections[shot.id]]);
    }
    for (const take of production.takes) add(`${name}: take ${take.id}`, take);
  }
  for (const other of world.artifacts) if (other.id !== artifact.id) add(`Artifact: ${other.file}`, other);
  return [...new Set(uses)];
}

/**
 * Which viewer opens an artifact (issue 477).
 *
 * The shelf used to render three shapes — a thumbnail, a play button, and three grey lines for
 * everything else — and clicking any of them did nothing. Opening a file means choosing a
 * renderer for it, and the choice is made here rather than inside the card so the matrix can be
 * read, tested and extended in one place.
 *
 * **The file's own type decides, not the sidecar's `kind`.** `kind` is a declaration made at
 * filing time and it disagrees with the bytes often enough to matter: a `board` is a PNG, a
 * character's `other` upload is an MP4, and a scan filed as a `document` is a PDF. The extension
 * is also exactly what the media route agrees to serve, so choosing by it means the viewer that
 * opens is the viewer whose bytes will actually arrive. `kind` is still shown — as metadata,
 * which is what it is.
 *
 * The extension is the *first* word on the type, never the last. Bytes that will not decode are
 * reported by the element that failed to decode them (see `artifact-viewer.tsx`), so a `.png`
 * holding something else opens the image viewer and then says the image could not be read —
 * rather than being silently re-labelled as some other kind of file.
 */
export type ArtifactViewerKind = "image" | "video" | "audio" | "markdown" | "text" | "pdf" | "details";

/**
 * Extension → viewer. Deliberately the same set the coordinator's media route serves: an entry
 * here with no matching content type there is a viewer that opens onto a 404 every time.
 */
const BY_EXTENSION: Record<string, ArtifactViewerKind> = {
  ".png": "image",
  ".jpg": "image",
  ".jpeg": "image",
  ".webp": "image",
  ".gif": "image",
  ".mp4": "video",
  ".webm": "video",
  ".mp3": "audio",
  ".wav": "audio",
  ".flac": "audio",
  ".md": "markdown",
  ".txt": "text",
  ".pdf": "pdf",
};

/** The viewer this artifact opens in. `details` is the honest answer for a file nothing renders. */
export function artifactViewer(artifact: Pick<ArtifactSidecar, "file">): ArtifactViewerKind {
  return BY_EXTENSION[mediaExtension(artifact.file)] ?? "details";
}

/**
 * Whether the app can fetch these bytes at all.
 *
 * The media route and the desktop save handler answer the same resolver, so a file with no
 * viewer is also a file with no save — and a control that would fail after the click is worse
 * than one that was never offered.
 */
export function artifactIsServable(artifact: Pick<ArtifactSidecar, "file">): boolean {
  return artifactViewer(artifact) !== "details";
}

/** What the open control calls the viewer, for the accessible name on every card. */
const VIEWER_LABEL: Record<ArtifactViewerKind, string> = {
  image: "image",
  video: "video",
  audio: "audio",
  markdown: "markdown",
  text: "text",
  pdf: "PDF",
  details: "details",
};

/** Linked names title the shelf and its viewer; the file remains the download identity (issue 1005). */
export function artifactDisplayName(artifact: ArtifactSidecar, linkName: (link: string, links?: readonly string[]) => string): string {
  const names = artifact.links.map((link) => linkName(link, artifact.links)).filter((name, index) => name !== artifact.links[index]);
  return [...new Set(names)].slice(0, 2).join(" · ") || artifact.file.split("/").pop() || artifact.file;
}

/** The visible name and viewer are also the open button's accessible name. */
export function artifactOpenLabel(artifact: Pick<ArtifactSidecar, "file">, name = artifact.file.split("/").pop() ?? artifact.file): string {
  return `Open ${name} — ${VIEWER_LABEL[artifactViewer(artifact)]}`;
}
