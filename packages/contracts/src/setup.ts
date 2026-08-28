import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";
import { EngineIdSchema } from "./local-ai.js";
import { ProviderIdSchema } from "./provider.js";

/**
 * Local runtimes fetched during setup: the writing runtime (Ollama and one model) and the two
 * voice models. Each one is optional, individually skippable, and never blocks the app — the
 * user can continue while they arrive.
 *
 * A component is a *thing that must be on this machine*, not a thing we generate. Presence is
 * detected before anything is fetched, so a second launch downloads nothing.
 */

export const SetupComponentStateSchema = z.enum([
  /** Already on this machine — nothing to do. */
  "present",
  /** Offered but never fetched on its own: yours to start, from Settings. */
  "available",
  /** Waiting its turn. */
  "queued",
  "downloading",
  /** Bytes are here; the runtime's own installer or model-pull is running. */
  "installing",
  /** Arrived and usable. */
  "ready",
  /** The user said no, this time or for good. */
  "skipped",
  /** Cannot even be attempted — no disk, no network — with the measured reason. */
  "blocked",
  "failed",
]);
export type SetupComponentState = z.infer<typeof SetupComponentStateSchema>;

export const SetupComponentSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    /** What it buys you, in the product's words: "Writes with you, on this machine". */
    purpose: z.string().min(1),
    /** The download size as published, for honest arithmetic before anything starts. */
    sizeMb: z.number().int().min(0),
    /**
     * Peak disk this component needs where that differs from what it downloads — an archive that
     * is extracted holds both copies at once. On the wire so the closure's total is the same
     * figure on the button and in the guard.
     */
    installedMb: z.number().int().min(0).optional(),
    state: SetupComponentStateSchema,
    bytesDone: z.number().int().min(0).default(0),
    bytesTotal: z.number().int().min(0).default(0),
    /** Measured, not guessed; null while nothing is moving. */
    bytesPerSecond: z.number().int().min(0).nullable().default(null),
    /** The reason, whenever the state is one that owes you one. */
    detail: z.string().optional(),
    /**
     * Which guard blocked it (SPEC-032 R-20.3, R-20.4). The detail sentence carries the figures
     * for a person; a correlation that needs to know *disk* from *waiting on a dependency* must
     * not parse the sentence to find out, so the guard says which it was. Optional: only a
     * `blocked` component carries one.
     */
    blockedBy: z.enum(["disk", "dependency", "models-folder", "architecture"]).optional(),
    /**
     * The volume the disk guard measured, as a root like `D:` — the one filesystem
     * identification a diagnostics record may carry (SPEC-032 R-28), because a disk finding
     * has to name the drive.
     */
    blockedVolumeRoot: z.string().min(1).optional(),
    /**
     * The disk guard's own figures and instant, published beside the root it measured. The
     * guard works per volume and `diskFreeMb` below is the app volume's figure — carrying that
     * into a finding about a mapped drive would name D: and quote C:, the exact fact/screen
     * disagreement SPEC-032 R-13 forbids. The need is the volume group's total, which is the
     * number the detail sentence states.
     */
    blockedNeedMb: z.number().int().min(0).optional(),
    blockedFreeMb: z.number().int().min(0).optional(),
    /** Strict ISO: this instant lands in finding facts, whose schema would refuse anything looser. */
    blockedAt: IsoDateTimeSchema.optional(),
    /** The failed action must be tried again; an ordinary retry would trust the surviving file. */
    repairRequired: z.boolean().optional(),
    /**
     * The manifest models this component makes available (SPEC-033 R-39). Declared, so that a
     * capability row can say whether a model is installed without inferring a chain from an
     * identifier's prefix — the same class of mistake as `ollama-gemma4-12b` naming its runtime.
     *
     * ComfyUI recipe weights are deliberately absent: their component id is already derived from
     * the recipe catalogue, and a second declaration of the same weights is what drifts.
     */
    provides: z.array(z.string().min(1)).optional(),
    /**
     * Which engine requires this component (SPEC-033 R-71). Declared, so Engines can state a
     * component under the engine that needs it rather than in one flat list that mixes a runtime
     * with a set of weights.
     *
     * Absent means no engine requires it — a CLI, a native dependency. Those keep a place on
     * Engines and are not the organising idea.
     */
    engine: EngineIdSchema.optional(),
    /**
     * The provider whose tool this is (SPEC-033 R-1). Providers owns the credential a tool
     * exists for, so it owns the tool: the Higgsfield CLI is only useful to somebody with a
     * Higgsfield account, and its install button belongs beside the sign-in.
     *
     * Declared for the same reason `engine` is. Every fact belongs to exactly one surface, and
     * the alternative to declaring the owner is a hand-written list of what to hide where —
     * which is precisely the `statedElsewhere` R-6 deletes.
     */
    provider: ProviderIdSchema.optional(),
    /**
     * The components that must be here before this one is attempted (SPEC-033 R-39).
     *
     * On the wire because the closure is computed from it on both sides of the boundary: the
     * button that states what an install costs, and the guard that refuses one this disk cannot
     * hold, must be reading the same graph or they will eventually quote different figures.
     */
    requires: z.array(z.string().min(1)).optional(),
    /**
     * Whether Arke may take this one away (SPEC-033 R-43).
     *
     * Absent means it may not, and a row must not offer a Remove that cannot act: a component
     * setup fetches unasked comes back on the next launch, and a weight file inside a folder the
     * user mapped may already have been theirs before Arke ever saw it.
     */
    removable: z.boolean().optional(),
    /**
     * What a cancelled or failed install left behind and could not delete (R-45).
     *
     * Reported rather than claimed away. *Nothing remains* would be a requirement no
     * implementation can honour — a scanner holding a `.partial` open is ordinary on Windows —
     * and one every implementation would claim. Named with its path and its size so it stays
     * reclaimable, which is what makes the reporting worth anything.
     */
    leftovers: z
      .array(z.object({ path: z.string().min(1), sizeMb: z.number().int().min(0) }).strict())
      .optional(),
  })
  .strict();
