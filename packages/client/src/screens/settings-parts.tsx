import type { ReactNode } from "react";
import { CLONED_VOICE_MODEL, type Capability, type ComponentHealth } from "@arke-studio/contracts";
import { StatusDot, cx, type StatusDotTone } from "../components/ui.js";

/**
 * The pieces the runtime-facing settings screens are drawn from. They were private to shell.tsx
 * while Local runtime was one screen; Local AI and Engines both draw rows the same way, and two
 * copies of a status dot is how two screens start looking like two products.
 */

/**
 * One capability row: the label a creator reads, and what it draws.
 *
 * `claims` names models the row takes out of another row's capability. It exists for exactly one
 * model and is a *display* claim, never a capability claim — SPEC-022's cloned voice dispatches
 * as `voice-tts` on purpose, so that no capability probe implies an engine can perform a clone,
 * and that reasoning is about probes rather than about which heading a person looks under.
 */
export interface CapabilityRow {
  label: string;
  capabilities: readonly Capability[];
  claims?: readonly string[];
  /**
   * No local plane at all — nothing in the local half of the manifest can serve this, and nothing
   * is being fetched that would. The word is still needed, because Cloud AI routes the capability
   * and has to name it; the row is not drawn on Local AI.
   */
  cloudOnly?: boolean;
}

/**
 * The capability vocabulary, in the order Local AI states it (SPEC-033 R-47, R-62, R-89). One
 * table, read by both screens, because a capability named differently on Local AI and Cloud AI
 * is a defect and two hand-kept lists are how that defect arrives.
 *
 * `Voice` was one row over `voice-tts` and `voice-stt` together. It hid three separate questions
 * — what reads text aloud, what transcribes speech, what a cloned voice needs — under a noun
 * that answered none of them, and it put the cloned-voice recipe under a heading about voices in
 * general. The three are named for what they do.
 */
export const CAPABILITY_ROWS: readonly CapabilityRow[] = [
  { label: "Images", capabilities: ["image"] },
  { label: "Video", capabilities: ["video"] },
  { label: "Speech-to-Text", capabilities: ["voice-stt"] },
  { label: "Text-to-Speech", capabilities: ["voice-tts"] },
  { label: "Voice clone", capabilities: ["voice-clone"], claims: [CLONED_VOICE_MODEL] },
  // No local engine makes music, and none is coming — so Local AI does not draw it and Cloud AI,
  // which routes it, still has its word. The guard against forgetting this row when that changes
  // is the R-47 test: a capability a local provider declares must land in exactly one drawn row,
  // so a local music provider turns that assertion red rather than rendering nowhere.
  { label: "Music", capabilities: ["music"], cloudOnly: true },
  { label: "Language", capabilities: ["llm"] },
];

/**
 * A capability's creator-facing word, derived from the rows rather than restated beside them.
 * Total over `Capability` because every capability sits in exactly one row — the invariant a
 * test asserts, and the reason this map needs no fallback.
 *
 * `Clips`, `Frames & stills`, `Score & songs` and `Direct LLM work` are retired. They were our
 * words rather than a creator's, and a capability named differently on the two screens is what
 * stops the local/cloud split reading as two halves of one question. Cloud AI kept a map of its
 * own until Local AI's rows were renamed and only one of the two moved.
 */
export const CAPABILITY_LABEL: Record<Capability, string> = Object.fromEntries(
  CAPABILITY_ROWS.flatMap((row) => row.capabilities.map((capability) => [capability, row.label])),
) as Record<Capability, string>;

/** The row a model is drawn under: its capability's, unless another row claims it by id. */
export function rowForModel(model: { id: string; capability: Capability }): CapabilityRow {
  return (
    CAPABILITY_ROWS.find((row) => row.claims?.includes(model.id) === true) ??
    CAPABILITY_ROWS.find((row) => row.capabilities.includes(model.capability))!
  );
}

/** The three tones a runtime state comes in. Anything unmeasured is idle, never a fault (D12). */
export type RuntimeTone = "ok" | "warn" | "idle";

export const TONE_CLASS: Record<RuntimeTone, string> = {
  ok: "fy-set__dot--ok",
  warn: "fy-set__dot--warn",
  idle: "",
};

/** A dot leading the word it qualifies — the pairing every runtime row states its state with. */
export function RuntimeStatus({ tone, children }: { tone: RuntimeTone; children: ReactNode }) {
  return (
    <span className="fy-set__status">
      <span className={cx("fy-set__dot", TONE_CLASS[tone])} />
      <span className="fy-set__state">{children}</span>
    </span>
  );
}

/**
 * The head every runtime detail opens with: what this is, what it does, and where it stands.
 * The same three-part head 40a gives a provider, because the rail is the heading either way.
 */
export function RuntimeHead({
  title,
  caps,
  tone,
  state,
}: {
  title: string;
  caps: string;
  tone: RuntimeTone;
  state: string;
}) {
  return (
    <div className="fy-rt__head">
      <span className="fy-rt__title">{title}</span>
      <span className="fy-rt__caps">{caps}</span>
      <span style={{ flex: 1 }} />
      <RuntimeStatus tone={tone}>{state}</RuntimeStatus>
    </div>
  );
}

/** A labelled band inside a detail, with whatever acts on the band as a whole on its right. */
export function RuntimeSection({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <div className="fy-rt__sechead">
      <div className="fy-rt__eyebrow">{label}</div>
      <span style={{ flex: 1 }} />
      {children}
    </div>
  );
}

/** A download size as the catalogue states it. One spelling: the same figure on every row. */
export function sizeMb(mbytes: number): string {
  return mbytes >= 1024 ? `${(mbytes / 1024).toFixed(1)} GB` : `${mbytes} MB`;
}

/**
 * A supervised component's health, as a dot with the reason in its label. Here rather than in
 * shell.tsx because every runtime pane ends with one.
 */
const HEALTH_TONE: Record<ComponentHealth["status"], StatusDotTone> = {
  healthy: "ok",
  starting: "busy",
  unhealthy: "danger",
  unavailable: "muted",
};

export function HealthDot({ label, health }: { label: string; health: ComponentHealth | undefined }) {
  const status = health?.status ?? "starting";
  return (
    <StatusDot
      tone={HEALTH_TONE[status]}
      label={`${label} — ${status}${health?.reason ? ` (${health.reason})` : ""}`}
    />
  );
}
