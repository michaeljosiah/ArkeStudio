import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  SHEET_SHAPES,
  sheetDir,
  type ArtifactSidecar,
  type ExtractionCandidate,
  type SheetKind,
} from "@arke-studio/contracts";
import { excerptAppears } from "../canon/ask.js";
import { stageCanonEntry } from "../canon/authoring.js";
import { buildSheetContent } from "../sheets/authoring.js";
import type { ProposalManager } from "../gate/proposals.js";
import { toExtendedLength } from "../world/paths.js";
import { sha256 } from "../world/text-files.js";
import { uniqueSlug } from "../world/slug.js";
import type { WorldStore } from "../world/store.js";

/**
 * Fact extraction (SPEC-015 §2.7): the highest-risk operation in the product, held to
 * SPEC-006's discipline — quote the source, verify the quote mechanically (D2). Candidates
 * whose quotes do not appear are dropped AND counted (D3); unevidenced fields stay empty (D4);
 * decided candidates are never re-offered (D12). Filing already succeeded; nothing here can
 * touch it (D1).
 */

// ---------------------------------------------------------------------------
// Source text (T-8): markdown and plain text fully; PDFs via literal-string harvest
// ---------------------------------------------------------------------------

export async function extractText(store: WorldStore, artifact: ArtifactSidecar): Promise<string | null> {
  const path = toExtendedLength(join(store.dir, "artifacts", artifact.file));
  if (/\.(md|txt)$/i.test(artifact.file)) {
    return readFile(path, "utf8");
  }
  if (/\.pdf$/i.test(artifact.file)) {
    // Uncompressed text operators only: honest partial support, reported when it yields nothing.
    const raw = await readFile(path);
    const latin = raw.toString("latin1");
    const pieces: string[] = [];
    for (const match of latin.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) {
      pieces.push(match[1]!.replace(/\\([()\\])/g, "$1"));
    }
    const text = pieces.join(" ").trim();
    return text.length > 0 ? text : null;
  }
  return null; // audio, images, video: nothing to quote from — no text, no candidates
}

// ---------------------------------------------------------------------------
// Candidates and verification (R-12..R-14, D2, D3)
// ---------------------------------------------------------------------------

export function candidateHash(kind: string, name: string, quote: string, section?: string): string {
  // Section is part of identity: the same quote offered into Appearance and into Relationships
  // is two different claims. Body is not: a re-run rewording the same fact must not re-offer.
  return createHash("sha256").update(`${kind}\n${name}\n${section ?? ""}\n${quote}`).digest("hex").slice(0, 16);
}

/** What a model claims to have found; everything is re-verified before it is offered. */
export interface RawCandidate {
  kind: "canon" | "character" | "location" | "faction";
  name: string;
  body: string;
  section?: string;
  quote: string;
  line?: number;
}

const SHEET_SECTIONS_ALLOWED: Record<Exclude<RawCandidate["kind"], "canon">, string[]> = {
  character: ["Essence", "Appearance"],
  location: ["Look", "Sound"],
  faction: ["Essence", "Wants"],
};

export interface VerifiedBatch {
  verified: ExtractionCandidate[];
  /** Fabrications, wrong-source cites and out-of-scope fields — counted, never hidden (D3). */
  droppedCount: number;
  droppedReasons: string[];
}

/**
 * The mechanical gate (R-13): does this quote actually appear in this document? Implied,
 * adjacent and invented facts arrive in one list with one tone; this separates them.
 */
export function verifyCandidates(
  raw: RawCandidate[],
  sourceText: string,
  alreadyDecided: string[],
  /**
   * The production owning the source artifact, if any (SPEC-020 R-12). Present means canon
   * candidates are refused outright: canon is the world's settled truth, and a one-off's script
   * or scratch recording is the last thing that should be proposing it. Refused *here*, at
   * verification, rather than at acceptance — an offer the user is not allowed to take is a
   * worse surface than an offer that was never made.
   */
  ownedBy?: string,
): VerifiedBatch {
  const verified: ExtractionCandidate[] = [];
  const droppedReasons: string[] = [];
  const decided = new Set(alreadyDecided);
  const seen = new Set<string>();
  for (const candidate of raw) {
    const hash = candidateHash(candidate.kind, candidate.name, candidate.quote, candidate.section);
    if (decided.has(hash) || seen.has(hash)) continue; // never re-offered (R-17, D12) or double-offered
    if (candidate.kind === "canon" && ownedBy !== undefined) {
      // Counted, not hidden — the same discipline as a failed quote (D3). The user can see that
      // the document had world-level claims in it and re-file it at world scope to reach them.
      droppedReasons.push(`"${candidate.name}": canon cannot be proposed from an artifact owned by ${ownedBy}`);
      continue;
    }
    if (!excerptAppears(candidate.quote, sourceText)) {
      droppedReasons.push(`"${candidate.name}": quote not found in source`);
      continue;
    }
    if (candidate.kind !== "canon") {
      const allowed = SHEET_SECTIONS_ALLOWED[candidate.kind];
      const section = candidate.section ?? allowed[0]!;
      if (!allowed.includes(section)) {
        // A paragraph about a coat does not authorise inventing relationships (R-14, D4).
        droppedReasons.push(`"${candidate.name}": section "${section}" is not evidenceable from a document`);
        continue;
      }
      seen.add(hash);
      verified.push({
        hash,
        kind: candidate.kind,
        name: candidate.name,
        body: candidate.body,
        section,
        quote: candidate.quote,
        ...(candidate.line !== undefined ? { line: candidate.line } : {}),
      });
    } else {
      seen.add(hash);
      verified.push({
        hash,
        kind: "canon",
        name: candidate.name,
        body: candidate.body,
        quote: candidate.quote,
        ...(candidate.line !== undefined ? { line: candidate.line } : {}),
      });
    }
  }
  return { verified, droppedCount: droppedReasons.length, droppedReasons };
}

