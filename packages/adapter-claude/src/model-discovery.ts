import type { ModelInfo } from "@arke-studio/contracts";

/** SDK catalog metadata, without depending on a particular model generation. */
export interface ClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
}

export interface ClaudeModelDiscoveryInput {
  command: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type DiscoverClaudeModels = (input: ClaudeModelDiscoveryInput) => Promise<ClaudeModel[]>;

export interface ModelQuery {
  supportedModels(): Promise<ClaudeModel[]>;
  close(): void;
}

export type OpenModelQuery = (input: {
  prompt: AsyncIterable<unknown>;
  options: Record<string, unknown>;
}) => ModelQuery;

/**
 * Initialization knows the available models before there is a user message. Keep the input
 * open but empty until discovery finishes; an empty string would be a generation request.
 * Closing in finally also covers a hung binary, a failed login and adapter shutdown.
 */
export async function discoverClaudeModels(
  input: ClaudeModelDiscoveryInput,
  openQuery: OpenModelQuery,
): Promise<ClaudeModel[]> {
  input.signal?.throwIfAborted();
  const abort = new AbortController();
  let rejectStopped!: (error: Error) => void;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  const stop = () => {
    abort.abort();
    rejectStopped(new Error("Claude model discovery was cancelled"));
  };
  input.signal?.addEventListener("abort", stop, { once: true });
  const timer = setTimeout(() => {
    abort.abort();
    rejectStopped(new Error("Claude model discovery timed out"));
  }, input.timeoutMs ?? 15_000);
  let query: ModelQuery | undefined;
  try {
    const finished = new Promise<void>((resolve) => {
      if (abort.signal.aborted) resolve();
      else abort.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    const prompt: AsyncIterable<unknown> = {
      [Symbol.asyncIterator]: () => ({ next: async () => {
        await finished;
        return { value: undefined, done: true };
      } }),
    };
    query = openQuery({
      prompt,
      options: {
        pathToClaudeCodeExecutable: input.command,
        abortController: abort,
        settingSources: [],
        tools: [],
        mcpServers: {},
        persistSession: false,
      },
    });
    return await Promise.race([query.supportedModels(), stopped]);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener("abort", stop);
    abort.abort();
    query?.close();
  }
}

/** Pin the resolved identity while retaining aliases that match old saved preferences. */
export function normalizeClaudeModels(rows: ClaudeModel[]): ModelInfo[] {
  const models = new Map<string, ModelInfo>();
  for (const row of rows) {
    if (!row.value?.trim()) continue;
    let id = row.resolvedModel?.trim() || row.value;
    // supportedModels can resolve the family but omit its explicit context selector. A base
    // model and its 1M variant must remain different choices, even when their names match.
    if (row.value.endsWith("[1m]") && !id.endsWith("[1m]")) id += "[1m]";
    const previous = models.get(id);
    const aliases = new Set(previous?.aliases ?? []);
    if (row.value !== id) aliases.add(row.value);
    models.set(id, {
      id,
      provider: "anthropic",
      ...(row.displayName ? { displayName: row.displayName } : {}),
      ...(previous?.displayName && row.value === "default" ? { displayName: previous.displayName } : {}),
      ...(aliases.size > 0 ? { aliases: [...aliases] } : {}),
      ...(row.value === "default" || previous?.isDefault ? { isDefault: true } : {}),
      // The SDK does not report modalities or context limits. Unknown stays unknown.
    });
  }
  return [...models.values()];
}
