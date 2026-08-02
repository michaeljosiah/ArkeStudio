/**
 * Minimal Server-Sent Events parser over a fetch ReadableStream (adopted from Arke).
 * OpenCode emits `data: <json>` frames; there is no Last-Event-ID replay, so callers
 * re-resolve REST state on reconnect. Yields the parsed JSON of each data frame.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  /**
   * Called on every chunk read, including heartbeats — which carry no `data:` line and so are
   * never yielded. A liveness watchdog has to watch the bytes, not the events, or it mistakes a
   * quiet-but-healthy stream for a dead one.
   */
  onChunk?: () => void,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (!done) onChunk?.();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("\n");
        if (!data) continue; // heartbeat / comment
        try {
          yield JSON.parse(data);
        } catch {
          /* malformed frame — dropped, callers count dead letters at the boundary */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
