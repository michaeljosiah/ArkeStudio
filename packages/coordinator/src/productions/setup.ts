import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ProductionSetupDraftSchema, ProductionSetupStateSchema, ProductionSetupOriginSchema, PRODUCTION_SETUP_SCHEMA_VERSION,
  applyProductionSetupUpdate, ulid,
  type ConversationId, type ProductionSetupState, type ProductionSetupUpdate, type WorldChatLoaded,
} from "@arke-studio/contracts";
import { WriteQueue } from "../change-log.js";
import { createProductionFromPlan } from "./ops.js";
import { planProductionSetup, setupSourceDigest } from "./setup-plan.js";
import { WorldChatStore, conversationDir } from "../world-chat/store.js";
import { foldConversation } from "../world-chat/fold.js";
import { discoverConversations } from "../world-chat/discover.js";
import { WorldChatService } from "../world-chat/service.js";
import { CommitStaleError } from "../world/commit.js";
import { WorldStateStaleError, type WorldStore } from "../world/store.js";
import { toExtendedLength } from "../world/paths.js";

function initialState(worldId: string, setupId: ConversationId): ProductionSetupState {
  return { status: "draft", review: null, draft: ProductionSetupDraftSchema.parse({
    schemaVersion: 1, setupId, worldId, revision: 1, title: "", kind: "film", aspect: "16:9", frameRate: 24,
    narrative: {}, arcs: [], references: [], openQuestions: [], episodes: [], scenes: [],
  }) };
}

/** One lifecycle authority per open WorldStore, never an application-global draft sandbox. */
export class ProductionSetupService {
  private readonly queues = new Map<string, WriteQueue>();
  constructor(private readonly world: WorldStore) {}

  private serial<T>(id: ConversationId, work: () => Promise<T>): Promise<T> {
    let queue = this.queues.get(id);
    if (!queue) { queue = new WriteQueue(); this.queues.set(id, queue); }
    let result!: T;
    return queue.enqueue(async () => { result = await work(); }).then(() => result);
  }
  private log(id: ConversationId) { return new WorldChatStore(conversationDir(this.world.dir, id)); }
  private async read(id: ConversationId): Promise<WorldChatLoaded> {
    const log = this.log(id);
    const meta = await log.readMeta();
    if (!meta) throw new Error("This production setup no longer exists.");
    const { events, problems } = await log.read();
    if (problems.some(problem => problem.kind === "interior-corruption" || problem.kind === "foreign-write")) {
      throw new Error("This setup has an unreadable conversation record. Reopen it before making changes.");
    }
    if (events.length === 0) {
      // A saved setup route can also resume a crash immediately after the empty header landed.
      await log.append({ type: "conversation.created", title: "New production",
        entryContext: { kind: "production-setup", setupId: id } }, { at: this.world.now(), expectedSeq: 0 });
      return this.read(id);
    }
    const view = foldConversation(id, meta.createdAt, events).view;
    // Both appends are durable individually. If startup stopped after the context, complete
    // only that recognizable empty setup; never replace a malformed or unrelated conversation.
    if (!view.productionSetup && events.length === 1 && events[0]!.event.type === "conversation.created" &&
        view.entryContext?.kind === "production-setup" && view.entryContext.setupId === id) {
      await this.append(id, view, initialState(this.world.worldId, id));
      return this.read(id);
    }
    if (!view.productionSetup || view.productionSetup.draft.worldId !== this.world.worldId ||
        view.productionSetup.draft.setupId !== id) throw new Error("This setup belongs to another world.");
    return view;
  }
  private async append(id: ConversationId, view: WorldChatLoaded, state: ProductionSetupState): Promise<ProductionSetupState> {
    state = ProductionSetupStateSchema.parse(state);
    await this.log(id).append({ type: "production-setup.updated", state }, { at: this.world.now(), expectedSeq: view.seq });
    return state;
  }
  private editable(view: WorldChatLoaded, expectedRevision?: number, idle = false) {
    const state = view.productionSetup!;
    if (!["draft", "reviewed"].includes(state.status)) throw new Error("Resolve this production's creation before changing or discarding its setup.");
    if (expectedRevision !== undefined && state.draft.revision !== expectedRevision) throw new Error("Production so far changed. Review the current outline.");
    if (idle && view.activeRun) throw new Error("Wait for Arke to finish, or stop the turn before reviewing.");
    return state;
  }

