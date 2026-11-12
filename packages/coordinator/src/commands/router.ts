import type { ClientMessage } from "@arke-studio/contracts";
import type { WorldStore } from "../world/store.js";
import type { CommandContext } from "./context.js";

/**
 * Which world a command may act on, said once where the command is routed (issue 2796). Every
 * case in the coordinator's switch wrote its own check, and they drifted: some refused, some
 * returned in silence, some forgot.
 *
 * - `open-world`: only the world that is open now; a message naming another is refused.
 * - `any-world`: work that takes the named world's store in the background, open or not.
 * - `none`: application, account or installation state outside any world.
 */
export type WorldScope = "open-world" | "any-world" | "none";

export type ClientCommandKind = ClientMessage["kind"];
export type CommandOf<K extends ClientCommandKind> = Extract<ClientMessage, { kind: K }>;

/** A command scoped to the open world is handed that world's store, already checked. */
export type CommandSpec<K extends ClientCommandKind> =
  | (CommandOf<K> extends { worldId: string } ? { scope: "open-world"; handle(msg: CommandOf<K>, store: WorldStore): Promise<void> | void } : never)
  | { scope: "any-world" | "none"; handle(msg: CommandOf<K>): Promise<void> | void };

/** One domain's commands. */
export type CommandModule = { readonly [K in ClientCommandKind]?: CommandSpec<K> };

/** The coordinator's refusal for a command that names a world other than the open one (issue 2772). */
export const WORLD_NOT_OPEN = "That world is no longer open.";

/**
 * The commands domain modules own, checked for their world and answered when they fail. The
 * coordinator asks this first, after the prologue that serialises and redirects a message, so the
 * order every message is handled in is unchanged; a kind no module owns returns false and the
 * coordinator's switch takes it, as it took every kind before. Domains move here one at a time.
 */
export class CommandRouter {
  // Each spec's handler is typed for its own kind; the map holds them as one shape, and `dispatch`
  // hands each the message its kind was routed by.
  private readonly specs = new Map<ClientCommandKind, { scope: WorldScope; handle(msg: ClientMessage, store?: WorldStore): Promise<void> | void }>();

  constructor(private readonly ctx: Pick<CommandContext, "openStore" | "fail">, modules: readonly CommandModule[]) {
    for (const module of modules) {
      for (const kind of Object.keys(module) as ClientCommandKind[]) {
        if (this.specs.has(kind)) throw new Error(`${kind} is routed twice`);
        this.specs.set(kind, module[kind] as never);
      }
    }
  }

  /** True when a module answered this message, whatever its outcome; false leaves it to the switch. */
  async dispatch(msg: ClientMessage): Promise<boolean> {
    const spec = this.specs.get(msg.kind);
    if (!spec) return false;
    const requestId = "requestId" in msg && typeof msg.requestId === "string" ? msg.requestId : null;
    try {
      if (spec.scope === "open-world") {
        const store = this.ctx.openStore();
        if (!store || !("worldId" in msg) || store.worldId !== msg.worldId) {
          this.ctx.fail(msg.kind, requestId, WORLD_NOT_OPEN);
          return true;
        }
        await spec.handle(msg, store);
      } else {
        await spec.handle(msg);
      }
    } catch (error) {
      // A handler that answers its own failures catches them; one that throws is answered here,
      // in words a person can act on, rather than reaching the transport's generic backstop.
      this.ctx.fail(msg.kind, requestId, error);
    }
    return true;
  }
}
