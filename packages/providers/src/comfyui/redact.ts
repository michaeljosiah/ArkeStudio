import { createHash } from "node:crypto";
import { canonicalJson } from "./recipes.js";

/**
 * Provider-aware capture redaction (SPEC-021 §2.10, R-14). A `/prompt` request IS the graph,
 * a history or queue response can contain it, and payload history persists what it is given —
 * so a graph-shaped value is replaced before persistence by the summary a diagnostic actually
 * needs: digest, node count, byte count. Two digests answer "same graph?" without either graph.
 */

interface GraphSummary {
  comfyui: "graph-redacted";
  graphDigest: string;
  nodeCount: number;
  byteCount: number;
}

/** An API-format prompt graph: an object whose values are nodes carrying `class_type`. */
function looksLikeGraph(value: unknown): value is Record<string, { class_type: string }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.every(
    (node) =>
      node !== null &&
      typeof node === "object" &&
      typeof (node as { class_type?: unknown }).class_type === "string",
  );
}

function summarizeGraph(graph: Record<string, unknown>): GraphSummary {
  const bytes = Buffer.byteLength(JSON.stringify(graph), "utf8");
  return {
    comfyui: "graph-redacted",
    graphDigest: `sha256:${createHash("sha256").update(canonicalJson(graph), "utf8").digest("hex")}`,
    nodeCount: Object.keys(graph).length,
    byteCount: bytes,
  };
}

/** `[number, promptId]` and nothing else — a queue tuple's third element is the whole graph. */
function summarizeQueueList(list: unknown): unknown {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => (Array.isArray(entry) ? [entry[0], entry[1]] : entry));
}

/**
 * One history entry: `prompt` is a tuple whose third element is the graph, and `status` and
 * `outputs` are the parts worth keeping (filenames are what fetch uses; they carry no graph).
 */
function summarizeHistoryEntry(entry: unknown): unknown {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const record = entry as Record<string, unknown>;
  const out: Record<string, unknown> = { ...record };
  const prompt = record["prompt"];
  if (Array.isArray(prompt)) {
    const graph = prompt[2];
    out["prompt"] = looksLikeGraph(graph) ? summarizeGraph(graph) : { comfyui: "prompt-tuple-redacted" };
  }
  return out;
}

/**
 * The redaction, by endpoint shape rather than by exact path — a user-directed engine can live
 * under any origin, so the path's tail is what identifies the surface.
 */
export function redactComfyUiBody(direction: "request" | "response", endpoint: string, body: unknown): unknown {
  if (body === null || typeof body !== "object") return body;
  const path = endpoint.replace(/\/+$/, "");
  if (direction === "request" && path.endsWith("/prompt")) {
    const record = body as Record<string, unknown>;
    const graph = record["prompt"];
    if (looksLikeGraph(graph)) {
      return { ...record, prompt: summarizeGraph(graph) };
    }
    return body;
  }
  if (direction === "response" && /\/history(\/|$)/.test(path)) {
    const record = body as Record<string, unknown>;
    return Object.fromEntries(Object.entries(record).map(([id, entry]) => [id, summarizeHistoryEntry(entry)]));
  }
  if (direction === "response" && path.endsWith("/queue")) {
    const record = body as Record<string, unknown>;
    return {
      ...record,
      queue_running: summarizeQueueList(record["queue_running"]),
      queue_pending: summarizeQueueList(record["queue_pending"]),
    };
  }
  if (direction === "response" && path.endsWith("/object_info")) {
    // Megabytes of node schemas; the record needs only that the probe was answered, and how big.
    return { comfyui: "object-info-summarized", nodeClassCount: Object.keys(body as Record<string, unknown>).length };
  }
  if (direction === "response" && path.endsWith("/prompt")) {
    const record = body as Record<string, unknown>;
    const errors = record["node_errors"];
    if (errors !== null && typeof errors === "object" && Object.keys(errors as object).length > 0) {
      // node_errors carries the offending inputs back verbatim, keyed by node id — both are
      // graph content (R-1). The messages alone are the record, without their node ids.
      const messages = Object.values(errors as Record<string, unknown>).map((detail) => {
        const list = (detail as { errors?: Array<{ message?: unknown }> } | null)?.errors ?? [];
        const first = list.find((e) => typeof e?.message === "string")?.message;
        return typeof first === "string" ? first : "invalid";
      });
      return { ...record, node_errors: { comfyui: "node-errors-summarized", messages } };
    }
    return body;
  }
  return body;
}
