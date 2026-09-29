import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { z } from "zod";
import {
  ADULT_CONTENT_OFF, AdultAcknowledgementSchema, AdultContentSchema, AdapterDecisionSchema,
  AdapterSelectionsSchema, adapterCombinationProblem, adapterCompatibilityProblem, adapterPolicyProblem,
  type AdapterAction, type AdapterBundle, type AdapterDecision, type AdapterLibraryState, type AdapterRelease,
} from "@arke-studio/contracts";
import { appendFlushed } from "../flushed-append.js";
import { serializeFileMutation } from "../world/atomic.js";
import type { CatalogueEntry } from "../setup/catalogue.js";

const RecordSchema = z.object({
  revision: z.number().int().nonnegative(), adultContent: AdultContentSchema,
  decisions: z.record(AdapterDecisionSchema), removed: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  disabled: z.array(z.string().regex(/^[a-f0-9]{64}$/)).default([]),
  owned: z.record(z.object({ path: z.string(), device: z.number(), inode: z.number(), createdMs: z.number() }).strict()), reason: z.string(),
}).strict();
type RecordState = z.infer<typeof RecordSchema>;
const initial = (): RecordState => ({ revision: 0, adultContent: { ...ADULT_CONTENT_OFF }, decisions: {}, removed: [], disabled: [], owned: {}, reason: "Initial state" });

export interface AdapterComplianceClient {
  assess(releases: readonly AdapterRelease[], signal: AbortSignal): Promise<readonly AdapterDecision[]>;
}
async function assessWithSignal(client: AdapterComplianceClient, releases: readonly AdapterRelease[], signal: AbortSignal): Promise<readonly AdapterDecision[]> {
  signal.throwIfAborted();
  let onAbort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error("Compliance assessment was interrupted.")); signal.addEventListener("abort", onAbort, { once: true }); });
  try { return await Promise.race([client.assess(releases, signal), interrupted]); }
  finally { signal.removeEventListener("abort", onAbort); }
}
export interface AdapterLibraryOptions {
  appRoot: string;
  releases: readonly AdapterRelease[];
  bundles?: readonly AdapterBundle[];
  modelsDir(): string | null;
  local(): boolean;
  scanner?: AdapterComplianceClient;
  install(componentIds: string[]): Promise<void>;
  active(sha256: string): boolean;
  shared?(sha256: string): boolean;
  revoke(sha256?: string): Promise<void>;
  changed(state: AdapterLibraryState): void;
}

export function adapterComponentId(release: AdapterRelease): string { return `adapter-${release.id}`; }
export function adapterSetupEntries(releases: readonly AdapterRelease[]): CatalogueEntry[] {
  return releases.map(release => ({
    id: adapterComponentId(release), engine: "comfyui", displayName: release.displayName,
    purpose: "Optional H3 adapter", sizeMb: Math.ceil(release.source.bytes / 1_000_000), optional: true, preserveExistingFiles: true,
    spec: { kind: "files", dir: "loras/arke", externalRoot: "comfyui-models", files: [{
      file: `${release.source.sha256}.safetensors`, sizeMb: Math.ceil(release.source.bytes / 1_000_000),
      sha256: release.source.sha256,
      url: `https://huggingface.co/${release.source.repository}/resolve/${release.source.revision}/${release.source.file}`,
    }] },
  }));
}

/** App/device authority and audit live outside worlds. No renderer can supply a verdict. */
export class AdapterLibrary {
  private readonly journal: string;
  private readonly closed = new AbortController();
  private error: string | null = null;
  private readonly pending = new Set<Promise<void>>();
  constructor(private readonly opts: AdapterLibraryOptions) { this.journal = join(opts.appRoot, "adapters", "decisions.jsonl"); }

