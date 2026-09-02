// Run as a bare process by provider-transport.test.ts, with nothing else on the event loop: the
// only pending work is a CloudProviderTransport whole-operation deadline behind an operation
// that awaits nothing. The deadline has to hold the process open until it fires. If it does not,
// the loop drains first, `run` never settles, and the only line printed is the beforeExit one.
import { CloudProviderTransport, PROVIDER_HTTP_DEADLINES } from "../../src/provider-transport.js";

process.on("beforeExit", () => console.log("beforeExit"));
const transport = new CloudProviderTransport({
  deadlines: { ...PROVIDER_HTTP_DEADLINES, synchronous: { ...PROVIDER_HTTP_DEADLINES.synchronous, operationMs: 50 } },
  dispatcher: () => ({ close: async () => {} }),
  fetch: async () => new Response("{}"),
});
transport
  .run(
    { provider: "openai", operation: "submit", capability: "image", model: "gpt-image-2" },
    () => new Promise<never>(() => {}),
  )
  .then(
    () => console.log("resolved"),
    (error: unknown) =>
      console.log(`rejected: ${(error as { diagnostic?: { category?: string } }).diagnostic?.category}`),
  )
  .finally(() => transport.close());
