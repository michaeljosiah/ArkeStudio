import type { EngineContext, EngineMutation, EngineReceipt, EngineWorldRepository, SheetProposalInput } from "./contracts.js";
import { engineHash, EngineOperations } from "./operations.js";
import type { AcceptOutcome } from "../gate/proposals.js";

/** The existing gate still owns acceptance. This service owns the caller's complete use case. */
export class ProposalApplicationService {
  constructor(private readonly worlds: EngineWorldRepository, private readonly operations: EngineOperations) {}

  async propose(context: EngineContext, worldId: string, input: SheetProposalInput & EngineMutation) {
    context = structuredClone(context);
    input = structuredClone(input);
    const { operationId, expectedRevision, ...draft } = input;
    const result = await this.operations.run(context, "propose", { worldId }, operationId, input, key =>
      this.worlds.use(worldId, async session => {
        if (expectedRevision !== undefined && (await session.snapshot()).revision !== expectedRevision) {
          throw new Error("The world changed before this proposal was started.");
        }
        const value = await session.propose(draft, expectedRevision);
        const saved = await session.saved(key);
        return { operationKey: key, revision: saved.revision, value };
      }));
    await this.operations.policy.deliver(context, { worldId, proposalId: result.value.proposal.id },
      { kind: "proposal", id: result.value.proposal.id, sha256: engineHash(result.value) });
    return result;
  }

  async accept(context: EngineContext, worldId: string, proposalId: string,
    input: EngineMutation & { confirmRipples?: string; expectedDraftRevision?: number }): Promise<EngineReceipt<AcceptOutcome>> {
    context = structuredClone(context);
    input = structuredClone(input);
    const result = await this.operations.run(context, "accept", { worldId, proposalId }, input.operationId, input, key =>
      this.worlds.use(worldId, async session => {
        const proposal = await session.proposal(proposalId);
        const value = await session.accept(proposalId, input);
        if (value.status === "accepted" || value.status === "no-op") await session.resolution(proposal, "accepted");
        const saved = await session.saved(key);
        return { operationKey: key, revision: saved.revision, value };
      }));
    await this.operations.policy.deliver(context, { worldId, proposalId },
      { kind: "proposal", id: proposalId, sha256: engineHash(result.value) });
    return result;
  }

  async discard(context: EngineContext, worldId: string, proposalId: string, input: EngineMutation) {
    context = structuredClone(context);
    input = structuredClone(input);
    const result = await this.operations.run(context, "discard", { worldId, proposalId }, input.operationId, input, key =>
      this.worlds.use(worldId, async session => {
        const proposal = await session.proposal(proposalId);
        await session.discard(proposalId, input.expectedRevision);
        await session.resolution(proposal, "discarded");
        return { operationKey: key, ...(await session.saved(key)), value: { status: "discarded" as const } };
      }));
    await this.operations.policy.deliver(context, { worldId, proposalId },
      { kind: "proposal", id: proposalId, sha256: engineHash(result.value) });
    return result;
  }
}
