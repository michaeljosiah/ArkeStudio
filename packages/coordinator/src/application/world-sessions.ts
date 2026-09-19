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
    await this.policy.authorise(context, "media", resource);
    if (/^productions\/[^/]+\/media\/[^/]+\/(?:page|narration)-/i.test(artifactId)) {
      const matches = this.queue?.jobs().filter(job => job.worldId === worldId && job.landedFiles?.includes(artifactId)) ?? [];
      if (matches.length !== 1) throw new Error("The story media source record is unavailable or ambiguous.");
      if (matches[0]!.status !== "succeeded") throw new Error("The story media job has not completed successfully.");
      const owner = matches[0]!.params.engineOperation as {context?: EngineContext; resource?: EngineResource} | undefined;
      if (owner?.context?.scopeId !== context.scopeId || owner.context.subjectId !== context.subjectId ||
        owner.resource?.worldId !== worldId || !owner.resource.mediaKind || !owner.resource.sourceHash)
        throw new Error("The story media belongs to a different scope or has no source binding.");
      resource = {...owner.resource, artifactId};
      await this.policy.authorise(context, "media", resource);
      await readStoryMediaSource(this.repository, this.policy, context, resource);
    }
    const artifact = await this.repository.use(worldId, session => session.artifact(artifactId));
    if (artifact.id !== artifactId) throw new Error("Artifact identity does not match the request.");
    if (resource.mediaKind === "image" && !artifact.contentType.startsWith("image/")) throw new Error("The page artifact is not an image.");
    if (resource.mediaKind === "speech" && !["audio/wav", "audio/mpeg", "audio/flac"].includes(artifact.contentType))
      throw new Error("The narration artifact is not supported audio.");
    artifact.bytes = new Uint8Array(artifact.bytes);
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
    if (resource.mediaKind) await readStoryMediaSource(this.repository, this.policy, context, resource);
    await this.policy.deliver(context, resource, { kind: "artifact", id: artifact.id, sha256 });
    return { ...artifact, sha256 };
  }
}
