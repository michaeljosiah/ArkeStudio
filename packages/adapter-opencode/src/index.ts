export { MockHarnessAdapter } from "./mock.js";
export { OpenCodeAdapter, type OpenCodeAdapterOptions } from "./opencode-adapter.js";
export { OpenCodeV2Adapter, type OpenCodeV2AdapterOptions } from "./v2/opencode-v2-adapter.js";
export { OpenCodeV2Http, sameDirectory, v2BasicAuth, wireDirectory, type V2Envelope } from "./v2/http.js";
export { createNormalizeV2State, normalizeOpenCodeV2, type NormalizeV2Outcome } from "./v2/normalize.js";
export { buildSessionConfigV2, type SessionConfigV2Input } from "./v2/config.js";
export { probeCapabilities, type ProbeResult } from "./capabilities.js";
export {
  discoverOpenCode,
  discoverOpenCode2,
  discoverPreferredHarness,
  meetsV2Gate,
  OPENCODE2_MIN_BUILD,
  type DiscoveredHarness,
  type DiscoveredOpenCode,
  type DiscoveryOptions,
} from "./discovery.js";
export { buildSessionConfig, credentialEnv, credentialEnvPatch, LLM_ENV_PROVIDERS } from "./config.js";
export { createNormalizeState, normalizeOpenCode, toolSummary, type NormalizeOutcome } from "./normalize.js";
export { OpenCodeError, OpenCodeHttp } from "./http.js";
export { parseSse } from "./sse.js";
export type {
  HarnessCapability,
  CreateSessionInput,
  HarnessAdapter,
  HarnessEvent,
  ModelInfo,
  PermissionAck,
  PermissionAssessment,
  PermissionDecision,
  PermissionRequest,
  Readiness,
  SendMessageInput,
  SendReceipt,
  SessionRef,
} from "@arke-studio/contracts";
