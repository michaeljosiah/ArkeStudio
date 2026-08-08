import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CapabilityProbe, ClientDeclarations } from "@arke-studio/contracts";
import { SHIPPED_MANIFEST } from "../manifest-data.js";
import {
  ProviderAuthError,
  type CommandRunner,
  type FetchedArtifact,
  type FetchLike,
  type PollResult,
  type PreparedImageReference,
  type ProviderClient,
  type SubmitRequest,
  type SubmitResult,
} from "../types.js";

/**
 * Higgsfield — driven as a subprocess, not over HTTP (issue #137). The published API and the
 * client written against it disagreed on every path and on the auth scheme; rather than guess
 * at the HTTP surface again, this drives `higgsfield`, the vendor's own CLI, which is the
 * interface they document and keep working.
 *
 * The consequence that shapes everything here: **there is no credential of ours**. The CLI
 * authenticates with OAuth 2.0 PKCE over a loopback callback and holds its own token, so the
 * `key` every method takes is empty and unused. Sign-in state is a probe, not a file read.
 *
 * Declarations (T-9): no idempotency key, no lookup, and — despite `generate list` existing —
 * no usable listing either. The listing carries nothing we supplied, so reconciliation cannot
 * match a row to a job; SPEC-009's Strategy B needs an idempotency key to compare against and
 * would find none. Declaring `supportsListRecent` here would make `reconcileStrategy` report
 * `list-recent` while the dispatcher stayed on ask-the-user — a lie in the data. So: all false,
 * an interrupted submission asks the user, and no cost figure is reported (R-17).
 */

/** Seconds → the word a route wants for that length, from the shipped rows. */
const DURATIONS = new Map(
  SHIPPED_MANIFEST.models
    .filter((model) => model.provider === "higgsfield" && model.limits.durations !== undefined)
    .map((model) => [model.id, model.limits.durations!]),
);

/**
 * Params the coordinator carries for its own bookkeeping. They are not Higgsfield's, and the
 * CLI rejects a flag it does not declare, so they are dropped before the argument list is
 * built. `durationSec` is ours too: the length goes as `--duration`, in the route's vocabulary.
 */
const INTERNAL_PARAMS = new Set([
  "references",
  "referenceRoles",
  "artDirection",
  "provenance",
  "lookKind",
  "lookPrompt",
  "shotPlan",
  "durationSec",
  "output",
]);

/**
 * Which flag carries the size tier, per route. Most take `--resolution`; Soul takes
 * `--quality` for the same idea, and sending it `--resolution` would be an undeclared flag the
 * CLI rejects. The manifest's `tiers` already holds the provider's own *word* for each tier —
 * this holds the provider's own *name for the field*, which is the other half of the same
 * translation and the only part that varies by route.
 */
const SIZE_FLAG = new Map<string, string>([["text2image_soul_v2", "quality"]]);

/** The CLI says so itself: "tokens are short-lived. Re-run `higgsfield auth login`." */
function looksUnauthenticated(message: string): boolean {
  return /not authenticated|session expired|unauthori[sz]ed|auth login|401|403/i.test(message);
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
}

function extensionFor(contentType: string): string {
  const type = contentType.toLowerCase().split(";", 1)[0];
  if (type === "image/jpeg") return "jpg";
  if (type === "image/webp") return "webp";
  if (type === "image/png") return "png";
  if (type === "video/mp4") return "mp4";
  return "bin";
}

function extensionForReference(reference: PreparedImageReference): string {
  return extensionFor(reference.contentType);
}

/** One job as `generate create|get|list` reports it. Only the fields we act on are named. */
interface HiggsfieldJob {
  id?: string;
  status?: string;
  job_type?: string;
  result_url?: string;
  created_at?: string;
}

export class HiggsfieldClient implements ProviderClient {
  readonly id = "higgsfield" as const;
  readonly declarations: ClientDeclarations = {
    supportsIdempotencyKey: false,
    supportsLookupByKey: false,
    supportsListRecent: false,
    reportsCost: false,
  };

  constructor(
    private readonly run: CommandRunner,
    /** Results are URLs; the bytes still come over HTTP. */
    private readonly fetchImpl: FetchLike,
  ) {}

