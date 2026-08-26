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
  readonly denyUnknown: boolean;
}

/** Prepared settings keyed by cwd so concurrent session setup cannot cross-wire policy. */
export class PreparedSessionPolicies {
  private readonly byCwd = new Map<string, SessionConfigInput>();

  prepare(input: SessionConfigInput): void {
    if (input.sessionCwd !== undefined) this.byCwd.set(input.sessionCwd, input);
  }

  take(agentName: string | undefined, cwd: string | undefined): SessionPermissionPolicy | null {
    if (cwd === undefined) return null;
    const input = this.byCwd.get(cwd);
    this.byCwd.delete(cwd);
    return input === undefined ? null : sessionPermissionPolicy(agentName, input);
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
    // OpenCode may ask about future tools for authoring agents. Read-only agents fail closed:
    // an unknown action must not become a path around their smaller allowlist.
    denyUnknown: member.readOnly === true,
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
  return policy.denyUnknown
    ? { status: "denied", reason: "unknown actions are denied for read-only agents" }
    : { status: "ask" };
}
