import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { PrivateSessionDestination, PrivateSessionRequest } from "@arke-studio/contracts";
import { modelEnabled, type WireModel } from "../model-metadata.js";
import { boundedResponseText, OpenCodeV2Http, sameDirectory, type V2Envelope } from "./http.js";
import { localOllamaModelEndpoint } from "./image-input.js";
import { privateControlProof } from "./private-control.js";

interface Pin { sessionId: string; directory: string; agent: string; model: { providerID: string; id: string; variant?: string }; request?: PrivateSessionRequest }
interface State { id?: string; agent?: string; model?: Pin["model"]; location?: { directory?: string } }

function matchesPin(state: State | undefined, pin: Pin): boolean {
  return state?.id === pin.sessionId && state.agent === pin.agent && sameDirectory(state.location?.directory, pin.directory) &&
    state.model?.providerID === pin.model.providerID && state.model.id === pin.model.id && (state.model.variant ?? "default") === (pin.model.variant ?? "default");
}

function canonical(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error("Native route settings exceed their depth bound");
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item, depth + 1)]));
  return value;
}

/** Proves only the measured native Ollama route, including its possible cloud forwarding.
 * A provider label, global catalogue or loopback URL alone never proves local inference.
 * Other native transports remain unqualified rather than borrowing a familiar SDK name. */
export async function privateSessionDestination(http: OpenCodeV2Http, pin: Pin, signal: AbortSignal, waitForCatalogue = false): Promise<PrivateSessionDestination | null> {
  try {
    signal.throwIfAborted();
    const state = await http.reqData<State>("GET", `/api/session/${encodeURIComponent(pin.sessionId)}`, undefined, { signal, responseBytes: 64 * 1024 });
    if (!matchesPin(state, pin)) return null;
    let control: string | null | undefined;
    for (;;) {
      control = await privateControlProof(http, pin.directory, signal, pin.request, pin.request ? "generate" : "primary");
      if (control !== undefined || !waitForCatalogue) break;
      await delay(100, undefined, { signal });
    }
    if (!control) return null;
    let matches: WireModel[];
    for (;;) {
      const envelope = await http.req<V2Envelope<WireModel[]>>("GET", "/api/model", undefined, { location: pin.directory, signal, responseBytes: 1024 ** 2 });
      if (!sameDirectory(envelope?.location?.directory, pin.directory) || !Array.isArray(envelope.data)) return null;
      matches = envelope.data.filter(row => row?.providerID === pin.model.providerID && row.id === pin.model.id);
      if (matches.length || !waitForCatalogue) break;
      await delay(100, undefined, { signal });
    }
    if (matches.length !== 1 || !modelEnabled(matches[0]!)) return null;
    const row = matches[0]!, endpoint = localOllamaModelEndpoint(row);
    if (!endpoint) return null;
    const settings = row.settings as Record<string, unknown>;
    if (Object.keys(settings).some(key => !["baseURL", "apiKey", "provider"].includes(key)) ||
      settings.provider !== undefined && settings.provider !== "ollama" ||
      settings.apiKey !== undefined && (typeof settings.apiKey !== "string" || settings.apiKey.length > 16_384)) return null;
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json",
      ...(typeof settings.apiKey === "string" && settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}) },
      body: JSON.stringify({ model: pin.model.id, verbose: false }), redirect: "error", signal });
    if (!response.ok) { await response.body?.cancel(); return null; }
    const metadata = JSON.parse(await boundedResponseText(response, 1024 ** 2));
    const architecture = metadata?.model_info?.["general.architecture"], remoteHost = metadata?.remote_host, remoteModel = metadata?.remote_model;
    for (const value of [architecture, remoteHost, remoteModel]) if (value !== undefined && (typeof value !== "string" || value.length > 16_384)) return null;
    const remote = !!remoteHost || !!remoteModel;
    if (!remote && !(typeof architecture === "string" && architecture.trim())) return null;
    // Metadata I/O is an async boundary. Re-read the selected route and session afterwards;
    // a settings/model switch during /api/show cannot borrow its earlier local observation.
    const fresh = await http.req<V2Envelope<WireModel[]>>("GET", "/api/model", undefined, { location: pin.directory, signal, responseBytes: 1024 ** 2 });
    if (!sameDirectory(fresh?.location?.directory, pin.directory) || !Array.isArray(fresh.data)) return null;
    const selected = fresh.data.filter(item => item?.providerID === pin.model.providerID && item.id === pin.model.id);
    if (selected.length !== 1 || !modelEnabled(selected[0]!) || JSON.stringify(canonical({ package: selected[0]!.package, settings: selected[0]!.settings })) !== JSON.stringify(canonical({ package: row.package, settings: row.settings }))) return null;
    const confirmed = await http.reqData<State>("GET", `/api/session/${encodeURIComponent(pin.sessionId)}`, undefined, { signal, responseBytes: 64 * 1024 });
    if (!matchesPin(confirmed, pin)) return null;
    if (await privateControlProof(http, pin.directory, signal, pin.request, pin.request ? "generate" : "primary") !== control) return null;
    const route = JSON.stringify(canonical({ directory: pin.directory, agent: pin.agent, model: state.model, package: row.package,
      settings: row.settings, control, architecture: architecture ?? null, remoteHost: remoteHost ?? null, remoteModel: remoteModel ?? null }));
    if (Buffer.byteLength(route) > 256 * 1024) return null;
    signal.throwIfAborted();
    return Object.freeze({ provider: pin.model.providerID, model: `${pin.model.providerID}/${pin.model.id}`, local: !remote,
      identity: createHash("sha256").update(route).digest("hex") });
  } catch { signal.throwIfAborted(); return null; }
}
