import {
  newId,
  type CanonEntry,
  type CheckReceiptId,
  type Sheet,
  type WorldBundle,
  type WorldChatCheckReceipt,
} from "@arke-studio/contracts";
import { canonObservation, sheetObservation } from "./observations.js";
import { productionRecord } from "./production-record.js";
import { refsForCanon, refsForSheet, searchCanon, searchSheets } from "../index-db/queries.js";
import type { WorldIndex } from "../index-db/world-index.js";
import { LeaseDeniedError, type QueryLease, type QueryLeaseRegistry } from "./lease.js";
import {
  MAX_TEXT_PER_RUN_CHARS,
  type AttachmentRange,
  type WorldChatAttachmentStore,
} from "./attachments.js";
import type { WorldChatAttachment } from "@arke-studio/contracts";

/**
 * The read-only surface a World Chat run may reach, and the record of what it read
 * (#70 §9.2, §9.3).
 *
 * Every call produces a receipt. That is the point of routing these through here rather than
 * letting the model's own account of its searching stand: the panel's claim that something is new
 * rests on a search actually having happened, over a known corpus, with a known result. A model
 * saying "I checked" is not that, and a candidate marked ready on the strength of it would be a
 * confident lie about the world.
 *
 * Retrieval degradation is handled here too (§9.4). When the index is down, direct reads still
 * work and search reports `unavailable` — never `empty`, because "I found nothing" and "I could
 * not look" mean opposite things to somebody deciding whether a character already exists.
 */

/** Bounded results, default 8, hard maximum 20 (§19). */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export type RetrievalTool = WorldChatCheckReceipt["tool"];

const TOOL_BY_NAME: Record<string, RetrievalTool> = {
  search_canon: "search-canon",
  search_sheets: "search-sheets",
  get_entry: "get-entry",
  get_sheet: "get-sheet",
  list_entities: "list-entities",
  related: "related",
  get_attachment_text: "get-attachment-text",
  fetch_url: "fetch-url",
  get_production: "get-production",
};

export class RetrievalError extends Error {
  constructor(
    readonly kind: "unknown-tool" | "not-found" | "unavailable" | "bad-argument" | "budget-exhausted",
    message: string,
  ) {
    super(message);
    this.name = "RetrievalError";
  }
}

export interface RetrievalOutcome {
  result: unknown;
  receipt: WorldChatCheckReceipt;
}

function boundedLimit(raw: unknown): number {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_LIMIT;
  return Math.min(Math.max(1, n), MAX_LIMIT);
}

/**
 * Safe product text summarising what was asked (§9.3).
 *
 * The user's phrasing is theirs; this is a short, bounded echo so the panel can say what was
 * checked. It never reaches app diagnostics.
 */
function summarise(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > 120 ? `${collapsed.slice(0, 117)}…` : collapsed;
}

export interface RetrievalDeps {
  leases: QueryLeaseRegistry;
  getBundle: () => WorldBundle | null;
  getIndex: () => WorldIndex | null;
  attachments: WorldChatAttachmentStore;
  findAttachment: (lease: QueryLease, attachmentId: string) => Promise<WorldChatAttachment | null>;
  /**
   * What one run may read out of attachments in total, from the answering model's window.
   *
   * Absent means nobody could name a window and `MAX_TEXT_PER_RUN_CHARS` applies — the figure
   * this was before it was asked of the harness rather than picked.
   */
  textBudgetChars?: () => number;
  /**
   * Whether the person has turned research on. Absent means off — this app reads your
   * world off your disk, and going online is a different promise from the one it makes by
   * default, so silence is the safe answer rather than the permissive one.
   */
  researchAllowed?: () => boolean | Promise<boolean>;
  /** Injectable so a test can serve a page without a network. */
  fetch?: typeof globalThis.fetch;
  now?: () => string;
}

const NO_RANGES: ReadonlyMap<string, readonly AttachmentRange[]> = new Map();

