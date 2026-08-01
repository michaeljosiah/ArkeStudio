import type { Capability, Readiness } from "@arke-studio/contracts";

/**
 * Startup capability probe (SPEC-005 R-2, D6): capabilities come from the live server's
 * OpenAPI document at `GET /doc`, never from a version string — an existing installation is
 * preferred over the bundled one, so its surface is not ours to assume. A missing optional
 * endpoint disables its feature with a reason; a missing *required* one (the event stream)
 * fails readiness outright, because authoring cannot be observed without it.
 */

export interface ProbeClient {
  req<T>(method: string, path: string): Promise<T>;
}

interface OpenApiDoc {
  paths?: Record<string, unknown>;
  info?: { version?: string };
}

/** Endpoint patterns per capability — legacy and /api/* generations both accepted. */
const CAPABILITY_ENDPOINTS: ReadonlyArray<{ cap: Capability; match: RegExp }> = [
  { cap: "events", match: /^\/(api\/event|global\/event|event)$/ },
  { cap: "permissions", match: /^\/(api\/session\/\*\/permission\/\*\/reply|permission\/\*\/reply)$/ },
  { cap: "models", match: /^\/(api\/model|api\/provider|config\/providers)$/ },
];

const REQUIRED: ReadonlySet<Capability> = new Set<Capability>(["events"]);

function normalizePath(path: string): string {
  return path.replace(/\{[^}]+\}/g, "*");
}

export interface ProbeResult {
  capabilities: Set<Capability>;
  readiness: Readiness;
  /** The server's self-reported version from the OpenAPI info block, when present. */
  serverVersion?: string;
}

export async function probeCapabilities(client: ProbeClient): Promise<ProbeResult> {
  // 1. Health first — the server must be reachable at all.
  let healthy = false;
  for (const path of ["/api/health", "/global/health"]) {
    try {
      await client.req("GET", path);
      healthy = true;
      break;
    } catch {
      /* try the other generation */
    }
  }
  if (!healthy) {
    return { capabilities: new Set(), readiness: { ready: false, reason: "health check failed" } };
  }

  // 2. Enumerate endpoints from the OpenAPI document.
  let doc: OpenApiDoc;
  try {
    doc = await client.req<OpenApiDoc>("GET", "/doc");
  } catch (err) {
    return {
      capabilities: new Set(),
      readiness: {
        ready: false,
        reason: `cannot probe capabilities: /doc unavailable (${err instanceof Error ? err.message : String(err)})`,
      },
    };
  }
  const paths = Object.keys(doc?.paths ?? {}).map(normalizePath);

  const capabilities = new Set<Capability>();
  for (const { cap, match } of CAPABILITY_ENDPOINTS) {
    if (paths.some((p) => match.test(p))) capabilities.add(cap);
  }

  // 3. Required capabilities fail readiness honestly when absent (R-2).
  const missingRequired = [...REQUIRED].filter((c) => !capabilities.has(c));
  if (missingRequired.length > 0) {
    return {
      capabilities,
      readiness: {
        ready: false,
        reason: `missing required capability: ${missingRequired.join(", ")} (no matching endpoint at /doc)`,
      },
      ...(doc.info?.version !== undefined ? { serverVersion: doc.info.version } : {}),
    };
  }

  return {
    capabilities,
    readiness: { ready: true },
    ...(doc.info?.version !== undefined ? { serverVersion: doc.info.version } : {}),
  };
}
