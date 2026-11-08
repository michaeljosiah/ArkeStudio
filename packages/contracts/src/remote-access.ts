import { REMOTE_COMMAND_ACCESS, type RemoteHostCommand } from "./remote-command-access.js";
import { z } from "zod";

export const RemotePairingDurationSchema = z.union([z.literal(30), z.literal(90), z.literal(120), z.literal("never")]);
export type RemotePairingDuration = z.infer<typeof RemotePairingDurationSchema>;

/** Owner controls cross private desktop IPC only, never the remote command transport. */
export const RemoteAccessCommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status") }),
  z.object({ kind: z.literal("enable") }),
  z.object({ kind: z.literal("disable") }),
  z.object({ kind: z.literal("pair") }),
  z.object({ kind: z.literal("copy-link") }),
  z.object({ kind: z.literal("approve"), id: z.string().uuid() }),
  z.object({ kind: z.literal("reject"), id: z.string().uuid() }),
  z.object({ kind: z.literal("revoke"), id: z.string().uuid() }),
  z.object({ kind: z.literal("startup"), enabled: z.boolean() }),
  z.object({ kind: z.literal("duration"), duration: RemotePairingDurationSchema }),
]);
export type RemoteAccessCommand = z.infer<typeof RemoteAccessCommandSchema>;
export interface RemoteAccessStatus {
  enabled: boolean;
  running: boolean;
  startOnLogin: boolean;
  startupSupported: boolean;
  pairingDuration: RemotePairingDuration;
  url: string | null;
  reason: string | null;
  devices: Array<{ id: string; name: string; createdAt: number; expiresAt: number | null }>;
  pending: Array<{ id: string; name: string; expiresAt: number }>;
}
export interface RemoteAccessReply {
  status: RemoteAccessStatus;
  pairing?: { code: string; expiresAt: number };
  copied?: boolean;
}

/** Named refusals include mixed commands whose host-only payload is checked separately. */
export { REMOTE_COMMAND_ACCESS, REMOTE_PREPARED_ACTION_ACCESS, isRemoteHostCommand, isRemoteHostConversationAction } from "./remote-command-access.js";
export const REMOTE_HOST_ONLY_COMMANDS = Object.entries(REMOTE_COMMAND_ACCESS)
  .filter(([, access]) => access === "host" || access === "payload").map(([kind]) => kind) as [RemoteHostCommand, ...RemoteHostCommand[]];
const CLIENT_COMMAND_KINDS = Object.keys(REMOTE_COMMAND_ACCESS) as [keyof typeof REMOTE_COMMAND_ACCESS, ...(keyof typeof REMOTE_COMMAND_ACCESS)[]];
export const RemoteCommandRefusalSchema = z.discriminatedUnion("refused", [
  z.object({
    kind: z.literal("command-refused"), refused: z.literal("host-only"),
    command: z.enum(REMOTE_HOST_ONLY_COMMANDS),
  }).strict(),
  // A command that failed its schema, from the coordinator or the remote gateway (issue 2778).
  z.object({
    kind: z.literal("command-refused"), refused: z.literal("invalid"),
    command: z.enum(CLIENT_COMMAND_KINDS).optional(), requestId: z.string().min(1).max(128).optional(),
  }).strict(),
]);
export type RemoteCommandRefusal = z.infer<typeof RemoteCommandRefusalSchema>;

/**
 * The answer to valid JSON that fails the client message schema, or null when there is no one
 * to answer. Dropped without a word, a screen waiting on the request kept its controls disabled
 * for good (issue 2778). Only a known command kind and a plain request id are echoed: the rest of
 * the message is never read back, and a kind from a newer build without an id stays a quiet drop.
 */
export function invalidCommandRefusal(input: unknown): RemoteCommandRefusal | null {
  const { kind, requestId } = (typeof input === "object" && input !== null ? input : {}) as { kind?: unknown; requestId?: unknown };
  const command = typeof kind === "string" && Object.hasOwn(REMOTE_COMMAND_ACCESS, kind) ? kind as keyof typeof REMOTE_COMMAND_ACCESS : undefined;
  const id = typeof requestId === "string" && /^[\x21-\x7e]{1,128}$/.test(requestId) ? requestId : undefined;
  if (command === undefined && id === undefined) return null;
  return { kind: "command-refused", refused: "invalid", ...(command !== undefined ? { command } : {}), ...(id !== undefined ? { requestId: id } : {}) };
}
/** Only the authenticating device, with no registry IDs, proofs or other devices. */
export const RemoteDeviceInfoSchema = z.object({
  name: z.string(), pairedAt: z.number(), expiresAt: z.number().nullable(),
}).strict();
export type RemoteDeviceInfo = z.infer<typeof RemoteDeviceInfoSchema>;
