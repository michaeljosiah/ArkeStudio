import type { CanonEntry, Sheet, WorldBundle } from "@arke-studio/contracts";
import { orderedShots } from "@arke-studio/contracts";

/**
 * Citation extraction (SPEC-003 §2.4) — the heart of the index. Every reference between
 * entities becomes a row carrying source, target, relation and the target's version at the
 * time the citation was made (R-8). Extraction reads only the bundle, which is itself derived
 * only from the world folder (D1).
 */

export interface CitationRow {
  sourceKind: string;
  sourceId: string;
  sourceVersion: number | null;
  targetKind: string;
  targetId: string;
  /** The version cited at the time — recorded truth for dispatch/tiles, current for live refs. */
  targetVersion: number | null;
  relation:
    | "shot-cast"
    | "dispatch"
    | "canon-rule"
    | "entry-link"
    | "artifact-link"
    | "tile-source"
    | "scene-location"
    | "voice-assignment"
    | "sheet-link";
  productionId: string | null;
}

export interface EntityRow {
  kind: "character" | "location" | "faction" | "canon" | "production" | "scene" | "shot" | "artifact";
  id: string;
  name: string;
  status: string | null;
  version: number | null;
  retired: boolean;
  /**
   * Which production's *slice* this row belongs to — the partition `applyCommit` deletes and
   * re-inserts when a production's files change. Null for everything the world owns directly.
   */
  productionId: string | null;
  /**
   * Which production *owns* this sheet, for a guest (SPEC-020 R-17). Absent on every other kind.
   *
   * Deliberately NOT `productionId`, however much the two look alike. That field is a partition
   * key: `applyCommit` deletes every row carrying it whenever that production's files change,
   * and re-inserts only scenes, shots and takes. A guest filed under it would be deleted by an
   * edit to an unrelated scene and never come back — the sheet would vanish from the index while
   * sitting untouched on disk.
   */
  ownerProduction?: string | null;
  updatedAt: string | null;
}

export interface TakeRow {
  id: string;
  productionId: string;
  kind: string;
  provider: string;
  model: string;
  canonRevision: number;
  /** Latest review decision, later reviews.jsonl lines winning; null = pending. */
  review: "accepted" | "rejected" | null;
  estimatedMicroUsd: number;
  actualMicroUsd: number | null;
  dispatchedAt: string;
  shots: string[];
  sheets: Array<{ sheetId: string; sheetVersion: number }>;
}

/** The revision stamp a canon entry's current content carries. */
export function canonStamp(entry: CanonEntry): number {
  return Math.max(entry.introducedAt, entry.settledAt ?? 0, entry.amendedAt ?? 0);
}

/** `@slug` tokens inside shot descriptions are live sheet references (master spec §2.3.4). */
export function castRefs(description: string): string[] {
  const out = new Set<string>();
  for (const m of description.matchAll(/@([a-z0-9][a-z0-9-]*)/g)) out.add(m[1]!);
  return [...out];
}

export interface Extraction {
  entities: EntityRow[];
  citations: CitationRow[];
  takes: TakeRow[];
}

