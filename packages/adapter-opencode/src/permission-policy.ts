import {
  confinementFor,
  permits,
  ROSTER,
  type AgentConfinement,
  type PermissionAssessment,
  type SessionConfigInput,
  type ToolIntent,
} from "@arke-studio/contracts";

export interface SessionPermissionPolicy {
  readonly confinement: AgentConfinement;
}

/** Prepared settings keyed by an opaque one-use token, never by a reusable directory. */
export class PreparedSessionPolicies {
  private readonly byId = new Map<string, SessionConfigInput>();

  prepare(input: SessionConfigInput): void {
    if (input.preparationId !== undefined) this.byId.set(input.preparationId, input);
  }

  take(agentName: string | undefined, preparationId: string | undefined): SessionPermissionPolicy | null {
    if (preparationId === undefined) return null;
    const input = this.byId.get(preparationId);
    this.byId.delete(preparationId);
    return input === undefined ? null : sessionPermissionPolicy(agentName, input);
  }

  abandon(preparationId: string): void {
    this.byId.delete(preparationId);
  }
}

/** The exact policy captured when a named roster agent's session starts. */
export function sessionPermissionPolicy(
  agentName: string | undefined,
  input: SessionConfigInput,
): SessionPermissionPolicy | null {
  const member = ROSTER.find((agent) => agent.name === agentName);
  if (!member) return null;
  return {
    confinement: confinementFor(member, { web: input.researchWeb === true }),
  };
}

function matches(pattern: string, action: string): boolean {
  return pattern.endsWith("*") ? action.startsWith(pattern.slice(0, -1)) : action === pattern;
}

/** Assess one generation's action name without moving harness vocabulary into the coordinator. */
export function assessMappedPermission(
  policy: SessionPermissionPolicy | null | undefined,
  actionClass: string,
  names: Partial<Record<ToolIntent, readonly string[]>>,
  never: readonly string[],
): PermissionAssessment {
  if (!policy) return { status: "denied", reason: "session policy is unavailable" };
  const action = actionClass.toLowerCase();
  if (never.some((name) => matches(name, action))) {
    return { status: "denied", reason: "action is always denied" };
  }
  for (const [intent, patterns] of Object.entries(names) as Array<[ToolIntent, readonly string[]]>) {
    if (!patterns.some((pattern) => matches(pattern, action))) continue;
    return permits(policy.confinement, intent)
      ? { status: "allowed" }
      : { status: "denied", reason: `${intent} is denied by the active confinement` };
  }
  // OpenCode's documented future-tool behavior: ask, but never silently apply an old grant.
  return { status: "ask" };
}
