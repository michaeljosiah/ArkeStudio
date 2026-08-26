import { mediaExtension, type ArtifactSidecar } from "@arke-studio/contracts";

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

/** "Open key-art.png — image". Filename and viewer, which is what the name has to carry. */
export function artifactOpenLabel(artifact: Pick<ArtifactSidecar, "file">): string {
  const name = artifact.file.split("/").pop() ?? artifact.file;
  return `Open ${name} — ${VIEWER_LABEL[artifactViewer(artifact)]}`;
}
