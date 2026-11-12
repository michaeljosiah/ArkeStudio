import { z } from "zod";
import { SceneIdSchema, ShotIdSchema } from "./ids.js";

export const StoryLiteralSchema = z.union([z.boolean(), z.string().min(1).max(64)]);
const FactId = z.string().regex(/^[a-z][a-z0-9-]*$/).max(64);
export const StoryFactSchema = z.discriminatedUnion("type", [
  z.object({ id: FactId, label: z.string().trim().min(1).max(256), type: z.literal("boolean"), default: z.boolean() }).strict(),
  z.object({ id: FactId, label: z.string().trim().min(1).max(256), type: z.literal("enum"), values: z.array(z.string().min(1).max(64)).min(1).max(16), default: z.string().min(1).max(64) }).strict(),
]);
export type StoryFact = z.infer<typeof StoryFactSchema>;
export type StoryPredicate = { op: "eq"; fact: string; value: boolean | string } | { op: "not"; arg: StoryPredicate } | { op: "all" | "any"; args: StoryPredicate[] };
// Depth is checked before recursion, including malformed inputs, rather than only after parsing.
const condition = (depth: number): z.ZodType<StoryPredicate> => depth > 8 ? z.never() : z.lazy(() => z.union([
  z.object({ op: z.literal("eq"), fact: FactId, value: StoryLiteralSchema }).strict(),
  z.object({ op: z.literal("not"), arg: condition(depth + 1) }).strict(),
  z.object({ op: z.enum(["all", "any"]), args: z.array(condition(depth + 1)).min(1).max(128) }).strict(),
]));
export const StoryPredicateSchema = condition(1).superRefine((predicate, ctx) => {
  const pending = [predicate];
  let count = 0;
  while (pending.length) {
    const next = pending.pop()!;
    if (++count > 128) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Story condition exceeds 128 nodes" }); break; }
    if (next.op === "not") pending.push(next.arg);
    else if (next.op !== "eq") pending.push(...next.args);
  }
});
export const StoryEffectSchema = z.object({ fact: FactId, value: StoryLiteralSchema }).strict();
export type StoryEffect = z.infer<typeof StoryEffectSchema>;
export const StoryPresentationSchema = z.object({
  sceneId: SceneIdSchema,
  blocks: z.array(z.object({ blockId: z.string().regex(/^blk_[a-z0-9-]+$/), when: StoryPredicateSchema }).strict()),
  shots: z.array(z.object({ shotId: ShotIdSchema, when: StoryPredicateSchema }).strict()),
}).strict();
export type StoryPresentation = z.infer<typeof StoryPresentationSchema>;
const EndingFields = { id: z.string().min(1).max(64), title: z.string().min(1).max(256), text: z.string() };
export const StoryEndingSchema = z.union([
  z.object({ ...EndingFields, when: StoryPredicateSchema }).strict(),
  z.object({ ...EndingFields, fallback: z.literal(true) }).strict(),
]);
export type StoryEnding = z.infer<typeof StoryEndingSchema>;
