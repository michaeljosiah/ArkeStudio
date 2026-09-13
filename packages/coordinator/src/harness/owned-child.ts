import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { killTree, listDescendants, ownerStamp, platformProbe, type DescendantInfo } from "../child-ledger.js";
import { leashChildToParent } from "../job-leash.js";
import type { SupervisorDeps } from "../supervisor.js";

interface OwnedChildDeps extends SupervisorDeps {
  platform?: NodeJS.Platform;
  kill?: (pid: number) => Promise<void>;
  leash?: typeof leashChildToParent;
  snapshotMs?: number;
}
interface TrackedChild {
  descendants: Map<number, DescendantInfo>;
  snapshot: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
}

/**
 * The stdio harness has no HTTP health supervisor. Give its private process the same ledger
 * and Windows Job Object ownership, including helpers started only when a later turn needs
 * them. Identity checks keep an old helper pid from becoming permission to kill a new owner.
 */
export function ownedChildHooks(
  id: string, command: string, deps: OwnedChildDeps = {}, onTrace?: (line: Record<string, unknown>) => void,
): {
  onSpawn: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  killProcess: (child: ChildProcessWithoutNullStreams) => Promise<void>;
} {
  const children = new WeakMap<ChildProcessWithoutNullStreams, TrackedChild>();
  const platform = deps.platform ?? process.platform;
  const kill = deps.kill ?? killTree;
  const trace = (at: string) => onTrace?.({ at, harness: id });
  const release = async (pid: number) => { await deps.ledger?.release(pid).catch(() => trace("harness.ledger-release-failed")); };
  const live = (child: ChildProcessWithoutNullStreams) => child.exitCode === null && child.signalCode === null;
  const snapshot = async (child: ChildProcessWithoutNullStreams, state: TrackedChild) => {
    if (platform !== "win32" || state.stopping || !child.pid || !live(child)) return;
    try {
      const found = await (deps.listDescendants ?? listDescendants)(child.pid);
      for (const descendant of found) {
        if (state.descendants.has(descendant.pid)) continue;
        state.descendants.set(descendant.pid, descendant);
        await deps.ledger?.record({
          ...ownerStamp(), pid: descendant.pid, image: descendant.image, id,
          parentPid: child.pid, recordedAt: descendant.startedAt ?? Date.now(),
        }).catch(() => trace("harness.ledger-record-failed"));
      }
    } catch { trace("harness.descendant-snapshot-failed"); }
  };
  const schedule = (child: ChildProcessWithoutNullStreams, state: TrackedChild) => {
    if (platform !== "win32" || state.stopping || !live(child)) return;
    state.timer = setTimeout(() => {
      state.snapshot = snapshot(child, state).finally(() => schedule(child, state));
    }, deps.snapshotMs ?? 3000);
    state.timer.unref();
  };
  const killProcess = async (child: ChildProcessWithoutNullStreams): Promise<void> => {
    const state = children.get(child);
    if (!state || !child.pid) return;
    if (state.stopping) return state.stopping;
    if (state.timer) clearTimeout(state.timer);
    const pid = child.pid;
    state.stopping = (async () => {
      await state.snapshot;
      if (platform !== "win32" && !deps.kill) {
        // Rpc spawns a detached process group on POSIX, so a helper remains reachable after
        // the app-server exits. Killing only its already-dead leader would strand the helper.
        try { process.kill(-pid, "SIGKILL"); } catch { if (live(child)) await kill(pid); }
      } else if (live(child)) await kill(pid);
      const tracked = [...state.descendants.values()];
      if (tracked.length) {
        try {
          const processes = await (deps.probe ?? platformProbe)(tracked.map(row => row.pid));
          for (const row of tracked) {
            const current = processes.get(row.pid);
            if (!current) { await release(row.pid); continue; }
            if (current.image !== row.image || current.startedAt === null || row.startedAt === null ||
              Math.abs(current.startedAt - row.startedAt) > 5000) continue;
            await kill(row.pid);
            await release(row.pid);
          }
        } catch { trace("harness.descendant-reap-failed"); }
      }
      if (!live(child)) await release(pid);
    })();
    return state.stopping;
  };
  return {
    onSpawn: async (child) => {
      if (!child.pid) return;
      const state: TrackedChild = { descendants: new Map(), snapshot: Promise.resolve() };
      children.set(child, state);
      child.once("exit", () => {
        void killProcess(child).then(() => release(child.pid!), () => trace("harness.child-cleanup-failed"));
      });
      await deps.ledger?.record({ pid: child.pid, image: basename(command).toLowerCase(), id, ...ownerStamp(), recordedAt: Date.now() })
        .catch(() => trace("harness.ledger-record-failed"));
      if (platform === "win32" && live(child)) {
        const leashed = await (deps.leash ?? leashChildToParent)(child.pid).catch(() => ({ ok: false }));
        if (!leashed.ok) trace("harness.child-leash-failed");
      }
      state.snapshot = snapshot(child, state);
      await state.snapshot;
      if (live(child)) schedule(child, state);
      else await killProcess(child);
    },
    killProcess,
  };
}
