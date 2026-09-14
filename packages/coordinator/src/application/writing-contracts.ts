import { z } from "zod";
import { ChapterSummarySchema, ConversationIdSchema, ProposalSchema, type HarnessAdapter } from "@arke-studio/contracts";
import type { EngineContext, EngineResource, EnginePolicy } from "./contracts.js";
import { proseId } from "./prose-contracts.js";

export const writingInput = z.object({
  operationId: z.string().min(1).max(500).refine(s => s.trim().length > 0),
  expectedRevision: z.string().min(1),
  baseHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  instruction: z.string().min(1).max(20000).refine(s => s.trim().length > 0),
  modelId: z.string().min(1).max(200),
}).strict();
export const writingResult = z.object({
  productionId: proseId, chapterId: proseId, conversationId: ConversationIdSchema, title: ChapterSummarySchema.shape.title,
  proposal: ProposalSchema, body: z.string().min(1).max(2000000).refine(body => body.trim().length > 0),
  groundingHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(value => value.proposal.kind === "chapter-draft" && value.proposal.targets.length === 1 &&
  value.proposal.targets[0]!.path.startsWith(`productions/${value.productionId}/chapters/`) &&
  !value.proposal.targets[0]!.path.slice(`productions/${value.productionId}/chapters/`.length).match(/[\\/:]/) &&
  value.proposal.targets[0]!.path.endsWith(".md") && value.proposal.origin?.conversationId === value.conversationId,
  "The writing proposal identity is invalid.");
export type WritingInput = z.infer<typeof writingInput>;
export type WritingResult = z.infer<typeof writingResult>;

/** The host owns model access, allowance and session confinement. No default paid provider. */
export interface WritingRuntime {
  adapter: HarnessAdapter;
  /** A private scratch directory outside every materialised world. */
  cwd: string;
  inputTokenLimit: number;
  sessionModel: string;
  createSession(input: { cwd: string; model: string }): Promise<{ sessionId: string }>;
  /** Drain provider work and record operator usage. This does not authorize a product charge. */
  close(): Promise<void>;
}
export type WritingRuntimeFactory = (input: {
  context: EngineContext; resource: EngineResource; operationKey: string; modelId: string; signal: AbortSignal;
}) => Promise<WritingRuntime>;

export interface EngineWritingSession {
  /** Read the authoritative staged chapter, independently of the model/run receipt. */
  review(proposalId: string): Promise<{ proposal: WritingResult["proposal"]; title: string; body: string }>;
  run(productionId: string, chapterId: string, input: WritingInput, options: {
    mode: "draft" | "revise"; context: EngineContext; operationKey: string;
    policy: EnginePolicy; runtime: WritingRuntimeFactory; signal: AbortSignal;
  }): Promise<WritingResult>;
}
