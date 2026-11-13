import assert from "node:assert/strict";
import { it } from "node:test";
import { z } from "zod";

// scripts/patch-zod.mjs, the root postinstall, leaves zod 3's schema methods on the prototype
// rather than binding 24 onto every instance (issue 2815). A failure here after `npm install`
// means the patch did not run or zod changed under it.
it("leaves zod's schema methods on the prototype, and they still work", async () => {
  const schema = z.object({ name: z.string().optional(), tags: z.string().array() });
  assert.equal(Object.hasOwn(schema, "parse"), false, "npm install runs scripts/patch-zod.mjs");
  assert.deepEqual(schema.parse({ name: "Maren", tags: ["bell"] }), { name: "Maren", tags: ["bell"] });
  assert.equal(schema.safeParse({ tags: [1] }).success, false);
  assert.equal((await z.string().spa("tide")).success, true, "the spa alias still reads its schema");
});
