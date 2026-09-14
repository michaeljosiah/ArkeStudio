import type { EngineContext, EnginePolicy, EngineSnapshot, EngineWorldRepository } from "./contracts.js";
import { engineHash, requireContext } from "./operations.js";

/** World identity is explicit; this service has no selected-world or transport state. */
export class WorldSessionService {
  constructor(readonly repository: EngineWorldRepository, private readonly policy: EnginePolicy) {}

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

  async media(context: EngineContext, worldId: string, artifactId: string) {
    context = structuredClone(context);
    requireContext(context);
    const resource = { worldId, artifactId };
    await this.policy.authorise(context, "media", resource);
    const artifact = await this.repository.use(worldId, session => session.artifact(artifactId));
    if (artifact.id !== artifactId) throw new Error("Artifact identity does not match the request.");
    artifact.bytes = new Uint8Array(artifact.bytes);
    const { createHash } = await import("node:crypto");
    const sha256 = createHash("sha256").update(artifact.bytes).digest("hex");
    await this.policy.deliver(context, resource, { kind: "artifact", id: artifact.id, sha256 });
    return { ...artifact, sha256 };
  }
}
