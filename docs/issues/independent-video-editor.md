## Problem

The Cut page looks like an editor but importing personal footage requires filing it into the world, separately adding it to a curated Library, and then placing it. The default placement treats video as an insert above Picture. Scene bands and shot-oriented labels suggest fixed sections, even though the saved timeline already supports independent artifact clips.

The intended experience is a lightweight video editor: start with no scenes, import video onto the main timeline, detach its audio, then independently split, trim, move and delete picture and sound.

## Specification

SPEC-042: `docs/specifications/042.independent-video-editing.md` (included in the implementation PR). Amends the editor workflow in SPEC-037/038/039 while retaining world-owned immutable media, frame-based commands, shared preview/export planning and durable undo.

## Acceptance criteria

- An empty production with zero scenes can import one or more local videos and append them sequentially to the main Picture track.
- Import automatically adds the filed assets to the current Library, reports failures, and never stores a host path in a timeline clip.
- Desktop file drops into the Library import media; drops onto Picture import and place at the requested position. Existing Library media offers explicit main-track placement and overlay actions.
- Timeline clips show source names and editable clip boundaries. Scene grouping is optional context rather than permanent timeline sections.
- Detach audio creates an independent audio clip with matching start, duration and source offset, and mutes the original picture in the same undoable operation. Unsupported or unmeasured sources explain why detachment is unavailable.
- Both halves support independent split, trim, move and delete, with source bounds, overlap validation and durable undo/redo.
- A footage-only edit survives reopening and previews/exports the same picture and audio without doubled sound.
- Existing story assemblies and saved timelines remain usable; no scene/shot creation or destructive migration is required.

## Validation

The agreed audio model is generic, renameable Audio tracks created as needed, with optional
clip roles (Unspecified, Voice, Music, Ambience) selected after placement. A track may provide a
default role for future clips; explicit clip roles override it and changing the default does not
change existing clips. Preserve legacy mixes, performance safeguards and master references while
removing the requirement for dedicated Dialogue, Ambience or Music lanes (SPEC-042 R-17–R-21).

Add regressions for import success, deduplication, cancellation/failure, stale timeline protection, a zero-scene video/audio editing journey, render-plan parity, persistence and undo/redo. Run lint, typecheck, build and tests; validate native drop handling if the desktop bridge changes.

## Audio foundation dependency (reviewed 2026-09-05)

The pushed branch `origin/codex/issue-117-audio-foundation` was reviewed at `4e696b5d86b5af4cd78f2dc397840ec611076d01`. That work landed through PR #856. On 2026-09-05 the editor worktree was successfully rebased onto fetched remote main at `d129c493`, incorporating its dependencies together.

SPEC-042 R-13 through R-16 and T-6 through T-9 now cover the compatibility requirements:

- **#115:** Preserve shot-linked reviewed `performance` sources, atomic mutually approved dialogue placement, the in-gate placement checks, saved-timeline slot authority and exact physical audio ranges in preview/export. Ordinary imported/detached artifact or take audio remains independently editable, including on Dialogue tracks. Editing referenced shot slots must surface stale/ambiguous reviewed timing and its existing recovery.
- **#256:** Preserve `performanceSourceClipId`, `set-performance-source`, timeline hashes and undo. Master generation references map Picture timeline time into Music source time; Picture media trims do not shift them. This relationship is not an editing link. Embedded-audio detachment must not copy/mute the external soundtrack or copy the Picture-only reference onto an audio clip. New preparation/dispatch revalidates changed bindings; queued prepared audio stays frozen.

No application code has been changed for this issue. The current worktree contains the issue brief and specification.

## Implementation branch

`codex/independent-video-editor`, created in a new worktree from fetched `origin/main` at `9fbf1bd456dbea1a2dff9fed777b357cdda6ebf8`, then rebased onto `d129c493` after the audio foundation landed.
