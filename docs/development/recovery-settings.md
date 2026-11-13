# Recovery preferences

Settings → Diagnostics keeps the recovery mode and current remedies visible. **Advanced recovery
settings** contains operator preferences and optional automatic preset-preview maintenance.
Changes are saved on the host PC. Remote sessions and model tools cannot change these controls.

| Preference | Default | Effect |
|---|---|---|
| Check storage before submitting generation | On | Holds new requests when the operational headroom check fails. Turn off to manage submission headroom yourself. Warnings remain, and saving a completed result can still wait for space. |
| Files per result | 64 | Admission limit for new result retrieval/checkpoint writes; adjustable from 1 to 256. |
| Maximum file size | 1,024 MiB | Adjustable from 1 to 2,048 MiB. |
| Maximum total result | 4,096 MiB | Adjustable from the per-file limit to 8,192 MiB. |
| Result download timeout | 30 minutes | Adjustable from 1 to 240 minutes for separate completed-result retrievals across FAL, ComfyUI and Higgsfield. It does not change generation timeouts or the provider's retention period. |
| Automatic preset-preview cleanup | Off | A separate reviewed opt-in, also requiring Automatic recovery. Only eligible fixed local preset auditions are candidates. |

The default preflight is an operational floor, not an estimate or promise that a complete
generation will fit. Turning it off does not grant world-write ownership, remove result-write
checks or change Stop, cancellation or duplicate-charge prevention.

Larger results need more RAM and disk. The current transport buffers results in memory and may
need additional copying space. Its 2-GiB file, 8-GiB aggregate and 256-file support ceilings are
finite implementation limits, not provider account limits. HTTP result metadata remains bounded
to 1 MiB and local receipt metadata to 512 KiB. Higgsfield's result-location query retains its
existing bounded CLI output and process lifetime; an abandoned query cannot start a late download.

Every provider with a separate result download uses the same admitted file, aggregate and
deadline policy. The desktop transport honours the selected deadline rather than imposing its
former 15-minute overall cap. Connection, response-header and body-inactivity timeouts still
detect failed or stalled connections earlier. Providers that return output during generation
(including the synchronous speech and language clients) keep their generation timing and use
the common file/aggregate limits when those results are checkpointed; there is no separate
download to time out.

Editing a value does nothing until Save. Use default values changes the draft, then Save applies
it. Numeric fields can be cleared and retyped; visible ranges and validation govern Save. Editing
a saved value or restoring defaults replaces the previous Saved message with Unsaved changes.
Saved transfer-limit changes retry witnessed completed remote results held by those limits,
once each and sequentially, without another generation or application restart. Paused providers
and cancelled/uncertain jobs stay under their existing controls. Active transfers keep the
limits captured when they started. Previously saved receipts remain readable after lowering a
preference; their accepted bytes are not subjected to the new admission preference.

Settings writes retain the existing flushed recovery control and acknowledge only their own
request ID. They do not reset retry budgets, deliberate stops or uncertain repair outcomes.
Invalid stored preferences fall back to defaults without discarding that control. An unconfirmed
write cannot silently activate relaxed preferences. Credential protection, creative-data
retention and confirmed original-process/GPU cleanup are not optional preferences.

Provider-scope audit (28 October 2026): recovery preferences, storage preflight, receipt
admission/readback, held-result retries and recovery notices contain no FAL-specific branch.
The two inconsistent boundaries were the downloader implementations and the desktop's older
overall timeout; both now receive the shared policy. Recipe output selection and managed-service
restart eligibility remain specific to their actual protocol/ownership. This audit covers these
recovery/result paths, not every provider feature or full epic acceptance. See the
[application/user-journey acceptance record](recovery-acceptance.md) for observed UX fixes and
the remaining native-model and application/device checks.

Implementation: contracts `recovery-policy.ts` and `artifact-result-limits.ts`; coordinator
`recovery/control.ts`, `recovery/commands.ts` and `queue/`; client
`components/recovery-advanced.tsx`. These implement the owner's 28 October 2026 instruction
under SPEC-061/062 and ADR-004. Ordinary provider dispatch and existing install overrides retain
their own authorization.
