import { EffectVersionRefSchema, effectProposalApplicableReason, type EffectProposalFamilyView, type EffectProposalVersion,
  type EffectReviewGrant, type EffectReviewOperation, type EffectReviewResult, type EffectVersionRef } from "@arke-studio/contracts";

export type EffectReviewComparison = "current" | "suggested";
export interface EffectReviewPosition { selectedEffectId?: string; playheadFrame?: number; scrollLeft?: number }
export interface EffectReviewSelection {
  ref: EffectVersionRef;
  grant: EffectReviewGrant;
  comparison: EffectReviewComparison;
  position: EffectReviewPosition | null;
}
export interface ActiveEffectReview extends EffectReviewSelection {
  family: EffectProposalFamilyView;
  version: EffectProposalVersion;
  authoringEpoch: number;
  /** Navigation observes only explicit Review, never incoming versions or continued gestures. */
  activationSerial: number;
}
export interface EffectReviewError { requestId: string; ref: EffectVersionRef; reason: string }
export interface EffectReviewRequest { requestId: string; operation: EffectReviewOperation; generation: number; originPath?: string }
export interface EffectReviewState {
  active: ActiveEffectReview | null;
  pending: EffectReviewRequest | null;
  error: EffectReviewError | null;
  inspect: { serial: number; ref: EffectVersionRef; effectId: string } | null;
  cardFocus: { serial: number; ref: EffectVersionRef } | null;
  statusReason: string | null;
  canUndo: boolean;
  canRedo: boolean;
}
interface WaitingReview { selection: EffectReviewSelection; generation: number; explicit: boolean; originPath?: string }
export interface EffectReviewSavedState {
  schemaVersion: 1;
  ref: EffectVersionRef;
  reviewId: string;
  comparison: EffectReviewComparison;
  position: EffectReviewPosition | null;
}

export function sameEffectVersion(left: EffectVersionRef, right: EffectVersionRef): boolean {
  return left.familyId === right.familyId && left.versionId === right.versionId && left.candidateHash === right.candidateHash;
}
function sameGrant(left: EffectReviewGrant, right: EffectReviewGrant): boolean {
  return left.id === right.id && left.familyId === right.familyId && left.versionId === right.versionId &&
    left.branchId === right.branchId && left.candidateHash === right.candidateHash && left.decisionRevision === right.decisionRevision;
}
function positionValue(value: unknown): EffectReviewPosition | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>, result: EffectReviewPosition = {};
  if (typeof row.selectedEffectId === "string" && row.selectedEffectId.length <= 128) result.selectedEffectId = row.selectedEffectId;
  if (Number.isSafeInteger(row.playheadFrame) && (row.playheadFrame as number) >= 0) result.playheadFrame = row.playheadFrame as number;
  if (typeof row.scrollLeft === "number" && Number.isFinite(row.scrollLeft) && row.scrollLeft >= 0) result.scrollLeft = row.scrollLeft;
  return result;
}
/** Local UI storage conveys no authority. A retained server grant must match before restoration. */
export function parseEffectReviewSavedState(raw: string | null): EffectReviewSavedState | null {
  if (!raw || raw.length > 8192) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>, ref = EffectVersionRefSchema.safeParse(value.ref);
    if (value.schemaVersion !== 1 || !ref.success || typeof value.reviewId !== "string" || value.reviewId.length > 128 ||
      (value.comparison !== "current" && value.comparison !== "suggested")) return null;
    return { schemaVersion: 1, ref: ref.data, reviewId: value.reviewId, comparison: value.comparison, position: positionValue(value.position) };
  } catch { return null; }
}

