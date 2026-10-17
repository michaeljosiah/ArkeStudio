# Audio Drama — adapting for the ear · design turn 228

Status: **Proposed · revision 1 · 17 October 2026.** For author review, not approved for implementation. This turn adds no production type to the running app and generates no audio.

Baseline: fetched and fast-forward checked against `origin/main`, **7f6b82b62**. The shared checkout contains unrelated work; this turn lives on `codex/audio-drama-design` in an isolated worktree. [Interactive design](audio-drama-228.review.html) · [Design master](Arke%20Studio.dc.html#t228) · [Research](../docs/research/audio-drama-adaptation.md).

## Decision

Add **Audio Drama** as a production type, alongside Story and the screen formats. It can begin from an idea or adapt a Story in the same world. A cast audiobook remains an audiobook of the prose. An audio drama owns a separate, source-linked script, episode structure and arrangement. Neither conversion nor later source reconciliation rewrites the novel.

For the first adaptation, recommend **Narrated drama**: a narrator carries essential orientation and interior perspective; characters own dialogue; sound carries evidence that can actually be understood by ear. Offer **Ensemble drama** and **In-world recordings** as editable creative approaches, not different storage formats or rigid templates. Narration is allowed scene by scene in all approaches. An in-world recording needs a credible recorder/listener and permission to know each fact. No automatic diary or radio framing imposed on every scene.

The product should answer three questions together: What survives from the story? What will the listener understand? What will this performance sound like?

## Fit with current Arke

Turn 227's chapter writing room and overview are the basis for the scene room. Turn 225 remains the sole global Chat. Turn 226's Audio Studio is the arrangement environment. Latest main now implements substantial Audio Studio functionality: the source-backed workspace, sample-domain arrangements, source replacement review, stereo rendering and shared Listen/export path. Reuse those implemented modules, not the older notes' claim that stereo remains hypothetical. This design does not assert that every turn-226 affordance has shipped; `docs/development/audio-studio.md` bounds it.

| Reuse | Extension needed |
|---|---|
| Story setup's Adapt from, Target, Spine, Verdicts, Season, Episodes | Admit Audio Drama; add listener perspective, narration approach, flexible episode duration and an audio-specific coverage plan. SPEC-052 remains marked proposed; its current contracts support micro drama and film, not audio drama. |
| Chapter room: brief, focus, selection, Compare, held revisions | A typed audio-script document; stable utterance/cue IDs; multi-block adaptation proposals. A text-only replacement cannot safely edit a cue graph. |
| Chapter overview and progress | Scene overview, source coverage, characters, required sounds and Script / Cast / Performed / Mixed states. |
| Character Voice pages, recorded performance workflow and take history | Production casting overrides; actor direction distinct from narrator portrayal; paired scene auditions; explicit substitution policy. |
| Audio Studio's Library / preview / timeline / Inspector and shared transport | Audio-script rows in the preview; scene/episode adapters; cue attachment; actor, channel and sound-role metadata. No new competing timeline. |
| Quotes, durable generation jobs, background world stores, Activity | Quote the exact speaker sequence and material; scene request planning; resumable per-group outcomes. Switching worlds must not interrupt generation. |
| Source-backed review and media evidence tools | Audio adaptation and listening review with source permissions, listening intervals, speech evidence and declared coverage. |
| Publication capture and rendering services | Audio Drama edition/profile and episode sequence; audio-only delivery, performance scripts and listener transcripts. Do not simply pass an audio drama into Story-only publication commands. |

No permanent extra studio rail item. Production navigation is **Overview · Episodes · Cast · Listen · Artifacts** using existing shell conventions. Adaptation is an Overview section and a contextual Source drawer, not another dashboard. The scene's views are **Scene · Script · Performances · Audio Studio**. Script is the default. Scene is the visual overview. Performances replaces the misleading Audiobook label for this production type.

## The journey and drawings

| Frame | Author task |
|---|---|
| 228a | Create Audio Drama, choose an existing Story, creative approach and an adjustable target; create an adaptation plan before any performance spend. |
| 228b | Review episode structure and source coverage, including moved, condensed and omitted beats with reasons. A chapter is not automatically an episode. |
| 228c | Write an audio script in the turn-227 room, with compact sound cues and an optional source drawer. Select a cue to inspect what is heard versus what is direction. |
| 228d | Cast the scene, compare actor direction with narrator portrayal, see missing voices and request an in-context audition. |
| 228e | Use the turn-226 Audio Studio shell for the scene; select script and timeline together. |
| 228f | Review intelligibility, source fidelity and knowledge boundaries with evidence and an explicit unheard interval. |
| 228g | Review an edition's included episodes, readiness, delivery profile, credits, transcript and stems. |
| 228h | Phone script with Source and Details as sheets; the document remains the primary surface. |
| 228i | Reconcile a changed source passage against the pinned source and current adaptation; Keep adaptation and Propose revision are distinct decisions. |

The interactive fixture is local state only. It demonstrates approach selection, source decisions, block selection, direction origin, audition preflight, review states, changed-source comparison and return navigation. Waveforms and take durations are illustrative; it never claims to play or analyse real media. Studio details reuse the actual 226 drawing; transport controls explain their fixture limit rather than simulate heard audio. Fixture fiction is invented for this turn and is not an excerpt from the user's manuscript.

## Adaptation before generation

1. **Target.** Select source version, audience, language, approach, episode duration range, narration preference and delivery intent. Defaults are suggestions, not hard word or page limits. Duration estimates count spoken words, pauses, overlaps and beds separately; realised duration comes from the mix. A ten-minute target never licenses an automatic cut.
2. **Spine.** Identify essential events, emotional changes, mysteries, chronology, character commitments and facts the listener must not yet learn. Preserve capability and consequence, not every sentence. Keep the original narrative perspective unless a changed one is explicitly reviewed.
3. **Coverage.** Read the whole selected source using bounded reads and a completion ledger before claiming a whole-book plan. Every chapter/beat receives Keep, Reframe, Condense, Move, Omit or Deferred with rationale and destination. Show unsurveyed material. Many source beats may feed one scene; one beat may span scenes. A pilot may proceed with a clearly bounded source scope while the rest stays unplanned.
4. **Episodes.** Propose scenes around dramatic movement and listening breaks, with source mappings, estimated range, speaker load and questions. Endings may resolve, suspend or transition; no compulsory cliffhanger formula. Author keeps the plan before scripts are drafted.
5. **Pilot.** Adapt one complete scene and table-read it before scaling. Check quiet exposition and fast action, not only a showcase exchange. A successful pilot should be understandable without seeing the source or the editor.

The source drawer shows the exact selected source version, paragraph/beat references, transformed information and decisions. Source references are durable IDs plus revision/hash and a quoted context window. A text match is repair evidence, not authority to relink ambiguous paragraphs. Keep an immutable source snapshot so deleted/retired sources remain explainable. A linked source's new revision marks only affected mappings for review. New chapters not in the original manifest appear as unassessed additions. Keeping a divergence records why and which source revision was considered; it does not mark new source text as adapted. No live dependency silently changes generated performances.

## Script that can be performed

Use a structured document presented like a familiar radio script. Do not make authors type JSON or provider tags. Stable block IDs survive revisions; printed scene and cue numbers are derived labels. Keyboard Enter continues an utterance; Tab cycles the next block's speaker/type; `/` inserts Narration, Dialogue, Sound, Ambience, Music, Silence or Production note. Undo, selection, source marks, linked character names, Compare and Ask Arke retain turn-227 behaviour. A change of speaker is an explicit casting operation, never inferred from dragging a clip between tracks.

| Element | Spoken or rendered | Essential properties |
|---|---|---|
| Scene heading | Neither | Location, story time, listener position, transition, source mapping. |
| Dialogue / Narration | Words only | Character or narrator identity, public label, delivery, channel, selected performance. |
| Performance direction | Never read aloud | Sparse playable intention; temporary emotion; actor baseline inherited separately. |
| Sound cue | Asset/rendered event | Audible description, story purpose, source, anchor and required/optional state. |
| Ambience / Music | Asset/range | Entrance, exit, loop, fades, diegetic/non-diegetic role and ducking intent. |
| Silence | Timing | Gap duration or intended beat, and whether beds continue or the mix becomes silent. |
| Production note | Neither | Writer/director rationale, physical action or continuity instruction. |

Speaker identity, actor/voice identity and audible channel are distinct. Radio is a reversible mix treatment over a clean performance, not a second character voice. A disguised or imitated voice has an explicit performance identity and a public speaker label; internal character IDs must not leak through transcripts, filenames or credits before the chosen reveal point. Hidden identity must not be exposed by an automatic sound motif or an actor note. Crowds and simultaneous responses need explicit attribution rather than accidental merging.

Internal thought is not automatically dialogue. Give it narration, an audible consequence or a reviewed omission. A sound can establish a latch engaging; it usually cannot establish a precise distance or unseen identity by itself. Avoid characters explaining shared facts to each other solely for the audience. An orientation line from the narrator is preferable when the scene needs it. Direction describes audible behaviour, not camera angles. Retain character presence cues when cutting dialogue tags.

Interruption and overlap are relations between stable utterances (for example start after a cue or before another line ends). They are not punctuation hacks. Timing initially remains intent until selected performances establish lengths. Word-accurate cues require alignment for the exact take; otherwise expose boundary-level attachment. Missing endpoints produce repair states, never guessed offsets.

### Exchange format

Provide a readable **radio-script PDF** with numbered scenes, consistent speaker labels, sparse parentheticals and clearly separate sound/music cues. Also provide plain-text script and a structured Arke package for lossless exchange. Fountain is useful for dialogue, scene headings and dual dialogue, but has no standard for Arke's cue graph, source links or take choices. A future Fountain import/export must label its lossy fields and provide an import preview; it cannot be the sole durable record. Listener transcripts omit unspoken directions and include meaningful sound descriptions. Production scripts and listener transcripts are different exports.

## Casting and performances

Retain character identity and existing voices across productions by default, with explicit **This production** casting overrides. Casting does not overwrite the world's character. Narrator is an optional role. A cast row shows public name, voice, accent, line count, readiness and an audition using the character's own dialogue. Show all speaking roles, including unnamed and imported speakers. A missing or unavailable assignment blocks that role's generation until assigned, recorded or explicitly designated for narrator substitution. Never silently substitute a voice.

Separate **Actor direction** from **Narrator portrayal**. Reuse underlying character traits, but do not apply single-narrator instructions such as pitch imitation or retaining another person's timbre to an actor. Direction precedence is character actor baseline → production override → scene intention → local delivery. Channel effects are separate. Source provenance and effective provider text remain inspectable in Details, not technical clutter on every row. The narrator's American baseline applies only to narrator passages. Switching provider/model shows unsupported controls and affected performances before confirmation.

Audition short exchanges, not just isolated voices. Offer a dry table read and a mixed comparison, preserving pauses and the narrator's interruptions. Audition creates candidate takes; it does not replace kept performances. Quote actual voices, text, context-only material and request groups. Context must never be mistaken for words meant to be returned.

Use provider multi-speaker generation only when the adapter declares and tests it. A provider may return one mixed asset; do not promise independent actor tracks, clean stems or line-level regeneration without actual separable sources/alignment. Otherwise generate individual performances with bounded scene context and assemble them on the common clock. Grouping must preserve order and voice IDs. More voices need not imply a request per sentence, but continuity cannot be purchased by pretending arbitrary model speaker limits do not exist. Record effective requests, exact inputs, supported controls and provenance, with uncertain requests recoverable under existing spend rules.

## Audio Studio, one arrangement

Reuse `AudioStudioWorkspace`, shared Cut panel layout and `resolveAudioArrangement`. Generalise the current chapter source adapter into an audio-script unit adapter without weakening Story's existing behaviour. Scenes are the editing units; episodes sequence their committed arrangements. Initially an episode splice has explicit gap/transition metadata; no cross-scene bed or overlap is advertised until the sequence renderer resolves it on the same clock. Export must reflect the shown sequence.

Library holds kept and alternate performances, recordings, SFX, ambience and music. Script occupies the preview slot. Timeline tracks organise the mix; clip role determines speech processing and stems. Inspector owns source, trim, placement, channel treatment, level, fades and cue links. Stable script IDs replace fragile paragraph offsets. Follow cue/range and Fixed time retain 226's semantics. Longer takes trigger Current / Suggested with affected cues, overlaps and repairs. Apply is revision-checked and undoable; source, script and arrangement changes invalidate a pending preview. Imported media is filed before placement. Missing sources remain repairable clips.

Preview, Listen, review evidence and delivered files use the same resolved arrangement identity, measured source metadata and renderer version. Stereo/mono checks, loudness, peaks, silence and masking are reported against the selected delivery profile; do not invent one universal podcast mastering number. Do not normalise individual actors into a different acoustic space on every line. Draft listening may skip missing media with an explicit incomplete state; final editions may not silently do so. Background generation follows the named production across navigation.

## Arke as collaborator

Use the existing production conversation and reviewable proposals. The main agent coordinates bounded adaptation, script, performance and listening tasks with versioned prompts. This is a proposed internal workflow, not new user-visible chat tabs or a requirement for parallel execution. Tasks consume a shared context packet: source versions, scene/episode IDs, approved adaptation decisions, current script, public knowledge ceiling, actor assignments and relevant arrangements. They cannot promote private lore to dialogue because it happens to be in their context.

An adaptation reviewer asks whether required story information survived; a script reviewer asks whether it can be understood by ear; a performance reviewer checks accent, identity, pacing and missing/extra words; a mix reviewer checks intelligibility and cue execution. Deterministic checks handle missing assets, stale hashes and invalid placements. Human creative decisions remain decisions, not automated pass/fail metrics.

Every finding references a source span, script block or exact audio interval and records observed / inferred / not assessed. A text-only pass cannot certify the mix. If no supported audio inspection ran, say **Script reviewed · audio not assessed**. Incomplete listening coverage cannot become a clean review. Fix stages a proposal; Intentional records rationale; Dismiss retains the finding. Accepting an edit can make performances and mixes stale. A skipped sound must be explicitly marked optional/omitted before final readiness.

## Delivery and phone use

Episode overview inherits turn 227's progress vocabulary: Script, Cast, Performed, Mixed. Publication adds source reconciliation, listening review, media/voice clearance and exact included episodes. Export supports episode audio and a compiled edition when the selected profile supports it, a listener transcript, credits, a production script and genuinely available stems. Archive exact script/source/voice/arrangement versions in an immutable edition; later edits do not mutate it. Podcast hosting, RSS publication, monetisation and new third-party accounts are out of the first release.

Desktop keeps the writing page's measure and optional source column, without a hero over the script. Fold collapses Source into a sheet when it would squeeze the page. Phone uses a compact header, horizontal scene navigation, Script/Source access, a fixed typing toolbar and sheets for source, cast and cue details. Audio Studio keeps its existing phone timeline and numeric controls. Focus restoration, labelled controls, keyboard alternatives and 44px touch targets are requirements. A script remains readable without sound or colour; transcripts are part of the production, not a later accessibility patch.

## Proposed implementation slices and acceptance

1. **Source-linked script.** Add `audio-drama` to exhaustive kind/shape, setup, routes and export eligibility; source manifest and adaptation decisions; typed script documents and revisions. Test same-world eligibility, empty/retired source, incomplete reads, multi-source mappings, repeated text, splits/joins and source edits. No generation yet.
2. **Scene room and pilot.** Reuse writing and overview UI, selection proposals, source drawer and script export. Test every block type, spoken/unspoken distinction, focus/touch, partial acceptance and knowledge-boundary review. Demonstrate an action scene and quiet scene understood in a blind table read.
3. **Casting and performances.** Explicit production overrides, mode-aware direction, quote previews, recordings and resumable jobs. Test missing cast, no silent fallback, narrator accent isolation, dialogue tags not spoken, mixed output limits, retries/unknown outcomes and navigation during generation.
4. **Arrange and deliver.** Adapt the existing Studio input, add episode sequencing and edition capture. Test cue movement after take replacement, fixed cues, stale selections, mono intelligibility, preview/export equivalence, exact transcript membership and missing-asset refusal. Do not ship a second mixer or duplicate editable timeline.

Design acceptance: approve the new production type, three editable creative approaches, scene view names, source/coverage workflow, direction separation and reuse of Audio Studio. After design approval, amend SPEC-012, SPEC-020, SPEC-047, SPEC-052 and publication requirements or introduce a dedicated Audio Drama capability spec with explicit ownership. The private document set was readable but **not a Git repository** on this machine; no private amendment was made or claimed committed. This is a public design proposal, not a substitute for those requirements.

## Validation

The review fixture and its nine HTML drawings are generated by `audio-drama-228.mjs`. Run `node design-system/audio-drama-228.mjs`, `node design-system/check-master.mjs --record`, `node design-system/build-review.mjs`, and `node design-system/build-review.mjs --check`. Browser checks exercise local interactions, desktop/Fold/phone overflow, keyboard focus and source decisions. These validate drawings, not synthesis quality or implementation.

Verified on 17 October 2026:

- Generator and JavaScript syntax checks pass. The master preserves 224 recorded turns and the generated review resolves all 397 screens; all prior turn bodies remain unchanged.
- Headless Edge rendered all nine views at 1440 px, and adaptation/script/cast/review/source-change views at 984 px and 390 px. No document-width overflow or browser/resource errors remained. Desktop script, cast, setup, studio and phone script screenshots were visually inspected.
- Exercised omission acceptance before opening the pilot, unassigned-voice blocking, casting followed by audition preflight, actor/portrayal switching, cue details, source revision proposals, retained divergence, review proposals and the phone source sheet. Dialogs close using their button or Escape.
- The Studio drawing uses the existing shell with seven illustrative clips; controls explain the fixture boundary and link to the dedicated Studio prototype. There is no synthesis, real listening analysis, provider charge or persisted production edit.

Preview locally with `node design-system/audio-drama-228.serve.mjs 8796`, then open `http://127.0.0.1:8796/design-system/audio-drama-228.review.html`. The server is read-only and restricted to public design assets and the named research/style files.
