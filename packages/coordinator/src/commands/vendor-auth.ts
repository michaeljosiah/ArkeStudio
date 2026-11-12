import type { VendorAuthService } from "../harness/vendor-auth.js";
import type { CommandModule } from "./router.js";

/**
 * Vendor sign-in through the harness (SPEC-030 §3.1): refreshed, begun, a code or a key submitted,
 * cancelled and a connection removed. No world. The service publishes every state change through
 * its own callback, so nothing here waits on the browser the person is standing in front of.
 */
export function vendorAuthCommands(deps: { vendorAuth: VendorAuthService }) {
  return {
    "refresh-vendor-auth": { scope: "none", async handle() { await deps.vendorAuth.refresh(); } },
    "begin-vendor-sign-in": { scope: "none", async handle(msg) { await deps.vendorAuth.beginOAuth(msg.vendor, msg.method, msg.answers); } },
    "submit-vendor-sign-in-code": { scope: "none", async handle(msg) { await deps.vendorAuth.submitCode(msg.code); } },
    "submit-vendor-key": { scope: "none", async handle(msg) { await deps.vendorAuth.submitKey(msg.vendor, msg.key, msg.answers); } },
    "cancel-vendor-sign-in": { scope: "none", async handle() { await deps.vendorAuth.cancel(); } },
    "remove-vendor-connection": { scope: "none", async handle(msg) { await deps.vendorAuth.remove(msg.vendor, msg.credential); } },
  } satisfies CommandModule;
}
