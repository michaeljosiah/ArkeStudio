import { z } from "zod";

/** Owner controls cross private desktop IPC only, never the remote command transport. */
export const RemoteAccessCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("enable") }),
  z.object({ kind: z.literal("disable") }),
  z.object({ kind: z.literal("pair") }),
  z.object({ kind: z.literal("approve"), id: z.string().uuid() }),
  z.object({ kind: z.literal("reject"), id: z.string().uuid() }),
  z.object({ kind: z.literal("revoke"), id: z.string().uuid() }),
  z.object({ kind: z.literal("startup"), enabled: z.boolean() }),
]);
export type RemoteAccessCommand = z.infer<typeof RemoteAccessCommandSchema>;
export interface RemoteAccessStatus {
  enabled: boolean;
  running: boolean;
  startOnLogin: boolean;
  startupSupported: boolean;
  url: string | null;
  reason: string | null;
  devices: Array<{ id: string; name: string; createdAt: number; expiresAt: number }>;
  pending: Array<{ id: string; name: string; expiresAt: number }>;
}
export interface RemoteAccessReply {
  status: RemoteAccessStatus;
  pairing?: { code: string; expiresAt: number };
}
