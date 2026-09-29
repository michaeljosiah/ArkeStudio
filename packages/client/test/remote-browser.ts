import { prepareRemoteSession } from "../src/lib/remote-session.js";

export async function prepareTestRemoteBrowser() {
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    register: async () => ({}), ready: Promise.resolve({}),
    // MessagePort has no targetOrigin argument; this channel is supplied by the caller.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    controller: { postMessage: (_message: unknown, ports: MessagePort[]) => ports[0]!.postMessage("b".repeat(64)) },
    addEventListener() {}, removeEventListener() {},
  } });
  await prepareRemoteSession();
}
