/** Resolve against the whole world so an ownership refusal is never described as lost media. */
export function resolveProductionArtifact<T extends { id: string; production?: string | null; file?: string }>(
  artifacts: readonly T[], artifactId: string, productionId: string,
): { ok: true; artifact: T } | { ok: false; code: "missing" | "other-production"; reason: string } {
  const artifact = artifacts.find(candidate => candidate.id === artifactId);
  // These reasons reach the screen (the Cut, Publish), so a file is named by its name, never its id.
  if (artifact === undefined) return { ok: false, code: "missing", reason: "a file which this world does not have" };
  if (artifact.production != null && artifact.production !== productionId) return {
    ok: false, code: "other-production",
    reason: `${artifact.file?.split("/").pop() ?? "a file"}, which belongs to another production. Import the file into this production or remove this reference`,
  };
  return { ok: true, artifact };
}
