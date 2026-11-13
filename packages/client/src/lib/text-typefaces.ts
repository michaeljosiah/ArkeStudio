import { useEffect, useState } from "react";
import { TEXT_TYPEFACE_IDS, type TextTypefaceBytes, type TextTypefaceId } from "@arke-studio/contracts";
import { onTextTypefaces, send } from "./store.js";

/**
 * The Typeface menu draws each name in its own face (turn 277 rule 10, SPEC-065 §2.5), from the
 * files the painter draws with. The client bundles some weights of four of the six and neither EB
 * Garamond nor Cinzel, and bundling them would cost the stylesheet budget about 700 KB, so the six
 * Regular files are asked for once a session, over the window's own socket, the first time the
 * menu opens. No URL carries them, so no credential rides in one and the remote gateway needs no
 * new route. A face whose file did not come, or a window with no FontFace (a test's document),
 * draws its name in the shell's face.
 */

/** The family a face's name is drawn in, once its file is loaded. Never the family the app's own screens use. */
export const textTypefaceFamily = (id: TextTypefaceId): string => `Arke text ${id}`;

let loading: Promise<ReadonlySet<TextTypefaceId>> | null = null;

function askFaces(timeoutMs: number): Promise<TextTypefaceBytes[] | null> {
  const requestId = crypto.randomUUID();
  return new Promise(resolve => {
    const stop = onTextTypefaces(frame => {
      if (frame.requestId !== requestId) return;
      clearTimeout(timer); stop(); resolve(frame.faces);
    });
    const timer = setTimeout(() => { stop(); resolve(null); }, timeoutMs);
    if (!send({ kind: "text-typefaces", requestId })) { clearTimeout(timer); stop(); resolve(null); }
  });
}

/** Loads the six names' faces once; answers the ids whose face is ready. A failed ask may be tried again later. */
export function loadTextTypefaces(): Promise<ReadonlySet<TextTypefaceId>> {
  if (typeof FontFace === "undefined" || typeof document === "undefined" || !document.fonts) return Promise.resolve(new Set());
  loading ??= askFaces(10_000).then(async faces => {
    if (faces === null) { loading = null; return new Set<TextTypefaceId>(); }
    const ready = new Set<TextTypefaceId>();
    await Promise.all(faces.filter(face => TEXT_TYPEFACE_IDS.includes(face.id)).map(async face => {
      try {
        const bytes = Uint8Array.from(atob(face.data), character => character.charCodeAt(0));
        const font = new FontFace(textTypefaceFamily(face.id), bytes);
        await font.load();
        document.fonts.add(font);
        ready.add(face.id);
      } catch { /* That name is drawn in the shell's face; the painter refuses the face by name anyway. */ }
    }));
    return ready;
  });
  return loading;
}

/** The faces ready to draw their own names, asked for when `wanted` first turns true. */
export function useTextTypefaces(wanted: boolean): ReadonlySet<TextTypefaceId> {
  const [ready, setReady] = useState<ReadonlySet<TextTypefaceId>>(() => new Set());
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    void loadTextTypefaces().then(faces => { if (current) setReady(faces); });
    return () => { current = false; };
  }, [wanted]);
  return ready;
}
