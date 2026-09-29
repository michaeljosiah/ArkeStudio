import { z } from "zod";
export const GenesisReadinessFindingSchema = z.object({
  id: z.string(), category: z.enum(["blocker", "approval", "possible-conflict", "optional", "open"]),
  title: z.string(), detail: z.string(), records: z.array(z.object({ key: z.string(), text: z.string() }).strict()),
  leftOpen: z.boolean().default(false),
}).strict();
export const GenesisReadinessSchema = z.object({
  digest: z.string(), findings: z.array(GenesisReadinessFindingSchema), approved: z.array(z.object({ key: z.string(), title: z.string() }).strict()),
  reused: z.array(z.string()), canBegin: z.boolean(),
}).strict();
export type GenesisReadiness = z.infer<typeof GenesisReadinessSchema>;
