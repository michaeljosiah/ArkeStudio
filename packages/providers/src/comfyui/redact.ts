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
 * A filesystem path reduced to its basename. The engine's own error text quotes the paths it
 * resolved — a missing checkpoint names the full model path — and payload history is displayed
 * and copied, so the name survives and the machine's shape does not.
 */
export function scrubPaths(text: string): string {
  return text
    .replace(/[A-Za-z]:[\\/](?:[^\\/\r\n"']*[\\/])*([^\\/\r\n"']*)/g, "$1")
    .replace(/(?:^|(?<=[\s"'(]))\/(?:[^/\s"']+\/)+([^/\s"']*)/g, "$1");
}

/**
 * What an execution failure is allowed to say. ComfyUI's `execution_error` payload carries
 * `node_id`, `node_type`, a Python `traceback` of absolute engine paths, and `current_inputs` —
 * the failing node's *resolved inputs*, which is a literal graph fragment. Only the message
 * survives, with paths reduced to basenames.
 */
function summarizeStatusMessage(message: unknown): unknown {
  if (!Array.isArray(message)) return { comfyui: "message-redacted" };
  const kind = typeof message[0] === "string" ? message[0] : "message";
  const detail = message[1] as { exception_message?: unknown } | undefined;
  const text =
    detail !== null && typeof detail === "object" && typeof detail.exception_message === "string"
      ? scrubPaths(detail.exception_message).slice(0, 500)
      : undefined;
  return text === undefined ? [kind] : [kind, { exception_message: text }];
}

/**
 * One history entry, built as an ALLOW-LIST rather than a spread-and-patch.
 *
 * A denylist over a third party's response shape is a bet lost the first time upstream adds a
 * field — and this response has three separate graph carriers already: the `prompt` tuple's
 * third element, `status.messages[].current_inputs`, and the node ids keying `outputs` and
 * `meta`. Only what a diagnostic actually needs is copied forward: whether it finished, why it
 * failed in the engine's own words, and which files came back.
 */
function summarizeHistoryEntry(entry: unknown): unknown {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
  const record = entry as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const prompt = record["prompt"];
  if (prompt !== undefined) {
    const graph = Array.isArray(prompt) ? prompt[2] : undefined;
    out["prompt"] = looksLikeGraph(graph) ? summarizeGraph(graph) : { comfyui: "prompt-tuple-redacted" };
  }

  const status = record["status"] as Record<string, unknown> | undefined;
  if (status !== null && typeof status === "object") {
    const messages = status["messages"];
    out["status"] = {
      ...(typeof status["status_str"] === "string" ? { status_str: status["status_str"] } : {}),
      ...(typeof status["completed"] === "boolean" ? { completed: status["completed"] } : {}),
      ...(Array.isArray(messages) ? { messages: messages.slice(0, 20).map(summarizeStatusMessage) } : {}),
    };
  }

  // Filenames are what a diagnostic needs and what fetch used; the node ids keying them are
  // graph structure, so the files are flattened out from under them.
  const outputs = record["outputs"];
  if (outputs !== null && typeof outputs === "object" && !Array.isArray(outputs)) {
    const files: unknown[] = [];
    for (const byNode of Object.values(outputs as Record<string, unknown>)) {
      if (byNode === null || typeof byNode !== "object") continue;
      for (const value of Object.values(byNode as Record<string, unknown>)) {
        if (!Array.isArray(value)) continue;
        for (const item of value) {
          const file = item as { filename?: unknown; type?: unknown } | null;
          if (file !== null && typeof file === "object" && typeof file.filename === "string") {
            files.push({ filename: file.filename, ...(typeof file.type === "string" ? { type: file.type } : {}) });
          }
        }
      }
    }
    out["outputs"] = { comfyui: "outputs-summarized", files: files.slice(0, 100) };
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
