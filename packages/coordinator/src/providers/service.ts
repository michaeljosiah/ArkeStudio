import { PROVIDERS, type CapabilityProbe, type ProviderId, type ProviderStatus } from "@arke-studio/contracts";
import type { AppLog } from "../app-log.js";
import type { CredentialStore } from "../credentials/store.js";

/**
 * Provider status orchestration (SPEC-008 R-1..R-4): who is configured, what the last
 * validation found, and mid-session provider faults. Statuses carry no key material — the
 * renderer sees booleans and probe results only (R-6).
 */

/** The one slice of a provider client the coordinator needs; SPEC-009 wires the rest. */
export interface KeyValidator {
  validateKey(key: string): Promise<CapabilityProbe[]>;
}

export class ProviderService {
  private readonly statuses = new Map<ProviderId, ProviderStatus>();

  constructor(
    private readonly credentials: CredentialStore | null,
    private readonly validators: Partial<Record<ProviderId, KeyValidator>>,
    private readonly log: AppLog | null,
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  /** Seed statuses from stored credentials; local runtimes need no key to be configured. */
  async init(): Promise<void> {
    const configured = new Set(this.credentials ? await this.credentials.configuredProviders() : []);
    for (const id of Object.keys(PROVIDERS) as ProviderId[]) {
      this.statuses.set(id, {
        id,
        configured: PROVIDERS[id].local || configured.has(id),
        validation: "untested",
        probes: [],
        fault: null,
      });
    }
  }

  list(): ProviderStatus[] {
    return [...this.statuses.values()];
  }

  private patch(id: ProviderId, changes: Partial<ProviderStatus>): ProviderStatus {
    const current = this.statuses.get(id) ?? {
      id,
      configured: false,
      validation: "untested" as const,
      probes: [],
      fault: null,
    };
    const next = { ...current, ...changes } as ProviderStatus;
    this.statuses.set(id, next);
    return next;
  }

  /** A credential landed or was cleared; validation resets to untested. */
  setConfigured(id: ProviderId, configured: boolean): void {
    this.patch(id, { configured, validation: "untested", probes: [], fault: null });
  }

  /**
   * Run the per-capability probes (R-3, D5). "Valid" means at least one capability is
   * unlocked; the probes themselves are the real answer either way.
   */
  async validate(id: ProviderId): Promise<ProviderStatus> {
    const validator = this.validators[id];
    if (!validator) {
      return this.patch(id, {
        validation: "invalid",
        probes: PROVIDERS[id].capabilities.map((capability) => ({
          capability,
          available: false,
          reason: `${PROVIDERS[id].displayName} runs inside the Voxa sidecar — validated by runtime detection, not a key`,
        })),
      });
    }
    const key = PROVIDERS[id].local ? "" : ((await this.credentials?.get(id)) ?? null);
    if (key === null) {
      return this.patch(id, {
        validation: "invalid",
        probes: PROVIDERS[id].capabilities.map((capability) => ({
          capability,
          available: false,
          reason: "no credential is stored for this provider",
        })),
      });
    }
    this.patch(id, { validation: "testing" });
    try {
      const probes = await validator.validateKey(key);
      const anyAvailable = probes.some((p) => p.available);
      void this.log?.append({ kind: "provider.validated", provider: id, probes });
      return this.patch(id, {
        validation: anyAvailable ? "valid" : "invalid",
        probes,
        lastValidated: this.clock(),
        fault: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      void this.log?.append({ kind: "provider.validation-failed", provider: id, message });
      return this.patch(id, {
        validation: "invalid",
        probes: PROVIDERS[id].capabilities.map((capability) => ({ capability, available: false, reason: message })),
        lastValidated: this.clock(),
      });
    }
  }

  /** A credential failed mid-session — a provider fault naming the provider, never a work failure (R-4). */
  markFault(id: ProviderId, message: string): ProviderStatus {
    void this.log?.append({ kind: "provider.fault", provider: id, message });
    return this.patch(id, { fault: message, validation: "invalid" });
  }
}
