import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BenchEventEnvelopeSchema, BenchSessionMetaSchema, foldBenchSession, hasAdultAdapter } from "@arke-studio/contracts";

/**
 * Answers by the identity of the provenance they were read from. A gallery asks once a tile and
 * a scrub once a range, and each re-read a take record, a sidecar or a whole Bench log with a
 * schema parse (issue 2782). A changed file has a new identity, so it is read again.
 */
const answers = new Map<string, boolean>();
const ANSWER_LIMIT = 2_000;

async function remembered(subject: string, provenance: readonly string[], decide: () => Promise<boolean>): Promise<boolean> {
  const identity = await Promise.all(provenance.map(async (path) => {
    const info = await stat(path);
    return `${path}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
  }));
  const key = `${subject}|${identity.join("|")}`;
  const known = answers.get(key);
  if (known !== undefined) return known;
  const answer = await decide();
  if (answers.size >= ANSWER_LIMIT) answers.clear();
  answers.set(key, answer);
  return answer;
}

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
      const session = join(dir, "session.json"), log = join(dir, "events.jsonl");
      return await remembered(parts[3], [session, log], async () => {
        const meta = BenchSessionMetaSchema.parse(JSON.parse(await readFile(session, "utf8")));
        const events = (await readFile(log, "utf8")).split("\n").filter(line => line.trim())
          .map(line => BenchEventEnvelopeSchema.parse(JSON.parse(line)));
        const take = foldBenchSession(meta, events).takes.find(row => row.id === parts[3]);
        return !!take && !hasAdultAdapter(take.request.params);
      });
    }
    if (parts[0] === "productions" && parts[2] === "takes" && parts[3]) {
      const record = join(root, ...parts.slice(0, 4), "take.json");
      return await remembered("take", [record], async () => !hasAdultAdapter(JSON.parse(await readFile(record, "utf8")).params));
    }
    if (parts[0] === "artifacts") {
      const sidecar = join(root, portable + ".json");
      return await remembered("artifact", [sidecar], async () => !hasAdultAdapter(JSON.parse(await readFile(sidecar, "utf8")).generation?.params));
    }
    return true;
  } catch {
    // Missing or damaged provenance cannot authorize a preview while access is off.
    return false;
  }
}
