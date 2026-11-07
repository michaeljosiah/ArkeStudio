import type { ClientState, WorldProblem } from "@arke-studio/contracts";

/**
 * File problems as a notice rather than a band (design turn 268). What the scan finds stays derived
 * and the Inbox always lists it; the settings remember only which paths a person has been told
 * about, so a restart or a second window does not raise the notice again.
 */

export interface FileProblemGroup {
  title: string;
  /** Past versions: the live record is whole, so the row draws without the warning dot. */
  quiet: boolean;
  problems: WorldProblem[];
}

export function fileProblemGroups(problems: readonly WorldProblem[]): FileProblemGroup[] {
  const groups: FileProblemGroup[] = [
    { title: "Could not be read", quiet: false, problems: problems.filter((problem) => problem.kind === undefined || problem.kind === "unreadable") },
    { title: "Same name", quiet: false, problems: problems.filter((problem) => problem.kind === "conflict") },
    { title: "History", quiet: true, problems: problems.filter((problem) => problem.kind === "history") },
  ];
  return groups.filter((group) => group.problems.length > 0);
}

/** Only these announce themselves. A snapshot's trouble costs a past version, not the live world. */
function announced(problems: readonly WorldProblem[]): WorldProblem[] {
  return problems.filter((problem) => problem.kind !== "history");
}

const count = (paths: Iterable<string>): number => new Set(paths).size;

export interface FileNotice {
  id: string;
  worldId: string;
  title: string;
  meta: string;
  /** Every announced path now, so answering settles the whole list and prunes what has cleared. */
  settles: string[];
}

/** The notice owed for the open world: paths not yet told, or null when there are none. */
export function pendingFileNotice(state: ClientState | null | undefined): FileNotice | null {
  const world = state?.world;
  if (!state || !world) return null;
  const told = new Set(state.app.activitySeen.fileProblems?.[world.meta.worldId] ?? []);
  const fresh = announced(world.problems).filter((problem) => !told.has(problem.path));
  if (fresh.length === 0) return null;
  const unread = count(fresh.filter((problem) => problem.kind !== "conflict").map((problem) => problem.path));
  const named = count(fresh.map((problem) => problem.path));
  return {
    id: `file-problems:${world.meta.worldId}`,
    worldId: world.meta.worldId,
    title: unread > 0
      ? `${unread} file${unread === 1 ? "" : "s"} could not be read`
      : `${named} record${named === 1 ? " shares" : "s share"} a name`,
    meta: world.meta.name,
    settles: [...new Set(announced(world.problems).map((problem) => problem.path))],
  };
}

/** The told list without the paths that have cleared, when any have: their return would be new. */
export function staleFileSettlement(state: ClientState | null | undefined): { worldId: string; paths: string[] } | null {
  const world = state?.world;
  if (!state || !world) return null;
  const told = state.app.activitySeen.fileProblems?.[world.meta.worldId] ?? [];
  const current = new Set(announced(world.problems).map((problem) => problem.path));
  const paths = told.filter((path) => current.has(path));
  return paths.length === told.length ? null : { worldId: world.meta.worldId, paths };
}
