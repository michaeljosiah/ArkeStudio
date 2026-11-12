import assert from "node:assert/strict";
import { it } from "node:test";
import { FakeCreator, publishingFixture } from "./helpers.js";
import { AonikPublishingApi } from "../../src/publishing/api.js";

it("refreshes only a definitive 401 and never replays an uncertain mutation", async () => {
  const h = await publishingFixture(); const refreshed: boolean[] = []; const account = new FakeCreator(); account.bearer = async (force = false) => { refreshed.push(force); return "synthetic-token"; }; let attempts = 0;
  const api = new AonikPublishingApi(h.transport.configuration, account, async () => { attempts++; return attempts === 1 ? new Response(null, { status: 401 }) : Response.json({ ok: true }); });
  try { assert.deepEqual(await api.request("/publishing/submissions", "POST", {}), { ok: true }); assert.deepEqual(refreshed, [false, true]); attempts = 0;
    const offline = new AonikPublishingApi(h.transport.configuration, account, async () => { attempts++; throw new TypeError("private internal token must not escape"); }); await assert.rejects(offline.request("/publishing/submissions", "POST", {}), error => error instanceof Error && !error.message.includes("private internal")); assert.equal(attempts, 1);
  } finally { await h.service.stop(); }
});
it("discards a response arriving after an account switch and keeps catalogue requests anonymous", async () => {
  const h = await publishingFixture(); const api = new AonikPublishingApi(h.transport.configuration, h.account, async (_url, init) => { h.account.switch(); assert.equal(init?.credentials, "omit"); return Response.json({ privateReceipt: true }); });
  try { await assert.rejects(api.request("/publishing/submissions/test", "GET"), /Sign in/);
    const publicApi = new AonikPublishingApi(h.transport.configuration, h.account, async (_url, init) => { assert.equal(new Headers(init?.headers).has("Authorization"), false); return Response.json({ version: 2 }); }); assert.deepEqual(await publicApi.catalogue(new AbortController().signal), { version: 2 });
  } finally { await h.service.stop(); }
});
