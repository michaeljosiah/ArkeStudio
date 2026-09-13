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
  snapshotTimeoutMs?: number;
  listDescendants?: (rootPid: number, signal?: AbortSignal) => Promise<DescendantInfo[]>;
}
interface TrackedChild {
  descendants: Map<number, DescendantInfo>;
  snapshot: Promise<void>;
  snapshotAbort?: AbortController;
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
    const abort = new AbortController();
    state.snapshotAbort = abort;
    const timer = setTimeout(() => abort.abort(), deps.snapshotTimeoutMs ?? 10_000);
    let rejectCancelled!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancelled = () => reject(new Error("Descendant inspection was cancelled."));
      abort.signal.addEventListener("abort", rejectCancelled, { once: true });
    });
    try {
      const found = await Promise.race([(deps.listDescendants ?? listDescendants)(child.pid, abort.signal), cancelled]);
      for (const descendant of found) {
        // A late result from a non-cancellable injected probe cannot repopulate a ledger
        // after cleanup. Already-started record writes finish before their release below.
        if (abort.signal.aborted || state.stopping || !live(child)) break;
        if (state.descendants.has(descendant.pid)) continue;
        state.descendants.set(descendant.pid, descendant);
        await deps.ledger?.record({
          ...ownerStamp(), pid: descendant.pid, image: descendant.image, id,
          parentPid: child.pid, recordedAt: descendant.startedAt ?? Date.now(),
        }).catch(() => trace("harness.ledger-record-failed"));
      }
    } catch { if (!state.stopping) trace("harness.descendant-snapshot-failed"); }
    finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", rejectCancelled);
      if (state.snapshotAbort === abort) state.snapshotAbort = undefined;
    }
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
    state.stopping = Promise.resolve().then(async () => {
      state.snapshotAbort?.abort();
      if (platform !== "win32" && !deps.kill) {
        // Rpc spawns a detached process group on POSIX, so a helper remains reachable after
        // the app-server exits. Killing only its already-dead leader would strand the helper.
        try { process.kill(-pid, "SIGKILL"); } catch { if (live(child)) await kill(pid); }
      } else if (live(child)) {
        await kill(pid).catch(() => trace("harness.child-tree-kill-failed"));
        // taskkill can time out or be refused. The ChildProcess still holds our own process
        // handle, so force that child down while keeping unresolved helpers in the ledger.
        if (live(child)) { try { child.kill("SIGKILL"); } catch { trace("harness.child-kill-failed"); } }
      }
      await state.snapshot;
      const tracked = [...state.descendants.values()];
      if (tracked.length) {
        try {
          const processes = await (deps.probe ?? platformProbe)(tracked.map(row => row.pid));
          const attempted: number[] = [];
          for (const row of tracked) {
            const current = processes.get(row.pid);
            if (!current) { await release(row.pid); continue; }
            if (current.image !== row.image || current.startedAt === null || row.startedAt === null ||
              Math.abs(current.startedAt - row.startedAt) > 5000) continue;
            await kill(row.pid);
            attempted.push(row.pid);
          }
          if (attempted.length) {
            const remaining = await (deps.probe ?? platformProbe)(attempted);
            for (const descendantPid of attempted) {
              if (!remaining.has(descendantPid)) await release(descendantPid);
            }
          }
        } catch { trace("harness.descendant-reap-failed"); }
      }
      if (!live(child)) await release(pid);
    });
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
