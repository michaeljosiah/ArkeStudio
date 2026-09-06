import type { ReactNode } from "react";
import {
  CLONED_VOICE_MODEL,
  ENGINE_PROVIDERS,
  PROVIDERS,
  type Capability,
  type ComponentHealth,
  type EngineId,
} from "@arke-studio/contracts";
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

/**
 * What an engine is used for, in the capability words every surface shares (SPEC-033 R-62, R-89).
 *
 * Derived from the providers it hosts rather than written beside them: a hand-kept string is how
 * one engine comes to be described in words no other screen uses, which is the drift R-62 exists
 * to prevent. The engine table in contracts kept its own spelling — `voice`, `images, video,
 * voice` — and none of those three is a word this vocabulary has, so it is gone rather than
 * left for the next caller to find.
 */
export function engineCapabilityWords(engine: EngineId): string {
  const capabilities = [...new Set(ENGINE_PROVIDERS[engine].flatMap((p) => PROVIDERS[p].capabilities))];
  // In the rows' order, so two engines sharing a capability name it in the same place.
  const ordered = CAPABILITY_ROWS.flatMap((row) => row.capabilities).filter((c) => capabilities.includes(c));
  return [...new Set(ordered.map((c) => CAPABILITY_LABEL[c]))].join(", ");
}

/** The three tones a runtime state comes in. Anything unmeasured is idle, never a fault (D12). */
export type RuntimeTone = "ok" | "warn" | "idle";

export const TONE_CLASS: Record<RuntimeTone, string> = {
  ok: "fy-set__dot--ok",
  warn: "fy-set__dot--warn",
  idle: "",
};

/** A dot leading the word it qualifies — the pairing every runtime row states its state with. */
export function RuntimeStatus({ tone, children }: { tone?: RuntimeTone; children: ReactNode }) {
  return (
    <span className="fy-set__status">
      {/* No tone, no dot (SPEC-034 R-22). A caller that has nothing for the dot to say leaves it
          out rather than drawing a neutral one, so the coloured one stays findable in a list. */}
      {tone !== undefined && <span className={cx("fy-set__dot", TONE_CLASS[tone])} />}
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
  mark,
}: {
  title: string;
  caps: string;
  tone: RuntimeTone;
  state: string;
  /** The engine's mark, where the head is an engine's (SPEC-042 R-20). */
  mark?: string;
}) {
  return (
    <div className="fy-rt__head">
      {mark !== undefined && <ProviderMark id={mark} label={title} size="lg" />}
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

/**
 * The kind a model is drawn under (SPEC-042 R-8, R-12): the row that claims it by id, else the
 * row that owns its capability. The claim comes first because it exists for exactly one model —
 * the cloned voice dispatches as `voice-tts` and is drawn under Voice clone — and asking the
 * capability first would file it under the heading it was moved away from.
 */
export function kindOf(model: { id: string; capability: Capability }): CapabilityRow {
  return (
    CAPABILITY_ROWS.find((row) => row.claims?.includes(model.id)) ??
    CAPABILITY_ROWS.find((row) => row.capabilities.includes(model.capability))!
  );
}

/** A kind's address in the URL (SPEC-042 R-11): its first capability, which is unique per row. */
export function kindId(row: CapabilityRow): Capability {
  return row.capabilities[0]!;
}

/**
 * The marks under public/marks, by provider or engine (SPEC-042 R-20). Bundled with the client
 * and never fetched from the provider at runtime. Voxa is our own engine, so it carries Arke's.
 */
const MARK_SRC: Partial<Record<string, string>> = {
  fal: "./marks/fal.ico",
  anthropic: "./marks/anthropic.ico",
  elevenlabs: "./marks/elevenlabs.ico",
  higgsfield: "./marks/higgsfield.ico",
  comfyui: "./marks/comfyui.ico",
  ollama: "./marks/ollama.png",
  voxa: "./marks/arke.ico",
};

/**
 * A provider's or engine's mark, on one light plate whatever the theme: half of these are a
 * black glyph on nothing and would disappear against a dark pane. A source with no bundled mark
 * keeps a monogram in the same slot, so nothing in the layout depends on having one.
 */
export function ProviderMark({ id, label, size = "sm" }: { id: string; label: string; size?: "sm" | "lg" }) {
  const src = MARK_SRC[id];
  return (
    <span className={cx("fy-mark", size === "lg" && "fy-mark--lg", src === undefined && "fy-mark--letter")} aria-hidden="true">
      {src !== undefined ? <img src={src} alt="" /> : label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/**
 * An action that says its verb, with the icon that makes it findable (SPEC-042 R-18). Not
 * icon-only: that made every row tidy and every action a guess, and `Test again` is not a glyph
 * anyone knows. The visible label is the accessible name, so nothing carries it a second time.
 */
export function ActionButton({
  icon,
  children,
  danger,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  /** Destructive: quiet at rest, the signal colour only under the pointer. */
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={cx("fy-act", danger && "fy-act--danger")} disabled={disabled} onClick={onClick}>
      {icon}
      <span>{children}</span>
    </button>
  );
}

/**
 * A half of the second column, drawn as a level above the rows under it (SPEC-042 R-10): a rule
 * above, an icon beside the words, the foreground's weight where the rows stay muted. Never a
 * larger size and never capitals — the first fights the pane title, the second is the eyebrow
 * turn 69 spent a sweep removing.
 */
export function HalfHeading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="fy-half">
      {icon}
      <span>{children}</span>
    </div>
  );
}
