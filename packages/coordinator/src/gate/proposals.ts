import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  ArtDirectionRecordSchema,
  newId,
  ProposalSchema,
  RipplePreviewSchema,
  type Proposal,
  type ProposalConflict,
  type RippleItem,
  type RipplePreview,
} from "@arke-studio/contracts";
import { ripplesForCanonEntry, ripplesForSheet } from "../index-db/queries.js";
import { atomicWriteFile } from "../world/atomic.js";
import { appendChanges } from "../world/change-writer.js";
import { classify, type CommitFileInput, type CommitResult } from "../world/commit.js";
import { fromPortable, toExtendedLength } from "../world/paths.js";
import { MarkdownFile, sha256 } from "../world/text-files.js";
import type { WorldStore } from "../world/store.js";
import { applyResolution, mergeMarkdown } from "./merge.js";

/**
 * The accept gate (SPEC-004): one path into the world. A proposal is materialised with its
 * bases, edited, previewed with computed ripples, verified under the lock, and accepted as
 * exactly one SPEC-002 commit — or discarded, leaving one log line.
 */

export type AcceptOutcome =
  | { status: "accepted"; result: CommitResult }
  | { status: "no-op" }
  | { status: "stale"; stalePaths: string[] }
  | { status: "needs-reconfirm"; authoritative: RipplePreview; signature: string }
  | { status: "pending-review" }
  | { status: "unresolved-conflicts"; count: number }
  | { status: "target-retired"; paths: string[] };

export interface StageInput {
  kind: Proposal["kind"];
  summary: string;
  source: string;
  /** World-relative paths to materialise. Created paths carry content and no live base. */
  targets: Array<{ path: string; content?: string }>;
  /** How many canon ids to reserve at creation (R-13). */
  reserveCanonIds?: number;
  /** Ids already reserved by the caller (store.allocateCanonIds) — recorded, not re-allocated. */
  preReservedCanonIds?: string[];
}

const PROPOSALS_DIR = ".proposals";

/** Category:count signature — the definition of a material ripple difference (R-10, D6). */
export function rippleSignature(items: RippleItem[]): string {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.kind, (counts.get(item.kind) ?? 0) + item.targets.length);
  const canonical = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 16);
}

export class ProposalManager {
  constructor(private readonly store: WorldStore) {}

  private abs(...rel: string[]): string {
    return join(this.store.dir, ...rel.map(fromPortable));
  }

  private proposalDir(id: string): string {
    return this.abs(PROPOSALS_DIR, id);
  }

  private async readLive(path: string): Promise<string | null> {
    try {
      return await readFile(toExtendedLength(this.abs(path)), "utf8");
    } catch {
      return null;
    }
  }

