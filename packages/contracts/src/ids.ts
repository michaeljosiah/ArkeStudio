import { z } from "zod";

/**
 * Identifiers (master spec §2.3.1).
 *
 * Durable records are keyed on ULIDs, never on slugs: a slug is a filename and a user can
 * rename it, while the queue and ledger are global and outlive any one world. World ids are
 * bare ULIDs; other record kinds carry a short type prefix (`tk_`, `jb_`, `pr_`, …) so an id
 * read out of a log line identifies its kind on sight.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-char Crockford base32 ULID: 48-bit timestamp + 80-bit randomness. */
export function ulid(now: number = Date.now()): string {
  let time = now;
  const chars = Array.from<string>({ length: 26 });
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[time % 32]!;
    time = Math.floor(time / 32);
  }
  // Web Crypto — contracts are imported by the renderer too, so no node: builtins here.
  const rand = globalThis.crypto.getRandomValues(new Uint8Array(16));
  // 80 bits of randomness → 16 base32 chars (we generate 16 bytes and take 5 bits per char).
  for (let i = 0; i < 16; i++) {
    chars[10 + i] = CROCKFORD[rand[i]! % 32]!;
  }
  return chars.join("");
}

export const UlidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "expected a 26-char Crockford ULID");

/**
 * A genesis conversation's id. Not a ULID: it exists before the world does, and it names a
 * directory on disk, so it is held to what a directory name may safely be.
 */
export const GenesisIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{2,40}$/, "expected a genesis id: lowercase, digits and dashes");

/** Record-kind prefixes used across the world model and the app-level logs. */
export const ID_PREFIXES = {
  take: "tk",
  job: "jb",
  pass: "ps",
  proposal: "pr",
  artifact: "ar",
  commit: "cm",
  session: "sess",
  providerCall: "pc",
  // World Chat (#70 §5.1). Product identity is kept strictly separate from the harness's own
  // session ids: a provider session is an ephemeral implementation detail that may be replaced
  // between turns, and nothing durable is ever keyed on one.
  conversation: "cv",
  turn: "turn",
  message: "msg",
  run: "run",
  checkReceipt: "check",
  candidate: "cand",
  candidateGroup: "grp",
  chatAttachment: "wca",
  chatEvent: "wce",
} as const;

export type IdPrefix = (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export function prefixedIdSchema(prefix: IdPrefix): z.ZodString {
  return z.string().regex(new RegExp(`^${prefix}_[0-9A-HJKMNP-TV-Z]{26}$`), `expected a ${prefix}_<ULID> id`);
}

export const TakeIdSchema = prefixedIdSchema("tk");
export const JobIdSchema = prefixedIdSchema("jb");
export const PassIdSchema = prefixedIdSchema("ps");
export const ProposalIdSchema = prefixedIdSchema("pr");
export const ArtifactIdSchema = prefixedIdSchema("ar");
export const ProviderCallIdSchema = prefixedIdSchema("pc");

export const ConversationIdSchema = prefixedIdSchema("cv");
export const TurnIdSchema = prefixedIdSchema("turn");
export const MessageIdSchema = prefixedIdSchema("msg");
export const RunIdSchema = prefixedIdSchema("run");
export const CheckReceiptIdSchema = prefixedIdSchema("check");
export const CandidateIdSchema = prefixedIdSchema("cand");
export const CandidateGroupIdSchema = prefixedIdSchema("grp");
export const ChatAttachmentIdSchema = prefixedIdSchema("wca");
export const ChatEventIdSchema = prefixedIdSchema("wce");

/** The World Chat ids all carry their type; this one predates them and had only a schema. */
export type ProposalId = z.infer<typeof ProposalIdSchema>;

export type ConversationId = z.infer<typeof ConversationIdSchema>;
export type TurnId = z.infer<typeof TurnIdSchema>;
export type MessageId = z.infer<typeof MessageIdSchema>;
export type RunId = z.infer<typeof RunIdSchema>;
export type CheckReceiptId = z.infer<typeof CheckReceiptIdSchema>;
export type CandidateId = z.infer<typeof CandidateIdSchema>;
export type CandidateGroupId = z.infer<typeof CandidateGroupIdSchema>;
export type ChatAttachmentId = z.infer<typeof ChatAttachmentIdSchema>;

/**
 * Entity slugs are filenames (master spec §2.2): lowercase kebab-case, no spaces. Kept
 * conservative so every slug is safe on NTFS and case-insensitive filesystems.
 */
export const SlugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "expected a lowercase kebab-case slug");

/** Canon ids are human-scale and monotonic: CANON-001, CANON-002, … never reused (R-CANON-4). */
export const CanonIdSchema = z.string().regex(/^CANON-\d{3,}$/, "expected CANON-nnn");

/** Scene / shot ids are human-numbered within their production: sc_04, sh_12. */
export const SceneIdSchema = z.string().regex(/^sc_[a-z0-9-]+$/, "expected sc_<n>");
export const ShotIdSchema = z.string().regex(/^sh_[a-z0-9-]+$/, "expected sh_<n>");

export const Sha256Schema = z.string().regex(/^sha256:[0-9a-f]{8,64}$/, "expected sha256:<hex>");

export const IsoDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/, "expected an ISO date-time");

/** Frontmatter dates are date-only or date-time; both are accepted wherever a date is displayed. */
export const IsoDateSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/,
    "expected an ISO date",
  );
