import type { z } from "zod";
import type { ArkeCommandBodySchema, ArkeDestructiveBodySchema, BenchTake, ConversationActionCard,
  ModelWorldChatAction } from "@arke-studio/contracts";
import type { OpenedBench } from "./service.js";
import { readBenchRecord } from "./chat-reads.js";
import type { WorldStatePrecondition, WorldStore } from "../world/store.js";

type Action = Extract<ModelWorldChatAction, { kind: "bench-keep" | "bench-select" | "bench-discard" }>;
export class BenchChatControls {
  constructor(private readonly store: WorldStore, private readonly ports: {
    bench(sessionId: string): Promise<OpenedBench | null>;
    serialise<T>(key: string, work: () => Promise<T>): Promise<T>;
    keep(bench: OpenedBench, take: BenchTake, id: string, precondition: WorldStatePrecondition): Promise<{ id: string }>;
    refresh(sessionId: string): Promise<void>;
  }) {}
  private source(action: Action) {
    const record = readBenchRecord(this.store.dir, action.sessionId);
    const take = record?.session.takes.find(take => take.id === action.takeId);
    if (!record || !take) throw new Error("That Bench take is unavailable.");
    if (action.kind === "bench-discard" && take.disposition !== "open") throw new Error("Only an open Bench take can be discarded.");
    if (action.kind !== "bench-discard" && take.disposition === "discarded") throw new Error("That Bench take was discarded.");
    if (action.kind === "bench-keep" && (record.session.subject || take.status !== "succeeded" || !take.media)) {
      throw new Error(record.session.subject ? "Use the production take filing action for a production subject." : "This take has no completed media to keep.");
    }
    return { record, take };
  }
  prepare(action: Action): z.infer<typeof ArkeCommandBodySchema> | z.infer<typeof ArkeDestructiveBodySchema> {
    const { record, take } = this.source(action);
    if (action.kind === "bench-discard") return { family: "destructive", removed: [`Take ${take.n} from the open Bench candidates`],
      retained: ["The immutable take, source media and generation provenance"], dependentChanges: [], blockers: [], undoAvailable: false };
    return { family: "command", commands: [{ label: action.kind === "bench-keep" ? `Keep Take ${take.n} as an artifact` : `Select Take ${take.n} in Bench`,
      detail: `${take.request.mode} · ${take.status} · ${take.request.provider}/${take.request.model}${action.kind === "bench-select" ? ` · current selection ${record.session.selectedTakeId ?? "none"}` : ""}` }],
      expectedResult: action.kind === "bench-keep" ? "Copies the completed media into the world's artifacts with its generation provenance." : "Selects this take in this Bench session; production selections stay as they are.",
      undoAvailable: false };
  }
  execute(action: Action, id: string, precondition: WorldStatePrecondition) {
    return this.ports.serialise(`${action.sessionId}/${action.takeId}`, async () => {
      const recovered = await this.reconcileIdentity(action.sessionId, action.takeId, action.kind, id);
      if (recovered) return recovered;
      const { take } = this.source(action);
      const bench = await this.ports.bench(action.sessionId);
      if (!bench) throw new Error("That Bench is unavailable.");
      let resultId = action.takeId;
      if (action.kind === "bench-keep") resultId = (await this.ports.keep(bench, take, id, precondition)).id;
      else await this.store.gateOp(async () => {
        this.source(action);
        await bench.store.append({ type: action.kind === "bench-select" ? "take-selected" : "take-discarded", takeId: action.takeId }, { at: this.store.now(), requestId: id });
      }, precondition);
      await this.ports.refresh(action.sessionId);
      return this.receipt(resultId, action.kind);
    });
  }
  private receipt(id: string, kind: Action["kind"]) {
    return { status: "completed" as const, receipt: { kind, id, summary: kind === "bench-keep" ? "The Bench take was kept as an artifact."
      : kind === "bench-select" ? "The Bench take was selected." : "The Bench take was discarded; its source media remains available." } };
  }
  private async reconcileIdentity(sessionId: string, takeId: string, kind: Action["kind"], id: string) {
    const record = readBenchRecord(this.store.dir, sessionId);
    if (!record) return null;
    const event = record.events.find(event => event.requestId === id)?.event;
    const expected = kind === "bench-keep" ? "take-filed" : kind === "bench-select" ? "take-selected" : "take-discarded";
    if (event?.type === expected && "takeId" in event && event.takeId === takeId) return this.receipt("artifactId" in event ? event.artifactId : takeId, kind);
    // The artifact commit can precede the Bench event. Repair this link without filing again.
    if (kind !== "bench-keep") return null;
    const artifact = this.store.getBundle().artifacts.find(artifact => artifact.retiredAt === undefined && artifact.generation?.source === "bench"
      && artifact.generation.sessionId === sessionId && artifact.generation.takeId === takeId);
    if (!artifact) return null;
    const take = record.session.takes.find(take => take.id === takeId);
    if (!take || record.session.subject || take.disposition === "discarded") return null;
    const bench = await this.ports.bench(sessionId);
    if (!bench) return null;
    await this.store.ownedWrite(() => bench.store.append({ type: "take-filed", takeId, artifactId: artifact.id }, { at: this.store.now(), requestId: id }));
    await this.ports.refresh(sessionId);
    return this.receipt(artifact.id, kind);
  }
  reconcile(card: ConversationActionCard) {
    if (card.status === "pending") return Promise.resolve(null);
    const kind = card.actionKind.replace("world-chat-", "") as Action["kind"];
    const takeId = card.targets.find(target => target.kind === "bench-take")?.id;
    if (!takeId || !["bench-keep", "bench-select", "bench-discard"].includes(kind)) return Promise.resolve(null);
    return this.ports.serialise(`${card.authority.id}/${takeId}`, () => this.reconcileIdentity(card.authority.id, takeId, kind, card.actionId));
  }
}
