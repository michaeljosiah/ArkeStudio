import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentForPurpose,
  type DomainEvent,
  type HarnessAdapter,
  type HarnessEvent,
  type ModelInfo,
  type VendorAuthStatus,
  type VendorIntegration,
  type VendorOAuthAttempt,
  type VendorOAuthAttemptState,
} from "@arke-studio/contracts";
import {
  AUTH_FAILURE_REASON,
  isAuthShapedFailure,
  VendorAuthService,
  type VendorAuthServiceOptions,
} from "../../src/harness/vendor-auth.js";
import { AuthoringService } from "../../src/harness/authoring.js";
import { ProposalManager } from "../../src/gate/proposals.js";
import { WorldStore } from "../../src/world/store.js";
import { makeTempWorld, WORLD_ID } from "../world/helpers.js";

/**
 * The vendor sign-in service (SPEC-030 §3.1) over a scripted adapter: the surface filter, the
 * hand-off, the bounded poll, abandonment, the typed-secret method, removal, and R-13's
 * classification of a refresh failure out of a turn's ending.
 */

const CLOCK = () => "2026-08-01T12:00:00.000Z";

function vendor(partial: Partial<VendorIntegration> & { id: string; name: string }): VendorIntegration {
  return { methods: [], connections: [], needsSignIn: false, ...partial };
}

const OAUTH_METHOD = { id: "browser", kind: "oauth" as const, label: "Vendor (browser)", fields: [] };
const KEY_METHOD = { id: null, kind: "key" as const, label: "API key", fields: [] };

interface FakeAuthAdapter extends HarnessAdapter {
  integrations: VendorIntegration[];
  attempt: VendorOAuthAttempt;
  attemptState: VendorOAuthAttemptState;
  beginCalls: Array<{ integrationId: string; methodId: string; answers?: Record<string, string> }>;
  cancelCalls: string[];
  completeCalls: Array<{ attemptId: string; code: string }>;
  keyCalls: Array<{ integrationId: string; key: string }>;
  removeCalls: string[];
  models: ModelInfo[];
  failBegin: string | null;
  failKey: string | null;
}

