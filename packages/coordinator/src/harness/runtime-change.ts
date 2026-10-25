import type { HarnessAdapter } from "@arke-studio/contracts";

/** Completion, rather than async admission, bounds a writing turn. Coordinator's async
 * dispatch wrapper calls sendMessage too, so cloud and local turns share this fence. */
export class HarnessRuntimeChanges {
  private active = 0;
  private changing = false;

  wrap<T extends HarnessAdapter>(adapter: T): T {
    return new Proxy(adapter, { get: (target, property) => {
      if (property === "sendMessage") return async (...args: Parameters<HarnessAdapter["sendMessage"]>) => {
        if (this.changing) throw new Error("Writing runtime settings are changing. Try again shortly.");
        this.active++;
        try { return await target.sendMessage(...args); }
        finally { this.active--; }
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active > 0 || this.changing) throw new Error("Finish or cancel writing before changing the Ollama runtime.");
    this.changing = true;
    try { return await work(); }
    finally { this.changing = false; }
  }
}
