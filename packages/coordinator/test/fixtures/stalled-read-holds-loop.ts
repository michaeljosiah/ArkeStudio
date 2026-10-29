// Run as a bare process by coalesced-reads.test.ts, with nothing else on the event loop: the only
// pending work is a CoalescedReads deadline behind a read that awaits nothing, as a read waiting on
// a world that never comes does. The deadline has to hold the process open until it fires. If it
// does not, the loop drains first, the ask never settles, and the only line printed is beforeExit.
import { CoalescedReads, ReadStalledError } from "../../src/coalesced-reads.js";

process.on("beforeExit", () => console.log("beforeExit"));
new CoalescedReads<string>(50)
  .ask("book", (turn) => {
    turn.stage("waiting for the world");
    return new Promise<never>(() => {});
  })
  .then(
    () => console.log("resolved"),
    (error: unknown) => console.log(error instanceof ReadStalledError ? `stalled: ${error.stage}` : `rejected: ${String(error)}`),
  );
