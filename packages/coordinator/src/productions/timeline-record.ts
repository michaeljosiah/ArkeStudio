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
