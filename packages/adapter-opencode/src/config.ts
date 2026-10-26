import { LLM_ENV_NAMES, LLM_ENV_PROVIDERS } from "@arke-studio/contracts";

/** Compatibility export; contracts owns the policy shared with credential rotation guards. */
export { LLM_ENV_PROVIDERS } from "@arke-studio/contracts";

/**
 * Provider credentials as environment variables for the spawned harness (R-6). Keys never
 * touch a config file; SPEC-008 supplies the actual values from safeStorage.
 */
export function credentialEnv(credentials: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const provider of LLM_ENV_PROVIDERS) {
    const key = credentials[provider];
    if (key) env[LLM_ENV_NAMES[provider]] = key;
  }
  return env;
}

/**
 * The same delivery as a PATCH: every managed variable is named, with `undefined` for a
 * provider whose key is absent — the deletion marker a merge can honour. `credentialEnv`'s
 * omit-when-absent shape cannot express removal, and a cleared key that silently survives
 * the next spawn is a revocation that did not happen (found in review of issue 327's wiring
 * slice: Settings said "not configured" while the child kept the revoked key until app exit).
 */
export function credentialEnvPatch(
  credentials: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const patch: Record<string, string | undefined> = {};
  for (const provider of LLM_ENV_PROVIDERS) {
    patch[LLM_ENV_NAMES[provider]] = credentials[provider] || undefined;
  }
  return patch;
}
