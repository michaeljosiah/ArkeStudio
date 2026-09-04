import { lookup } from "node:dns/promises";
import { request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

export interface ResolvedWebAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveWebHost = (hostname: string) => Promise<readonly ResolvedWebAddress[]>;

export interface WebResponse {
  status: number;
  location?: string;
  contentType?: string;
  bytes: Uint8Array;
}

/** Test seam at the socket boundary: production always receives and connects to the pinned address. */
export type WebRequest = (
  url: URL,
  address: ResolvedWebAddress,
  maxBytes: number,
) => Promise<WebResponse>;

export class SafeWebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeWebError";
  }
}

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) BLOCKED.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) BLOCKED.addSubnet(network, prefix, "ipv6");

function mappedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  if (!lower.startsWith("::ffff:")) return null;
  const suffix = lower.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  const high = Number.parseInt(parts[0]!, 16);
  const low = Number.parseInt(parts[1]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

export function isPublicWebAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = mappedIpv4(address);
  if (mapped !== null) return isPublicWebAddress(mapped);
  return !BLOCKED.check(address, "ipv6");
}

const defaultResolve: ResolveWebHost = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));

function header(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" || value === undefined ? value : value[0];
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

const defaultRequest: WebRequest = (url, address, maxBytes) => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (fn: () => void): void => {
    if (settled) return;
    settled = true;
    fn();
  };
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all === true) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const request = (url.protocol === "https:" ? requestHttps : requestHttp)(url, {
    headers: { accept: "text/html,text/plain;q=0.9,*/*;q=0.1" },
    lookup: pinnedLookup,
  }, (response) => {
    const status = response.statusCode ?? 0;
    const location = header(response.headers.location);
    const contentType = header(response.headers["content-type"]);
    if (REDIRECT_STATUS.has(status)) {
      response.destroy();
      finish(() => resolve({ status, ...(location ? { location } : {}), bytes: new Uint8Array() }));
      return;
    }

    const declared = Number(header(response.headers["content-length"]));
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      finish(() => reject(new SafeWebError("that page is larger than this will keep.")));
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    response.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        response.destroy();
        finish(() => reject(new SafeWebError("that page is larger than this will keep.")));
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () => finish(() => resolve({
      status,
      ...(location ? { location } : {}),
      ...(contentType ? { contentType } : {}),
      bytes: Buffer.concat(chunks, total),
    })));
    response.once("error", (error) => finish(() => reject(error)));
  });
  request.setTimeout(15_000, () => request.destroy(new Error("the page took too long to answer")));
  request.once("error", (error) => finish(() => reject(error)));
  request.end();
});

function checkedUrl(value: string | URL): URL {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new SafeWebError(`"${String(value)}" is not an address this can read.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeWebError(`${url.protocol} is not a protocol this reads — http and https only.`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new SafeWebError("addresses containing credentials are not read.");
  }
  return url;
}

async function resolvePublic(url: URL, resolveHost: ResolveWebHost): Promise<ResolvedWebAddress> {
  const hostname = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (hostname.toLowerCase() === "localhost" || hostname.toLowerCase().endsWith(".localhost")) {
    throw new SafeWebError("that address resolves inside this machine and cannot be read.");
  }
  const literalFamily = isIP(hostname);
  let addresses: readonly ResolvedWebAddress[];
  try {
    addresses = literalFamily === 0
      ? await resolveHost(hostname)
      : [{ address: hostname, family: literalFamily as 4 | 6 }];
  } catch (error) {
    throw new SafeWebError(`that page could not be reached: ${error instanceof Error ? error.message : "no address"}`);
  }
  if (addresses.length === 0) throw new SafeWebError("that page could not be reached: no address");
  if (addresses.some(({ address }) => !isPublicWebAddress(address))) {
    throw new SafeWebError("that address resolves to a private or reserved network and cannot be read.");
  }
  return addresses[0]!;
}

/** Resolve, validate and pin every hop; no redirect inherits trust from the address before it. */
export async function safeWebGet(
  input: string,
  maxBytes: number,
  deps: { resolveHost?: ResolveWebHost; request?: WebRequest } = {},
): Promise<WebResponse & { url: URL }> {
  const resolveHost = deps.resolveHost ?? defaultResolve;
  const request = deps.request ?? defaultRequest;
  let current = checkedUrl(input);
  const visited = new Set<string>();
  for (let redirects = 0; ; redirects++) {
    if (visited.has(current.toString())) throw new SafeWebError("that page redirected in a loop.");
    visited.add(current.toString());
    const address = await resolvePublic(current, resolveHost);
    let response: WebResponse;
    try {
      response = await request(current, address, maxBytes);
    } catch (error) {
      if (error instanceof SafeWebError) throw error;
      throw new SafeWebError(`that page could not be reached: ${error instanceof Error ? error.message : "no answer"}`);
    }
    if (!REDIRECT_STATUS.has(response.status)) {
      if (response.bytes.byteLength > maxBytes) throw new SafeWebError("that page is larger than this will keep.");
      return { ...response, url: current };
    }
    if (!response.location) throw new SafeWebError(`that page answered ${response.status} without a redirect address.`);
    if (redirects >= 5) throw new SafeWebError("that page redirected too many times.");
    try {
      current = checkedUrl(new URL(response.location, current));
    } catch (error) {
      if (error instanceof SafeWebError) throw error;
      throw new SafeWebError("that page redirected to an invalid address.");
    }
  }
}
