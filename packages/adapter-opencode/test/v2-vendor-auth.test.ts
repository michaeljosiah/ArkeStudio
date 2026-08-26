import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { OpenCodeV2Adapter } from "../src/v2/opencode-v2-adapter.js";
import { normalizeAttempt, normalizeAttemptStatus, normalizeIntegration } from "../src/v2/vendor-auth.js";
import { errorDetailFrom, OpenCodeError } from "../src/http.js";
import { StubOpenCodeV2, STUB_V2_PASSWORD } from "./helpers/stub-server-v2.js";

/**
 * The v2 vendor sign-in surface (SPEC-030 §2.2), against the stub serving the measured
 * 0.0.0-next-17444 shapes. The stub 401s every unauthenticated request, so the auth posture
 * of each new route is exercised by every test that passes.
 */

// The openai row exactly as the pinned build reports it (measured 2026-08-26).
const OPENAI_WIRE = {
  id: "openai",
  name: "OpenAI",
  methods: [
    { type: "key" },
    { type: "env", names: ["OPENAI_API_KEY"] },
    { id: "chatgpt-browser", type: "oauth", label: "ChatGPT Pro/Plus (browser)" },
    { id: "chatgpt-headless", type: "oauth", label: "ChatGPT Pro/Plus (headless)" },
  ],
  connections: [],
};

// GitHub Copilot's oauth method carries a form: a pick plus a field gated on its answer.
const COPILOT_WIRE = {
  id: "github-copilot",
  name: "GitHub Copilot",
  methods: [
    { type: "env", names: ["GITHUB_TOKEN"] },
    {
      id: "device",
      type: "oauth",
      label: "Login with GitHub Copilot",
      form: [
        {
          key: "deploymentType",
          title: "Select GitHub deployment type",
          required: true,
          type: "string",
          options: [
            { value: "github.com", label: "GitHub.com", description: "Public" },
            { value: "enterprise", label: "GitHub Enterprise", description: "Data residency or self-hosted" },
          ],
        },
        {
          key: "enterpriseUrl",
          title: "Enter your GitHub Enterprise URL or domain",
          required: true,
          when: [{ key: "deploymentType", op: "eq", value: "enterprise" }],
          type: "string",
          placeholder: "company.ghe.com or https://company.ghe.com",
        },
      ],
    },
  ],
  connections: [
    { type: "credential", id: "cred_stub_1", label: "default" },
    { type: "env", name: "GITHUB_TOKEN" },
  ],
};

describe("vendor-auth normalisation (SPEC-030 §2.2)", () => {
  it("keeps oauth and key methods verbatim and drops env methods from the offers", () => {
    const openai = normalizeIntegration(OPENAI_WIRE);
    assert.ok(openai);
    assert.equal(openai.id, "openai");
    assert.equal(openai.name, "OpenAI");
    assert.deepEqual(
      openai.methods.map((m) => [m.id, m.kind, m.label]),
      [
        [null, "key", "API key"],
        ["chatgpt-browser", "oauth", "ChatGPT Pro/Plus (browser)"],
        ["chatgpt-headless", "oauth", "ChatGPT Pro/Plus (headless)"],
      ],
    );
    assert.equal(openai.needsSignIn, false);
  });

  it("carries a method's form fields, options and equality gates", () => {
    const copilot = normalizeIntegration(COPILOT_WIRE);
    assert.ok(copilot);
    const device = copilot.methods.find((m) => m.id === "device");
    assert.ok(device);
    assert.equal(device.fields.length, 2);
    const pick = device.fields[0]!;
    assert.equal(pick.key, "deploymentType");
    assert.equal(pick.required, true);
    assert.deepEqual(pick.options?.map((o) => o.value), ["github.com", "enterprise"]);
    const gated = device.fields[1]!;
    assert.deepEqual(gated.whenEquals, [{ key: "deploymentType", value: "enterprise" }]);
    assert.equal(gated.placeholder, "company.ghe.com or https://company.ghe.com");
  });

  it("maps stored and env connections, and env connections keep the variable's name", () => {
    const copilot = normalizeIntegration(COPILOT_WIRE);
    assert.ok(copilot);
    assert.deepEqual(copilot.connections, [
      { kind: "stored", id: "cred_stub_1", label: "default" },
      { kind: "env", name: "GITHUB_TOKEN" },
    ]);
  });

  it("drops a row with no id or name, and an oauth method with neither id nor label", () => {
    assert.equal(normalizeIntegration({ name: "Nameless" }), null);
    assert.equal(normalizeIntegration({ id: "x" }), null);
    const partial = normalizeIntegration({
      id: "v",
      name: "Vendor",
      methods: [{ type: "oauth", label: "No id" }, { type: "oauth", id: "no-label" }],
    });
    assert.ok(partial);
    assert.equal(partial.methods.length, 0);
  });

  it("normalises an attempt, falling back to a bounded expiry when the wire's is unreadable", () => {
    const now = 1_000_000;
    const good = normalizeAttempt(
      { attemptID: "con_1", url: "https://v.example", instructions: "Enter code: AAAA-BBBBB", mode: "auto", time: { created: now, expires: now + 600_000 } },
      now,
    );
    assert.equal(good.expiresAt, now + 600_000);
    assert.equal(good.mode, "auto");
    const bad = normalizeAttempt({ attemptID: "con_2", time: { expires: "NaN" } }, now);
    assert.equal(bad.expiresAt, now + 600_000);
    assert.throws(() => normalizeAttempt({}), /attempt id/);
  });

  it("maps attempt statuses, keeps a failure's message, and treats the unknown as pending", () => {
    assert.deepEqual(normalizeAttemptStatus({ status: "complete" }), { status: "complete" });
    assert.deepEqual(normalizeAttemptStatus({ status: "expired" }), { status: "expired" });
    assert.deepEqual(normalizeAttemptStatus({ status: "failed", message: "declined" }), {
      status: "failed",
      message: "declined",
    });
    assert.deepEqual(normalizeAttemptStatus({ status: "someday" }), { status: "pending" });
  });
});

