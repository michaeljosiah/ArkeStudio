import { z } from "zod";

/**
 * Vendor sign-in through the harness (SPEC-030): a person's own model subscription, connected
 * by the harness's sign-in API and held in the harness's own store. Arke never holds a token.
 *
 * Every id and label here is the harness's, verbatim (R-7, D12). Vendor ids are free strings
 * deliberately — `ProviderId` is a closed enum of the providers Arke dispatches with, and this
 * list changes with the harness's version, not with Arke's.
 */

// ---------------------------------------------------------------------------
// What a vendor offers: methods, sometimes with a small form
// ---------------------------------------------------------------------------

/** One choice on a form field, in the harness's words. */
export const VendorFormOptionSchema = z
  .object({
    value: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1).nullable().default(null),
  })
  .strict();
export type VendorFormOption = z.infer<typeof VendorFormOptionSchema>;

/**
 * One field a sign-in method asks for before it can begin — GitHub Copilot's deployment type,
 * an enterprise URL. Text unless `options` narrows it to a pick. `whenEquals` gates the field
 * on an earlier answer; the only operator the harness uses is equality, so that is all this
 * carries.
 */
export const VendorFormFieldSchema = z
  .object({
    key: z.string().min(1),
    title: z.string().min(1),
    required: z.boolean().default(false),
    placeholder: z.string().min(1).nullable().default(null),
    options: z.array(VendorFormOptionSchema).nullable().default(null),
    whenEquals: z.array(z.object({ key: z.string().min(1), value: z.string() }).strict()).default([]),
  })
  .strict();
export type VendorFormField = z.infer<typeof VendorFormFieldSchema>;

/**
 * One way to sign in, as the harness reports it. `oauth` hands off to the vendor's own page;
 * `key` takes a typed secret. The harness also reports `env` methods — those are how a
 * configured key reaches it, not something a person does, so they are not offered here.
 *
 * `id` is null for key methods because the harness gives them none: a vendor has one key
 * method, addressed by the vendor alone.
 */
export const VendorAuthMethodSchema = z
  .object({
    id: z.string().min(1).nullable(),
    kind: z.enum(["oauth", "key"]),
    label: z.string().min(1),
    fields: z.array(VendorFormFieldSchema).default([]),
  })
  .strict();
export type VendorAuthMethod = z.infer<typeof VendorAuthMethodSchema>;

// ---------------------------------------------------------------------------
// What exists now: connections
// ---------------------------------------------------------------------------

/**
 * One connection a vendor currently has. `stored` is a credential the harness keeps — a
 * subscription sign-in or a typed key; the harness does not say which, and claiming to know
 * would be invention. `env` is a key handed to the harness at spawn: Studio's own configured
 * key, as the harness sees it (R-11).
 */
export const VendorConnectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("stored"), id: z.string().min(1), label: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("env"), name: z.string().min(1) }).strict(),
]);
export type VendorConnection = z.infer<typeof VendorConnectionSchema>;

/** One vendor on the sign-in surface: what it offers, what it has, whether it needs attention. */
export const VendorIntegrationSchema = z
  .object({
    /** The harness's integration id, e.g. "openai". Free string by design (R-7). */
    id: z.string().min(1),
    /** The vendor's display name, the harness's own. */
    name: z.string().min(1),
    methods: z.array(VendorAuthMethodSchema),
    connections: z.array(VendorConnectionSchema),
    /** R-13: a turn failed because this vendor's token could not be refreshed. Cleared by a
     * successful sign-in or removal. Presence-only otherwise — readiness never claims health
     * (R-14). */
    needsSignIn: z.boolean().default(false),
  })
  .strict();
export type VendorIntegration = z.infer<typeof VendorIntegrationSchema>;

// ---------------------------------------------------------------------------
// A sign-in under way
// ---------------------------------------------------------------------------

/**
 * The one sign-in in flight, if any. One at a time deliberately: two browser hand-offs at once
 * is a state nobody asked for and no screen can render honestly.
 *
 * `instructions` is shown verbatim — for a device flow it carries the code the person types on
 * the vendor's page (§2.2). `codeEntry` is true when the vendor hands the person a code to
 * bring back, and Arke must show a field for it; the code passes through to the harness and is
 * not retained (R-1).
 */
export const VendorSignInSchema = z
  .object({
    vendor: z.string().min(1),
    /** The chosen method's label, the harness's words. */
    method: z.string().min(1),
    phase: z.enum(["waiting", "failed"]),
    instructions: z.string().min(1).nullable().default(null),
    codeEntry: z.boolean().default(false),
    /** The stated reason, when the phase is failed — the harness's message or the bounded
     * wait's outcome. */
    detail: z.string().min(1).nullable().default(null),
  })
  .strict();
export type VendorSignIn = z.infer<typeof VendorSignInSchema>;

// ---------------------------------------------------------------------------
// The whole surface, published as one piece
// ---------------------------------------------------------------------------

/**
 * How an existing sign-in on this machine relates to Arke's own state (SPEC-030 §2.3, R-4).
 *
 * `none`: nothing to carry — no personal harness state exists. `unavailable`: personal state
 * exists but cannot be shared, with the reason stated; the person signs in through Arke
 * instead and loses a step, not a capability (D7). The measured build keeps credentials in
 * its database rather than a shareable file, so `linked` — one file, two names — is reserved
 * for a harness build whose store makes it possible again.
 */
export const VendorCarrySchema = z.enum(["none", "unavailable", "linked"]);
export type VendorCarry = z.infer<typeof VendorCarrySchema>;

export const VendorAuthStatusSchema = z
  .object({
    /** Whether this harness lane can sign a person in at all. Stated, never inferred (R-12). */
    available: z.boolean(),
    /** The reason, whenever `available` is false — or a fault worth stating while it is true. */
    reason: z.string().min(1).nullable().default(null),
    carry: VendorCarrySchema.default("none"),
    /** The stated limitation, when carry is `unavailable` (R-4). */
    carryDetail: z.string().min(1).nullable().default(null),
    vendors: z.array(VendorIntegrationSchema).default([]),
    signIn: VendorSignInSchema.nullable().default(null),
  })
  .strict();
export type VendorAuthStatus = z.infer<typeof VendorAuthStatusSchema>;

/** The empty surface: what a lane with no sign-in support publishes, reason attached. */
export function vendorAuthUnavailable(reason: string): VendorAuthStatus {
  return { available: false, reason, carry: "none", carryDetail: null, vendors: [], signIn: null };
}