export function extract(bundle: WorldBundle): Extraction {
  const entities: EntityRow[] = [];
  const citations: CitationRow[] = [];
  const takes: TakeRow[] = [];

  const sheetById = new Map<string, Sheet>(bundle.sheets.map((s) => [s.id, s]));
  const canonById = new Map<string, CanonEntry>(bundle.canon.map((c) => [c.id, c]));

  const targetOf = (id: string): { kind: string; version: number | null } => {
    const sheet = sheetById.get(id);
    if (sheet) return { kind: sheet.type, version: sheet.version };
    const entry = canonById.get(id);
    if (entry) return { kind: "canon", version: canonStamp(entry) };
    if (bundle.productions.some((p) => p.meta.id === id)) return { kind: "production", version: null };
    return { kind: "unknown", version: null };
  };

  for (const sheet of bundle.sheets) {
    entities.push({
      kind: sheet.type,
      id: sheet.id,
      name: sheet.name,
      status: sheet.status,
      version: sheet.version,
      retired: sheet.retired === true,
      productionId: null,
      ownerProduction: sheet.production ?? null,
      updatedAt: sheet.updated,
    });
    for (const ruleId of sheet.canonRules) {
      const entry = canonById.get(ruleId);
      citations.push({
        sourceKind: sheet.type,
        sourceId: sheet.id,
        sourceVersion: sheet.version,
        targetKind: "canon",
        targetId: ruleId,
        targetVersion: entry ? canonStamp(entry) : null,
        relation: "canon-rule",
        productionId: null,
      });
    }
    if (sheet.voice) {
      citations.push({
        sourceKind: sheet.type,
        sourceId: sheet.id,
        sourceVersion: sheet.voice.assignedAtVersion,
        targetKind: "voice",
        targetId: sheet.voice.model
          ? `${sheet.voice.provider}/${sheet.voice.model}/${sheet.voice.voiceId}`
          : `${sheet.voice.provider}/${sheet.voice.voiceId}`,
        targetVersion: null,
        relation: "voice-assignment",
        productionId: null,
      });
    }
    // Directed relationship links, stored one-sided; the reverse lookup is this row queried
    // from the target's side (SPEC-007 R-4, D10).
    for (const link of sheet.links) {
      const target = targetOf(link);
      citations.push({
        sourceKind: sheet.type,
        sourceId: sheet.id,
        sourceVersion: sheet.version,
        targetKind: target.kind,
        targetId: link,
        targetVersion: target.version,
        relation: "sheet-link",
        productionId: null,
      });
    }
  }

  for (const entry of bundle.canon) {
    entities.push({
      kind: "canon",
      id: entry.id,
      name: entry.title,
      status: entry.status,
      version: canonStamp(entry),
      retired: entry.retired === true,
      productionId: null,
      updatedAt: null,
    });
    for (const link of entry.links) {
      const target = targetOf(link);
      citations.push({
        sourceKind: "canon",
        sourceId: entry.id,
        sourceVersion: canonStamp(entry),
        targetKind: target.kind,
        targetId: link,
        targetVersion: target.version,
        relation: "entry-link",
        productionId: null,
      });
    }
  }

  for (const kit of bundle.referenceKits) {
    for (const tile of kit.tiles) {
      // Superseded tiles are history, not references (SPEC-010 R-4, D11); queue states carry
      // no image yet. Only tiles with a made-against version cite their sheet.
      if (tile.status === "empty" || tile.status === "superseded" || tile.status === "pending" || tile.status === "rendering") continue;
      if (tile.sheetVersion === undefined) continue;
      citations.push({
        sourceKind: "reference-tile",
        sourceId: `${kit.sheetId}/${tile.angle}`,
        sourceVersion: tile.sheetVersion,
        targetKind: sheetById.get(kit.sheetId)?.type ?? "character",
        targetId: kit.sheetId,
        // The version the tile was made against — what "predates v5" is computed from (R-8).
        targetVersion: tile.sheetVersion,
        relation: "tile-source",
        productionId: null,
      });
    }
  }

  for (const artifact of bundle.artifacts) {
    entities.push({
      kind: "artifact",
      id: artifact.id,
      name: artifact.file,
      status: artifact.origin.by,
      version: null,
      retired: false,
      productionId: null,
      updatedAt: artifact.created,
    });
    for (const link of artifact.links) {
      const target = targetOf(link);
      citations.push({
        sourceKind: "artifact",
        sourceId: artifact.id,
        sourceVersion: null,
        targetKind: target.kind,
        targetId: link,
        targetVersion: target.version,
        relation: "artifact-link",
        productionId: null,
      });
    }
  }

  for (const production of bundle.productions) {
    entities.push({
      kind: "production",
      id: production.meta.id,
      name: production.meta.title,
      status: production.meta.status,
      version: null,
      retired: false,
      productionId: null,
      updatedAt: production.meta.updated,
    });

    for (const scene of production.scenes) {
      entities.push({
        kind: "scene",
        id: scene.id,
        name: scene.title,
        status: scene.status,
        version: scene.version,
        retired: false,
        productionId: production.meta.id,
        updatedAt: null,
      });
      if (scene.inherits?.location) {
        const target = targetOf(scene.inherits.location);
        citations.push({
          sourceKind: "scene",
          sourceId: scene.id,
          sourceVersion: scene.version,
          targetKind: target.kind,
          targetId: scene.inherits.location,
          targetVersion: target.version,
          relation: "scene-location",
          productionId: production.meta.id,
        });
      }
      for (const shot of orderedShots(scene)) {
        entities.push({
          kind: "shot",
          id: shot.id,
          name: shot.title,
          status: null,
          version: null,
          retired: false,
          productionId: production.meta.id,
          updatedAt: null,
        });
        for (const ref of castRefs(shot.description)) {
          const target = targetOf(ref);
          citations.push({
            sourceKind: "shot",
            sourceId: shot.id,
            sourceVersion: scene.version,
            targetKind: target.kind,
            targetId: ref,
            targetVersion: target.version,
            relation: "shot-cast",
            productionId: production.meta.id,
          });
        }
        if (shot.audio?.speaker) {
          const target = targetOf(shot.audio.speaker);
          citations.push({
            sourceKind: "shot",
            sourceId: shot.id,
            sourceVersion: scene.version,
            targetKind: target.kind,
            targetId: shot.audio.speaker,
            targetVersion: target.version,
            relation: "shot-cast",
            productionId: production.meta.id,
          });
        }
      }
    }

    // Latest decision per take — later reviews.jsonl lines win (§2.3.6).
    const decisions = new Map<string, "accepted" | "rejected">();
    for (const review of production.reviews) {
      decisions.set(review.takeId, review.decision === "accept" ? "accepted" : "rejected");
    }

    for (const take of production.takes) {
      takes.push({
        id: take.id,
        productionId: production.meta.id,
        kind: take.kind,
        provider: take.provider,
        model: take.model,
        canonRevision: take.provenance.canonRevision,
        review: decisions.get(take.id) ?? null,
        estimatedMicroUsd: take.cost.estimatedMicroUsd,
        actualMicroUsd: take.cost.actualMicroUsd,
        dispatchedAt: take.dispatchedAt,
        shots: [...take.coversShots],
        sheets: Object.entries(take.provenance.sheets).map(([sheetId, sheetVersion]) => ({
          sheetId,
          sheetVersion,
        })),
      });
      for (const [sheetId, sheetVersion] of Object.entries(take.provenance.sheets)) {
        citations.push({
          sourceKind: "take",
          sourceId: take.id,
          sourceVersion: null,
          targetKind: sheetById.get(sheetId)?.type ?? "unknown",
          targetId: sheetId,
          // Dispatch provenance is recorded truth: the version cited at dispatch (R-8).
          targetVersion: sheetVersion,
          relation: "dispatch",
          productionId: production.meta.id,
        });
      }
      citations.push({
        sourceKind: "take",
        sourceId: take.id,
        sourceVersion: null,
        targetKind: "canon",
        targetId: "canon",
        targetVersion: take.provenance.canonRevision,
        relation: "dispatch",
        productionId: production.meta.id,
      });
    }
  }

  return { entities, citations, takes };
}
