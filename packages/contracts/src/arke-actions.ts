import { z } from "zod";
import type { ZodType } from "zod";
import type { ClientMessage } from "./frames.js";

/** The closed parity classes required by SPEC-041 R-47. */
export const ArkeCommandClassificationSchema = z.enum([
  "supported-by-arke",
  "human-only-control-plane",
  "read-only",
  "out-of-scope-global",
]);
export type ArkeCommandClassification = z.infer<typeof ArkeCommandClassificationSchema>;

/** Arke acts only inside an open creative workspace. */
export const ArkeActionScopeSchema = z.enum(["world", "production"]);
export type ArkeActionScope = z.infer<typeof ArkeActionScopeSchema>;

export const ArkeCardFamilySchema = z.enum([
  "authored-diff",
  "command",
  "destructive",
  "take-review",
  "generation",
  "host-action",
  "setting",
]);
export type ArkeCardFamily = z.infer<typeof ArkeCardFamilySchema>;

/** Existing durable authorities. The common action protocol never replaces one of these. */
export const ArkeActionAuthoritySchema = z.enum([
  "world-store",
  "proposal-manager",
  "bible",
  "reference-kit",
  "voice",
  "production-store",
  "scene-store",
  "chapter-store",
  "frame-run",
  "dispatch-plan",
  "routing",
  "board",
  "take-review",
  "timeline",
  "audio-cut",
  "audio-spine",
  "artifact-store",
  "extraction",
  "bench",
  "job-queue",
  "export",
  "host",
]);
export type ArkeActionAuthority = z.infer<typeof ArkeActionAuthoritySchema>;

export const ArkePermissionReasonSchema = z.enum([
  "authored-change",
  "destructive-change",
  "spend-and-compute",
  "external-network-action",
  "privacy-sensitive",
  "host-file-access",
  "export",
  "world-administration",
]);
export type ArkePermissionReason = z.infer<typeof ArkePermissionReasonSchema>;

/** Records that may have to be read completely before an action can be prepared. */
export const ArkeReadRequirementSchema = z.enum([
  "world-metadata",
  "canon",
  "sheets",
  "bible",
  "art-direction",
  "references",
  "artifacts",
  "voices",
  "production-metadata",
  "series",
  "seasons",
  "episodes",
  "chapters",
  "scenes",
  "shots",
  "stage",
  "boards",
  "takes",
  "timeline",
  "audio",
  "subtitles",
  "spine",
  "routing",
  "plans",
  "jobs",
  "exports",
  "bench",
]);
export type ArkeReadRequirement = z.infer<typeof ArkeReadRequirementSchema>;

/** Named seams make an unavailable operation discoverable without pretending it is safe. */
export const ArkeBlockingSeamSchema = z.enum([
  "typed-sheet-target",
  "typed-media-target",
  "typed-world-target",
  "typed-scene-target",
  "typed-chapter-target",
  "typed-routing-command",
  "typed-audio-command",
  "typed-audio-spine-command",
  "typed-artifact-source",
  "durable-generation-quote",
  "coordinator-owned-generation-quote",
  "complete-timeline-read",
  "complete-spine-read",
]);
export type ArkeBlockingSeam = z.infer<typeof ArkeBlockingSeamSchema>;

export type ArkeCapabilitySupport =
  | { readonly state: "available" }
  | {
      readonly state: "blocked";
      readonly blockingSeams: readonly ArkeBlockingSeam[];
      readonly reason: string;
    };

export interface ArkeActionSupport {
  /** Whether a strict, model-safe payload can represent this operation. */
  readonly preparation: ArkeCapabilitySupport;
  /** Whether every record required to fence the payload can currently be read completely. */
  readonly reads: ArkeCapabilitySupport;
  /** Whether the existing authority has an exact semantic command seam. */
  readonly execution: ArkeCapabilitySupport;
}

export type ClientMessageKind = ClientMessage["kind"];
export type ClientMessageOfKind<K extends ClientMessageKind> = Extract<ClientMessage, { kind: K }>;

/** Metadata shared by registered client commands and intended authorities with no client seam yet. */
export interface ArkeActionDescriptor<K extends string, TAction extends { kind: K }> {
  readonly kind: K;
  readonly schema: ZodType<TAction>;
  readonly scope: ArkeActionScope;
  readonly cardFamily: ArkeCardFamily;
  readonly authority: ArkeActionAuthority;
  readonly permissionReason: ArkePermissionReason;
  readonly requiredReads: readonly ArkeReadRequirement[];
  readonly support: ArkeActionSupport;
}

export interface ArkeSupportedClientCommand<K extends ClientMessageKind>
  extends ArkeActionDescriptor<K, ClientMessageOfKind<K>> {
  readonly classification: "supported-by-arke";
}

export interface ArkeExcludedClientCommand<K extends ClientMessageKind> {
  readonly kind: K;
  readonly schema: ZodType<ClientMessageOfKind<K>>;
  readonly classification: Exclude<ArkeCommandClassification, "supported-by-arke">;
  readonly reason: string;
}

export type ArkeClientCommandDescriptor<K extends ClientMessageKind = ClientMessageKind> =
  | ArkeSupportedClientCommand<K>
  | ArkeExcludedClientCommand<K>;

/** A coordinator-owned observation supplied to preparation, never a model-authored fence. */
export interface ArkeReadObservation {
  readonly requirement: ArkeReadRequirement;
  readonly target: string;
  readonly revisionOrDigest: string;
  readonly complete: boolean;
}

export interface ArkePreparedAction<TPreview> {
  readonly preview: TPreview;
  readonly baseObservations: readonly ArkeReadObservation[];
}

/**
 * Preparation only. Approval, persistence and execution deliberately remain outside issue #803;
 * adding them here would create a second, generic command path before the card protocol exists.
 */
export interface ArkeActionAdapter<
  K extends string,
  TAction extends { kind: K },
  TPreview,
> {
  readonly descriptor: ArkeActionDescriptor<K, TAction>;
  prepare(
    action: TAction,
    observations: readonly ArkeReadObservation[],
  ): Promise<ArkePreparedAction<TPreview>>;
}
