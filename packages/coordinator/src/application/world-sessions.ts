import {audioFormatOf, imageFormatOf} from "../queue/verify.js";
import type { EngineContext, EnginePolicy, EngineQueue, EngineResource, EngineSnapshot, EngineWorldRepository } from "./contracts.js";
import { readStoryMediaSource } from "./story-media.js";
import { engineHash, requireContext } from "./operations.js";

/** World identity is explicit; this service has no selected-world or transport state. */
export class WorldSessionService {
  constructor(readonly repository: EngineWorldRepository, private readonly policy: EnginePolicy, private readonly queue?: EngineQueue) {}

  async read(context: EngineContext, worldId: string): Promise<EngineSnapshot> {
    context = structuredClone(context);
    requireContext(context);
    await this.policy.authorise(context, "read", { worldId });
    const snapshot = await this.repository.use(worldId, session => session.snapshot());
    const bundle = structuredClone(await this.policy.project(context, structuredClone(snapshot.bundle)));
    if (bundle.meta.worldId !== worldId) throw new Error("The projected world does not match the request.");
    await this.policy.deliver(context, { worldId }, { kind: "world", id: worldId, sha256: engineHash(bundle) });
    return { revision: snapshot.revision, bundle };
  }

  async media(context: EngineContext, worldId: string, artifactId: string, sheetId?: string) {
    context = structuredClone(context);
    requireContext(context);
    artifactId = artifactId.replace(/\\/g, "/");
    let resource: EngineResource = { worldId, artifactId, ...(sheetId ? { sheetId } : {}) };
    const matches = this.queue?.jobs().filter(job => job.worldId === worldId && job.landedFiles?.includes(artifactId)) ?? [];
    if (/^productions\/[^/]+\/media\/[^/]+\//i.test(artifactId) ||
      matches.some(job => (job.params.engineOperation as {resource?: EngineResource} | undefined)?.resource?.mediaKind)) {
      if (matches.length !== 1) throw new Error("The story media source record is unavailable or ambiguous.");
      if (matches[0]!.status !== "succeeded") throw new Error("The story media job has not completed successfully.");
      const owner = matches[0]!.params.engineOperation as {context?: EngineContext; resource?: EngineResource} | undefined;
      if (owner?.context?.scopeId !== context.scopeId || owner.context.subjectId !== context.subjectId ||
        owner.resource?.worldId !== worldId || !owner.resource.mediaKind || !owner.resource.sourceHash)
        throw new Error("The story media belongs to a different scope or has no source binding.");
      resource = {...owner.resource, artifactId};
      await this.policy.authorise(context, "media", resource);
      await readStoryMediaSource(this.repository, this.policy, context, resource);
    } else {
      await this.policy.authorise(context, "media", resource);
    }
    const artifact = await this.repository.use(worldId, session => session.artifact(artifactId));
    if (artifact.id !== artifactId) throw new Error("Artifact identity does not match the request.");
    if (resource.mediaKind === "image" && !artifact.contentType.startsWith("image/")) throw new Error("The page artifact is not an image.");
    if (resource.mediaKind === "speech" && !["audio/wav", "audio/mpeg", "audio/flac"].includes(artifact.contentType))
      throw new Error("The narration artifact is not supported audio.");
    artifact.bytes = new Uint8Array(artifact.bytes);
    if (resource.mediaKind === "image") {
      const format = imageFormatOf(artifact.bytes);
      if (!format || artifact.contentType !== format.contentType) throw new Error("The page artifact bytes do not match a supported image format.");
    }
    if (resource.mediaKind === "speech") {
      const format = audioFormatOf(artifact.bytes);
      const mime = format === "mp3" ? "audio/mpeg" : `audio/${format}`;
      if (!format || format !== matches[0]!.params.audioFormat || artifact.contentType !== mime)
        throw new Error("The narration artifact bytes do not match the requested audio format.");
    }
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
    await this.policy.deliver(context, resource, { kind: "artifact", id: artifact.id, sha256 });
    // Delivery policy may await a remote safety review. Validate the source after it returns;
    // the repository serializes this final check with chapter writes, with no later policy await.
    if (resource.mediaKind) await readStoryMediaSource(this.repository, this.policy, context, resource);
    return { ...artifact, sha256 };
  }
}
