# Bounded implementation status

Checked against source on 5 September 2026. This register clarifies areas that had misleading blanket descriptions; it is not a complete roadmap or a passing-test report. Keep entries current when their cited behavior changes. Capability specs remain the detailed requirements.

| Area | Status | Evidence and limit |
|---|---|---|
| Episodes | Partial | Client [App.tsx](../../packages/client/src/App.tsx) routes episode detail/chat screens; [episode-create.test.ts](../../packages/coordinator/test/productions/episode-create.test.ts) covers episode creation. This does not establish a complete season-production or audience-publishing workflow. See [SPEC-012](../specifications/012.productions-scenes-shots-boards.md). |
| Local voice protocol | Implemented client | [voice/src/index.ts](../../packages/voice/src/index.ts) contains sidecar schemas and client behavior. Runtime readiness and supported operations still depend on setup and available engines; this is not a claim that every planned voice feature is delivered. See [SPEC-011](../specifications/011.voice.md). |
| World ownership | Bounded desktop checks accepted | [ADR-002](../decisions/002-ownership-is-a-revision.md) accepts local disk identity checks and ownership-loss handling; hosted leases and atomic fencing remain proposed. Local checks do not establish cross-machine concurrent ownership. |
| Host/cloud foundation | Designed / incomplete integration | [SPEC-025](../specifications/025.the-host-ports.md) describes the host ports; a named cloud entry in the product is not evidence of completed sync/collaboration integration. |

For other capabilities, read the relevant spec's current implementation notes and follow its source/tests. Historical architecture reviews may describe risks fixed by subsequent work; check the linked decisions and operational rules before applying their recommendations.