function fakeAdapter(): FakeAuthAdapter {
  const adapter: FakeAuthAdapter = {
    id: "fake-auth",
    integrations: [],
    attempt: {
      attemptId: "con_1",
      url: "https://vendor.example/authorize",
      instructions: "Complete authorization in your browser.",
      mode: "auto",
      expiresAt: Date.now() + 600_000,
    },
    attemptState: { status: "pending" },
    beginCalls: [],
    cancelCalls: [],
    completeCalls: [],
    keyCalls: [],
    removeCalls: [],
    models: [],
    failBegin: null,
    failKey: null,
    capabilities: () => new Set(["auth", "models"]),
    readiness: () => ({ ready: true }),
    async createSession() {
      return { sessionId: "ses_unused" };
    },
    async sendMessage(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    async dispatchAsync(input) {
      return { sessionId: input.sessionId, correlationId: "c" };
    },
    streamEvents(): AsyncIterable<HarnessEvent> {
      return (async function* () {})();
    },
    async listModels() {
      return adapter.models;
    },
    async listIntegrations() {
      return adapter.integrations.map((v) => ({ ...v }));
    },
    async beginVendorOAuth(integrationId, methodId, answers) {
      if (adapter.failBegin !== null) throw new Error(adapter.failBegin);
      adapter.beginCalls.push({ integrationId, methodId, ...(answers ? { answers } : {}) });
      return adapter.attempt;
    },
    async pollVendorOAuth() {
      return adapter.attemptState;
    },
    async cancelVendorOAuth(_integrationId, attemptId) {
      adapter.cancelCalls.push(attemptId);
    },
    async completeVendorOAuth(_integrationId, attemptId, code) {
      adapter.completeCalls.push({ attemptId, code });
    },
    async connectVendorKey(integrationId, key) {
      if (adapter.failKey !== null) throw new Error(adapter.failKey);
      adapter.keyCalls.push({ integrationId, key });
    },
    async removeVendorCredential(credentialId) {
      adapter.removeCalls.push(credentialId);
    },
  };
  return adapter;
}

function makeService(
  adapter: HarnessAdapter | null,
  overrides: Partial<VendorAuthServiceOptions> = {},
): { service: VendorAuthService; published: VendorAuthStatus[]; opened: string[]; secrets: string[] } {
  const published: VendorAuthStatus[] = [];
  const opened: string[] = [];
  const secrets: string[] = [];
  const service = new VendorAuthService({
    adapter: () => adapter,
    openExternal: (url) => opened.push(url),
    onChange: (status) => published.push(status),
    registerSecret: (value) => secrets.push(value),
    pollIntervalMs: 10,
    // A directory that exists nowhere, so the carry statement stays out of unrelated tests.
    personalStateDir: "Z:\\no-such-arke-test-dir",
    ...overrides,
  });
  return { service, published, opened, secrets };
}

async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) assert.fail("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the sign-in surface (R-7, R-10, R-12)", () => {
  it("offers oauth-capable vendors and connected ones, and drops the key-only crowd", async () => {
    const adapter = fakeAdapter();
    adapter.integrations = [
      vendor({ id: "zeta", name: "Zeta", methods: [OAUTH_METHOD, KEY_METHOD] }),
      vendor({ id: "keyonly", name: "Key Only", methods: [KEY_METHOD] }),
      vendor({
        id: "connected",
        name: "Already Connected",
        methods: [KEY_METHOD],
        connections: [{ kind: "stored", id: "cred_1", label: "default" }],
      }),
    ];
    const { service, published } = makeService(adapter);
    await service.refresh();
    const last = published.at(-1)!;
    assert.equal(last.available, true);
    // Connected first, then by name — and the key-only vendor is Providers-screen work.
    assert.deepEqual(last.vendors.map((v) => v.id), ["connected", "zeta"]);
  });

  it("states its absence on a lane with no auth capability, and stays optional (R-12)", async () => {
    const adapter = fakeAdapter();
    adapter.capabilities = () => new Set(["events"]);
    const { service, published } = makeService(adapter);
    await service.refresh();
    const last = published.at(-1)!;
    assert.equal(last.available, false);
    assert.match(last.reason ?? "", /cannot sign in/);
    assert.deepEqual(last.vendors, []);
  });

  it("keeps the surface and states the fault when the listing call fails", async () => {
    const adapter = fakeAdapter();
    adapter.listIntegrations = async () => {
      throw new Error("the catalog is on fire");
    };
    const { service, published } = makeService(adapter);
    await service.refresh();
    const last = published.at(-1)!;
    assert.equal(last.available, true);
    assert.equal(last.reason, "the catalog is on fire");
  });

  it("states the carry limitation only to somebody with personal harness state (R-4)", async () => {
    const adapter = fakeAdapter();
    adapter.integrations = [vendor({ id: "v", name: "V", methods: [OAUTH_METHOD] })];
    const { service, published } = makeService(adapter, { personalStateDir: process.cwd() });
    await service.refresh();
    // cwd has no auth.json/opencode.db, so even an existing directory stays "none".
    assert.equal(published.at(-1)!.carry, "none");
  });
});

