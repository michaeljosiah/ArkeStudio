import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tempDir } from "../tmp.js";
import { CredentialStore, type Cipher } from "../../src/credentials/store.js";
import { AppLog } from "../../src/app-log.js";
import { REDACTED, redactDeep, SecretRegistry } from "../../src/redact.js";
import { buildDiagnosticsBundle } from "../../src/diagnostics.js";
import { vendorAuthUnavailable, type ClientState } from "@arke-studio/contracts";

/** A reversible fake cipher that is very visibly not the plaintext. */
const fakeCipher: Cipher = {
  isAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain).toString("hex")}`),
  decryptString: (buf) => Buffer.from(buf.toString().slice(4), "hex").toString(),
};

const KEY = "sk-fal-SUPERSECRET-1234567890";

async function makeStore() {
  const dir = await tempDir("arke-cred-");
  const registry = new SecretRegistry();
  const aclCalls: string[] = [];
  const store = new CredentialStore(join(dir, "credentials.dat"), fakeCipher, registry, async (p) => {
    aclCalls.push(p);
  });
  return { dir, registry, store, aclCalls };
}

describe("credential storage (R-5, R-8, §3.2)", () => {
  it("stores ciphertext, never plaintext, and resets the ACL on every write", async () => {
    const { dir, store, aclCalls } = await makeStore();
    await store.set("fal", KEY);
    const raw = await readFile(join(dir, "credentials.dat"), "utf8");
    assert.ok(!raw.includes(KEY), "plaintext never rests on disk");
    const stored = (JSON.parse(raw) as { entries: Record<string, string> }).entries["fal"]!;
    assert.ok(
      Buffer.from(stored, "base64").toString().startsWith("enc:"),
      "what rests is the cipher's output",
    );
    assert.equal(aclCalls.length, 1, "ACL reset on write");
    assert.equal(await store.get("fal"), KEY, "round-trips through the cipher");

    await store.clear("fal");
    assert.equal(await store.get("fal"), null);
    assert.equal(aclCalls.length, 2, "clearing rewrites, so the ACL resets again");
  });

  it("refuses to store when the cipher is unavailable rather than falling back to plaintext", async () => {
    const dir = await tempDir("arke-cred-");
    const store = new CredentialStore(
      join(dir, "credentials.dat"),
      { ...fakeCipher, isAvailable: () => false },
      new SecretRegistry(),
      async () => {},
    );
    await assert.rejects(() => store.set("fal", KEY), /encryption is unavailable/);
  });

  it("registers every stored and read plaintext with the redaction boundary (R-7)", async () => {
    const { registry, store } = await makeStore();
    await store.set("fal", KEY);
    assert.equal(registry.scrub(`about to send ${KEY} upstream`), `about to send ${REDACTED} upstream`);
  });

  it("serializes Promise.all mutations across stores without losing either credential", async () => {
    const dir = await tempDir("arke-cred-");
    const path = join(dir, "credentials.dat");
    const first = new CredentialStore(path, fakeCipher, new SecretRegistry(), async () => {});
    const second = new CredentialStore(path, fakeCipher, new SecretRegistry(), async () => {});
    await first.set("fal", KEY);

    // Both old store instances cached this same shape. Start the second mutation only once the
    // first reaches ACL hardening: this avoids coupling the lost-update proof to its temp bug.
    await Promise.all([first.configuredProviders(), second.configuredProviders()]);
    let updateReachedAcl!: () => void;
    const updateAtAcl = new Promise<void>((resolve) => {
      updateReachedAcl = resolve;
    });
    const orderedFirst = new CredentialStore(path, fakeCipher, new SecretRegistry(), async () =>
      updateReachedAcl(),
    );
    await orderedFirst.configuredProviders();
    await Promise.all([
      orderedFirst.set("openai", "sk-openai-concurrent-1234567890"),
      updateAtAcl.then(() => second.set("anthropic", "sk-anthropic-concurrent-1234567890")),
    ]);

    const reopened = new CredentialStore(path, fakeCipher, new SecretRegistry(), async () => {});
    assert.deepEqual((await reopened.configuredProviders()).sort(), ["anthropic", "fal", "openai"]);
    assert.equal(await reopened.get("openai"), "sk-openai-concurrent-1234567890");
    assert.equal(await reopened.get("anthropic"), "sk-anthropic-concurrent-1234567890");
  });

  it("reports malformed JSON and schema without replacing the credential source", async () => {
    const dir = await tempDir("arke-cred-");
    const path = join(dir, "credentials.dat");
    const cases = [
      { source: '{"version":1,"entries":', message: /contains malformed JSON/ },
      { source: JSON.stringify({ version: 1, entries: { fal: 42 } }), message: /current schema/ },
    ];

    for (const testCase of cases) {
      await writeFile(path, testCase.source, "utf8");
      const store = new CredentialStore(path, fakeCipher, new SecretRegistry(), async () => {});
      await assert.rejects(() => store.configuredProviders(), testCase.message);
      await assert.rejects(() => store.set("openai", "sk-openai-new-1234567890"), testCase.message);
      assert.equal(await readFile(path, "utf8"), testCase.source);
    }
  });

  it("uses a fresh same-directory temp name for every write and avoids stale-name collisions", async () => {
    const dir = await tempDir("arke-cred-");
    const path = join(dir, "credentials.dat");
    const stale = join(dir, `.tmp-credentials-${process.pid}`);
    await writeFile(stale, "stale staging file", "utf8");
    const staged: string[] = [];
    const store = new CredentialStore(path, fakeCipher, new SecretRegistry(), async (candidate) => {
      staged.push(candidate);
    });

    await store.set("fal", KEY);
    await store.set("openai", "sk-openai-second-1234567890");

    assert.equal(await readFile(stale, "utf8"), "stale staging file");
    assert.equal(staged.length, 2);
    assert.equal(dirname(staged[0]!), dir, "staging stays on the target filesystem");
    assert.match(basename(staged[0]!), /^\.tmp-credentials\.dat-[0-9a-f-]+$/);
    assert.notEqual(staged[0], staged[1], "each transaction owns a unique staging path");
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.startsWith(".tmp-credentials.dat-")),
      [],
      "successful transactions leave no staging files",
    );
  });

  it("fails the transaction on ACL failure and preserves the previous valid file", async () => {
    const dir = await tempDir("arke-cred-");
    const path = join(dir, "credentials.dat");
    const original = new CredentialStore(path, fakeCipher, new SecretRegistry(), async () => {});
    await original.set("fal", KEY);
    const before = await readFile(path, "utf8");
    const failing = new CredentialStore(path, fakeCipher, new SecretRegistry(), async () => {
      throw new Error("ACL hardening failed");
    });

    await assert.rejects(() => failing.set("openai", "sk-openai-unsaved-1234567890"), /ACL hardening failed/);
    await assert.rejects(() => failing.clear("fal"), /ACL hardening failed/);
    assert.equal(await readFile(path, "utf8"), before, "the hardened previous inode remains the live file");
    assert.equal(await original.get("fal"), KEY);
    assert.equal(
      await original.get("openai"),
      null,
      "a failed transaction is never reported through the store",
    );
    assert.deepEqual(
      (await readdir(dir)).filter((entry) => entry.startsWith(".tmp-credentials.dat-")),
      [],
      "the rejected staging file is cleaned up",
    );
  });

  it("writes no credential bytes and creates no live file when initial ACL hardening fails", async () => {
    const dir = await tempDir("arke-cred-");
    const path = join(dir, "credentials.dat");
    let stagedContent: string | null = null;
    const store = new CredentialStore(path, fakeCipher, new SecretRegistry(), async (staged) => {
      stagedContent = await readFile(staged, "utf8");
      throw new Error("ACL hardening failed");
    });

    await assert.rejects(() => store.set("fal", KEY), /ACL hardening failed/);
    assert.equal(stagedContent, "", "ACL hardening precedes writing even encrypted credential bytes");
    await assert.rejects(() => readFile(path), { code: "ENOENT" });
    assert.deepEqual(await readdir(dir), [], "the empty rejected staging file is removed");
  });
});

describe("redaction at the logging boundary (R-7, §3.2)", () => {
  it("a NEW call site logging an object containing a key is redacted without changing that path", async () => {
    const dir = await tempDir("arke-log-");
    const registry = new SecretRegistry();
    registry.register(KEY);
    const log = new AppLog(join(dir, "app.jsonl"), registry);

    // A call site written after the boundary existed, logging shapes it invented itself:
    await log.append({ kind: "brand-new-path", nested: { falApiKey: KEY, note: `sent ${KEY} to fal` } });
    await log.append({ kind: "unregistered-secret", authorization: "Bearer never-registered-token" });
    await log.drain();

    const raw = await readFile(join(dir, "app.jsonl"), "utf8");
    assert.ok(!raw.includes(KEY), "the registered secret is gone from every string");
    assert.ok(
      !raw.includes("never-registered-token"),
      "credential-shaped fields are masked even unregistered",
    );
    assert.ok(raw.includes(REDACTED));
  });

  it("redactDeep masks suspicious fields but leaves working identifiers alone", () => {
    const registry = new SecretRegistry();
    const out = redactDeep(
      { apiKey: "abc123", idempotencyKey: "01J8ZZZZ", keyHint: "sk-…", note: "plain" },
      registry,
    ) as Record<string, unknown>;
    assert.equal(out["apiKey"], REDACTED);
    assert.equal(out["idempotencyKey"], "01J8ZZZZ", "idempotency keys are identifiers, not secrets");
    assert.equal(out["keyHint"], "sk-…");
    assert.equal(out["note"], "plain");
  });
});

describe("the diagnostics bundle (R-6, §3.2)", () => {
  it("contains no key material and no world content", async () => {
    const state: ClientState = {
      app: {
        version: "0.1.0-test",
        health: {
          coordinator: { status: "healthy" },
          harness: { status: "unavailable", reason: "not configured" },
          voice: { status: "unavailable", reason: "not configured" },
        },
        jobs: [],
        builds: [],
        ledger: [],
        ledgerUnavailable: false,
        providers: [
          {
            id: "fal",
            configured: true,
            validation: "valid",
            probes: [{ capability: "video", available: true }],
            fault: null,
          },
        ],
        providerTools: [],
        vendorAuth: vendorAuthUnavailable("not configured"),
        manifest: null,
        routing: { defaults: {}, faults: [] },
        models: { disabled: [] },
        presets: [],
        spend: null,
        backgroundNotifications: "issues-only",
        research: { web: false },
        internal: { sceneWorkspace: false },
        narrator: null,
        appearance: { theme: "system" },
        runtime: null,
        harness: null,
        comfyui: null,
        voiceRuntime: null,
        drift: [],
        agents: [],
        harnessModels: [],
        harnessInfo: null,
        queues: [],
        setup: null,
        update: { status: "idle", targetVersion: null, progressPercent: null, flow: null, detail: null },
        env: null,
        sampleWorld: { available: false, installing: false, note: null },
      },
      worlds: [
        {
          worldId: "01J8F3K2QW9VZX4N7M0RTYB6HC",
          slug: "the-undersong",
          name: "The Undersong",
          logline: "A drowned god still sings beneath the harbour.",
          counts: { characters: 3, locations: 2, factions: 1, canonEntries: 6, productions: 1 },
          keyArt: null,
          updated: "2026-07-30T18:22:00Z",
        },
      ],
      world: null,
      worldOpenFailure: null,
      worldChat: null,
      bench: null,
      authoringRuns: [],
      frameRuns: [],
    };
    const registry = new SecretRegistry();
    registry.register(KEY);
    const dir = await tempDir("arke-diag-");
    const log = new AppLog(join(dir, "app.jsonl"), registry);
    await log.append({ kind: "provider.fault", provider: "fal", message: `rejected ${KEY}` });
    await log.drain();

    const bundle = await buildDiagnosticsBundle(state, log, registry);
    const serialized = JSON.stringify(bundle);
    assert.ok(!serialized.includes(KEY), "no key material (R-6)");
    assert.ok(!serialized.includes("Undersong"), "no world content");
    assert.ok(!serialized.includes("drowned god"), "no world prose");
    assert.ok(serialized.includes('"version":"0.1.0-test"'), "still useful: version and health are present");
    assert.ok(serialized.includes("provider.fault"), "the redacted log tail rides along");
  });
});