export type SetupComponent = z.infer<typeof SetupComponentSchema>;

/**
 * What one activation actually costs (SPEC-033 R-40, R-41).
 *
 * SPEC-028 R-5 already requires one-action activation over a complete dependency closure. This
 * is what the closure is **built from** and how its size is **spoken about**: the figure on the
 * button is the figure that lands on disk, and the rest of the chain is stated by count rather
 * than named, because `Install ComfyUI 0.3.48 and its nodes` is the machine's sentence and not
 * the product's.
 */
export interface SetupClosure {
  /** The component the person asked for. */
  componentId: string;
  /** Everything that must land, dependencies first, including the component itself. */
  componentIds: string[];
  /** The whole closure's download, never the model's own weights alone (R-40). */
  downloadMb: number;
  /** Peak disk, using each component's installed size where it differs from its download. */
  installedMb: number;
  /** How many of the closure are not the thing that was asked for — the count R-41 states. */
  supporting: number;
}

/** Already here, by either spelling. Nothing settled is fetched again (R-44). */
export function componentIsSettled(state: SetupComponentState): boolean {
  return state === "ready" || state === "present";
}

/**
 * The components one activation must fetch, dependencies first.
 *
 * Declared data throughout — a closure is never inferred from an identifier's prefix or shape,
 * which is the same class of mistake as `ollama-gemma4-12b` naming its runtime. Anything already
 * settled is left out of both the list and the arithmetic: two models sharing a component do not
 * fetch it twice, and the second one's button does not quote a figure it will not spend.
 */
export function setupClosure(components: readonly SetupComponent[], componentId: string): SetupClosure {
  const byId = new Map(components.map((c) => [c.id, c]));
  const ordered: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const component = byId.get(id);
    if (!component) return;
    for (const dependency of component.requires ?? []) walk(dependency);
    // Settled components stay out of the closure entirely: they cost nothing and naming them
    // would put a supporting count on a button that has nothing to support.
    if (!componentIsSettled(component.state)) ordered.push(id);
  };
  walk(componentId);
  let downloadMb = 0;
  let installedMb = 0;
  for (const id of ordered) {
    const component = byId.get(id)!;
    downloadMb += component.sizeMb;
    installedMb += component.installedMb ?? component.sizeMb;
  }
  return {
    componentId,
    componentIds: ordered,
    downloadMb,
    installedMb,
    // What is in the closure besides the thing that was asked for. Counted by exclusion rather
    // than by subtracting one: a component that is already settled is not in `ordered` at all,
    // and `length - 1` would then quietly undercount every supporting component by one.
    supporting: ordered.filter((id) => id !== componentId).length,
  };
}

/**
 * A transfer in flight, as both surfaces state it (R-82).
 *
 * **Downloads owns progress**; a capability row renders this same projection rather than
 * computing its own. Two independently derived figures for one download is exactly the
 * duplication `statedElsewhere` existed to paper over, and R-6 removed that mechanism — so
 * there is nothing left to resolve a disagreement between them.
 */
export interface TransferProgress {
  /** 0..100, and 0 where the server never said how big the file is. */
  percent: number;
  doneMb: number;
  /** Measured, never guessed; null while nothing is moving. */
  mbPerSecond: number | null;
  /** Whether bytes are actually moving right now. */
  active: boolean;
}

const MB = 1024 * 1024;

export function transferProgress(component: SetupComponent): TransferProgress {
  return {
    percent: component.bytesTotal > 0 ? Math.min(100, Math.round((component.bytesDone / component.bytesTotal) * 100)) : 0,
    doneMb: Math.round(component.bytesDone / MB),
    mbPerSecond: component.bytesPerSecond === null ? null : Math.round((component.bytesPerSecond / MB) * 10) / 10,
    active: component.state === "downloading" || component.state === "installing",
  };
}

export const SetupStatusSchema = z
  .object({
    components: z.array(SetupComponentSchema),
    /** True while any component is downloading or installing. */
    running: z.boolean(),
    /** Free disk at the last check — the guard's evidence, shown rather than assumed. */
    diskFreeMb: z.number().int().min(0).nullable(),
    /**
     * When that check ran (SPEC-032 R-7, R-16): a figure measured at start-up must not read as
     * a statement about the drive right now. Defaulted null for payloads that predate it, and
     * strict ISO because it lands in finding facts whose schema refuses anything looser.
     */
    diskCheckedAt: IsoDateTimeSchema.nullable().default(null),
  })
  .strict();
export type SetupStatus = z.infer<typeof SetupStatusSchema>;
