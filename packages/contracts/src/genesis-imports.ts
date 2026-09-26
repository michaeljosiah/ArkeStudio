import { z } from "zod";

export const FOUNDING_IMPORTS_SCHEMA_VERSION = 31;
export const GenesisSourceSchema = z.object({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/), name: z.string().min(1).max(240),
  quote: z.string().min(1).max(8000), line: z.number().int().positive(),
  candidateId: z.string().regex(/^[a-f0-9]{64}$/),
  originalName: z.string(), originalBody: z.string(), modified: z.boolean(),
}).strict();
export type GenesisSource = z.infer<typeof GenesisSourceSchema>;
export const GenesisImportProposalSchema = z.object({
  source: z.string().min(1).max(240), kind: z.enum(["character", "location", "faction", "canon"]),
  name: z.string().min(1).max(120), body: z.string().min(1).max(6000),
  quote: z.string().min(1).max(8000), section: z.string().max(80).optional(),
  links: z.array(z.string().regex(/^(character|location|faction):[a-z0-9][a-z0-9-]*$/)).max(50).optional(),
}).strict();
export const GenesisImportCardSchema = z.object({
  id: z.string(), digest: z.string(), proposal: GenesisImportProposalSchema, source: GenesisSourceSchema,
  matches: z.array(z.object({ key: z.string(), name: z.string(), text: z.string() }).strict()),
  related: z.array(z.object({ source: z.string(), name: z.string(), text: z.string() }).strict()).default([]),
  status: z.enum(["pending", "prepared", "rejected", "deferred"]), target: z.string().optional(),
}).strict();
export type GenesisImportCard = z.infer<typeof GenesisImportCardSchema>;
export const GenesisImportsSchema = z.object({
  cards: z.array(GenesisImportCardSchema), problems: z.array(z.string()),
  documents: z.array(z.object({ name: z.string(), supported: z.boolean(), detail: z.string() }).strict()),
}).strict();
export type GenesisImports = z.infer<typeof GenesisImportsSchema>;
export const GenesisImportResolveSchema = z.object({
  id: z.string(), digest: z.string(), decision: z.enum(["prepare", "reject", "defer"]),
  name: z.string().min(1).max(120).optional(), body: z.string().min(1).max(6000).optional(),
  target: z.string().regex(/^(character|location|faction|canon):[a-z0-9][a-z0-9-]*$/).optional(),
  mode: z.enum(["distinct", "append", "replace"]).optional(),
}).strict();
export type GenesisImportResolve = z.infer<typeof GenesisImportResolveSchema>;
