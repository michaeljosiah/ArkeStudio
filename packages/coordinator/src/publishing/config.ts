import { z } from "zod";

const endpoint = z.string().url();
export const AonikConfigurationSchema = z.object({
  apiBaseUrl: endpoint,
  issuer: endpoint,
  clientId: z.string().trim().min(1).max(200),
  audience: z.string().trim().min(1).max(1000).optional(),
  scope: z.string().trim().min(1).max(2000).refine(value => value.split(/\s+/).includes("openid"), "openid scope is required"),
  tenantId: z.string().uuid(),
  channelKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  rightsDeclarationVersion: z.string().trim().min(1).max(120),
  permissionText: z.string().trim().min(1).max(4000),
  maxPackageBytes: z.number().int().min(1).max(2147483648).default(134217728),
  redirectPort: z.number().int().min(0).max(65535).default(0),
  accountUrl: endpoint.optional(),
  planUrl: endpoint.optional(),
  allowLoopbackHttp: z.boolean().default(false),
}).strict();
export type AonikConfiguration = z.infer<typeof AonikConfigurationSchema>;

export function trustedAonikUrl(value: string, allowLoopbackHttp = false): URL {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search ||
    (url.protocol !== "https:" && !(allowLoopbackHttp && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("AONIK requires a configured HTTPS endpoint (or explicit local loopback development).");
  }
  return url;
}

export function parseAonikConfiguration(input: unknown): AonikConfiguration {
  const parsed = AonikConfigurationSchema.parse(input);
  for (const value of [parsed.apiBaseUrl, parsed.issuer, parsed.accountUrl, parsed.planUrl]) if (value) trustedAonikUrl(value, parsed.allowLoopbackHttp);
  return { ...parsed, apiBaseUrl: parsed.apiBaseUrl.replace(/\/+$/, ""), issuer: parsed.issuer.replace(/\/+$/, "") };
}
