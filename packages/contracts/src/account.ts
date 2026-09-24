import { z } from "zod";

/**
 * The Arke account the app is signed in to, as every snapshot carries it (design turn 151).
 *
 * Studio runs whole without one — SPEC-025's premise, a machine with no network and no account
 * — so the resting state is signed out and nothing local reads this. The cloud that would answer
 * a sign-in is not built. The shape is fixed here so the chrome's control, its menu and their
 * states are fixed, and the service behind the frames is a placeholder that refuses until there
 * is a cloud to reach; when there is, it takes this shape rather than the shape taking it.
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
    })
    .strict(),
]);
export type AccountState = z.infer<typeof AccountStateSchema>;

/** Which of the account's pages a door in the menu opens in the system browser. */
export const AccountPageSchema = z.enum(["account", "plan"]);
export type AccountPage = z.infer<typeof AccountPageSchema>;

export const SIGNED_OUT: AccountState = { kind: "signed-out", refusal: null };