  /**
   * One CLI call, JSON in hand. `--no-color` because ANSI escapes would land in the parse and
   * in anything that later logs this; `--json` because the human tables are not a contract.
   */
  private async json(operation: string, args: readonly string[]): Promise<unknown> {
    const result = await this.run([...args, "--json", "--no-color"]);
    if (result.code !== 0) {
      const message = firstLine(result.stderr) || firstLine(result.stdout) || `exited ${result.code}`;
      // A signed-out CLI is a provider fault, never a work failure (R-4): the remedy is to sign
      // in, not to retry the shot.
      if (looksUnauthenticated(message)) throw new ProviderAuthError(this.id, `higgsfield: ${message}`);
      throw new Error(`higgsfield: ${operation} failed — ${message}`);
    }
    const text = result.stdout.trim();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`higgsfield: ${operation} returned output that is not JSON — ${firstLine(text)}`);
    }
  }

  /**
   * What the signed-in account can actually do (R-3, D5). `account status` is the free probe
   * §2.4 asks for: it proves authentication and reports the credit balance without generating
   * anything. `auth token` would also prove it, but it prints the live token to stdout, and a
   * probe that handles a secret is a probe that can leak one.
   */
  async validateKey(_key: string): Promise<CapabilityProbe[]> {
    const unavailable = (reason: string): CapabilityProbe[] => [
      { capability: "image", available: false, reason },
      { capability: "video", available: false, reason },
    ];
    let body: unknown;
    try {
      body = await this.json("account status", ["account", "status"]);
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        return unavailable("the Higgsfield CLI is not signed in — run `higgsfield auth login`");
      }
      return unavailable(err instanceof Error ? err.message : String(err));
    }
    const credits = (body as { credits?: unknown } | null)?.credits;
    // A key that authenticates and cannot pay is exactly the case R-3 exists for: say it here,
    // not at the end of composing a scene.
    if (typeof credits === "number" && credits <= 0) {
      return unavailable("this Higgsfield account has no credit left");
    }
    return [
      { capability: "image", available: true },
      { capability: "video", available: true },
    ];
  }

  /**
   * The length flag as this route wants it, or nothing when the row declares no lengths — the
   * provider's default is the honest answer there, and the estimate was computed the same way.
   */
  private durationArgs(model: string, params: Record<string, unknown>): string[] {
    const seconds = params["durationSec"];
    if (typeof seconds !== "number") return [];
    const declared = DURATIONS.get(model);
    if (declared === undefined) return [];
    const wire = declared[String(seconds)];
    if (wire === undefined) {
      // Refused, not dropped: sending nothing runs the provider's default length while the
      // estimate was computed from the seconds the job carries.
      throw new Error(
        `higgsfield: ${model} cannot be asked for ${seconds}s — it offers ${Object.keys(declared).join(", ")}s`,
      );
    }
    return ["--duration", wire];
  }

  async submit(_key: string, request: SubmitRequest): Promise<SubmitResult> {
    const durable = request.params["references"];
    const withReferences = Array.isArray(durable) && durable.length > 0;
    const prepared = request.imageReferences ?? [];
    // The durable list is what the job promised; the prepared list is what resolved to bytes.
    // Submitting the remainder would quietly generate against a smaller set than was priced.
    if (withReferences && prepared.length !== durable.length) {
      throw new Error("higgsfield: not every image reference was prepared");
    }

    const size = request.params["output"] as { aspect?: unknown; resolution?: unknown } | undefined;
    const args = [
      "generate",
      "create",
      request.model,
      ...Object.entries(request.params)
        .filter(([key]) => !INTERNAL_PARAMS.has(key))
        .flatMap(([key, value]) => (value === undefined || value === null ? [] : [`--${key}`, String(value)])),
      ...this.durationArgs(request.model, request.params),
      ...(request.capability === "image" && typeof size?.aspect === "string"
        ? ["--aspect_ratio", size.aspect]
        : []),
      ...(request.capability === "image" && typeof size?.resolution === "string"
        ? [`--${SIZE_FLAG.get(request.model) ?? "resolution"}`, size.resolution]
        : []),
    ];

    // The CLI takes media as a UUID or a local path and uploads paths itself, so references
    // reach it as files. They are ephemeral verified bytes (never journalled), so the directory
    // is temporary and removed on every exit from here, submitted or not.
    const dir = withReferences ? await mkdtemp(join(tmpdir(), "arke-higgsfield-")) : null;
    try {
      if (dir !== null) {
        for (const [index, reference] of prepared.entries()) {
          const file = join(dir, `reference-${index + 1}.${extensionForReference(reference)}`);
          await writeFile(file, reference.data);
          args.push("--image-references", file);
        }
      }
      const body = await this.json("submit", args);
      // A single create returns one job; the CLI wraps batches in an array.
      const job = (Array.isArray(body) ? body[0] : body) as HiggsfieldJob | null;
      const jobId = job?.id;
      if (typeof jobId !== "string" || jobId.length === 0) {
        throw new Error("higgsfield: submit returned no job id");
      }
      return { remoteId: jobId, acceptedAt: new Date().toISOString() };
    } finally {
      if (dir !== null) await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async poll(_key: string, remoteId: string): Promise<PollResult> {
    const body = await this.json("status read", ["generate", "get", remoteId]);
    const remote = (body as HiggsfieldJob | null)?.status ?? "unknown";
    switch (remote) {
      case "completed":
      case "succeeded":
        return { state: "succeeded" };
      case "queued":
      case "pending":
        return { state: "queued" };
      case "in_progress":
      case "processing":
      case "running":
      case "started":
        return { state: "running" };
      case "canceled":
      case "cancelled":
        return { state: "cancelled" };
      case "failed":
      case "error":
      case "rejected":
      case "nsfw":
        return { state: "failed", error: `higgsfield: status "${remote}"` };
      default:
        // Loud, like fal's: an unrecognised value is named rather than watched forever. Only
        // "completed" has been seen against a live account, so a miss here should read as a
        // legible failure with the provider's own word in it.
        return { state: "failed", error: `higgsfield: unexpected status "${remote}"` };
    }
  }

  async fetchArtifacts(_key: string, remoteId: string): Promise<FetchedArtifact[]> {
    const body = await this.json("result fetch", ["generate", "get", remoteId]);
    const job = body as (HiggsfieldJob & { result_url?: string }) | null;
    const url = job?.result_url;
    // `min_result_url` is deliberately ignored: it is a webp thumbnail of the result, not the
    // result, and filing it would land a preview where the take should be.
    if (typeof url !== "string" || url.length === 0) return [];
    const res = await this.fetchImpl(url);
    if (!res.ok) throw new Error(`higgsfield: result download failed (HTTP ${res.status})`);
    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    return [
      {
        name: `output-1.${extensionFor(contentType)}`,
        contentType,
        data: new Uint8Array(await res.arrayBuffer()),
      },
    ];
  }

  /**
   * The CLI has no cancel verb — `generate` is cost, create, get, list, wait and workflow, and
   * nothing else. Stopping here means we stop watching; the remote job runs on and bills. The
   * dispatcher already tolerates a cancel that does nothing, but the user must be told that
   * this one does (§2.10), which is the UI's job rather than this method's.
   */
  async cancel(_key: string, _remoteId: string): Promise<void> {
    return;
  }
}