  async start(id: ConversationId): Promise<ProductionSetupState> {
    return this.serial(id, async () => {
      await this.world.ensureSchemaVersion(PRODUCTION_SETUP_SCHEMA_VERSION, "production-setup");
      return this.world.ownedWrite(async () => {
        const log = this.log(id);
        const meta = await log.readMeta();
        if (meta) {
          const events = (await log.read()).events;
          if (events.some(envelope => envelope.event.type === "production-setup.updated")) return (await this.read(id)).productionSetup!;
          if (events.some(envelope => envelope.event.type !== "conversation.created" ||
              envelope.event.entryContext.kind !== "production-setup" || envelope.event.entryContext.setupId !== id)) {
            throw new Error("That conversation is not a production setup.");
          }
        } else await log.create(id, this.world.now());
        const current = await log.read();
        if (!current.events.length) await log.append({
          type: "conversation.created", title: "New production", entryContext: { kind: "production-setup", setupId: id },
        }, { at: this.world.now() });
        const state = initialState(this.world.worldId, id);
        await log.append({ type: "production-setup.updated", state }, { at: this.world.now() });
        return state;
      });
    });
  }

  async update(id: ConversationId, update: ProductionSetupUpdate): Promise<ProductionSetupState> {
    return this.serial(id, () => this.world.ownedWrite(async () => {
      const view = await this.read(id);
      const state = this.editable(view, update.expectedRevision);
      const draft = applyProductionSetupUpdate(state.draft, update);
      return this.append(id, view, { draft, status: "draft", review: null });
    }));
  }

  async review(id: ConversationId, expectedRevision: number): Promise<ProductionSetupState> {
    return this.serial(id, () => this.world.gateOp(async () => {
      const view = await this.read(id);
      const state = this.editable(view, expectedRevision, true);
      const bundle = this.world.getBundle();
      const plan = planProductionSetup(bundle, state.draft, this.world.now());
      return this.append(id, view, {
        draft: state.draft, status: "reviewed",
        review: { id: ulid(), plan, sourceDigest: setupSourceDigest(bundle) },
      });
    }, () => null));
  }

