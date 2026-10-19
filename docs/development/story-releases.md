# Story releases

The full Undersong is a separate, explicitly requested download. The small world in
`fixtures/worlds/the-undersong` remains a test/dev fixture and is excluded from the installer.
Neither onboarding nor application startup downloads story media automatically.

Desktop and development composition use `UNDERSONG_RELEASE` from coordinator
`src/world/undersong-release.ts`. Settings shows its version, download size and completion
status before installation. The coordinator fetches only the pinned HTTPS GitHub release,
checks exact compressed size and SHA-256, validates archive paths, types, expanded size and
entry CRCs, then uses the existing world installer to assign a fresh identity. Existing worlds
are not updated or overwritten. Failure removes the partial download; shutdown aborts network
and extraction work. Installation already in progress drains before shutdown.

## Prepare and publish

1. Finish native world edits, stop authoring work, and select the intended productions,
   artifacts and completed exports in a versioned JSON configuration. Exclude unrelated worlds,
   operational sessions and credentials. Describe missing deliverables explicitly.
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