  private async read(): Promise<RecordState> {
    let text: string;
    try { text = await readFile(this.journal, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial(); throw error; }
    let state = initial();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const next = RecordSchema.parse(JSON.parse(line));
      if (next.revision !== state.revision + 1) throw new Error("Adapter decision history has an invalid revision.");
      state = next;
    }
    return state;
  }
  private async mutate(reason: string, change: (state: RecordState) => void): Promise<void> {
    this.closed.signal.throwIfAborted();
    await serializeFileMutation(this.journal, async () => {
      const next = structuredClone(await this.read());
      this.closed.signal.throwIfAborted();
      change(next); next.revision += 1; next.reason = reason;
      RecordSchema.parse(next);
      await mkdir(dirname(this.journal), { recursive: true });
      this.closed.signal.throwIfAborted();
      await appendFlushed(this.journal, JSON.stringify(next) + "\n");
    });
  }
  private release(id: string): AdapterRelease {
    const release = this.opts.releases.find(row => row.id === id);
    if (!release) throw new Error("Unknown adapter release.");
    return release;
  }
  private file(release: AdapterRelease): string {
    const root = this.opts.modelsDir();
    if (!root || !this.opts.local()) throw new Error("Adapter files require a mapped local ComfyUI model folder.");
    return resolve(root, "loras", "arke", `${release.source.sha256}.safetensors`);
  }
  private async present(release: AdapterRelease): Promise<boolean> {
    try { const info = await lstat(this.file(release)); return info.isFile() && !info.isSymbolicLink() && info.size === release.source.bytes; }
    catch { return false; }
  }
  private policy(release: AdapterRelease, state: RecordState): string | null {
    if (state.removed.includes(release.source.sha256)) return "Removed from this studio.";
    if (state.disabled.includes(release.source.sha256)) return "Disabled by the user.";
    return adapterPolicyProblem(release, state.adultContent, state.decisions[release.source.sha256] ?? null,
      state.removed.includes(release.source.sha256), new Date().toISOString());
  }
  async snapshot(): Promise<AdapterLibraryState> {
    try {
      const state = await this.read();
      const entries = await Promise.all(this.opts.releases.filter(row => state.adultContent.enabled || row.classification !== "adult").map(async release => ({
        release, decision: state.decisions[release.source.sha256] ?? null, removed: state.removed.includes(release.source.sha256),
        installed: await this.present(release), owned: await this.owns(release, state), reason: this.policy(release, state),
      })));
      const bundles = state.adultContent.enabled ? structuredClone([...(this.opts.bundles ?? [])]) : [];
      return { revision: state.revision, adultContent: state.adultContent, scannerAvailable: !!this.opts.scanner, entries, bundles, error: this.error };
    } catch {
      return { revision: 0, adultContent: { ...ADULT_CONTENT_OFF }, scannerAvailable: !!this.opts.scanner, entries: [], error: "Adapter history could not be read. Access is disabled until it is repaired." };
    }
  }
  private fileOrNull(release: AdapterRelease): string | null { try { return this.file(release); } catch { return null; } }
  private async owns(release: AdapterRelease, state: RecordState): Promise<boolean> {
    const receipt = state.owned[release.source.sha256];
    if (!receipt || receipt.path !== this.fileOrNull(release)) return false;
    try {
      const info = await lstat(receipt.path);
      return info.isFile() && !info.isSymbolicLink() && info.dev === receipt.device && info.ino === receipt.inode && info.birthtimeMs === receipt.createdMs;
    } catch { return false; }
  }
  async refresh(): Promise<void> {
    const snapshot = await this.snapshot();
    if (!this.closed.signal.aborted) this.opts.changed(snapshot);
  }

