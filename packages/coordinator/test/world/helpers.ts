import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_WORLD = resolve(here, "../../../../fixtures/worlds/the-undersong");
export const WORLD_ID = "01J8F3K2QW9VZX4N7M0RTYB6HC";

/** A disposable copy of the fixture world for mutating tests. */
export async function makeTempWorld(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arke-world-"));
  const worldDir = join(dir, "the-undersong");
  await cp(FIXTURE_WORLD, worldDir, { recursive: true });
  return worldDir;
}

/** A disposable app root holding a copy of the fixture world. */
export async function makeTempRoot(): Promise<{ root: string; worldDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "arke-root-"));
  const worldDir = join(root, "worlds", "the-undersong");
  await cp(FIXTURE_WORLD, worldDir, { recursive: true });
  return { root, worldDir };
}
