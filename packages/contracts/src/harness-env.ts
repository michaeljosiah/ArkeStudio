/** Provider credentials delivered to harnesses through their environment (SPEC-005 R-6).
 * Rotation guards and environment builders share this policy; concrete adapters do not own it. */
export const LLM_ENV_PROVIDERS = ["anthropic", "openai"] as const;

export const LLM_ENV_NAMES: Record<(typeof LLM_ENV_PROVIDERS)[number], string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};
