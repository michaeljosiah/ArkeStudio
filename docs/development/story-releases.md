# Story releases

The full Undersong is a separate, explicitly requested download. The small world in
`fixtures/worlds/the-undersong` remains a test/dev fixture and is excluded from the installer.
Neither onboarding nor application startup downloads story media automatically.

## Standalone reading editions

The [reviewed illustrated EPUB](https://github.com/michaeljosiah/ArkeStudio/releases/download/undersong-2026-10-19-r3/the-undersong-perrins-awakening-reviewed-reading-2026-10-22.epub)
contains all 23 revised chapters and 290 picture placements, including the 24 corrections
accepted after the complete illustration review. It uses reading-size images up to 2048 pixels
and is 88,354,113 bytes. SHA-256:
`919fed2be79e5615027d586eb6f2d2cf62bc3f90e661ec7043baa71181307036`.

The [single-narrator M4B](https://github.com/michaeljosiah/ArkeStudio/releases/download/undersong-2026-10-19-r3/the-undersong-perrins-awakening-23-chapters-2026-10-21.m4b)
contains the same 23 chapters, with 23 chapter markers and a duration of 5h 33m 30s. It is
262,400,863 bytes, SHA-256
`a6e5cdee76ce9d93b558390aedacc3c67885bf999fff69c3e10bfe556e917608`.
The illustration corrections do not change its narration.

These are immutable standalone files created through Arke Publish. They do not update an
installed world or the earlier editable-world archive. The older original-quality EPUB
predates the latest 24 illustration corrections. Full-book listening qualification,
physical-device import, the updated editable-world package and the video episode remain
unfinished. The [story release](https://github.com/michaeljosiah/ArkeStudio/releases/tag/undersong-2026-10-19-r3)
keeps current download links and the scope of each historical edition.

## On-demand world installation

Desktop and development composition use `UNDERSONG_RELEASE` from coordinator
`src/world/undersong-release.ts`. Settings shows its version, download size and completion
status before installation. The coordinator fetches only the pinned HTTPS GitHub release,
checks exact compressed size and SHA-256, validates archive paths, types, expanded size and
entry CRCs, then uses the existing world installer to assign a fresh identity. Existing worlds
are not updated or overwritten. Settings shows required and available disk space before the
action, with a refresh control after space has been freed. Required space accounts for the
remaining archive, extraction, an independent installed copy and a 64 MiB margin.

Cancel download stops only this transfer or extraction. Cancellation, shutdown and network
interruption retain a nonempty archive prefix under its pinned SHA-256 in the app's downloads
folder; extraction scratch is removed. Resume survives restarting Arke and requests exactly
the remaining range. If the host ignores Range, the archive is replaced from the beginning.
Every attempt hashes the entire completed archive before extracting it; invalid ranges,
sizes, digests or archive contents discard the cache. A different release never uses its
predecessor's bytes. Remove downloaded data deletes only the selected release's cache, not
installed worlds or other files. Invalid or empty retained files can also be removed there.

Install, cancel, resume, remove and refresh remain host-only commands. Once independent
installation starts, Cancel is withdrawn and the copy drains before shutdown. Successful
installation removes the archive and extraction scratch; cleanup failure is reported separately.
If the copy fails, extraction scratch is removed but the verified archive remains for another
attempt. Retry still rehashes it before extraction and installation, without another transfer.

## Prepare and publish

1. Finish native world edits, stop authoring work, and select the intended productions,
   artifacts and completed exports in a versioned JSON configuration. Exclude unrelated worlds,
   operational sessions and credentials. Set `completion` to an explicit, nonempty release
   status and describe missing deliverables in `status`. The packager requires the completion
   label before creating output and copies it into `story-package.json`; it does not infer
   editorial readiness from the presence of media files.
2. Run `node --import tsx scripts/package-story-world.mts SOURCE NEW_OUTPUT CONFIG`.
   The new output must be outside the source world. It preserves selected authored history,
   follows artifact references, binds configured prop artwork through native domain operations,
   scans the isolated copy, and emits a ZIP, file inventory and release digest. It never edits
   the live world. Use a volume with room for the source copy, archive and installation checks.
3. Inspect the inventory and text files for private paths, credentials or unrelated content.
   Verify all images, exported players and referenced media. Test the resulting archive through
   `downloadStory` and `installSampleWorld` in an isolated app root; reopen and scan the copy.
4. Publish the archive under a unique **non-`v*`** GitHub release tag, with `--latest=false`.
   This prevents triggering the application release workflow or replacing the app-update feed.
   Include completion status and SHA-256 in release notes; never replace a published archive.
5. Update the pinned descriptor with the exact URL, hash and compressed/expanded byte counts.
   Verify an unauthenticated download from that URL through the production downloader.
6. Run focused download/install tests, then the normal code gates and Windows/Linux CI.
   Merge the implementation and ship an application release before claiming installed clients
   have the new flow. The ZIP can also be extracted and opened as a normal world in Arke.

The 2026-10-19 delivery contains a novel and its illustrations, six completed audiobook
chapter exports, and an unfinished pilot plan with stills. It does **not** contain a complete
audiobook or finished video episode. These labels belong in the app, archive and release notes.
