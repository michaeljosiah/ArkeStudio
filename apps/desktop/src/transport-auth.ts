/** Electron sends file:// on the WebSocket handshake but null on file-page fetches. Both
 * still require the capability; a development window instead uses its exact HTTP origin. */
export function desktopTransportOrigins(devServerUrl?: string): string[] {
  return devServerUrl ? [new URL(devServerUrl).origin] : ["file://", "null"];
}

interface MediaRequest {
  url: string;
  webContentsId?: number;
  requestHeaders: Record<string, string>;
}

/** Add credentials only to this window's media at this launch's endpoint. Redirects to other
 * ports/hosts must not inherit the header; never put a capability in a renderer-visible URL. */
export function authenticatedMediaHeaders(
  request: MediaRequest,
  session: { port: number; token: string } | null,
  windowId: number | undefined,
): Record<string, string> {
  const headers = { ...request.requestHeaders };
  if (!session || windowId === undefined || request.webContentsId !== windowId) return headers;
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === "authorization" && headers[key] === `Bearer ${session.token}`) delete headers[key];
  }
  const url = new URL(request.url);
  if (url.origin === `http://127.0.0.1:${session.port}` && /^\/(?:media|genesis-media)\//.test(url.pathname)) {
    headers.Authorization = `Bearer ${session.token}`;
  }
  return headers;
}