  handle(action: AdapterAction): Promise<void> {
    const work = this.handleAction(action);
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work)).catch(() => {});
    return work;
  }
  private async handleAction(action: AdapterAction): Promise<void> {
    this.closed.signal.throwIfAborted();
    this.error = null;
    try {
      if (action.action === "enable") {
        AdultAcknowledgementSchema.parse(action.acknowledgement);
        await this.mutate("Adult access acknowledged", state => { state.adultContent = { enabled: true, acknowledgedAt: new Date().toISOString(), acknowledgementVersion: 1 }; });
      } else if (action.action === "disable-content") {
        await this.mutate("Adult access disabled", state => { state.adultContent.enabled = false; });
        await this.opts.revoke();
      } else if (action.action === "scan") {
        // Retire old approvals before asking the agent. Timeout, malformed output or a
        // missing response cannot leave a previous allow decision silently authoritative.
        await this.mutate("Compliance assessment pending", state => { state.decisions = {}; });
        const assessmentRevision = (await this.read()).revision;
        await this.opts.revoke();
        await this.refresh();
        if (!this.opts.scanner) throw new Error("No compliance agent is connected.");
        const signal = AbortSignal.any([this.closed.signal, AbortSignal.timeout(30_000)]);
        const decisions = z.array(AdapterDecisionSchema).parse(await assessWithSignal(this.opts.scanner, this.opts.releases, signal));
        signal.throwIfAborted();
        const known = new Set(this.opts.releases.map(row => row.source.sha256));
        if (new Set(decisions.map(row => row.sha256)).size !== decisions.length || decisions.some(row => !known.has(row.sha256) || row.assessedAt > new Date().toISOString())) throw new Error("The compliance agent returned invalid artifact decisions.");
        await this.mutate("Compliance assessment", state => {
          if (state.revision !== assessmentRevision) throw new Error("Adapter settings changed during assessment. Run assessment again.");
          state.decisions = Object.fromEntries(decisions.map(row => [row.sha256, row]));
          for (const row of decisions) if (row.decision === "removal-requested" && !state.removed.includes(row.sha256)) state.removed.push(row.sha256);
        });
        const state = await this.read();
        for (const release of this.opts.releases) if (this.policy(release, state)) await this.opts.revoke(release.source.sha256);
        for (const release of this.opts.releases) if (state.decisions[release.source.sha256]?.decision === "removal-requested" && state.owned[release.source.sha256]) {
          await this.removeOwned(release).catch(() => { this.error = "An adapter was disabled but its file could not be safely removed. It was kept."; });
        }
      } else if (action.action === "install") {
        const state = await this.read();
        const releases = [...new Set(action.releaseIds)].map(id => this.release(id));
        for (const release of releases) { const problem = this.policy(release, state); if (problem) throw new Error(problem); this.file(release); }
        this.closed.signal.throwIfAborted();
        await this.opts.install(releases.map(adapterComponentId));
      } else if (action.action === "restore") {
        const sha = this.release(action.releaseId).source.sha256;
        await this.mutate("User requested a fresh adapter review", state => {
          if (!state.adultContent.enabled) throw new Error("Enable adult content before restoring an adapter.");
          state.removed = state.removed.filter(value => value !== sha);
          state.disabled = state.disabled.filter(value => value !== sha);
          delete state.decisions[sha];
        });
      } else if (action.action === "disable" || action.action === "remove") {
        const release = this.release(action.releaseId), sha = release.source.sha256;
        await this.mutate(action.action === "remove" ? "Adapter removed" : "Adapter disabled", state => {
          state.decisions[sha] = { sha256: sha, decision: "disabled", reason: "Disabled by the user.", policyRevision: "user", assessedAt: new Date().toISOString() };
          if (!state.disabled.includes(sha)) state.disabled.push(sha);
          if (action.action === "remove" && !state.removed.includes(sha)) state.removed.push(sha);
        });
        await this.opts.revoke(sha);
        if (action.action === "remove" && action.deleteOwnedFile) await this.removeOwned(release);
      }
    } catch (error) { this.error = error instanceof Error && !("code" in error) ? error.message : "Adapter operation failed. Check the configured local model folder."; throw error; }
    finally { await this.refresh(); }
  }

  async guardInstall(componentId: string): Promise<void> {
    this.closed.signal.throwIfAborted();
    const release = this.release(componentId.slice("adapter-".length));
    const problem = this.policy(release, await this.read());
    if (problem) throw new Error(problem);
    this.file(release);
  }
  /** Only setup's successful verified transfer grants ownership, never file discovery. */
  async recordInstalled(componentId: string, path: string): Promise<void> {
    const release = this.release(componentId.slice("adapter-".length));
    if (resolve(path) !== this.file(release)) throw new Error("The model folder changed during download. The file was kept.");
    await this.verify(release);
    const info = await lstat(path);
    await this.mutate("Verified adapter download completed", state => { state.owned[release.source.sha256] = { path: resolve(path), device: info.dev, inode: info.ino, createdMs: info.birthtimeMs }; });
    await this.refresh();
  }

  private async safePath(release: AdapterRelease): Promise<string> {
    const file = this.file(release), root = await realpath(this.opts.modelsDir()!);
    const actual = await realpath(file), inside = relative(root, actual);
    const expected = join(root, "loras", "arke", `${release.source.sha256}.safetensors`);
    if (inside.startsWith("..") || isAbsolute(inside) || actual !== expected || (await lstat(file)).isSymbolicLink()) throw new Error("Adapter file is not a regular file in the selected model folder.");
    return file;
  }
  async verify(release: AdapterRelease): Promise<void> {
    const file = await this.safePath(release);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file, { signal: this.closed.signal })) hash.update(chunk);
    if (hash.digest("hex") !== release.source.sha256) throw new Error("Adapter checksum does not match its pinned release.");
  }
  private async removeOwned(release: AdapterRelease): Promise<void> {
    const state = await this.read(), sha = release.source.sha256;
    if (!await this.owns(release, state)) throw new Error("Adapter disabled. The file is user-managed and was kept.");
    if (this.opts.shared?.(sha)) throw new Error("Adapter disabled. Another recipe needs this file, so it was kept.");
    if (this.opts.active(sha)) throw new Error("Adapter disabled. Its file is still in use and was kept.");
    await this.verify(release);
    if (!await this.owns(release, state)) throw new Error("The adapter file changed while removal was being checked. It was kept.");
    if (this.opts.active(sha)) throw new Error("The adapter file is still in use.");
    await unlink(await this.safePath(release));
    await this.mutate("Owned adapter file deleted", next => { delete next.owned[sha]; });
  }

  async guard(model: string, selections: unknown, verifyFiles = false): Promise<void> {
    this.closed.signal.throwIfAborted();
    if (selections === undefined) return;
    const selected = AdapterSelectionsSchema.parse(selections);
    if (!selected.length) return;
    if (!this.opts.local()) throw new Error("Adapters require a local ComfyUI engine.");
    const combinationProblem = adapterCombinationProblem(selected, model, this.opts.bundles ?? []);
    if (combinationProblem) throw new Error(combinationProblem);
    const state = await this.read();
    for (const row of selected) {
      const release = this.release(row.releaseId);
      if (release.source.sha256 !== row.sha256) throw new Error("The selected adapter version has changed.");
      const problem = this.policy(release, state) ?? adapterCompatibilityProblem(release, model, row.strength);
      if (problem) throw new Error(problem);
      if (verifyFiles) await this.verify(release);
      else if (!await this.present(release)) throw new Error("The selected adapter is not installed.");
    }
    // Hashing can take seconds. Re-read permission after it, immediately before returning.
    const latest = await this.read();
    this.closed.signal.throwIfAborted();
    for (const row of selected) { const problem = this.policy(this.release(row.releaseId), latest); if (problem) throw new Error(problem); }
  }
  async dispose(): Promise<void> { this.closed.abort(); await Promise.allSettled(this.pending); }
}
