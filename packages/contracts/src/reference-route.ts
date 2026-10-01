import type { ArtifactSidecar } from "./artifact.js";
import type { BenchReferenceToken } from "./bench.js";
import type { ManifestModel } from "./manifest.js";

/**
 * A local recipe's reference route (design turn 179): the same checkpoint, the same sampling and
 * the same adapter slot as its text-to-video graph, with the pictures going in as references —
 * who is in the clip — instead of as the frame it opens on.
 *
 * Everything here is shared by the composer, which says before Generate what dispatch would say,
 * and the bench's gate, which says it again with the authority to refuse. Two copies of the
 * subject line or of the refusal clause would be two places for a take and its record to differ.
 */

export const REFERENCE_ROUTE = "reference" as const;

/** What a picture is called when nobody has said who it is. */
export const DEFAULT_REFERENCE_WHO = "the person";

/**
 * The row as its Reference lane sees it: the route's own picture budget and citation grammar in
 * place of the row's first-frame budget. A row with no route is returned unchanged.
 *
 * A view rather than a second manifest row because nothing else about the model changes — the
 * lengths, the sizes, the price and the sampling are the row's — and a second row would have to
 * be kept in step with all of them.
 */
export function referenceRouteModel(model: ManifestModel): ManifestModel {
  const route = model.referenceRoute;
  if (route === undefined) return model;
  return {
    ...model,
    accepts: { ...model.accepts, referenceImages: route.maxImages },
    limits: { ...model.limits, referenceSyntax: route.referenceSyntax },
  };
}

/** "Local · H3 Video 768p" → "H3 Video 768p": the clause names the model, not where it runs. */
export function shortModelName(model: Pick<ManifestModel, "displayName">): string {
  return model.displayName.replace(/^Local · /, "");
}

/**
 * The one clause a local video row without a reference route answers pictures with (design
 * 179c). The picture stays in the tray — switching back to a row that has the route should not
 * cost the author their pick — and Generate waits.
 *
 * Narrowed to local video rows that take no picture at all: a cloud row's reference budget is
 * its own route and already says what it takes, and a local row with a picture budget either
 * has this route or binds the picture natively.
 */
export function referenceRouteRefusal(model: ManifestModel, pictures: number): string | null {
  if (pictures === 0 || model.referenceRoute !== undefined) return null;
  if (model.provider !== "comfyui" || model.capability !== "video" || model.accepts.referenceImages > 0) return null;
  return `${shortModelName(model)} takes no reference pictures yet`;
}

/**
 * The character sheet a picture came from, when it came from one: a subject prefill names it,
 * a pick from a character's folder carries it in its path, and a picture filed from a character
 * reference names it in its sidecar.
 */
export function referenceSheetId(
  entry: Pick<BenchReferenceToken, "sheetId" | "source">,
  artifacts: readonly Pick<ArtifactSidecar, "id" | "generation">[],
): string | undefined {
  if (entry.sheetId !== undefined) return entry.sheetId;
  const source = entry.source;
  if (source.source === "world-file") return /^references\/([^/]+)\//.exec(source.path)?.[1];
  if (source.source === "artifact") {
    const generation = artifacts.find((artifact) => artifact.id === source.artifactId)?.generation;
    return generation?.source === "character-reference" ? generation.sheetId : undefined;
  }
  return undefined;
}

/** The Cast name a picture carries, or undefined for a picture that is nobody in the Cast. */
export function castNameFor(
  entry: Pick<BenchReferenceToken, "sheetId" | "source">,
  world: {
    sheets: readonly { id: string; name: string }[];
    artifacts: readonly Pick<ArtifactSidecar, "id" | "generation">[];
  },
): string | undefined {
  const sheetId = referenceSheetId(entry, world.artifacts);
  return sheetId === undefined ? undefined : world.sheets.find((sheet) => sheet.id === sheetId)?.name;
}

/**
 * A typed label, made safe to put inside a subject line: one line, no tags, at most 80
 * characters. Angle brackets go because they are H3's own grammar — a label reading
 * "<Picture 2>" would cite a picture the author did not cite.
 */
export function cleanWho(text: string | undefined): string {
  return (text ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Who a picture is: its Cast name, else what was typed, else the default. */
export function whoFor(castName: string | undefined, typed: string | undefined): string {
  return cleanWho(castName) || cleanWho(typed) || DEFAULT_REFERENCE_WHO;
}

/**
 * The lines Arke prepends, one per picture, in the order the pictures ride: MiniMax's reference
 * guide asks for a picture used for identity to be named as a subject, and a bare picture tag
 * reads as a composition to copy. Nothing else in the brief is rewritten.
 */
export function referenceSubjectLines(whos: readonly string[]): string[] {
  return whos.map((who, index) => `<Subject ${index + 1}> is ${who}, shown in <Picture ${index + 1}>.`);
}
