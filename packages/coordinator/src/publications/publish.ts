import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { VideoPublicationRequestSchema, type VideoPublicationManifest, type VideoPublicationRequest } from "@arke-studio/contracts";
import { renameWithRetry, serializeFileMutation, withTransientRetry } from "../world/atomic.js";
import { toExtendedLength } from "../world/paths.js";
import type { WorldStore } from "../world/store.js";
import { copyPublicationDirectory, extractPublicationZip, publicationArchiveByteLimit, writePublicationZip, type PublicationArchiveOptions } from "./archive.js";
import { PublicationFileError, readPublicationFile, requirePublicationDigest } from "./files.js";
import { verifyPublicationDirectory, type VerifiedPublicationDirectory } from "./verify.js";
import { compileVideoPublication, type CompiledVideoPublication, type VideoPublicationCompilerOptions } from "./video.js";

const Hash = z.string().regex(/^[0-9a-f]{64}$/);
const Bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Operation = z.object({
  version: z.literal(1), operationId: z.string().uuid().regex(/^[0-9a-f-]+$/),
  publicationId: z.string().refine(value => value.startsWith("urn:uuid:") && z.string().uuid().safeParse(value.slice(9)).success),
  requestFingerprint: Hash, format: z.enum(["directory", "zip"]),
}).strict();
const Prepared = z.object({
  version: z.literal(1), attempt: z.string().regex(/^attempt-[A-Za-z0-9]{6}$/),
  manifestSha256: Hash, byteLength: Bytes,
  archive: z.object({ sha256: Hash, byteLength: Bytes }).strict().nullable(),
}).strict();
type Prepared = z.infer<typeof Prepared>;

export type PublicationDeliveryRequest = Omit<z.infer<typeof Operation>, "version">;
export interface PublishedPublication {
  operationId: string;
  format: "directory" | "zip";
  path: string;
  manifest: VideoPublicationManifest;
  manifestSha256: string;
  /** Portable package bytes (or ZIP bytes for an archive). */
  byteLength: number;
}
export interface PublicationPublisherOptions extends PublicationArchiveOptions {
  /** Existing host-owned local directory, outside authored world storage. */
  outputRoot: string;
  /** Lifecycle observations; a thrown error models interruption and preserves recovery state. */
  onPhase?: (phase: "prepared" | "promoted" | "completed") => void | Promise<void>;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(toExtendedLength(path)); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function realDirectory(path: string): Promise<string> {
  const stat = await lstat(toExtendedLength(path));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PublicationFileError("unsafe-path", "Publication storage must be a real directory.");
  return realpath(toExtendedLength(path));
}

async function record<T>(root: string, name: string, schema: z.ZodType<T>): Promise<T | undefined> {
  if (!await exists(join(root, name))) return undefined;
  const chunks: Buffer[] = [];
  await readPublicationFile(root, name, 16 * 1024, undefined, undefined, chunks).catch(recoveryFailure);
  try { return schema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)))); }
  catch { throw new PublicationFileError("incomplete-publication", "Publication recovery record is invalid; existing output has been preserved."); }
}

function recoveryFailure(error: unknown): never {
  // Damaged prepared bytes cannot be replaced by rerendering this operation. Keep transient
  // system failures (permissions, busy files, disk errors) and cancellation retryable.
  if (error instanceof PublicationFileError || ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException)?.code ?? "")) {
    throw new PublicationFileError("incomplete-publication", "Saved publication data is missing, invalid or changed; existing output has been preserved.");
  }
  throw error;
}