describe("beginning, waiting and abandoning an OAuth sign-in (§2.2, R-9b)", () => {
  it("moves the screen before the first await, opens the page, and settles on completion", async () => {
    const adapter = fakeAdapter();
    adapter.integrations = [vendor({ id: "openai", name: "OpenAI", methods: [OAUTH_METHOD] })];
    const { service, published, opened } = makeService(adapter);
    await service.refresh();
    const marked = published.length;
    const begun = service.beginOAuth("openai", "browser");
    // Published synchronously: the row changes the instant the button is pressed.
    assert.equal(published.length > marked, true);
    assert.equal(published.at(-1)!.signIn?.phase, "waiting");
    assert.equal(published.at(-1)!.signIn?.method, "Vendor (browser)");
    await begun;
    assert.deepEqual(opened, ["https://vendor.example/authorize"]);
    assert.equal(published.at(-1)!.signIn?.instructions, "Complete authorization in your browser.");
    adapter.attemptState = { status: "complete" };
    await until(() => published.at(-1)!.signIn === null);
    assert.equal(adapter.beginCalls.length, 1);
  });

  it("never opens a page that is not https", async () => {
    const adapter = fakeAdapter();
    adapter.attempt = { ...adapter.attempt, url: "http://localhost:1455/auth" };
    const { service, opened } = makeService(adapter);
    await service.beginOAuth("openai", "browser");
    assert.deepEqual(opened, []);
    await service.cancel();
  });

  it("reports the vendor's failure in its own words", async () => {
    const adapter = fakeAdapter();
    const { service, published } = makeService(adapter);
    await service.beginOAuth("openai", "browser");
    adapter.attemptState = { status: "failed", message: "authorization was declined" };
    await until(() => published.at(-1)!.signIn?.phase === "failed");
    assert.equal(published.at(-1)!.signIn?.detail, "authorization was declined");
  });

  it("bounds the wait by the attempt's own deadline and states the outcome (R-9b, R-9c)", async () => {
    const adapter = fakeAdapter();
    // The measured build leaves a bind-blocked attempt pending forever; the bound is ours.
    adapter.attempt = { ...adapter.attempt, expiresAt: Date.now() - 60_000 };
    const { service, published } = makeService(adapter);
    await service.beginOAuth("openai", "browser");
    await until(() => published.at(-1)!.signIn?.phase === "failed");
    assert.match(published.at(-1)!.signIn?.detail ?? "", /did not complete in time/);
  });

  it("a refused begin is a stated failure, not a hang", async () => {
    const adapter = fakeAdapter();
    adapter.failBegin = "methodID not found";
    const { service, published } = makeService(adapter);
    await service.beginOAuth("openai", "no-such");
    assert.equal(published.at(-1)!.signIn?.phase, "failed");
    assert.equal(published.at(-1)!.signIn?.detail, "methodID not found");
  });

  it("cancel abandons the attempt on the harness too, and leaves no partial state", async () => {
    const adapter = fakeAdapter();
    const { service, published } = makeService(adapter);
    await service.beginOAuth("openai", "browser");
    await service.cancel();
    assert.deepEqual(adapter.cancelCalls, ["con_1"]);
    assert.equal(published.at(-1)!.signIn, null);
  });

  it("hands a code-mode attempt's code straight through, redaction-registered (R-1)", async () => {
    const adapter = fakeAdapter();
    adapter.attempt = { ...adapter.attempt, mode: "code", instructions: "Paste the code here." };
    const { service, published, secrets } = makeService(adapter);
    await service.beginOAuth("openai", "browser");
    assert.equal(published.at(-1)!.signIn?.codeEntry, true);
    await service.submitCode("AAAA-BBBBB");
    assert.deepEqual(adapter.completeCalls, [{ attemptId: "con_1", code: "AAAA-BBBBB" }]);
    assert.deepEqual(secrets, ["AAAA-BBBBB"]);
    adapter.attemptState = { status: "complete" };
    await until(() => published.at(-1)!.signIn === null);
  });
});

