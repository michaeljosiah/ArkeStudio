export { MockHarnessAdapter } from "./mock.js";
export { OpenCodeV2Adapter, type OpenCodeV2AdapterOptions } from "./v2/opencode-v2-adapter.js";
export { OpenCodeV2Http, sameDirectory, v2BasicAuth, wireDirectory, type V2Envelope } from "./v2/http.js";
export { createNormalizeV2State, normalizeOpenCodeV2, type NormalizeV2Outcome } from "./v2/normalize.js";
export { buildSessionConfigV2, type SessionConfigV2Input } from "./v2/config.js";
export {
  discoverOpenCode2,
  discoverPreferredHarness,
  meetsV2Gate,
  OPENCODE2_PINNED_VERSION,
  type DiscoveredHarness,
  type PreferredHarnessDiscovery,
  type DiscoveredOpenCode,
  type DiscoveryOptions,
} from "./discovery.js";
export { credentialEnv, credentialEnvPatch, LLM_ENV_PROVIDERS } from "./config.js";
export { toolSummary } from "./normalize.js";
export { OpenCodeError } from "./http.js";
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
