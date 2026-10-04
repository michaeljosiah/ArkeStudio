import { z } from "zod";
import { ArtifactIdSchema, ConversationActionIdSchema, ConversationIdSchema, IsoDateTimeSchema,
  ProposalIdSchema, SceneIdSchema, ShotIdSchema, SlugSchema, TurnIdSchema, UlidSchema } from "./ids.js";
import { StageConstructionDraftSchema, type StageConstructionDraft } from "./stage-construction.js";
import { VoiceSampleReviewSchema, type VoiceSampleReview } from "./voice-sample.js";
import { PerformanceIdSchema } from "./performance.js";

/** A constructed draft is a review authority, not an accepted scene (SPEC-051 R-19..R-22). */
export const STAGE_REVIEW_SCHEMA_VERSION = 56;
export interface StageReview {
  id: string;
  worldId: string;
  productionId: string;
  sceneId: string;
  shotId: string;
  baseVersion: number;
  conversationId: string;
  actionId: string;
  createdAt: string;
  draft: StageConstructionDraft;
  status: "pending" | "discarded";
}
export const StageReviewSchema: z.ZodType<StageReview> = z.object({
  id: z.string().uuid(), worldId: UlidSchema, productionId: SlugSchema, sceneId: SceneIdSchema,
  shotId: ShotIdSchema, baseVersion: z.number().int().positive(), conversationId: ConversationIdSchema,
  actionId: ConversationActionIdSchema, createdAt: IsoDateTimeSchema, draft: StageConstructionDraftSchema,
  status: z.enum(["pending", "discarded"]),
}).strict();

export type HumanDecisionControl =
  | { kind: "plan"; productionId: string; planId: string; passIndex: number; gate: "continue" | "reconfirm"; capMicroUsd: number; estimatedMicroUsd: number }
  | { kind: "proposal"; proposalId: string }
  | { kind: "editor-request"; productionId: string; requestId: string }
  | { kind: "extraction"; artifactId: string }
  | { kind: "voice-sample"; review: VoiceSampleReview }
  | { kind: "performance-review"; productionId: string; performanceId: string }
  | { kind: "stage-host"; productionId: string; sceneId: string; shotId: string; actionId: string; mode: "construct" | "playblast"; instruction?: string; preserve?: "blocking" | "camera" | "none" }
  | { kind: "stage-review"; review: StageReview };

/** Only the coordinator projects these controls. None is a model action or a permission grant. */
export const HumanDecisionControlSchema: z.ZodType<HumanDecisionControl> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), productionId: SlugSchema, planId: z.string().min(1).max(100),
    passIndex: z.number().int().nonnegative(), gate: z.enum(["continue", "reconfirm"]),
    capMicroUsd: z.number().int().nonnegative(), estimatedMicroUsd: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("proposal"), proposalId: ProposalIdSchema }).strict(),
  z.object({ kind: z.literal("editor-request"), productionId: SlugSchema, requestId: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("extraction"), artifactId: ArtifactIdSchema }).strict(),
  z.object({ kind: z.literal("voice-sample"), review: VoiceSampleReviewSchema }).strict(),
  z.object({ kind: z.literal("performance-review"), productionId: SlugSchema, performanceId: PerformanceIdSchema }).strict(),
  z.object({ kind: z.literal("stage-host"), productionId: SlugSchema, sceneId: SceneIdSchema, shotId: ShotIdSchema,
    actionId: ConversationActionIdSchema, mode: z.enum(["construct", "playblast"]),
    instruction: z.string().max(4000).optional(), preserve: z.enum(["blocking", "camera", "none"]).optional() }).strict(),
  z.object({ kind: z.literal("stage-review"), review: StageReviewSchema }).strict(),
]);

export interface HumanDecisionCard {
  id: string;
  worldId: string;
  conversationId: string;
  actionId?: string;
  turnId?: string;
  title: string;
  status: "pending" | "settled" | "blocked";
  detail?: string;
  body: { family: "human-decision"; reason: string; control: HumanDecisionControl };
}
export const HumanDecisionCardSchema: z.ZodType<HumanDecisionCard> = z.object({
  id: z.string().min(1).max(300), worldId: UlidSchema, conversationId: ConversationIdSchema,
  actionId: ConversationActionIdSchema.optional(), turnId: TurnIdSchema.optional(), title: z.string().min(1).max(200),
  status: z.enum(["pending", "settled", "blocked"]), detail: z.string().max(1000).optional(),
  body: z.object({ family: z.literal("human-decision"), reason: z.string().min(1).max(500), control: HumanDecisionControlSchema }).strict(),
}).strict();
