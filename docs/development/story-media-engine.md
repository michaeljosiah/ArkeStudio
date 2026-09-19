# Story media in the public engine

The engine's `storyMedia` surface prepares page illustrations and stock-voice chapter narration from committed prose. It shares portrait admission, durable operation records, queue recovery, delivery checks and idempotent settlement. It adds no accounts, guardian rules or product pricing. A host owns those policies.

```ts
const chapter = await engine.prose.readChapter(context, worldId, productionId, chapterId);
const illustration = await engine.storyMedia.illustratePage(context, worldId, productionId, chapterId, {
  operationId: "stable-page-operation", baseHash: chapter.hash,
  model: configuredImageModel, instruction: "The garden glows beneath the stars.",
});
const narration = await engine.storyMedia.narrateChapter(context, worldId, productionId, chapterId, {
  operationId: "stable-narration-operation", baseHash: chapter.hash,
  model: configuredSpeechModel, voiceId: configuredStockVoice,
});
const progress = await engine.storyMedia.reconcile(context, worldId, "stable-narration-operation");
```

Models requiring cloned-reference transport are refused before reservation. Models and voices are host-resolved, never client-supplied commercial configuration. Both methods return the existing admission receipt: operation key, reservation, admitted job IDs and reconciliation state. Poll `reconcile` for pending, held, settled or uncertain work. Repeated requests use the original admission, including after restart. A started operation with uncertain admission is not permission to dispatch again.

The resource identifies production, chapter, media kind and source hash. These fields also ride inside the queue's private `engineOperation` metadata, which is removed before provider submission. The source must be an active, unique, fully visible chapter; optional expected revision is checked during preparation. Source and authority are rechecked before admission and at reconciliation. Direct `worlds.media` reads use the durable job's source binding and refuse changed prose, missing queue evidence, wrong subject/scope or the wrong media format. Output permission remains bound to exact artifact bytes by the host's delivery policy. A parent preview is not automatically a child's delivery permission.

Queue admission and provider recovery remain host responsibilities: recheck current authorization before provider submission, resolve scoped credentials, preserve durable job metadata (story-media rows are intentionally not deletable through Activity), and land artifacts through authoritative storage before acknowledging success. A copied filesystem world is not an Aonik commit. The engine's public API never fetches arbitrary external media or imports host credentials.

`cancel` requires the optional queue cancellation port. It cancels unfinished admitted jobs under the original caller's authority; completed outputs remain recorded. Uncertain admission requires reconciliation first. Cancellation does not itself release a reservation. Its receipt reports when reconciliation remains necessary. A remote cancellation may still complete or charge: the queue persists that uncertainty, and reconciliation retains the reservation for host recovery. Stale successful content reports a hold; it is never delivered or automatically charged. A recorded financial decision can finish after a source edit without making stale bytes deliverable.

This slice generates one illustrated page per chapter and one complete narration artifact per chapter. It uses world art direction as text; accepted image-reference assembly, cast/cloned-voice narration, long-chapter chunking and whole-book audio joining remain separate extensions. Narration is capped at 1,000 normalized characters, or a smaller model limit, including models without a declared prompt limit. This byte-returning surface is for short pages; longer chapters need the separate chunked audio workflow. The method refuses over-limit text rather than silently omitting part of the chapter. A product may present chapter audio in manuscript order. No completed-book or paid-plan promise is inferred from a successful individual job.

Version 0.3 requires all durable operation readers to accept the source-binding fields before story-media work is admitted. Existing portrait and prose operations retain their shape. Tests cover the real local world adapter and dispatcher, restart/replay, safety holds, changed prose, scope refusal, hidden sources and input limits. The packed consumer exercises both methods without source/workspace fallback. These tests use scripted providers; they are not model-quality evidence.

Recovery limits: page prompts are capped at 8,000 characters and 16,000 serialized JSON characters, or the model's lower bound, before reservation. A known zero-job release decision is journaled before calling host billing and can resume after a lost response. Cancellation retains every original admitted job ID and reports reconciliation required if queue rows disappear.

A saved financial decision also resumes after generation permission is withdrawn, under its original caller identity. Recovery never restores delivery permission. Story-media authorization receives the durable chapter and source identity before any artifact bytes are read, supporting chapter-scoped host policies.

Cancellation uses the original chapter resource for authorization. A definitive cancellation received by provider polling is recorded as confirmed and can release its reservation. Audio is compared by verified container format rather than an exact MIME label, so equivalent WAV labels remain interoperable.
