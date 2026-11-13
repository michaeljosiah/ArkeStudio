/**
 * A strict older reader must refuse these bytes even if a later field is malformed. Inspect
 * presence rather than parsing the current schema; deleted effects can survive only in Undo
 * or Redo and still need the same compatibility boundary (SPEC-053 R-21).
 */
export function carriesEditorEffects(raw: string): boolean {
  const carries = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(carries);
    if (value === null || typeof value !== "object") return false;
    const record = value as Record<string, unknown>;
    if (record.kind === "effect" || "effects" in record || "effectClips" in record || "effectProtection" in record) return true;
    return Object.values(record).some(carries);
  };
  try { return carries(JSON.parse(raw)); }
  catch { return false; }
}

/** SPEC-054 R-14: removing the last transition does not remove the history compatibility floor. */
export function carriesEditorTransitions(raw: string): boolean {
  const carries = (value: unknown): boolean => Array.isArray(value) ? value.some(carries) : value !== null && typeof value === "object" &&
    (Object.hasOwn(value, "transitions") || Object.values(value).some(carries));
  try { return carries(JSON.parse(raw)); } catch { return false; }
}

/** Motion and edge fades are strict clip fields; Undo and requests keep them after the clip lets go. */
export function carriesPictureMotion(raw: string): boolean {
  const carries = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(carries);
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    // An effect's own `motion` has a direction and no kind, and its fades are plural: neither is one of these.
    return row.kind === "picture-motion" || row.kind === "picture-fade" || Object.hasOwn(row, "fade") ||
      !!row.motion && typeof row.motion === "object" && "kind" in row.motion || Object.values(row).some(carries);
  };
  try { return carries(JSON.parse(raw)); } catch { return false; }
}

/**
 * SPEC-038 R-43: a sound clip's fades, on a clip, in Undo or Redo, or in a request's commands.
 * Its own field name is what lets this be read from the raw record: a picture's `fade` raises the
 * floor above, and a build at that floor refuses the same field on a sound clip.
 */
export function carriesSoundFade(raw: string): boolean {
  const carries = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(carries);
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return row.kind === "sound-fade" || Object.hasOwn(row, "soundFade") || Object.values(row).some(carries);
  };
  try { return carries(JSON.parse(raw)); } catch { return false; }
}

/** Inspect presence even in history/proposals so older readers never strip newly authored data. */
export function carriesEditorAppearance(raw: string): boolean {
  const carries = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(carries);
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return row.id === "air-particles" || row.property === "seed" || row.boundary === "soft-bounce" || row.boundary === "open-flow" ||
      ["visual", "visualOriginId", "blendMode", "texture", "softness", "depth", "airflow", "particleDeflections", "pictureFamilies"].some(key => Object.hasOwn(row, key)) ||
      !!row.before && !!row.after && typeof row.before === "object" && typeof row.after === "object" && "seed" in row.before && "seed" in row.after && row.before.seed !== row.after.seed ||
      row.kind === "effect-patch" && !!row.patch && typeof row.patch === "object" && Object.hasOwn(row.patch, "seed") || Object.values(row).some(carries);
  };
  try { return carries(JSON.parse(raw)); } catch { return false; }
}

/**
 * SPEC-065 R-27: a text source on a clip, in Undo or Redo, or in a request's commands. Read from
 * the raw record, never through the schema: an older Cut's strict reader refuses these bytes, and
 * a text source this build cannot parse (a hand edit, a later build's shape) is one all the same.
 * No stored record carries a `kind` of `text` for any other reason, and typed words sit under
 * `text` and `label`, so nothing a person types can raise the world.
 */
export function carriesEditorText(raw: string): boolean {
  const carries = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(carries);
    if (!value || typeof value !== "object") return false;
    const row = value as Record<string, unknown>;
    return row.kind === "text" || row.kind === "text-set" || Object.values(row).some(carries);
  };
  try { return carries(JSON.parse(raw)); } catch { return false; }
}
