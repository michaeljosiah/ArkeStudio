# Turn 260 — Word timing busy state

Issue #2241. The synthetic phone drawing was rendered in light and dark and shown inline before implementation on 1 November 2026. Implementation is authorized as part of the ten-issue task; no separate drawing approval is claimed.

Keep the existing word timing panel and reason field. Explicitly refuse preparation while a Words check owns the production, including checks in another chapter. The author can retry after Words finishes; no task is queued and nothing is synthesized. Each task retains its own Stop. Read/status responses retain the reason, and reconnect rereads the selected scope without preparing. A second timing preparation arriving during the availability await joins the existing operation rather than running concurrently.

SPEC-047 R-184 and the saved narration Words amendment remain conservative: no change to acoustic validation, take selection or paid request authority. Two command tests cover both request orders, production/chapter scope, cancellation and reconnect responses; the client test covers visible refusal and reconnect without new work. Capture checks synthetic horizontal fit only.
