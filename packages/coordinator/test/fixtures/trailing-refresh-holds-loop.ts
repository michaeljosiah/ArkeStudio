// Run as a bare process by founding-build.test.ts, with nothing else on the event loop: the only
// pending work is the pause after a coalesced snapshot refresh, which shutdown's drain awaits. The
// pause has to hold the process open until it ends. If it does not, the loop drains first, the
// drain never settles, and the only line printed is beforeExit.
import { FoundingBuildService, type FoundingBuildPorts } from "../../src/world/founding-build.js";

process.on("beforeExit", () => console.log("beforeExit"));
const tracked: Promise<unknown>[] = [];
const service = new FoundingBuildService({ refreshWorldSnapshot: async () => {},
  track: (work: Promise<unknown>) => { tracked.push(work); } } as unknown as FoundingBuildPorts);
(service as unknown as { refreshSoon(worldId: string): void }).refreshSoon("w1");
void Promise.allSettled(tracked).then(() => console.log("drained"));
