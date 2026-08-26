import { useCallback, useEffect, useState } from "react";
import { mediaUrl } from "./media.js";

/**
 * The bytes behind a markdown or text artifact (issue 477).
 *
 * A picture has an `<img>` to fetch it; a document has nothing, which is why the shelf could only
 * ever draw three grey lines where a `.md` was. This reads it over the same confined
 * `/media/<world-slug>/<file>` identity every picture uses — the renderer never holds a
 * filesystem path, and the coordinator serves text out of `artifacts/` and nowhere else.
 *
 * Four outcomes rather than two, because "no text on screen" has four different causes and a
 * viewer that renders an empty box for all of them is the bug this issue is about.
 */
export type ArtifactText =
  | { status: "loading" }
  | { status: "ready"; text: string }
  /** Named `.md` or `.txt`, holding something that is not text. Reported, never rendered. */
  | { status: "binary" }
  | { status: "failed"; reason: string };

/** A NUL — conclusive on its own, since no text file carries one. */
const NUL = 0;
/** U+FFFD, what a decoder leaves behind where the bytes were not UTF-8 after all. */
const REPLACEMENT = 0xfffd;

/**
 * Bytes that are not text, decided after decoding rather than from the name.
 *
 * Replacement characters are the softer signal: a handful can come from a genuinely mis-encoded
 * document that is still worth reading, a page of them means these bytes were never text. One in
 * twenty, with a floor under it, is well clear of both.
 */
function looksBinary(text: string): boolean {
  let replacements = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === NUL) return true;
    if (code === REPLACEMENT) replacements += 1;
  }
  return replacements > 8 && replacements / text.length > 0.05;
}

/**
 * Load one artifact's text. `path` is world-relative (`artifacts/<file>`); null holds off.
 *
 * `retry` refetches with a fresh attempt number on the query string, which the media route
 * ignores — the coordinator splits it off before resolving — so a retry is a real second request
 * rather than the same cached failure handed back.
 */
export function useArtifactText(
  worldSlug: string | undefined,
  path: string | null,
): ArtifactText & { retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ArtifactText>({ status: "loading" });
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!worldSlug || path === null) return;
    const abort = new AbortController();
    setState({ status: "loading" });
    void (async () => {
      try {
        const response = await fetch(`${mediaUrl(worldSlug, path)}?attempt=${attempt}`, {
          signal: abort.signal,
        });
        if (!response.ok) {
          setState({ status: "failed", reason: `the file could not be read (${response.status})` });
          return;
        }
        const text = await response.text();
        setState(looksBinary(text) ? { status: "binary" } : { status: "ready", text });
      } catch {
        // An abort is the viewer closing or the subject changing, and there is nobody left to
        // tell. Anything else is a failure the viewer must name rather than draw an empty box for.
        if (!abort.signal.aborted) setState({ status: "failed", reason: "the file could not be read" });
      }
    })();
    return () => abort.abort();
  }, [worldSlug, path, attempt]);

  return { ...state, retry };
}
