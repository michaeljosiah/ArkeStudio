/** Browser-only development has no isolated preload. The local terminal supplies a fragment
 * capability; remove it from browser history and remember it only for this tab and endpoint. */
export function devSession(): { port: number; token: string } | null {
  if (typeof window === "undefined" || window.arke) return null;
  const endpoint = (import.meta.env?.VITE_ARKE_WS as string | undefined) ?? "ws://127.0.0.1:8791";
  const key = "arke-dev-session:" + endpoint;
  try {
    const hash = window.location.hash;
    const queryAt = hash.indexOf("?");
    const query = new URLSearchParams(queryAt >= 0 ? hash.slice(queryAt + 1) : "");
    const supplied = query.get("arke-session");
    if (supplied !== null) {
      query.delete("arke-session");
      const cleanHash = hash.slice(0, queryAt) + (query.size ? "?" + query.toString() : "");
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search + cleanHash);
      if (/^[a-f0-9]{64}$/.test(supplied)) window.sessionStorage.setItem(key, supplied);
    }
    const token = window.sessionStorage.getItem(key);
    return token && /^[a-f0-9]{64}$/.test(token) ? { port: Number(new URL(endpoint).port), token } : null;
  } catch { return null; }
}

export function devMediaUrl(url: string): string {
  const session = devSession();
  return session ? url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(session.token) : url;
}
