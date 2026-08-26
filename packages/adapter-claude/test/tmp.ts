import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

/**
 * Scratch directories, swept when the test file that made them finishes.
 *
 * The same convention as `packages/coordinator/test/tmp.ts`, kept local because the path
 * confinement tests are the first thing in this package to need real directories — and they
 * need REAL ones: symlink resolution and the case-folding rule are properties of a filesystem,
 * and a fake path string would let a broken boundary pass.
 */
const dirs: string[] = [];

/** A temp directory that goes away when this test file is done with it. */
export async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

after(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
