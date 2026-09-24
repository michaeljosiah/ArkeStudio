import { rm } from "node:fs/promises";
import { join } from "node:path";
import { copyPublicationDirectory } from "../../src/publications/archive.js";
import { publishPublication } from "../../src/publications/publish.js";

// A separate process is needed to exercise abandoned receipts and races between independent
// module-local queues. The fixture never opens a world or generates media.
const [outputRoot, source, requestJson, killPhase] = process.argv.slice(2);
const result = await publishPublication(JSON.parse(requestJson!), async scratch => {
  const directory = join(scratch, "compiled");
  const copied = await copyPublicationDirectory(source!, directory);
  return { ...copied, dispose: () => rm(directory, { recursive: true, force: true }) };
}, { outputRoot: outputRoot!, onPhase: phase => { if (phase === killPhase) process.exit(71); } });
process.stdout.write(JSON.stringify({ path: result.path, manifestSha256: result.manifestSha256 }));