describe("the typed-secret method and removal (§2.2, R-9a)", () => {
  it("stores a key in one call, registers it for redaction, and reports from what it observes", async () => {
    const adapter = fakeAdapter();
    adapter.integrations = [vendor({ id: "openai", name: "OpenAI", methods: [OAUTH_METHOD, KEY_METHOD] })];
    const { service, published, secrets } = makeService(adapter);
    await service.refresh();
    await service.submitKey("openai", "sk-SYNTHETIC-1234");
    assert.deepEqual(adapter.keyCalls, [{ integrationId: "openai", key: "sk-SYNTHETIC-1234" }]);
    assert.deepEqual(secrets, ["sk-SYNTHETIC-1234"]);
    assert.equal(published.at(-1)!.signIn, null);
  });

  it("a refused key is a stated failure in the harness's words", async () => {
    const adapter = fakeAdapter();
    adapter.failKey = "key was rejected by the vendor";
    const { service, published } = makeService(adapter);
    await service.submitKey("openai", "sk-bad");
    assert.equal(published.at(-1)!.signIn?.phase, "failed");
    assert.equal(published.at(-1)!.signIn?.detail, "key was rejected by the vendor");
  });

  it("removal is the harness's operation and refreshes what remains", async () => {
    const adapter = fakeAdapter();
    adapter.integrations = [
      vendor({
        id: "openai",
        name: "OpenAI",
        methods: [OAUTH_METHOD],
        connections: [{ kind: "stored", id: "cred_9", label: "default" }],
      }),
    ];
    const { service } = makeService(adapter);
    await service.refresh();
    await service.remove("openai", "cred_9");
    assert.deepEqual(adapter.removeCalls, ["cred_9"]);
  });
});

describe("marking a connection that needs sign-in (R-13, R-14)", () => {
  it("marks the default model's vendor when it holds a stored connection", async () => {
    const adapter = fakeAdapter();
    adapter.models = [{ id: "gpt", provider: "openai", isDefault: true }];
    adapter.integrations = [
      vendor({
        id: "openai",
        name: "OpenAI",
        methods: [OAUTH_METHOD],
        connections: [{ kind: "stored", id: "cred_1", label: "default" }],
      }),
      vendor({
        id: "xai",
        name: "xAI",
        methods: [OAUTH_METHOD],
        connections: [{ kind: "stored", id: "cred_2", label: "default" }],
      }),
    ];
    const { service, published } = makeService(adapter);
    await service.refresh();
    await service.noteAuthFailure();
    const last = published.at(-1)!;
    assert.equal(last.vendors.find((v) => v.id === "openai")?.needsSignIn, true);
    assert.equal(last.vendors.find((v) => v.id === "xai")?.needsSignIn, false);
  });

  it("falls back to the single credentialed vendor, and to a stated fault past that", async () => {
    const adapter = fakeAdapter();
    adapter.models = [];
    adapter.integrations = [
      vendor({
        id: "solo",
        name: "Solo",
        methods: [OAUTH_METHOD],
        connections: [{ kind: "stored", id: "cred_1", label: "default" }],
      }),
    ];
    const { service, published } = makeService(adapter);
    await service.refresh();
    await service.noteAuthFailure();
    assert.equal(published.at(-1)!.vendors[0]?.needsSignIn, true);

    // Two credentialed vendors, no default model: nothing can be named honestly.
    adapter.integrations.push(
      vendor({
        id: "second",
        name: "Second",
        methods: [OAUTH_METHOD],
        connections: [{ kind: "stored", id: "cred_2", label: "default" }],
      }),
    );
    await service.refresh();
    await service.noteAuthFailure();
    assert.match(published.at(-1)!.reason ?? "", /stopped working/);
  });

  it("a successful re-sign-in clears the mark", async () => {
    const adapter = fakeAdapter();
    adapter.integrations = [
      vendor({
        id: "openai",
        name: "OpenAI",
        methods: [OAUTH_METHOD],
        connections: [{ kind: "stored", id: "cred_1", label: "default" }],
      }),
    ];
    const { service, published } = makeService(adapter);
    await service.refresh();
    await service.noteAuthFailure();
    assert.equal(published.at(-1)!.vendors[0]?.needsSignIn, true);
    await service.beginOAuth("openai", "browser");
    adapter.attemptState = { status: "complete" };
    await until(() => published.at(-1)!.signIn === null);
    await until(() => published.at(-1)!.vendors[0]?.needsSignIn === false);
  });
});