  private async linked(id: ConversationId, state: ProductionSetupState): Promise<string | null> {
    const productionId = state.review?.plan.production.id ?? state.productionId;
    if (!productionId) return null;
    let raw: string;
    try { raw = await readFile(toExtendedLength(join(this.world.dir, "productions", productionId, "setup-origin.json")), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const link = ProductionSetupOriginSchema.parse(JSON.parse(raw));
    if (link.worldId !== this.world.worldId || link.setupId !== id ||
        link.revision !== state.draft.revision || link.productionId !== productionId ||
        link.requestId !== state.review?.id) throw new Error("The production's creation record does not match this review.");
    if (!this.world.getBundle().productions.some(production => production.meta.id === productionId)) {
      throw new Error("Creation is awaiting world recovery. Close and reopen this world.");
    }
    return productionId;
  }

  private async attach(id: ConversationId, state: ProductionSetupState, productionId: string): Promise<ProductionSetupState> {
    return this.world.ownedWrite(async () => {
      let view = await this.read(id);
      if (view.entryContext?.kind !== "production" || view.entryContext.productionId !== productionId) {
        await this.log(id).append({
          type: "conversation.metadata-updated", title: state.draft.title, entryContext: { kind: "production", productionId },
        }, { at: this.world.now(), expectedSeq: view.seq });
        view = await this.read(id);
      }
      if (view.productionSetup!.status === "created") return view.productionSetup!;
      return this.append(id, view, { ...state, status: "created", productionId });
    });
  }

  async create(id: ConversationId, expectedRevision: number, reviewId: string): Promise<ProductionSetupState> {
    return this.serial(id, async () => {
      let fresh = false;
      let state = await this.world.ownedWrite(async () => {
        const view = await this.read(id);
        const current = view.productionSetup!;
        if (current.draft.revision !== expectedRevision || current.review?.id !== reviewId) throw new Error("This review has changed. Review the current outline.");
        if (current.status === "creating" || current.status === "created") return current;
        this.editable(view, expectedRevision, true);
        if (current.status !== "reviewed" || !current.review) throw new Error("Review this outline before creating the production.");
        fresh = true;
        return this.append(id, view, { ...current, status: "creating" });
      });
      const existing = await this.linked(id, state);
      if (existing) return this.attach(id, state, existing);
      // A prior creating record can represent a committing journal, even without a visible link.
      // Never retry it until reopening has resolved that journal's rollback/roll-forward decision.
      if (!fresh || this.uncertain.has(id)) throw new Error("Creation is awaiting recovery. Close and reopen this world.");
      this.uncertain.add(id);
      try {
        const review = state.review!;
        await createProductionFromPlan(this.world, review.plan, {
          source: "production-setup", requestId: review.id,
          precondition: () => setupSourceDigest(this.world.getBundle()) === review.sourceDigest
            ? null : "The world changed after review. Review the outline again.",
        });
      } catch (error) {
        if (error instanceof CommitStaleError || error instanceof WorldStateStaleError) {
          this.uncertain.delete(id);
          state = await this.world.ownedWrite(async () => {
            const view = await this.read(id);
            return this.append(id, view, { draft: state.draft, status: "draft", review: null });
          });
        }
        throw error;
      }
      return this.attach(id, state, state.review!.plan.production.id);
    });
  }
  private readonly uncertain = new Set<string>();

  /** Called only after WorldStore.open has resolved every pending authored commit journal. */
  async recover(id: ConversationId): Promise<ProductionSetupState> {
    return this.serial(id, async () => {
      const state = await this.world.ownedWrite(async () => (await this.read(id)).productionSetup!);
      const productionId = await this.linked(id, state);
      if (productionId) return this.attach(id, state, productionId);
      if (state.status !== "creating") return state;
      this.uncertain.delete(id);
      return this.world.ownedWrite(async () => {
        const view = await this.read(id);
        return this.append(id, view, { draft: state.draft, status: "draft", review: null,
          problem: "Creation did not land. Review the retained outline to try again." });
      });
    });
  }

  async resume(id: ConversationId): Promise<ProductionSetupState> {
    return this.serial(id, async () => {
      const state = await this.world.ownedWrite(async () => (await this.read(id)).productionSetup!);
      const productionId = await this.linked(id, state);
      if (productionId) return this.attach(id, state, productionId);
      return state;
    });
  }

  async discard(id: ConversationId): Promise<ProductionSetupState> {
    return this.serial(id, () => this.world.ownedWrite(async () => {
      const view = await this.read(id);
      const state = this.editable(view, undefined, true);
      if (await this.linked(id, state)) throw new Error("This setup has already created a production.");
      await new WorldChatService(this.world.dir).delete(id, ulid());
      return { draft: state.draft, status: "discarded", review: null };
    }));
  }
}

const services = new WeakMap<WorldStore, ProductionSetupService>();
export function productionSetups(world: WorldStore): ProductionSetupService {
  let service = services.get(world);
  if (!service) { service = new ProductionSetupService(world); services.set(world, service); }
  return service;
}

export async function recoverProductionSetups(world: WorldStore): Promise<void> {
  const service = productionSetups(world);
  const found = await world.ownedWrite(() => discoverConversations(world.dir));
  const errors: unknown[] = [];
  for (const summary of found.summaries) {
    if (summary.entryContext?.kind !== "production-setup" && summary.setupStatus !== "creating") continue;
    try { await service.recover(summary.id); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, "Some production setups could not be recovered; other setups remain available.");
}
