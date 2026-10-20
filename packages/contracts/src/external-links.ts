/** Untrusted document links may open web pages, never local files or OS protocol handlers. */
export function externalWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}