/** A window's explicit review intent, separate from authoritative family/version snapshots. */
export class EffectReviewSession {
  private state: EffectReviewState = { active: null, pending: null, error: null, inspect: null, cardFocus: null,
    statusReason: null, canUndo: false, canRedo: false };
  private listeners = new Set<() => void>();
  private families: readonly EffectProposalFamilyView[] = [];
  private currentRevision: number | null = null;
  private generation = 0;
  private authoringEpoch = 0;
  private activationSerial = 0;
  private signalSerial = 0;
  private waiting: WaitingReview | null = null;
  private restore: EffectReviewSavedState | null;
  constructor(private readonly persist: (value: EffectReviewSavedState | null) => void = () => {}, restored: EffectReviewSavedState | null = null,
    private readonly activated: (active: ActiveEffectReview, originPath?: string) => void = () => {}) { this.restore = restored; }
  getSnapshot = (): EffectReviewState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  canRelease(): boolean { return this.listeners.size === 0 && this.state.pending === null; }
  private publish(next: EffectReviewState): void {
    this.state = next;
    for (const listener of this.listeners) listener();
  }
  private save(): void {
    const row = this.state.active;
    this.persist(row ? { schemaVersion: 1, ref: row.ref, reviewId: row.grant.id, comparison: row.comparison, position: row.position } : null);
  }
  private selected(selection: EffectReviewSelection): ActiveEffectReview | null {
    const family = this.families.find(row => row.id === selection.ref.familyId);
    const version = family?.versions.find(row => row.id === selection.ref.versionId && row.candidateHash === selection.ref.candidateHash);
    const grant = family?.reviewGrants.find(row => sameGrant(row, selection.grant));
    if (!family || !version || !grant || grant.branchId !== version.branchId) return null;
    // Older cards are inspectable even when their decision revision cannot be applied.
    if (grant.decisionRevision !== version.decisionRevision) return null;
    return { ...selection, family, version, grant, authoringEpoch: this.authoringEpoch, activationSerial: this.activationSerial };
  }
  private assessed(state: EffectReviewState): EffectReviewState {
    const row = state.active;
    if (!row) return { ...state, statusReason: null, canUndo: false, canRedo: false };
    const { family, version, grant } = row;
    const compatible = family.status === "pending" && version.decisionRevision === family.decisionRevision && grant.decisionRevision === family.decisionRevision;
    const branch = family.branches.find(value => value.id === version.branchId && value.headVersionId === version.id);
    const reason = family.status !== "pending" ? `This arrangement is ${family.status}.`
      : !compatible ? "Human decisions changed. Review a compatible version before applying."
      : this.currentRevision !== null && version.dependencies.base.revision !== this.currentRevision ? "Current changed. Update the proposal and review the new version."
      : effectProposalApplicableReason(version);
    return { ...state, statusReason: reason, canUndo: compatible && !!branch?.undoVersionIds.length,
      canRedo: compatible && !!branch?.redoVersionIds.length };
  }
  observe(families: readonly EffectProposalFamilyView[], currentRevision: number | null): void {
    if (this.families === families && this.currentRevision === currentRevision) return;
    const active = this.state.active;
    if (active && (currentRevision !== this.currentRevision || families.find(row => row.id === active.family.id)?.decisionRevision !== active.family.decisionRevision)) this.authoringEpoch++;
    this.families = families; this.currentRevision = currentRevision;
    if (this.restore) {
      const saved = this.restore, family = families.find(row => row.id === saved.ref.familyId);
      const grant = family?.reviewGrants.find(row => row.id === saved.reviewId && sameEffectVersion(row, saved.ref));
      if (grant) this.waiting = { selection: { ref: saved.ref, grant, comparison: saved.comparison, position: saved.position }, generation: this.generation, explicit: false };
      this.restore = null;
    }
    this.reconcile();
  }
  private reconcile(): void {
    let next = this.state;
    if (next.active) {
      const active = this.selected(next.active);
      if (active) next = { ...next, active };
      else next = { ...next, active: null, error: { requestId: "retained-review", ref: next.active.ref, reason: "The exact reviewed version is no longer available." } };
    }
    const waiting = this.waiting;
    let activate: ActiveEffectReview | null = null;
    if (waiting && waiting.generation === this.generation) {
      const selected = this.selected(waiting.selection);
      if (selected) {
        this.authoringEpoch++;
        if (waiting.explicit) this.activationSerial++;
        const active = { ...selected, authoringEpoch: this.authoringEpoch, activationSerial: this.activationSerial };
        next = { ...next, active, pending: null, error: null, inspect: null };
        this.waiting = null;
        if (waiting.explicit) activate = active;
      }
    }
    this.publish(this.assessed(next)); this.save();
    if (activate) this.activated(activate, waiting?.originPath);
  }
  begin(requestId: string, operation: EffectReviewOperation, originPath?: string): boolean {
    if (this.state.pending) return false;
    this.publish({ ...this.state, pending: { requestId, operation, generation: this.generation, ...(originPath ? { originPath } : {}) }, error: null });
    return true;
  }
  refused(requestId: string, reason: string): void {
    const pending = this.state.pending;
    if (!pending || pending.requestId !== requestId) return;
    this.waiting = null;
    this.publish({ ...this.state, pending: null, error: { requestId, ref: pending.operation.ref, reason } });
  }
  receive(result: EffectReviewResult): void {
    const pending = this.state.pending;
    if (!pending || pending.requestId !== result.requestId) return;
    if (result.outcome === "refused") { this.refused(result.requestId, result.reason ?? "The proposal operation was refused."); return; }
    const operation = pending.operation, active = this.state.active;
    if ((result.outcome === "applied" || result.outcome === "discarded") && active && sameEffectVersion(active.ref, operation.ref)) {
      this.close(); return;
    }
    const explicit = operation.kind === "review" && result.outcome === "reviewed";
    const continuation = (operation.kind === "history" || (operation.kind === "edit" && operation.intent.kind !== "release")) &&
      result.outcome === "updated" && active && sameEffectVersion(active.ref, operation.ref) && operation.reviewId === active.grant.id;
    if ((explicit || continuation) && result.ref && result.grant && pending.generation === this.generation &&
      result.ref.familyId === operation.ref.familyId && sameEffectVersion(result.ref, result.grant) &&
      (!explicit || sameEffectVersion(result.ref, operation.ref))) {
      this.waiting = { selection: { ref: result.ref, grant: result.grant, comparison: explicit ? "suggested" : active!.comparison,
        position: active?.position ?? null }, generation: pending.generation, explicit, ...(pending.originPath ? { originPath: pending.originPath } : {}) };
      this.reconcile();
    } else this.publish({ ...this.state, pending: null });
  }
  compare(comparison: EffectReviewComparison): void {
    if (!this.state.active || this.state.active.comparison === comparison) return;
    this.authoringEpoch++;
    this.publish({ ...this.state, active: { ...this.state.active, comparison, authoringEpoch: this.authoringEpoch } }); this.save();
  }
  close(): void {
    this.generation++; this.waiting = null; this.restore = null; this.authoringEpoch++;
    this.publish({ ...this.state, active: null, pending: null, error: null, inspect: null, cardFocus: null, statusReason: null, canUndo: false, canRedo: false }); this.save();
  }
  inspect(ref: EffectVersionRef, effectId: string): boolean {
    const active = this.state.active;
    if (!active || !sameEffectVersion(active.ref, ref) || !active.version.state.tracks.some(track => track.effects.some(effect => effect.id === effectId))) return false;
    this.publish({ ...this.state, inspect: { serial: ++this.signalSerial, ref: active.ref, effectId } }); return true;
  }
  backToProposal(): void {
    if (this.state.active) this.publish({ ...this.state, cardFocus: { serial: ++this.signalSerial, ref: this.state.active.ref } });
  }
  rememberPosition(position: EffectReviewPosition): void {
    const active = this.state.active; if (!active) return;
    const next = positionValue(position);
    if (JSON.stringify(next) === JSON.stringify(active.position)) return;
    this.publish({ ...this.state, active: { ...active, position: next } }); this.save();
  }
}
