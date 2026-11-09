import type { AccountService } from "../account.js";
import type { CommandModule } from "./router.js";

/** The Arke account: signing in and out. Application state, no world. */
export function accountCommands(deps: { account: () => AccountService }) {
  return {
    "account-sign-in": { scope: "none", async handle() { await deps.account().signIn(); } },
    "account-create": { scope: "none", async handle() { await deps.account().createAccount(); } },
    "account-cancel-sign-in": { scope: "none", async handle() { await deps.account().cancelSignIn(); } },
    "account-sign-out": { scope: "none", async handle() { await deps.account().signOut(); } },
    "account-open": { scope: "none", async handle(msg) { await deps.account().open(msg.page); } },
  } satisfies CommandModule;
}
