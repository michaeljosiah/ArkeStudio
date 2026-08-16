import { OpenCodeError, errorDetailFrom } from "../http.js";

/**
 * The OpenCode v2 HTTP surface (issue 327 §4–§5). Three things distinguish it from the v1
 * layer and all three were measured against 0.0.0-next-17444:
 *
 * - Every request carries HTTP Basic auth, username `opencode`, password from the server's
 *   own stdout. Requests without it answer 401 — including the event stream.
 * - Location scoping travels as deep-object query encoding, `location[directory]=…`. The v1
 *   `?directory=` form is not an error on v2 — it is silently ignored and the request runs
 *   against the server's own working directory, so callers that scope a request MUST assert
 *   on the echoed `location` in the response envelope.
 * - Responses arrive in a `{ data, location? }` envelope; `reqData` unwraps it and performs
 *   that assertion.
 */

export interface OpenCodeV2HttpOptions {
  /** Resolved lazily so supervisor restarts on new ports keep working. */
  baseUrl: () => string;
  /**
   * The server password, parsed from the launch line by the supervisor. Lazy for the same
   * reason as baseUrl; null means "not learned yet", and requests fail plainly rather than
   * guessing.
   */
  password: () => string | null;
}

/** The `{ data, location }` envelope v2 wraps most JSON responses in. */
export interface V2Envelope<T> {
  data: T;
  location?: { directory?: string };
}

/** Forward-slash form for the wire; v2 echoes native separators back. */
export function wireDirectory(directory: string): string {
  return directory.replaceAll("\\", "/");
}

/**
 * Compare a response's echoed directory against the one requested, separator-insensitively.
 * Case folds only where the filesystem does: on Linux, /worlds/Alpha and /worlds/alpha are
 * different directories, and folding both would pass the wrong-location guard on exactly the
 * silent misdirection it exists to catch.
 */
export function sameDirectory(a: string | undefined, b: string, platform: string = process.platform): boolean {
  if (a === undefined) return false;
  const fold = platform === "win32" || platform === "darwin";
  const norm = (s: string) => {
    const slashed = s.replaceAll("\\", "/").replace(/\/+$/, "");
    return fold ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

/**
 * The v2 auth scheme in one place: Basic, username `opencode`, the launch-line password.
 * The supervisor's health probe and this client must always agree — encoded twice, a pin
 * bump that changes the scheme fixes one copy and leaves the other silently 401ing.
 */
export function v2BasicAuth(password: string): string {
  return "Basic " + Buffer.from(`opencode:${password}`).toString("base64");
}

export class OpenCodeV2Http {
  constructor(private readonly opts: OpenCodeV2HttpOptions) {}

  private authHeader(): string {
    const password = this.opts.password();
    if (password === null) {
      throw new OpenCodeError("AUTH", "(any)", 0, "no server password yet — the launch line has not been parsed");
    }
    return v2BasicAuth(password);
  }

  url(path: string, location?: string): string {
    const u = new URL(path, this.opts.baseUrl());
    // Deep-object encoding, measured from the generated client: location[directory]=<path>.
    if (location !== undefined) u.searchParams.set("location[directory]", wireDirectory(location));
    return u.toString();
  }

  async req<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { signal?: AbortSignal; location?: string },
  ): Promise<T> {
    const res = await fetch(this.url(path, init?.location), {
      method,
      headers: {
        "Content-Type": "application/json",
        authorization: this.authHeader(),
      },
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
   * Request and unwrap the `{ data, location }` envelope. When `location` was sent, the echoed
   * one must match — a mismatch means the server resolved a different directory, which on v2
   * is a silent success against the wrong place (measured; the worst kind of wrong).
   */
  async reqData<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { signal?: AbortSignal; location?: string },
  ): Promise<T> {
    const envelope = await this.req<V2Envelope<T>>(method, path, body, init);
    if (init?.location !== undefined && envelope?.location?.directory !== undefined) {
      if (!sameDirectory(envelope.location.directory, init.location)) {
        throw new OpenCodeError(
          method,
          path,
          200,
          "wrong location",
          `asked for ${wireDirectory(init.location)}, server answered for ${envelope.location.directory}`,
        );
      }
    }
    return envelope === undefined ? (undefined as T) : envelope.data;
  }

  /** Open the authenticated SSE stream. v2 has one channel: /api/event. */
  async openEventStream(signal?: AbortSignal): Promise<{ path: string; body: ReadableStream<Uint8Array> }> {
    // Same port-0 guard as v1: never dial before the supervisor has a child.
    while (new URL(this.opts.baseUrl()).port === "0") {
      if (signal?.aborted) throw new OpenCodeError("GET", "/api/event", 0, "aborted before the harness had a port");
      await new Promise((r) => {
        const t = setTimeout(r, 250);
        (t as { unref?: () => void }).unref?.();
      });
    }
    const res = await fetch(this.url("/api/event"), {
      headers: { Accept: "text/event-stream", authorization: this.authHeader() },
      ...(signal ? { signal } : {}),
    }).catch(() => null);
    if (res?.ok && res.body) return { path: "/api/event", body: res.body };
    throw new OpenCodeError("GET", "/api/event", res?.status ?? 0, "event stream unreachable — retry, do not downgrade");
  }
}
