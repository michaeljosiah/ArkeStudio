import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { productVersion } from "../src/product-version.js";
import { tempDir } from "./tmp.js";

/**
 * The standalone host reports the product's version, as the desktop does (issue 1191): the
 * repository's package.json three levels up from the module, the package's own beside it
 * when the repository root is not there, and a word only when neither can be read.
 */
describe("the product version a host reports", () => {
  it("reads the repository's version, then the package's, then says it is standalone", async () => {
    const root = await tempDir("product-version");
    const here = join(root, "packages", "coordinator", "src");
    await mkdir(here, { recursive: true });
    assert.equal(await productVersion(here), "standalone", "nothing to read");
    await writeFile(join(root, "packages", "coordinator", "package.json"), JSON.stringify({ name: "@arke-studio/coordinator", version: "0.1.0" }));
    assert.equal(await productVersion(here), "0.1.0", "the package's own, with no repository root");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "arke-studio", version: "0.5.49" }));
    assert.equal(await productVersion(here), "0.5.49", "the repository's, which is the product's");
  });

  it("reads this checkout's own version rather than a word", async () => {
    const version = await productVersion(join(process.cwd(), "src"));
    assert.match(version, /^\d+\.\d+\.\d+/);
    assert.notEqual(version, "standalone");
  });
});
