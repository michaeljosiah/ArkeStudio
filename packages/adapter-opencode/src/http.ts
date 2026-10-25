export class OpenCodeError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly statusText: string,
    readonly detail?: string,
  ) {
    super(`OpenCode ${method} ${path} → ${status} ${statusText}${detail ? ` — ${detail}` : ""}`);
    this.name = "OpenCodeError";
  }
}

/** Bounded, human-readable reason from an OpenCode v2 error body. */
export function errorDetailFrom(bodyText: string): string | undefined {
  const text = bodyText.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { _tag?: string; message?: string };
    const parts = [parsed._tag, parsed.message].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (parts.length > 0) return parts.join(": ").slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 200);
}