export class WorldChatRetrieval {
  private readonly now: () => string;
  /** Text read per run, so one run cannot pull a whole library through a bounded tool (§19). */
  private readonly textSpentByRun = new Map<string, number>();
  /**
   * The exact text this run was served, per attachment, so a quotation can be checked against
   * what was actually read (§5.8).
   *
   * The budget bounds how many characters a run may take, not where in a file it may take them
   * from: `offset` is free, so a run can legitimately read a passage half a megabyte into a
   * document. Verification cannot reconstruct that by re-reading a prefix — there is no prefix
   * long enough — so the ranges are kept as they are served. It also makes the evidence rule
   * exact rather than approximate: a quotation is verifiable when the model actually read it.
   *
   * Each range keeps the offset it came from, so windows that were consecutive can be rejoined
   * and windows that were not stay apart.
   */
  private readonly textReadByRun = new Map<string, Map<string, AttachmentRange[]>>();

  constructor(private readonly deps: RetrievalDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  /**
   * Run one tool call under a lease, and return its result with the receipt it produced.
   *
   * A failed or unavailable call still produces a receipt. An observation that could not be made
   * is exactly the thing wrap-up needs to know about later, so losing it on the error path would
   * be the worst place to lose it.
   */
  async call(token: string, toolName: string, args: Record<string, unknown>): Promise<RetrievalOutcome> {
    const tool = TOOL_BY_NAME[toolName];
    if (!tool) throw new RetrievalError("unknown-tool", `unknown tool: ${toolName}`);

    const lease = this.deps.leases.verify(token, toolName);
    const receipt = (
      status: WorldChatCheckReceipt["status"],
      extra: Partial<WorldChatCheckReceipt> = {},
    ): WorldChatCheckReceipt => ({
      id: newId("check") as CheckReceiptId,
      runId: lease.runId,
      tool,
      status,
      consulted: [],
      at: this.now(),
      ...extra,
    });

    try {
      return await this.dispatch(lease, toolName, args, receipt);
    } catch (err) {
      if (err instanceof LeaseDeniedError) throw err;
      if (err instanceof RetrievalError && err.kind === "unavailable") {
        return { result: { unavailable: true, reason: err.message }, receipt: receipt("unavailable") };
      }
      throw Object.assign(err as Error, { receipt: receipt("failed") });
    }
  }

  private async dispatch(
    lease: QueryLease,
    toolName: string,
    args: Record<string, unknown>,
    receipt: (status: WorldChatCheckReceipt["status"], extra?: Partial<WorldChatCheckReceipt>) => WorldChatCheckReceipt,
  ): Promise<RetrievalOutcome> {
    const bundle = this.deps.getBundle();
    if (!bundle) throw new RetrievalError("unavailable", "no world is open");
    const index = this.deps.getIndex();

    switch (toolName) {
      case "search_canon": {
        if (!index) throw new RetrievalError("unavailable", "the index is unavailable");
        const query = String(args["query"] ?? "");
        const result = searchCanon(index.db, query, { limit: boundedLimit(args["limit"]) });
        const consulted = result.candidates
          .map((c) => bundle.canon.find((e) => e.id === c.entryId))
          .filter((e): e is CanonEntry => e !== undefined)
          .map((e) => canonObservation(e, bundle.meta.canonRevision));
        return {
          result,
          // Below the floor the search returns its closest few as receipts of a refusal, not as
          // findings — so a non-empty candidate list is not the same as having found something.
          receipt: receipt(result.floorCleared ? "complete" : "empty", {
            querySummary: summarise(query),
            consulted,
            searchedCount: result.searched,
          }),
        };
      }

      case "search_sheets": {
        if (!index) throw new RetrievalError("unavailable", "the index is unavailable");
        const query = String(args["query"] ?? "");
        const kind = args["kind"] !== undefined ? String(args["kind"]) : undefined;
        const result = searchSheets(index.db, query, {
          limit: boundedLimit(args["limit"]),
          ...(kind !== undefined ? { kind } : {}),
        });
        const consulted = result.candidates
          .map((c) => bundle.sheets.find((s) => s.id === c.sheetId))
          .filter((s): s is Sheet => s !== undefined)
          .map(sheetObservation);
        return {
          result,
          receipt: receipt(result.floorCleared ? "complete" : "empty", {
            querySummary: summarise(kind ? `${query} (${kind})` : query),
            consulted,
            searchedCount: result.searched,
          }),
        };
      }

      case "get_entry": {
        const id = String(args["id"] ?? "");
        const entry = bundle.canon.find((c) => c.id === id);
        if (!entry) {
          return { result: { found: false, id }, receipt: receipt("empty", { querySummary: summarise(id) }) };
        }
        return {
          result: entry,
          receipt: receipt("complete", {
            querySummary: summarise(id),
            consulted: [canonObservation(entry, bundle.meta.canonRevision)],
          }),
        };
      }

      case "get_sheet": {
        const id = String(args["id"] ?? "");
        const sheet = bundle.sheets.find((s) => s.id === id);
        if (!sheet) {
          return { result: { found: false, id }, receipt: receipt("empty", { querySummary: summarise(id) }) };
        }
        return {
          result: sheet,
          receipt: receipt("complete", {
            querySummary: summarise(id),
            consulted: [sheetObservation(sheet)],
          }),
        };
      }

      case "list_entities": {
        const kind = String(args["kind"] ?? "");
        const status = args["status"] !== undefined ? String(args["status"]) : undefined;
        const limit = boundedLimit(args["limit"]);
        /*
         * The production arm existed on the unleased surface and not here (round 3, 2026-08-22),
         * so a production thread asking for its own production got an empty page — the sheet
         * filter matched nothing and said so as though the world held no productions at all.
         */
        const rows =
          kind === "canon"
            ? bundle.canon
                .filter((c) => c.retired !== true)
                .filter((c) => status === undefined || c.status === status)
                .map((c) => ({ id: c.id, title: c.title, type: c.type, status: c.status }))
            : kind === "production"
              ? bundle.productions.map((p) => ({ id: p.meta.id, title: p.meta.title, status: p.meta.status }))
              : bundle.sheets
                  .filter((s) => s.retired !== true)
                  .filter((s) => s.type === kind)
                  .filter((s) => status === undefined || s.status === status)
                  .map((s) => ({ id: s.id, name: s.name, status: s.status, version: s.version }));
        const page = rows.slice(0, limit);
        return {
          result: { entities: page, total: rows.length, truncated: rows.length > page.length },
          receipt: receipt(page.length > 0 ? "complete" : "empty", {
            querySummary: summarise(status ? `${kind} (${status})` : kind),
            searchedCount: rows.length,
          }),
        };
      }

      case "related": {
        if (!index) throw new RetrievalError("unavailable", "the index is unavailable");
        const id = String(args["id"] ?? "");
        const result = id.startsWith("CANON-") ? refsForCanon(index.db, id) : refsForSheet(index.db, id);
        return { result, receipt: receipt("complete", { querySummary: summarise(id) }) };
      }

      case "get_production": {
        // Context, not evidence: a production record carries no observation a citation could
        // verify against, so nothing consulted is recorded — the receipt says the read happened.
        const id = String(args["id"] ?? "");
        const record = productionRecord(bundle, id);
        if (!record) {
          return { result: { found: false, id }, receipt: receipt("empty", { querySummary: summarise(id) }) };
        }
        return { result: record, receipt: receipt("complete", { querySummary: summarise(id) }) };
      }

      case "fetch_url": {
        /*
         * Reading a page, and keeping it (2026-08-22).
         *
         * The page becomes an attachment on this conversation, because that is the only shape in
         * this system that a citation can be checked against later: hashed bytes the studio still
         * holds. Verifying a quote against a live URL would pass today and fail next month for
         * reasons that have nothing to do with the writing.
         *
         * The receipt is the record that the studio went out at all, and the reply's own
         * activity line says so while it happens. Nothing is fetched that was not named.
         */
        if ((await this.deps.researchAllowed?.()) !== true) {
          return {
            result: {
              refused: true,
              reason:
                "Research is off. Turn on web research in settings and ask again — nothing is read online until you do.",
            },
            receipt: receipt("unavailable", { querySummary: summarise(String(args["url"] ?? "")) }),
          };
        }
        const url = String(args["url"] ?? "");
        try {
          const attachment = await this.deps.attachments.fetchPage(
            lease.conversationId,
            url,
            this.deps.fetch ? { fetch: this.deps.fetch } : {},
          );
          // Readable by this run from here on, the same as a document handed over by hand.
          this.deps.leases.allowAttachment(lease, attachment.id);
          return {
            result: {
              attachmentId: attachment.id,
              url: attachment.source?.url ?? url,
              fetchedAt: attachment.source?.fetchedAt,
              bytes: attachment.byteLength,
              note: "Kept on this conversation. Read it with get_attachment_text, and quote from what it returns.",
            },
            receipt: receipt("complete", { querySummary: summarise(url) }),
          };
        } catch (err) {
          return {
            result: { refused: true, reason: err instanceof Error ? err.message : "that page could not be read" },
            receipt: receipt("empty", { querySummary: summarise(url) }),
          };
        }
      }

      case "get_attachment_text": {
        const id = String(args["id"] ?? "");
        // Scoping first: whether the file exists is itself information about another conversation.
        this.deps.leases.assertAttachmentAllowed(lease, id);

        const attachment = await this.deps.findAttachment(lease, id);
        if (!attachment) {
          return { result: { found: false, id }, receipt: receipt("empty", { querySummary: summarise(id) }) };
        }

        const budget = this.deps.textBudgetChars?.() ?? MAX_TEXT_PER_RUN_CHARS;
        const spent = this.textSpentByRun.get(lease.runId) ?? 0;
        if (spent >= budget) {
          throw new RetrievalError(
            "budget-exhausted",
            "This run has read as much attachment text as it may.",
          );
        }

        const offset = typeof args["offset"] === "number" ? args["offset"] : 0;
        const requested = typeof args["limit"] === "number" ? args["limit"] : undefined;
        const remaining = budget - spent;
        const read = await this.deps.attachments.readText(attachment, {
          offset,
          ...(requested !== undefined ? { limit: Math.min(requested, remaining) } : { limit: remaining }),
        });
        this.textSpentByRun.set(lease.runId, spent + read.text.length);
        if (read.text.length > 0) {
          const byAttachment = this.textReadByRun.get(lease.runId) ?? new Map<string, AttachmentRange[]>();
          byAttachment.set(attachment.id, [
            ...(byAttachment.get(attachment.id) ?? []),
            { offset: read.offset, text: read.text },
          ]);
          this.textReadByRun.set(lease.runId, byAttachment);
        }

        return {
          result: read,
          receipt: receipt("complete", {
            querySummary: summarise(attachment.fileName),
            // An attachment is not a world entity, so it has no entity ref to consult; the file
            // itself is identified by the hash returned alongside the text.
            searchedCount: 1,
          }),
        };
      }

      default:
        throw new RetrievalError("unknown-tool", `unknown tool: ${toolName}`);
    }
  }

  /** What this run read out of each attachment, with the offset each passage came from. */
  textReadBy(runId: string): ReadonlyMap<string, readonly AttachmentRange[]> {
    return this.textReadByRun.get(runId) ?? NO_RANGES;
  }

  /** Called when a run ends, so its text budget does not outlive it. */
  forgetRun(runId: string): void {
    this.textSpentByRun.delete(runId);
    this.textReadByRun.delete(runId);
  }
}
