import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { artifactShortHash } from "../artifacts/short-hash.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldFileReader } from "./service.js";

/**
 * Reads a world-relative file for the bench, and refuses anything that is not really inside the
 * world.
 *
 * The second of two gates. `WorldFilePathSchema` settles the shape of the path as it arrives;
 * this settles the only question that shape cannot answer — where the path actually lands once
 * the filesystem has had its say about separators, links and normalisation. A regular
 * expression and a resolved path disagree often enough that both are worth having.
 */
export function worldFileReader(worldDir: string): WorldFileReader {
  return {
    read: async (path) => {
      const resolvedWorld = resolve(worldDir);
      const target = resolve(resolvedWorld, path);
      // `startsWith` on the directory plus a separator: "…/world" must not admit "…/worldly".
      if (target !== resolvedWorld && !target.startsWith(resolvedWorld + sep)) {
        return { refused: "that file is not in this world" };
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(toExtendedLength(target));
      } catch {
        return { refused: "that picture is no longer in the world" };
      }
      return { hash: artifactShortHash(bytes) };
    },
  };
}
