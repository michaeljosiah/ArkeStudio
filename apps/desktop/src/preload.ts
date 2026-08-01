import { contextBridge } from "electron";

/**
 * The typed preload bridge (SPEC-001 R-9): one object on `window.arke` exposing connect,
 * send and subscribe. Nothing else crosses the boundary — no Node, no Electron, no paths,
 * and never a credential (R-10).
 */

function argValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

const port = argValue("arke-ws-port");
const appVersion = argValue("arke-app-version") ?? "0.0.0";
const wsUrl = port ? `ws://127.0.0.1:${port}` : null;
/** Read-only media base (design-fidelity pass): same server, plain GET. */
const httpBase = port ? `http://127.0.0.1:${port}` : null;

type FrameListener = (frameJson: string) => void;
type StatusListener = (status: "connecting" | "open" | "closed") => void;

let socket: WebSocket | null = null;
const frameListeners = new Set<FrameListener>();
const statusListeners = new Set<StatusListener>();

function notifyStatus(status: "connecting" | "open" | "closed"): void {
  for (const l of statusListeners) l(status);
}

const bridge = {
  appVersion,
  platform: process.platform as string,
  httpBase,

  /** (Re)establish the socket to the embedded coordinator. Loopback only. */
  connect(): void {
    if (!wsUrl) {
      notifyStatus("closed");
      return;
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    notifyStatus("connecting");
    socket = new WebSocket(wsUrl);
    socket.onopen = () => notifyStatus("open");
    socket.onclose = () => {
      socket = null;
      notifyStatus("closed");
    };
    socket.onerror = () => {
      /* close follows */
    };
    socket.onmessage = (e) => {
      const data = typeof e.data === "string" ? e.data : "";
      for (const l of frameListeners) l(data);
    };
  },

  send(json: string): void {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(json);
  },

  subscribe(onFrame: FrameListener, onStatus: StatusListener): void {
    frameListeners.add(onFrame);
    statusListeners.add(onStatus);
  },
};

export type ArkeBridge = typeof bridge;

contextBridge.exposeInMainWorld("arke", bridge);