/** Files are flushed before an atomic, no-replace link. Never overwrite a competing receipt. */
async function installRecord(root: string, name: string, value: unknown): Promise<boolean> {
  const temporary = join(root, `record-${randomUUID()}.tmp`);
  const handle = await open(toExtendedLength(temporary), "wx");
  try { await handle.writeFile(JSON.stringify(value) + "\n", "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try {
    await withTransientRetry(() => link(toExtendedLength(temporary), toExtendedLength(join(root, name))));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally { await rm(toExtendedLength(temporary), { force: true }); }
}

/**
 * SPEC-048 R-10/R-11. Each operation selects one flushed prepared attempt with an exclusive
 * receipt. Recovery validates that exact attempt/destination even if completion is absent.
 * Concurrent processes can prepare candidates, but only the winning candidate is promoted.
 * Supported storage is a trusted local filesystem, not an adversarially mutated/synced folder.
 */
export async function publishPublication(
  input: PublicationDeliveryRequest,
  build: (scratchRoot: string) => Promise<CompiledVideoPublication>,
  options: PublicationPublisherOptions,
): Promise<PublishedPublication> {
  const operation = Operation.parse({ ...input, version: 1 });
  options.signal?.throwIfAborted();
  const root = await realDirectory(options.outputRoot);
  const operationRoot = join(root, operation.operationId);
  try { await mkdir(toExtendedLength(operationRoot)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  await realDirectory(operationRoot);
  return serializeFileMutation(operationRoot, async () => {
    options.signal?.throwIfAborted();
    await installRecord(operationRoot, "operation.json", operation);
    const saved = await record(operationRoot, "operation.json", Operation);
    if (JSON.stringify(saved) !== JSON.stringify(operation)) throw new PublicationFileError("operation-conflict", "This publication operation already has different settings.");
    let prepared = await record(operationRoot, "prepared.json", Prepared);
    const completed = await record(operationRoot, "complete.json", Prepared);
    if (completed && (!prepared || JSON.stringify(completed) !== JSON.stringify(prepared))) {
      throw new PublicationFileError("incomplete-publication", "Publication completion does not match its prepared attempt.");
    }
    if (!prepared) {
      const attemptRoot = await mkdtemp(toExtendedLength(join(operationRoot, "attempt-")));
      const attempt = basename(attemptRoot);
      let retained = false;
      try {
        const compiled = await build(attemptRoot);
        let copied: VerifiedPublicationDirectory;
        try { copied = await copyPublicationDirectory(compiled.directory, join(attemptRoot, "staged"), options); }
        finally { await compiled.dispose(); }
        if (copied.manifest.id !== operation.publicationId) throw new PublicationFileError("operation-conflict", "The compiled publication identity differs from this operation.");
        let archive: Prepared["archive"] = null;
        if (operation.format === "zip") {
          await writePublicationZip(copied.directory, join(attemptRoot, "staged.zip"), options);
          const extracted = await extractPublicationZip(join(attemptRoot, "staged.zip"), attemptRoot, options);
          try {
            if (extracted.manifestSha256 !== copied.manifestSha256) throw new PublicationFileError("source-changed", "The archive differs from the prepared package.");
          } finally { await extracted.dispose(); }
          const measured = await readPublicationFile(attemptRoot, "staged.zip", publicationArchiveByteLimit(options.limits), options.signal);
          archive = { sha256: measured.sha256, byteLength: measured.byteLength };
          await rm(toExtendedLength(copied.directory), { recursive: true, force: true });
        }
        const candidate: Prepared = { version: 1, attempt, manifestSha256: copied.manifestSha256, byteLength: copied.byteLength, archive };
        options.signal?.throwIfAborted();
        retained = await installRecord(operationRoot, "prepared.json", candidate);
        prepared = await record(operationRoot, "prepared.json", Prepared);
        if (!prepared) throw new PublicationFileError("incomplete-publication", "Publication preparation receipt is missing.");
        // A failed receipt cleanup can leave a committed intent. The finally block below also
        // checks the record before deleting this attempt, so an uncertain write is preserved.
        if (retained) await options.onPhase?.("prepared");
      } finally {
        const selected = await record(operationRoot, "prepared.json", Prepared);
        if (!retained && selected?.attempt !== attempt) await rm(toExtendedLength(attemptRoot), { recursive: true, force: true });
      }
    }
    const chosen = prepared;
    if ((operation.format === "zip") !== (chosen.archive !== null)) throw new PublicationFileError("incomplete-publication", "Publication container does not match the prepared attempt.");
    const attemptRoot = join(operationRoot, chosen.attempt);
    await realDirectory(attemptRoot).catch(recoveryFailure);
    const staged = operation.format === "zip" ? "staged.zip" : "staged";
    const target = operation.format === "zip" ? "publication.zip" : "publication";
    const destination = join(attemptRoot, target);
    const verify = async (name: string): Promise<VerifiedPublicationDirectory> => {
      try {
        let verified: VerifiedPublicationDirectory;
        if (chosen.archive) {
          const measured = await readPublicationFile(attemptRoot, name, publicationArchiveByteLimit(options.limits), options.signal);
          requirePublicationDigest(measured, chosen.archive);
          const extracted = await extractPublicationZip(join(attemptRoot, name), attemptRoot, options);
          try { verified = extracted; }
          finally { await extracted.dispose(); }
          await measured.assertUnchanged();
        } else verified = await verifyPublicationDirectory(join(attemptRoot, name), options);
        if (verified.manifestSha256 !== chosen.manifestSha256 || verified.manifest.id !== operation.publicationId || verified.byteLength !== chosen.byteLength) {
          throw new PublicationFileError("incomplete-publication", "Publication output differs from its prepared receipt; it has been preserved.");
        }
        return verified;
      } catch (error) { options.signal?.throwIfAborted(); return recoveryFailure(error); }
    };
    options.signal?.throwIfAborted();
    if (!await exists(destination)) {
      if (completed || !await exists(join(attemptRoot, staged))) throw new PublicationFileError("incomplete-publication", "Prepared publication output is missing; it cannot be rebuilt under the same operation.");
      try { await verify(staged); }
      catch (error) {
        // A concurrent reconciler can rename the selected tree during this validation. Its
        // destination still has to pass the same receipt checks below; no new build is allowed.
        if (!await exists(destination)) throw error;
      }
      options.signal?.throwIfAborted();
      // Directory targets are inside the exclusively selected attempt. Another reconciler can
      // install only the same nonempty tree; it cannot be overwritten by a directory rename.
      // ZIP uses a hard link because Node's file rename would replace an existing destination.
      if (!await exists(destination)) {
        try {
          if (operation.format === "zip") await withTransientRetry(() => link(toExtendedLength(join(attemptRoot, staged)), toExtendedLength(destination)));
          else await renameWithRetry(join(attemptRoot, staged), destination);
        } catch (error) { if (!await exists(destination)) throw error; }
      }
      await options.onPhase?.("promoted");
    }
    const verified = await verify(target);
    options.signal?.throwIfAborted();
    await installRecord(operationRoot, "complete.json", chosen);
    const completion = await record(operationRoot, "complete.json", Prepared);
    if (JSON.stringify(completion) !== JSON.stringify(chosen)) throw new PublicationFileError("incomplete-publication", "Publication completion receipt conflicts with this output.");
    await options.onPhase?.("completed");
    return { operationId: operation.operationId, format: operation.format, path: destination,
      manifest: verified.manifest, manifestSha256: verified.manifestSha256, byteLength: chosen.archive?.byteLength ?? verified.byteLength };
  });
}

/** Host entry point: saved operation ids reconcile without scanning or rendering the world again. */
export async function publishVideoPublication(
  store: WorldStore, input: VideoPublicationRequest,
  options: Omit<VideoPublicationCompilerOptions, "scratchRoot"> & PublicationPublisherOptions & { operationId: string; format: "directory" | "zip" },
): Promise<PublishedPublication> {
  const request = VideoPublicationRequestSchema.parse(input);
  const signal = options.signal ? AbortSignal.any([options.signal, store.closingSignal]) : store.closingSignal;
  // Include the source world identity and all rendering settings, not the mutable source bytes:
  // once preparation commits, a retry intentionally returns that captured edition after edits.
  const requestFingerprint = createHash("sha256").update(JSON.stringify({ request, world: store.worldId, encoder: options.encoderVersion })).digest("hex");
  return publishPublication({ operationId: options.operationId, publicationId: request.id, requestFingerprint, format: options.format },
    scratchRoot => compileVideoPublication(store, request, { ...options, scratchRoot, signal }), { ...options, signal });
}
