import type {
  VendorAuthMethod,
  VendorConnection,
  VendorFormField,
  VendorIntegration,
  VendorOAuthAttempt,
  VendorOAuthAttemptState,
} from "@arke-studio/contracts";

/**
 * Wire-to-contract normalisation for the v2 sign-in surface (SPEC-030 §2.2). Every shape here
 * was measured against 0.0.0-next-17444: GET /api/integration lists vendors with `methods`
 * (oauth | key | env | command) and current `connections` (credential | env); an OAuth attempt
 * carries {attemptID, url, instructions, mode, time{created, expires}} and its status polls as
 * pending | complete | failed | expired.
 *
 * Ids and labels pass through verbatim (R-7). What gets dropped is stated per case below —
 * silence about a dropped method would read as the harness not offering it.
 */

interface WireFormOption {
  value?: unknown;
  label?: unknown;
  description?: unknown;
}

interface WireFormWhen {
  key?: unknown;
  op?: unknown;
  value?: unknown;
}

interface WireFormField {
  key?: unknown;
  title?: unknown;
  required?: unknown;
  type?: unknown;
  placeholder?: unknown;
  options?: WireFormOption[];
  when?: WireFormWhen[];
}

export interface WireIntegrationMethod {
  id?: unknown;
  type?: unknown;
  label?: unknown;
  names?: unknown;
  form?: WireFormField[];
  command?: unknown;
}

export interface WireConnection {
  type?: unknown;
  id?: unknown;
  label?: unknown;
  name?: unknown;
}

export interface WireIntegration {
  id?: unknown;
  name?: unknown;
  methods?: WireIntegrationMethod[];
  connections?: WireConnection[];
}

export interface WireAttempt {
  attemptID?: unknown;
  url?: unknown;
  instructions?: unknown;
  mode?: unknown;
  time?: { created?: unknown; expires?: unknown };
}

export interface WireAttemptStatus {
  status?: unknown;
  message?: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

function normalizeField(wire: WireFormField): VendorFormField | null {
  const key = str(wire.key);
  const title = str(wire.title);
  if (key === null || title === null) return null;
  const options: VendorFormField["options"] = [];
  for (const option of wire.options ?? []) {
    const value = str(option.value);
    const label = str(option.label);
    if (value === null || label === null) continue;
    options.push({ value, label, description: str(option.description) });
  }
  const whenEquals: VendorFormField["whenEquals"] = [];
  for (const when of wire.when ?? []) {
    const key2 = str(when.key);
    // Equality is the only operator the measured build emits; anything else would gate the
    // field on a judgement this code cannot make, so the field is kept unconditional instead.
    if (key2 === null || (when.op !== undefined && when.op !== "eq")) continue;
    whenEquals.push({ key: key2, value: String(when.value ?? "") });
  }
  return {
    key,
    title,
    required: wire.required === true,
    placeholder: str(wire.placeholder),
    options: options.length > 0 ? options : null,
    whenEquals,
  };
}

function normalizeMethods(wire: WireIntegrationMethod[] | undefined): VendorAuthMethod[] {
  const out: VendorAuthMethod[] = [];
  for (const method of wire ?? []) {
    if (method.type === "oauth") {
      const id = str(method.id);
      const label = str(method.label);
      // An oauth method with no id cannot be begun and one with no label cannot be offered in
      // the harness's words — either way there is nothing honest to render.
      if (id === null || label === null) continue;
      out.push({ id, kind: "oauth", label, fields: fieldsOf(method) });
    } else if (method.type === "key") {
      // Key methods carry no id on the wire, and usually no label. "API key" names the kind,
      // not a vendor flow, so it is not the invented label R-7 forbids.
      out.push({ id: null, kind: "key", label: str(method.label) ?? "API key", fields: fieldsOf(method) });
    }
    // env methods are how a configured key reaches the harness, not something a person does —
    // they surface as connections, never as offers. command methods are not driven yet: none
    // of the measured vendors reports one, and offering a flow that was never exercised would
    // promise something unbuilt.
  }
  return out;
}

function fieldsOf(method: WireIntegrationMethod): VendorFormField[] {
  const fields: VendorFormField[] = [];
  for (const field of method.form ?? []) {
    const normalized = normalizeField(field);
    if (normalized !== null) fields.push(normalized);
  }
  return fields;
}

function normalizeConnections(wire: WireConnection[] | undefined): VendorConnection[] {
  const out: VendorConnection[] = [];
  for (const connection of wire ?? []) {
    if (connection.type === "credential") {
      const id = str(connection.id);
      if (id === null) continue;
      out.push({ kind: "stored", id, label: str(connection.label) ?? "default" });
    } else if (connection.type === "env") {
      const name = str(connection.name);
      if (name === null) continue;
      out.push({ kind: "env", name });
    }
  }
  return out;
}

/** Null for a row with no id or name — nothing a screen could address or a person could read. */
export function normalizeIntegration(wire: WireIntegration): VendorIntegration | null {
  const id = str(wire.id);
  const name = str(wire.name);
  if (id === null || name === null) return null;
  return {
    id,
    name,
    methods: normalizeMethods(wire.methods),
    connections: normalizeConnections(wire.connections),
    needsSignIn: false,
  };
}

/** Ten minutes, matching the measured attempt lifetime — the fallback when the wire's own
 * expiry is absent or unreadable, so the poll stays bounded either way (R-9b). */
const FALLBACK_ATTEMPT_LIFE_MS = 600_000;

export function normalizeAttempt(wire: WireAttempt, now: number = Date.now()): VendorOAuthAttempt {
  const attemptId = str(wire.attemptID);
  if (attemptId === null) throw new Error("the harness answered an OAuth begin without an attempt id");
  const expires = Number(wire.time?.expires);
  return {
    attemptId,
    url: str(wire.url) ?? "",
    instructions: str(wire.instructions) ?? "",
    mode: wire.mode === "code" ? "code" : "auto",
    expiresAt: Number.isFinite(expires) && expires > now ? expires : now + FALLBACK_ATTEMPT_LIFE_MS,
  };
}

export function normalizeAttemptStatus(wire: WireAttemptStatus): VendorOAuthAttemptState {
  switch (wire.status) {
    case "complete":
      return { status: "complete" };
    case "expired":
      return { status: "expired" };
    case "failed":
      return { status: "failed", message: str(wire.message) ?? "the vendor reported a failure" };
    default:
      // Unknown statuses stay pending: the poll is bounded by the attempt's own expiry, so
      // patience here cannot hang anything, while guessing "failed" would end a sign-in that
      // was still under way.
      return { status: "pending" };
  }
}
