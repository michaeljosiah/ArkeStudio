import { join } from "node:path";
import type { ClientMessage, ModelManifest } from "@arke-studio/contracts";
import { Coordinator } from "../../src/coordinator.js";
import { FsWorldProvider } from "../../src/world/provider.js";

/**
 * A coordinator booted over an app root whose `ledger.jsonl` the test has staged — the wiring
 * the desktop shell uses, where the seed path and `LedgerFile` are the same file
 * (apps/desktop/src/main.ts). Shared so the availability suites cannot drift apart on how that
 * wiring is spelled: two copies of it would let one keep testing a boot the shipping app no
 * longer performs.
 *
 * The unreadable ledger these suites stage is a directory named `ledger.jsonl` — EACCES has no
 * portable fixture, and `readFile` fails EISDIR on every platform, which is exactly a path
 * that exists and cannot be read as a file.
 */
export async function startLedgerCoordinator(
  root: string,
  opts: { manifest?: ModelManifest } = {},
) {
  const provider = new FsWorldProvider(root, { clock: () => "2026-08-28T12:00:00.000Z" });
  const coordinator = new Coordinator({
    provider,
    adapter: null,
    changeLogPath: join(root, "logs", "changes.jsonl"),
    appVersion: "test",
    appRoot: root,
    ledgerSeedPath: join(root, "ledger.jsonl"),
    ...(opts.manifest ? { manifest: opts.manifest } : {}),
  });
  await coordinator.start(0);
  return {
    coordinator,
    send: (msg: ClientMessage) =>
      (coordinator as unknown as { handleClientMessage(m: ClientMessage): Promise<void> }).handleClientMessage(msg),
    close: async () => {
      await coordinator.stop();
      await provider.close();
    },
  };
}