  private async readProposalFile(id: string, path: string): Promise<string | null> {
    try {
      return await readFile(toExtendedLength(join(this.proposalDir(id), fromPortable(path))), "utf8");
    } catch {
      return null;
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  /** Materialise a proposal: copies, bases, `_base/` snapshots, reservation, preview (R-1, R-2). */
  async stage(input: StageInput): Promise<Proposal> {
    return this.store.gateOp(async () => {
      const id = newId("pr");
      const at = this.store.now();

      let reservedCanonIds: string[] = input.preReservedCanonIds ?? [];
      if (input.reserveCanonIds && input.reserveCanonIds > 0) {
        reservedCanonIds = [
          ...reservedCanonIds,
          ...(
            await this.store.commitUnserialised({
              kind: "canon-id-allocation",
              source: input.source,
              files: [],
              allocateCanonIds: input.reserveCanonIds,
            })
          ).allocatedCanonIds,
        ];
      }

      const targets: Proposal["targets"] = [];
      for (const target of input.targets) {
        const live = await this.readLive(target.path);
        const baseVersion = live !== null ? readVersion(target.path, live) : null;
        targets.push({
          path: target.path,
          baseVersion,
          baseHash: live !== null ? sha256(live) : null,
        });
        const content = target.content ?? live;
        if (content === null) throw new Error(`${target.path}: no live file and no content supplied`);
        await atomicWriteFile(join(this.proposalDir(id), fromPortable(target.path)), content);
        // The base travels with the proposal — rebase must not depend on .history existing (§2.5).
        if (live !== null) {
          await atomicWriteFile(join(this.proposalDir(id), "_base", fromPortable(target.path)), live);
        }
      }

      const proposal: Proposal = {
        id,
        kind: input.kind,
        summary: input.summary,
        targets,
        baseCanonRevision: this.store.getBundle().meta.canonRevision,
        reservedCanonIds,
        source: input.source,
        created: at,
      };
      await this.writeManifest(proposal);
      await this.refreshPreview(proposal);
      return proposal;
    });
  }

  /**
   * The form editor's whole flow (SPEC-004 §2.9): stage a sheet edit whose proposed content
   * is the live sheet with its prose sections replaced. Serialisation stays server-side.
   */
  async stageSheetEdit(
    path: string,
    summary: string,
    sections: Array<{ heading: string; body: string }>,
    source: string,
  ): Promise<Proposal> {
    const live = await this.readLive(path);
    if (live === null) throw new Error(`${path} does not exist`);
    const doc = MarkdownFile.parse(live);
    doc.setBody(sections.map((s) => `## ${s.heading}\n${s.body.trim()}`).join("\n\n"));
    return this.stage({
      kind: "sheet-edit",
      summary,
      source,
      targets: [{ path, content: doc.serialize() }],
    });
  }

  /** Stage the next world-look version. Acceptance, not this form write, stamps the version. */
  async stageArtDirectionChange(description: string, masterLook: string | null | undefined): Promise<Proposal> {
    const bundle = this.store.getBundle();
    const current = bundle.artDirection;
    const acceptedAt = current.acceptedAt ?? bundle.meta.created;
    const proposed = ArtDirectionRecordSchema.parse({
      version: current.version + 1,
      description,
      ...(masterLook ? { masterLook } : {}),
      acceptedAt: this.store.now(),
      history: [
        ...current.history,
        {
          version: current.version,
          description: current.description,
          ...(current.masterLook ? { masterLook: current.masterLook } : {}),
          acceptedAt,
        },
      ],
    });
    return this.stage({
      kind: "art-direction",
      summary: `Change world look to v${current.version + 1}`,
      source: "form",
      targets: [
        {
          path: "art-direction/art-direction.json",
          content: `${JSON.stringify(proposed, null, 2)}\n`,
        },
      ],
    });
  }

  /** Editor write (chat or form — one proposal, R-14). Refreshes the advisory preview. */
  async updateFile(proposalId: string, path: string, content: string): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);
      if (!proposal.targets.some((t) => t.path === path)) {
        throw new Error(`${path} is not a target of ${proposalId}`);
      }
      await atomicWriteFile(join(this.proposalDir(proposalId), fromPortable(path)), content);
      await this.refreshPreview(proposal);
    });
  }

  /** Discard: the directory goes, reservations stay burned, one log line remains (R-4, D9). */
  async discard(proposalId: string): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId).catch(() => null);
      await rm(toExtendedLength(this.proposalDir(proposalId)), { recursive: true, force: true });
      await appendChanges(this.abs("changes.jsonl"), [
        {
          ts: this.store.now(),
          entity: `.proposals/${proposalId}`,
          discarded: true,
          ...(proposal ? { reservedCanonIds: proposal.reservedCanonIds } : {}),
          source: proposal?.source ?? "unknown",
        },
      ]);
    });
  }

  // ---- accept --------------------------------------------------------------

  async accept(proposalId: string, opts: { confirmRipples?: string } = {}): Promise<AcceptOutcome> {
    return this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);

      if (proposal.pendingReview) return { status: "pending-review" };
      const unresolved = (proposal.conflicts ?? []).filter((c) => c.resolution === undefined);
      if (unresolved.length > 0) return { status: "unresolved-conflicts", count: unresolved.length };

      // Retired targets can only be discarded (§2.11).
      const retired: string[] = [];
      for (const target of proposal.targets) {
        const live = target.baseHash !== null ? await this.readLive(target.path) : "new";
        if (live !== null && live !== "new" && isRetired(target.path, live)) retired.push(target.path);
      }
      if (retired.length > 0) return { status: "target-retired", paths: retired };

      // Staleness first (R-5): compare recorded bases against the live world.
      const stalePaths: string[] = [];
      for (const target of proposal.targets) {
        const live = await this.readLive(target.path);
        const found = live === null ? null : sha256(live);
        if (target.baseHash === null ? live !== null : found !== target.baseHash) {
          stalePaths.push(target.path);
        }
      }
      if (stalePaths.length > 0) return { status: "stale", stalePaths };

      // Build the plan; a proposal identical to the live world is a no-op, reported (R-3).
      const files: CommitFileInput[] = [];
      for (const target of proposal.targets) {
        const proposed = await this.readProposalFile(proposalId, target.path);
        if (proposed === null) throw new Error(`${target.path} missing from proposal ${proposalId}`);
        const live = await this.readLive(target.path);
        if (live !== null && live === proposed) continue; // unchanged target
        files.push({
          path: target.path,
          action: live === null ? "create" : "replace",
          content: proposed,
          baseHash: target.baseHash,
        });
      }
      if (files.length === 0) return { status: "no-op" };

      // Authority: recompute ripples now, under the lock, after verification (R-9).
      const authoritative = this.computeRipples(proposal, files);
      const signature = rippleSignature(authoritative.items);
      const preview = await this.readPreview(proposalId);
      const previewSignature = preview ? rippleSignature(preview.items) : signature;
      if (signature !== previewSignature && opts.confirmRipples !== signature) {
        // Persist the authoritative set so the panel shows what now governs (R-10).
        await this.writePreview(proposal.id, { ...authoritative, governing: true });
        return { status: "needs-reconfirm", authoritative, signature };
      }

      // Exactly one commit (R-11); versions derive inside the primitive (R-12, D7).
      const result = await this.store.commitUnserialised({
        kind: proposal.kind,
        source: proposal.source,
        proposalId: proposal.id,
        files,
      });
      await rm(toExtendedLength(this.proposalDir(proposalId)), { recursive: true, force: true });
      return { status: "accepted", result };
    });
  }

  // ---- rebase --------------------------------------------------------------

  /** Field-level three-way rebase (R-6, R-7): new bases, merged files, recomputed preview. */
  async rebase(proposalId: string): Promise<{ conflicts: ProposalConflict[] }> {
    return this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);
      const conflicts: ProposalConflict[] = [];
      const targets: Proposal["targets"] = [];

      for (const target of proposal.targets) {
        const live = await this.readLive(target.path);
        const mine = await this.readProposalFile(proposalId, target.path);
        if (mine === null) throw new Error(`${target.path} missing from proposal`);
        const base = await this.readProposalFile(proposalId, `_base/${target.path}`);

        if (live === null) {
          // The live file vanished (retired files stay; this is create-vs-nothing): keep mine.
          targets.push({ path: target.path, baseVersion: null, baseHash: null });
          continue;
        }
        if (base === null || sha256(live) === target.baseHash) {
          // Created by this proposal, or not stale: rebase just refreshes the base record.
          targets.push({
            path: target.path,
            baseVersion: readVersion(target.path, live),
            baseHash: sha256(live),
          });
          continue;
        }

        const merge = mergeMarkdown(target.path, base, mine, live);
        conflicts.push(...merge.conflicts);
        await atomicWriteFile(join(this.proposalDir(proposalId), fromPortable(target.path)), merge.merged);
        await atomicWriteFile(join(this.proposalDir(proposalId), "_base", fromPortable(target.path)), live);
        targets.push({
          path: target.path,
          baseVersion: readVersion(target.path, live),
          baseHash: sha256(live),
        });
      }

      const updated: Proposal = {
        ...proposal,
        targets,
        baseCanonRevision: this.store.getBundle().meta.canonRevision,
        rebasedAt: this.store.now(),
        pendingReview: true, // must be seen before accept (R-7)
        ...(conflicts.length > 0 ? { conflicts } : { conflicts: [] }),
      };
      await this.writeManifest(updated);
      await this.refreshPreview(updated);
      return { conflicts };
    });
  }

  /** A human chose a side for one conflicted field (R-6, D4). */
  async resolveConflict(proposalId: string, path: string, field: string, choice: "mine" | "theirs"): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);
      const conflict = (proposal.conflicts ?? []).find((c) => c.path === path && c.field === field);
      if (!conflict) throw new Error(`no conflict on ${path}#${field}`);
      const current = await this.readProposalFile(proposalId, path);
      if (current === null) throw new Error(`${path} missing from proposal`);
      await atomicWriteFile(
        join(this.proposalDir(proposalId), fromPortable(path)),
        applyResolution(path, current, conflict, choice),
      );
      const conflicts = (proposal.conflicts ?? []).map((c) =>
        c.path === path && c.field === field ? { ...c, resolution: choice } : c,
      );
      await this.writeManifest({ ...proposal, conflicts });
    });
  }

  /** The user has seen the merged result; the proposal becomes acceptable again (R-7). */
  async markSeen(proposalId: string): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);
      await this.writeManifest({ ...proposal, pendingReview: false });
    });
  }

  // ---- ripples -------------------------------------------------------------

  private computeRipples(proposal: Proposal, files?: CommitFileInput[]): RipplePreview {
    const items: RippleItem[] = [];
    const index = this.store.getIndex();
    const bundle = this.store.getBundle();
    if (proposal.kind === "art-direction") {
      const reach = bundle.artDirection.reach;
      items.push(
        {
          kind: "visual-assets-keep-look",
          summary: `${reach.visualAssets} visual assets stay as they are; new work sees the next look`,
          targets: Array.from({ length: reach.visualAssets }, (_, index) => `visual-asset-${index + 1}`),
        },
        {
          kind: "reference-kits-see-new-look",
          summary: `${reach.referenceKits} reference kits see a newer world look`,
          targets: bundle.referenceKits.filter((kit) => !kit.styleOverride?.trim()).map((kit) => kit.sheetId),
        },
        {
          kind: "productions-inherit-look",
          summary: `${reach.productions} productions inherit the next look on dispatch`,
          targets: bundle.productions
            .filter((production) => !production.meta.styleOverride?.trim())
            .map((production) => production.meta.id),
        },
        {
          kind: "takes-pinned-to-old-version",
          summary: `${reach.earlierAcceptedTakes} accepted takes remain pinned to their original look`,
          targets: Array.from({ length: reach.earlierAcceptedTakes }, (_, index) => `accepted-take-${index + 1}`),
        },
      );
      if (bundle.artDirection.overrides.length > 0) {
        items.push({
          kind: "overrides-keep-own-look",
          summary: `${bundle.artDirection.overrides.length} overrides keep their own look`,
          targets: bundle.artDirection.overrides.map((override) => override.id),
        });
      }
      return { computedAt: this.store.now(), governing: false, items };
    }
    if (index) {
      for (const target of proposal.targets) {
        const kind = classify(target.path);
        if (kind.track === "sheet") {
          const sheet = bundle.sheets.find((s) => s.id === kind.id);
          const newVersion = (sheet?.version ?? target.baseVersion ?? 0) + 1;
          items.push(
            ...ripplesForSheet(index.db, {
              sheetId: kind.id,
              sheetName: sheet?.name ?? kind.id,
              newVersion,
            }),
          );
        } else if (kind.track === "canon") {
          const proposedRaw = files?.find((f) => f.path === target.path)?.content;
          const parsed = proposedRaw ? tryParseCanon(proposedRaw) : null;
          const entry = bundle.canon.find((c) => c.id === kind.id);
          items.push(
            ...ripplesForCanonEntry(index.db, {
              entryId: kind.id,
              title: parsed?.title ?? entry?.title ?? kind.id,
              statement: parsed?.body ?? entry?.body ?? "",
            }),
          );
        }
      }
    }
    return { computedAt: this.store.now(), governing: false, items };
  }

  /** Re-derive the advisory preview from the proposal files as they now stand (SPEC-005). */
  async refreshPreviewFor(proposalId: string): Promise<void> {
    await this.store.gateOp(async () => {
      const proposal = await this.readManifest(proposalId);
      await this.refreshPreview(proposal);
    });
  }

  private async refreshPreview(proposal: Proposal): Promise<void> {
    const files: CommitFileInput[] = [];
    for (const target of proposal.targets) {
      const content = await this.readProposalFile(proposal.id, target.path);
      if (content !== null) {
        files.push({ path: target.path, action: "replace", content, baseHash: target.baseHash });
      }
    }
    await this.writePreview(proposal.id, this.computeRipples(proposal, files));
  }

  // ---- manifest and preview io --------------------------------------------

  private async writeManifest(proposal: Proposal): Promise<void> {
    await mkdir(toExtendedLength(this.proposalDir(proposal.id)), { recursive: true });
    await atomicWriteFile(
      join(this.proposalDir(proposal.id), "proposal.json"),
      JSON.stringify(ProposalSchema.parse(proposal), null, 2) + "\n",
    );
  }

  async readManifest(proposalId: string): Promise<Proposal> {
    const raw = await readFile(toExtendedLength(join(this.proposalDir(proposalId), "proposal.json")), "utf8");
    return ProposalSchema.parse(JSON.parse(raw));
  }

  private async writePreview(proposalId: string, preview: RipplePreview): Promise<void> {
    await atomicWriteFile(
      join(this.proposalDir(proposalId), "ripple.json"),
      JSON.stringify(RipplePreviewSchema.parse(preview), null, 2) + "\n",
    );
  }

  private async readPreview(proposalId: string): Promise<RipplePreview | null> {
    try {
      const raw = await readFile(toExtendedLength(join(this.proposalDir(proposalId), "ripple.json")), "utf8");
      return RipplePreviewSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Restart recovery (§2.11): validate manifests; report proposals whose target retired. */
  async listOpen(): Promise<Proposal[]> {
    const out: Proposal[] = [];
    let entries: string[] = [];
    try {
      entries = await readdir(toExtendedLength(this.abs(PROPOSALS_DIR)));
    } catch {
      return out;
    }
    for (const id of entries) {
      try {
        out.push(await this.readManifest(id));
      } catch {
        /* unreadable manifest → not listed; discard-only via UI */
      }
    }
    return out;
  }
}

function readVersion(path: string, raw: string): number | null {
  const kind = classify(path);
  try {
    if (kind.track === "sheet" || kind.track === "chapter") {
      return ((MarkdownFile.parse(raw).data["version"] as number | undefined) ?? 1);
    }
    if (kind.track === "canon") {
      const data = MarkdownFile.parse(raw).data;
      return Math.max(
        (data["introducedAt"] as number | undefined) ?? 0,
        (data["settledAt"] as number | undefined) ?? 0,
        (data["amendedAt"] as number | undefined) ?? 0,
      );
    }
    if (kind.track === "scene" || kind.track === "story") {
      return ((JSON.parse(raw) as { version?: number }).version ?? 1);
    }
    if (kind.track === "art-direction") return ArtDirectionRecordSchema.parse(JSON.parse(raw)).version;
  } catch {
    return null;
  }
  return null;
}

function isRetired(path: string, raw: string): boolean {
  const kind = classify(path);
  if (kind.track !== "sheet" && kind.track !== "canon") return false;
  try {
    return MarkdownFile.parse(raw).data["retired"] === true;
  } catch {
    return false;
  }
}

function tryParseCanon(raw: string): { title: string; body: string } | null {
  try {
    const doc = MarkdownFile.parse(raw);
    return { title: String(doc.data["title"] ?? ""), body: doc.body };
  } catch {
    return null;
  }
}
