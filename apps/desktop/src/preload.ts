import { contextBridge, ipcRenderer, webUtils } from "electron";

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

/**
 * Where an attachment is going. The renderer names the destination, the host names the path —
 * neither knows the other's half, and the two only meet in the frame that leaves here.
 */
type AttachTarget = { kind: "file-artifact"; worldId: string } | { kind: "genesis-attach"; genesisId: string };

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
    socket.addEventListener("open", () => notifyStatus("open"));
    socket.addEventListener("close", () => {
      socket = null;
      notifyStatus("closed");
    });
    socket.addEventListener("error", () => {
      /* close follows */
    });
    socket.addEventListener("message", (e) => {
      const data = typeof e.data === "string" ? e.data : "";
      for (const l of frameListeners) l(data);
    });
  },

  send(json: string): void {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(json);
  },

  subscribe(onFrame: FrameListener, onStatus: StatusListener): void {
    frameListeners.add(onFrame);
    statusListeners.add(onStatus);
  },

  onActivateActivity(listener: () => void): () => void {
    const activate = () => listener();
    ipcRenderer.on("arke:activate-activity", activate);
    ipcRenderer.send("arke:activity-activation-ready");
    return () => ipcRenderer.removeListener("arke:activate-activity", activate);
  },

  /**
   * Files dropped on, or pasted into, the composer.
   *
   * The window legitimately holds the File objects — the drop event handed them over — but not
   * where they live. Resolving that happens here and the path goes straight out on the socket
   * as a file-artifact frame, so the renderer still never sees one (SPEC-001 R-9). Anything
   * with no file behind it (a clipboard screenshot, a drag out of a web page) comes back by
   * index, for the caller to offer again as bytes.
   */
  attachDropped(target: AttachTarget, files: readonly unknown[]): { filed: number; unresolved: number[] } {
    const unresolved: number[] = [];
    let filed = 0;
    files.forEach((file, index) => {
      let sourcePath = "";
      try {
        sourcePath = webUtils.getPathForFile(file as File);
      } catch {
        sourcePath = "";
      }
      if (!sourcePath) {
        unresolved.push(index);
        return;
      }
      bridge.send(JSON.stringify({ ...target, sourcePath }));
      filed += 1;
    });
    return { filed, unresolved };
  },

  /** Bytes with no file behind them: the host spools them, then they file like anything else. */
  async attachBytes(
    target: AttachTarget,
    name: string,
    bytes: Uint8Array,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Crossing the context bridge can hand this over as a view, a buffer or a plain array
    // depending on the shape it went in as. Normalise rather than trust — a wrong guess here
    // writes a zero-byte file and the attachment fails silently, which is the worst outcome.
    const raw: unknown = bytes;
    const view = ArrayBuffer.isView(raw)
      ? new Uint8Array((raw as ArrayBufferView).buffer, (raw as ArrayBufferView).byteOffset, (raw as ArrayBufferView).byteLength)
      : raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : Array.isArray(raw)
          ? Uint8Array.from(raw as number[])
          : null;
    if (!view) return { ok: false, reason: "the app could not read what was pasted" };
    const result = (await ipcRenderer
      .invoke("arke:spool", { name, bytes: view })
      .catch((err: unknown) => ({ reason: String(err) }))) as { path?: string; reason?: string };
    if (!result?.path) return { ok: false, reason: result?.reason ?? "the app could not hold on to it" };
    bridge.send(JSON.stringify({ ...target, sourcePath: result.path }));
    return { ok: true };
  },
};

export type ArkeBridge = typeof bridge;

contextBridge.exposeInMainWorld("arke", bridge);
