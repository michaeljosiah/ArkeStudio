import { z } from "zod";

/**
 * The Arke account the app is signed in to, as every snapshot carries it (design turn 151).
 *
 * Studio runs whole without one — SPEC-025's premise, a machine with no network and no account
 * — so the resting state is signed out and nothing local reads this. A configured host may
 * supply an optional creator account; this state never carries its credentials or claims
 * billing entitlement. The local default refuses cloud sign-in when it is unconfigured.
 */

export const AccountPersonSchema = z
  .object({
    name: z.string().min(1),
    email: z.string().min(1),
    /**
     * An address the renderer may load for the picture, or null for initials. The desktop's
     * CSP admits only the page's own origin, data URLs and loopback, so this is the
     * coordinator's own media route or a data URL — a service fetches the cloud's picture and
     * serves it itself; a remote address here would draw as a broken image (SPEC-025 R-27).
     */
    picture: z.string().nullable(),
  })
  .strict();
export type AccountPerson = z.infer<typeof AccountPersonSchema>;

export const AccountPlanSchema = z
  .object({
    /** The plan's name as the badge shows it: `Free`, or whatever the paid tier is called. */
    name: z.string().min(1),
    /** Decides the row's one action: `Upgrade` while free, `Manage` once paid. */
    paid: z.boolean(),
  })
  .strict();
export type AccountPlan = z.infer<typeof AccountPlanSchema>;

export const AccountPageSchema = z.enum(["account", "plan"]);
export type AccountPage = z.infer<typeof AccountPageSchema>;

export const AccountStateSchema = z.discriminatedUnion("kind", [
  /** No one signed in. `refusal` is the one clause a refused sign-in leaves under the title. */
  z.object({ kind: z.literal("signed-out"), refusal: z.string().nullable() }).strict(),
  /** The sign-in has been handed to the browser and the app is waiting for it to come back. */
  z.object({ kind: z.literal("signing-in") }).strict(),
  z
    .object({
      kind: z.literal("signed-in"),
      person: AccountPersonSchema,
      plan: AccountPlanSchema,
      /**
       * `expired` wants a sign-in again and lights the control's dot; `offline` is the cloud
       * out of reach, which is not the person's to fix, so the picture stays and nothing lights.
       */
      session: z.enum(["ok", "expired", "offline"]),
      /** A host can omit unavailable portals without inventing billing or plan access. */
      pages: z.array(AccountPageSchema).optional(),
      /** Opaque creator receipt scope. This is an identity reference, never a bearer token. */
      creatorScope: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .strict(),
]);
export type AccountState = z.infer<typeof AccountStateSchema>;

/** Which of the account's pages a door in the menu opens in the system browser. */

export const SIGNED_OUT: AccountState = { kind: "signed-out", refusal: null };