// ---------------------------------------------------------------------------
// Batch persistence on the sidecar (R-15..R-17)
// ---------------------------------------------------------------------------

async function updateSidecar(store: WorldStore, artifact: ArtifactSidecar, next: ArtifactSidecar): Promise<void> {
  const path = `artifacts/${artifact.file}.json`;
  const raw = await readFile(toExtendedLength(join(store.dir, path)), "utf8");
  await store.commit({
    kind: "artifact-extraction",
    source: "import",
    files: [{ path, action: "replace", content: JSON.stringify(next, null, 2) + "\n", baseHash: sha256(raw) }],
  });
}

/** Store the verified batch: ONE needs-you entry, granularity inside it (R-15, D5). */
export async function storeBatch(store: WorldStore, artifact: ArtifactSidecar, batch: VerifiedBatch): Promise<void> {
  const existing = artifact.extraction ?? { pending: [], decided: [], droppedCount: 0 };
  await updateSidecar(store, artifact, {
    ...artifact,
    extraction: {
      pending: [...existing.pending.filter((p) => !batch.verified.some((v) => v.hash === p.hash)), ...batch.verified],
      decided: existing.decided,
      droppedCount: existing.droppedCount + batch.droppedCount,
    },
  });
}

/**
 * Resolve one candidate (R-15): accepting commits individually through the gate, carrying the
 * source link; rejecting records the decision and leaves no world trace.
 */
export async function resolveCandidate(
  store: WorldStore,
  gate: ProposalManager,
  artifact: ArtifactSidecar,
  hash: string,
  decision: "accept" | "reject",
): Promise<void> {
  const extraction = artifact.extraction;
  if (!extraction) return;
  const candidate = extraction.pending.find((c) => c.hash === hash);
  if (!candidate) return;

  if (decision === "accept") {
    if (candidate.kind === "canon" && artifact.production !== undefined) {
      // Belt to `verifyCandidates`' braces (R-12). A canon candidate can only be here if it was
      // verified before the artifact was scoped, and accepting it would put a one-off's claim
      // into the world's settled truth by the back door.
      throw new Error(`canon cannot be extracted from an artifact owned by ${artifact.production}`);
    }
    if (candidate.kind === "canon") {
      const staged = await stageCanonEntry(store, gate, {
        entryType: "rule",
        title: candidate.name,
        // The accepted fact carries its source and the verified span (R-15).
        statement: `${candidate.body}\n\nSource: ${artifact.file} — "${candidate.quote}"`,
      });
      const outcome = await gate.accept(staged.id);
      if (outcome.status !== "accepted") throw new Error(`canon candidate did not land: ${outcome.status}`);
    } else {
      const kind = candidate.kind as SheetKind;
      const slug = uniqueSlug(candidate.name, kind, store.getBundle().sheets.map((s) => s.id));
      const shape = SHEET_SHAPES[kind];
      const section = candidate.section ?? shape.sections[0]!.heading;
      const content = buildSheetContent({
        id: slug,
        type: kind,
        name: candidate.name,
        status: "sketch",
        sections: { [section]: candidate.body },
        // A scoped artifact lifts a scoped cast (R-12): a treatment filed against one production
        // can populate its guest list in a pass without touching the world's.
        ...(artifact.production !== undefined ? { production: artifact.production } : {}),
        date: store.now().slice(0, 10),
      });
      const staged = await gate.stage({
        kind: "new-sheet",
        summary:
          artifact.production !== undefined
            ? `Extracted ${kind} for ${artifact.production}: ${candidate.name} (from ${artifact.file})`
            : `Extracted ${kind}: ${candidate.name} (from ${artifact.file})`,
        source: `import:${artifact.id}`,
        targets: [{ path: `${sheetDir(kind)}/${slug}.md`, content }],
        ...(artifact.production !== undefined ? { production: artifact.production } : {}),
      });
      const outcome = await gate.accept(staged.id);
      if (outcome.status !== "accepted") throw new Error(`sheet candidate did not land: ${outcome.status}`);
      // The accepted candidate links back to its source (R-15).
      const { addLinks } = await import("./filing.js");
      await addLinks(store, artifact, [slug]);
    }
  }

  const fresh = store.getBundle().artifacts.find((a) => a.id === artifact.id) ?? artifact;
  const freshExtraction = fresh.extraction ?? extraction;
  await updateSidecar(store, fresh, {
    ...fresh,
    extraction: {
      pending: freshExtraction.pending.filter((c) => c.hash !== hash),
      decided: [...freshExtraction.decided, hash],
      droppedCount: freshExtraction.droppedCount,
    },
  });
}
