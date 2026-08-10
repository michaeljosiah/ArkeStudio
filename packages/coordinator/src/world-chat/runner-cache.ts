import type { ConversationId } from "@arke-studio/contracts";

/**
 * Which runner serves a conversation, when the world underneath it can be closed (#70 §8).
 *
 * A runner is kept rather than rebuilt per command because it holds the in-flight runs: one made
 * fresh for a cancel would have no record of the turn it was asked to stop. But its callbacks
 * close over the WorldStore it was built from, and closing a world and reopening it hands back a
 * different one — so "keep it" and "it reads the world that is open" pull against each other, and
 * this is where that is decided rather than in the middle of building one.
 *
 * Kept here rather than as three fields on the coordinator because the rule is easy to state and
 * easy to get subtly wrong: the first version asked "is anything running?" and kept the old runner
 * for the whole world, which quietly served every new turn in every other conversation from a
 * closed store.
 */

/** What the cache needs of a runner. The rest of it is no business of this file. */
export interface CachedRunner {
  isRunning(conversationId: ConversationId): boolean;
  hasRunning(): boolean;
}

export class WorldChatRunnerCache<R extends CachedRunner> {
  private readonly current = new Map<string, { runner: R; store: object }>();
  /**
   * Runners whose store was closed under them while a turn was still running.
   *
   * They serve no new work, but the conversation they are mid-turn on has to keep reaching them:
   * the abort controller that can stop that turn exists nowhere else, and a turn already talking
   * to a model is a worse thing to drop than a stale read is to carry to the end of it.
   *
   * Each remembers the world it belonged to, and is only ever offered back to that one. A
   * conversation id is unique within a world and not across them — copying a world gives the copy
   * a new id of its own while its conversations keep theirs — so matching on the conversation
   * alone would hand the copy the original's runner, closed-over store and all.
   */
  private readonly retired = new Set<{ worldId: string; runner: R }>();

  /**
   * The runner that should serve this conversation, or undefined when one has to be built.
   *
   * Retires the world's runner as a side effect when the store it was built from is no longer the
   * open one — asking the question is the only moment anything knows.
   */
  runnerFor(worldId: string, store: object, conversationId: ConversationId): R | undefined {
    const existing = this.current.get(worldId);
    if (existing && existing.store !== store) {
      this.current.delete(worldId);
      if (existing.runner.hasRunning()) this.retired.add({ worldId, runner: existing.runner });
    }
    for (const entry of this.retired) {
      // Swept here rather than on a timer: a runner with nothing running holds nothing worth
      // keeping, and this is the only place that ever asks.
      if (!entry.runner.hasRunning()) {
        this.retired.delete(entry);
        continue;
      }
      if (entry.worldId === worldId && entry.runner.isRunning(conversationId)) return entry.runner;
    }
    return this.current.get(worldId)?.runner;
  }

  /** Hold this runner as the one the open store's world uses from now on. */
  remember(worldId: string, store: object, runner: R): void {
    this.current.set(worldId, { runner, store });
  }
}
