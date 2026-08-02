/**
 * The OpenCode HTTP surface (SPEC-005). One place builds URLs, attaches the directory scope,
 * and extracts human-readable error detail. Adopted from Arke's adapter, including the
 * Windows fix: the `directory` parameter goes on the wire in forward-slash form, because
 * OpenCode ≥1.17.13 validates it with POSIX isAbsolute and 500s on `C:\…` while `C:/…` passes.
 */

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

/** Bounded, human-readable reason from an OpenCode error body. */
export function errorDetailFrom(bodyText: string): string | undefined {
  const text = bodyText.trim();
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { name?: string; data?: { message?: string } };
    const parts = [parsed.name, parsed.data?.message].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    if (parts.length > 0) return parts.join(": ").slice(0, 300);
  } catch {
    /* not JSON */
  }
  return text.slice(0, 200);
}

export interface OpenCodeHttpOptions {
  /** Resolved lazily so the adapter can outlive supervisor restarts on new ports. */
  baseUrl: () => string;
}

export class OpenCodeHttp {
  constructor(private readonly opts: OpenCodeHttpOptions) {}

  url(path: string, directory?: string): string {
    const u = new URL(path, this.opts.baseUrl());
    if (directory !== undefined) {
      u.searchParams.set("directory", directory.replaceAll("\\", "/"));
    }
    return u.toString();
  }

  async req<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { signal?: AbortSignal; directory?: string },
  ): Promise<T> {
    const res = await fetch(this.url(path, init?.directory), {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(init?.signal ? { signal: init.signal } : {}),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new OpenCodeError(method, path, res.status, res.statusText, errorDetailFrom(errText));
    }
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Open the SSE stream. `/global/event` first, and the order is the whole point: all three
   * endpoints accept the connection, so "first one that answers" silently picks a channel that
   * carries almost nothing. Measured against OpenCode 1.18.10 over one turn — /global/event
   * 35 KB with the deltas and the idle, /api/event 2.7 KB with a single update, /event a
   * heartbeat and nothing else. A turn ran and the app never heard about it.
   */
  async openEventStream(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    for (const path of ["/global/event", "/api/event", "/event"]) {
      const res = await fetch(this.url(path), {
        headers: { Accept: "text/event-stream" },
        ...(signal ? { signal } : {}),
      }).catch(() => null);
      if (res?.ok && res.body) return res.body;
    }
    throw new OpenCodeError("GET", "/api/event", 0, "no event stream reachable");
  }
}
