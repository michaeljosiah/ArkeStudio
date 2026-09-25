// Moved to @arke-studio/confined-tools (issue 1247, Phase 1) so every harness that executes its
// own tools shares one implementation of the pinned-root confinement. Re-exported here so this
// package's imports, and its tests, read exactly as they did.
export {
  captureRootIdentity, ConfinedFiles, ConfinementError, confinedTarget, fileConfinementUnavailable, resolveRoot, WindowsFiles, within,
  type FileEntry, type FileIdentity,
} from "@arke-studio/confined-tools";
