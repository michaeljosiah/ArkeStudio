import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BenchEventEnvelopeSchema, BenchSessionMetaSchema, foldBenchSession, hasAdultAdapter } from "@arke-studio/contracts";

/** Called only after the world's media resolver has checked the real path is inside its root. */
export async function adapterMediaVisible(file: string, relativePath: string, adultEnabled: boolean): Promise<boolean> {
  if (adultEnabled) return true;
  const portable = relativePath.replaceAll("\\", "/");
  const parts = portable.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return false;
  let root = file;
  for (const _part of parts) root = dirname(root);
  try {
    if (parts[0] === ".sessions" && parts[2] === "media" && parts[3]) {
      const dir = join(root, ".sessions", parts[1]!);
      const meta = BenchSessionMetaSchema.parse(JSON.parse(await readFile(join(dir, "session.json"), "utf8")));
      const events = (await readFile(join(dir, "events.jsonl"), "utf8")).split("\n").filter(line => line.trim())
        .map(line => BenchEventEnvelopeSchema.parse(JSON.parse(line)));
      const take = foldBenchSession(meta, events).takes.find(row => row.id === parts[3]);
      return !!take && !hasAdultAdapter(take.request.params);
    }
    if (parts[0] === "productions" && parts[2] === "takes" && parts[3]) {
      const take = JSON.parse(await readFile(join(root, ...parts.slice(0, 4), "take.json"), "utf8"));
      return !hasAdultAdapter(take.params);
    }
    if (parts[0] === "artifacts") {
      const artifact = JSON.parse(await readFile(join(root, portable + ".json"), "utf8"));
      return !hasAdultAdapter(artifact.generation?.params);
    }
    return true;
  } catch {
    // Missing or damaged provenance cannot authorize a preview while access is off.
    return false;
  }
}
