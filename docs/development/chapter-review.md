# Chapter review

Chapter review is an advisory workflow for saved prose and selected audiobook stills. Open **Review chapter** in the chapter workspace, or ask Arke to review a chapter and approve its chapter-review action. Running a review uses the configured writing harness; it does not generate replacement media, edit prose or listen to audio.

## Ownership and specialist roles

The coordinator's `ChapterReviewService` owns the run. The conversation prepares a typed action; it cannot create arbitrary child agents. A read-only `chapter-script-reviewer` session extracts quoted scene facts and reader-facing concerns. Separate read-only `chapter-visual-reviewer` sessions inspect image renditions against the original text and those advisory facts. Each role receives a shipped, versioned review skill. Settings can choose its model and brief; normal harness tool confinement still applies. Native model delegation remains disabled.

The review uses a retained world store, independent of which world is selected. Each session receives the saved chapter snapshot and explicitly supplied images, without the currently selected world's query tools or memory. Source loading observes cancellation; review work drains on shutdown and per-task scratch is removed after interruption/listener cleanup. There is one active review per chapter and at most three across the coordinator.

## Evidence and limits

The initial implementation accepts at most 60,000 characters and 60 selected pictures, with a 120 MB total source-image budget. Exceeding that aggregate budget refuses the run before any model call. It runs one script task and sequential visual tasks in groups of three with neighboring context, at most five pictures per task. Each nonempty visual result receives a separate evidence-check session with the same pixels. A final text-only task consolidates duplicates; these extra model calls are recorded separately. Images use the existing sanitized rendition and encoded-byte limits. Vision capability and current cloud-image policy are checked before dispatch. Unsupported models, unreadable images and failed tasks remain visible as incomplete coverage.

Visual tasks receive the current grouped block-to-passage map and the saved shot frame, depicted people, deliberate exclusions, expressions and detail instructions when available. Shot intent is pinned in the review; missing legacy intent is not reconstructed. Intent helps interpret framing but cannot override the manuscript. A missing block or an image bound to older text is explicitly identified. The review checks perspective, usable objects, screen direction, eyelines, continuity, injuries, clothing, lighting and sequence readability. Intentional anomalies, cropping, occlusion and hidden screens are legitimate possibilities, not automatic errors. Character-reference matching and whole-book canon verification are outside this first pass.

Every model finding must quote an exact chapter span. Image findings must cite supplied image IDs. The application rejects unplaceable citations; this does not prove a model's interpretation is correct. Findings distinguish contradictions, possible confusion and inability to assess. Derived facts never outrank the original source.

The independent evidence check names the subject of each quote and assesses whether it supports the claim about the pictured person and moment. Wrong-subject or wrong-scene citations are rejected with an explanation; uncertainty becomes cannot-assess. This is model judgment, not a guarantee of correctness. The report calls mechanically checked results **source-linked**. An incomplete assessment fails its task, retains the original candidates and reports partial coverage without retry.

Consolidation proposes disjoint duplicate groups with existing IDs. The coordinator refuses unknown members, overlaps, different categories, certainty or image sets. Distinct defects in one prop must remain separate. Original findings, task IDs, quotes and assessment reasons remain in the sidecar and report, including rejected claims. No manuscript or media changes follow automatically. Consolidation has a 160,000-character input budget; an oversized set retains individual findings and marks that task failed. Legacy reviews remain readable; reviews with newly pinned shot intent require a fresh source check.

Narration is currently a saved-record audit. It reports record availability and counts; it does not claim to inspect compiled provider requests, assess pronunciation or listen to audio. Future specialist stages can extend this same workflow without changing its ownership model.

## Persistence and recovery

Reviews are derived sidecars under `productions/<production>/.reviews/chapters/<chapter>/<review-id>.json`, with a `latest.json` pointer to the authoritative per-ID checkpoint. A crash during pointer replacement cannot hide later findings for an already selected review. They retain the reviewed prose, hashes, source paths, task receipts, findings and human decisions. They contain unpublished story text and belong to the portable world. Original image hashes are retained; image bytes remain in their existing world files. The report loads bounded bytes, checks their recorded SHA-256 and displays that verified browser blob; replaced files cannot silently become review evidence.

The request ID determines a durable review identity. A replay reads the existing result, even after another review or a restart; it never silently retries an uncertain model call. Checkpoints use owned atomic writes before dispatch and after each task. World ownership is rechecked at dispatch, after asynchronous session and image preparation. An orphaned running review is marked interrupted. A new Review again request is an explicit new model run.

Changing prose, selected image bytes, audiobook records or character narration marks prior results stale. Distinct review runs follow coordinator publication rather than wall-clock ordering. Stale findings cannot receive decisions, and the UI hides potentially changed images while retaining the original quote and hash. Keep intentionally and Dismiss finding save assessments only. Decisions may carry to a new review of identical sources only when category, certainty, quote, image IDs, observation, impact and correction all match; no semantic matching or automatic suppression is claimed.

## Validation

Run contracts `test/chapter-review.test.ts`, coordinator `test/productions/chapter-review.test.ts` and `test/harness/review-task.test.ts`, and client `test/chapter-review.test.tsx` and `test/chapter-review-evidence.test.ts` from their package roots with `node --import tsx --test <file>`. Also run action registry/parity, shipped skill and audiobook picture-brief tests, then the standard lint, typecheck, build and test gates.

The tests use fixtures and fake model responses. They verify data boundaries and recovery, not the accuracy of a live model's visual judgment. A useful evaluation set includes a backwards tablet, a valid shared over-the-shoulder view, a deliberately impossible environment, an off-camera teammate, changing injury state and a recurring prop that changes appearance.