describe("R-13's classifier", () => {
  it("matches exactly the refresh-failure shapes and nothing broader", () => {
    assert.equal(isAuthShapedFailure("provider.auth"), true);
    assert.equal(isAuthShapedFailure("provider.auth: something"), true);
    assert.equal(isAuthShapedFailure("Token refresh failed: 401"), true);
    assert.equal(isAuthShapedFailure("HTTP 500 from the provider"), false);
    assert.equal(isAuthShapedFailure("the model declined"), false);
    assert.equal(isAuthShapedFailure(""), false);
    assert.equal(isAuthShapedFailure(null), false);
    assert.equal(isAuthShapedFailure(undefined), false);
  });
});

describe("a refresh failure ends an authoring turn as a sign-in request (R-13)", () => {
  it("restates the ending, preserves the proposal, and says it happened", async () => {
    const dir = await makeTempWorld();
    const store = await WorldStore.open(dir, { clock: CLOCK });
    try {
      const gate = new ProposalManager(store);
      const proposal = await gate.stage({
        kind: "sheet-edit",
        summary: "studio draft",
        source: "chat:studio",
        targets: [{ path: "characters/maren-kest.md" }],
      });

      const subscribers = new Set<{ queue: HarnessEvent[]; wake: (() => void) | null }>();
      const push = (event: HarnessEvent) => {
        for (const sub of subscribers) {
          sub.queue.push(event);
          sub.wake?.();
          sub.wake = null;
        }
      };
      const adapter: HarnessAdapter = {
        id: "stale-token",
        capabilities: () => new Set(),
        readiness: () => ({ ready: true }),
        async createSession() {
          return { sessionId: "ses_stale" };
        },
        async sendMessage(input) {
          return { sessionId: input.sessionId, correlationId: "c" };
        },
        async dispatchAsync(input) {
          // The measured wire shape: type kept in front, message often empty (§2.5).
          push({ type: "session.error", sessionId: input.sessionId, message: "provider.auth" });
          return { sessionId: input.sessionId, correlationId: "c" };
        },
        streamEvents(signal?: AbortSignal): AsyncIterable<HarnessEvent> {
          const sub: { queue: HarnessEvent[]; wake: (() => void) | null } = { queue: [], wake: null };
          subscribers.add(sub);
          return {
            [Symbol.asyncIterator]() {
              return (async function* () {
                try {
                  while (!signal?.aborted) {
                    const next = sub.queue.shift();
                    if (next) {
                      yield next;
                      continue;
                    }
                    await new Promise<void>((resolve) => {
                      signal?.addEventListener("abort", () => resolve(), { once: true });
                      sub.wake = resolve;
                    });
                  }
                } finally {
                  subscribers.delete(sub);
                }
              })();
            },
          };
        },
      };

      const events: DomainEvent[] = [];
      let noted = 0;
      const authoring = new AuthoringService(adapter, (e) => events.push(e), {
        sessionInput: (input) => input,
        agentForPurpose,
        onAuthFailure: () => {
          noted += 1;
        },
      });
      await authoring.run(store, gate, {
        worldId: WORLD_ID,
        proposalId: proposal.id,
        purpose: "authoring",
        instruction: "write something",
      });

      const final = events.findLast((e) => e.type === "authoring.status");
      assert.ok(final && final.type === "authoring.status");
      assert.equal(final.status, "failed");
      // The stated reason, never the wire's bare "provider.auth" (§2.5).
      assert.equal(final.detail, AUTH_FAILURE_REASON);
      assert.equal(noted, 1);
      // The proposal is untouched by the failure (R-13): still staged, still listable.
      assert.equal(await gate.isStaged(proposal.id), true);
    } finally {
      await store.close();
    }
  });
});