describe("vendor-auth over the wire (SPEC-030 §2.2, §3.2)", () => {
  const stub = new StubOpenCodeV2();
  let adapter: OpenCodeV2Adapter;

  before(async () => {
    await stub.start();
    adapter = new OpenCodeV2Adapter({
      baseUrl: () => stub.baseUrl(),
      password: () => STUB_V2_PASSWORD,
      warmupMs: 3_000,
    });
    await adapter.init();
  });

  after(async () => {
    await adapter.dispose?.();
    await stub.stop();
  });

  it("advertises the auth capability once healthy", () => {
    assert.ok(adapter.capabilities().has("auth"));
  });

  it("lists integrations from the harness and normalises them at the boundary", async () => {
    stub.integrations = [OPENAI_WIRE, COPILOT_WIRE, { rubbish: true }];
    const integrations = await adapter.listIntegrations();
    assert.deepEqual(integrations.map((i) => i.id), ["openai", "github-copilot"]);
    const listed = stub.lastRequest(/^\/api\/integration$/);
    assert.ok(listed);
    assert.equal(listed.authorized, true);
  });

  it("begins an oauth attempt, sending the method id and form answers as the harness expects", async () => {
    stub.nextAttempt = {
      attemptID: "con_test_1",
      url: "https://auth.vendor.example/authorize?x=1",
      instructions: "Complete authorization in your browser.",
      mode: "auto",
      time: { created: Date.now(), expires: Date.now() + 600_000 },
    };
    const attempt = await adapter.beginVendorOAuth("openai", "chatgpt-browser", { deploymentType: "github.com" });
    assert.equal(attempt.attemptId, "con_test_1");
    assert.equal(attempt.mode, "auto");
    const begin = stub.lastRequest(/\/connect\/oauth$/);
    assert.ok(begin);
    assert.deepEqual(begin.body, { methodID: "chatgpt-browser", answer: { deploymentType: "github.com" } });
  });

  it("polls the attempt it began: pending, then whatever the harness reports", async () => {
    assert.deepEqual(await adapter.pollVendorOAuth("openai", "con_test_1"), { status: "pending" });
    stub.oauthAttempts.get("con_test_1")!.status = { status: "failed", message: "authorization was declined" };
    assert.deepEqual(await adapter.pollVendorOAuth("openai", "con_test_1"), {
      status: "failed",
      message: "authorization was declined",
    });
    stub.oauthAttempts.get("con_test_1")!.status = { status: "complete", time: {} };
    assert.deepEqual(await adapter.pollVendorOAuth("openai", "con_test_1"), { status: "complete" });
  });

  it("cancel releases the attempt, and the measured after-cancel poll answers 500", async () => {
    stub.nextAttempt = null;
    const attempt = await adapter.beginVendorOAuth("openai", "chatgpt-headless");
    await adapter.cancelVendorOAuth("openai", attempt.attemptId);
    assert.equal(stub.oauthAttempts.has(attempt.attemptId), false);
    await assert.rejects(
      () => adapter.pollVendorOAuth("openai", attempt.attemptId),
      (err: unknown) => err instanceof OpenCodeError && err.status === 500,
    );
  });

  it("hands a code-mode attempt's code back through complete, verbatim", async () => {
    stub.nextAttempt = {
      attemptID: "con_code_1",
      url: "https://vendor.example/device",
      instructions: "Paste the code the vendor shows you.",
      mode: "code",
      time: { created: Date.now(), expires: Date.now() + 600_000 },
    };
    const attempt = await adapter.beginVendorOAuth("acme", "device");
    assert.equal(attempt.mode, "code");
    await adapter.completeVendorOAuth("acme", attempt.attemptId, "AAAA-BBBBB");
    assert.equal(stub.completedCodes.get("con_code_1"), "AAAA-BBBBB");
  });

  it("stores a typed key in one call and never retains it", async () => {
    await adapter.connectVendorKey("anthropic", "sk-ant-SYNTHETIC-0000");
    assert.equal(stub.storedKeys.get("anthropic"), "sk-ant-SYNTHETIC-0000");
  });

  it("removes a credential by the harness's operation, not a file deletion", async () => {
    await adapter.removeVendorCredential("cred_stub_1");
    assert.deepEqual(stub.removedCredentials, ["cred_stub_1"]);
  });

  it("surfaces the harness's stated refusal when a begin is rejected", async () => {
    stub.failNextOAuthBegin = "methodID not found";
    await assert.rejects(
      () => adapter.beginVendorOAuth("openai", "no-such-method"),
      (err: unknown) =>
        err instanceof OpenCodeError && err.detail === "InvalidRequestError: methodID not found",
    );
  });

  it("reads the v2 error envelope into human detail — the route never has to stand in for it", () => {
    // The measured v2 shape ({_tag, message}) and the v1 shape both parse; junk falls back.
    assert.equal(
      errorDetailFrom(JSON.stringify({ _tag: "InvalidRequestError", message: "methodID not found" })),
      "InvalidRequestError: methodID not found",
    );
    assert.equal(
      errorDetailFrom(JSON.stringify({ name: "NotFound", data: { message: "no such session" } })),
      "NotFound: no such session",
    );
    assert.equal(errorDetailFrom("plain text"), "plain text");
  });
});
