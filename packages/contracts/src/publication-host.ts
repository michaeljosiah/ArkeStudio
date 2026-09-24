import type { VideoPublicationManifest } from "./publication.js";
import type { VideoPublicationRequest } from "./publication-video.js";

/** SPEC-048: renderer identifiers are opaque; host paths and recovery records stay private. */
export interface PublicationPlayback {
  sessionId: string;
  manifest: VideoPublicationManifest;
  manifestSha256: string;
  mediaType: string;
  assets: Record<string, string>;
}
export interface PublicationJob {
  operationId: string;
  worldId: string;
  productionId: string;
  title: string;
  status: "interrupted" | "running" | "completed" | "failed" | "cancelled";
  phase: string;
  reason?: string;
  /** False when recovery requires a new edition instead of repeating the saved operation. */
  retryable?: boolean;
}
export type PublicationReply<T> = { ok: true; value: T } | { ok: false; reason: string; cancelled?: boolean };
export interface PublicationBridge {
  open(kind: "directory" | "zip" | { operationId: string }): Promise<PublicationReply<PublicationPlayback>>;
  close(sessionId: string): Promise<void>;
  list(): Promise<PublicationReply<PublicationJob[]>>;
  start(input: { worldId: string; request: VideoPublicationRequest; format: "directory" | "zip" }): Promise<PublicationReply<PublicationJob>>;
  retry(operationId: string): Promise<PublicationReply<PublicationJob>>;
  cancel(operationId: string): Promise<void>;
  reveal(operationId: string): Promise<PublicationReply<null>>;
}
