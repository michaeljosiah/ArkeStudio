import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { emptyRecoveryHistory, RecoveryHistorySchema, RecoveryObservationSchema, observeRecoveryIncidents, pruneRecoveryHistory, recoveryFindingFacts, findingRef, primaryFindings,
  recoveryNoticeDecision, recordRecoveryNotice, FINDING_SEVERITY_RANK,
  STORAGE_POLICY, storageWarningFloor,
  type ClientState, type DiagnosticsSnapshot, type RecoveryHistory, type RecoveryHistorySnapshot, type RecoveryObservation, type RecoveryNotice, type RecoveryIncident } from "@arke-studio/contracts";
import type { RecoveryHistoryStore } from "./history-file.js";

/** One bounded writer, no append/log recursion, no process/repair authority. Observations keep
 * working in memory after disk failure. A transient notice is delivered only after its budget
 * marker was flushed; reconnects and repeated probes therefore cannot make a toast storm. */
export class RecoveryHistoryService {
  private history = emptyRecoveryHistory();
  private opening: Promise<void> | null = null;
  private audit: RecoveryHistorySnapshot["audit"] = "starting";
  private reason: RecoveryHistorySnapshot["reason"];
  private closing = false;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private work: Promise<void> | null = null;
  private pendingNotices = new Map<string, RecoveryNotice>();
  private inFlightNotices = new Map<string, { notice: RecoveryNotice; incident: RecoveryIncident }>();
  private readonly subscribers = new Set<(snapshot: RecoveryHistorySnapshot) => void>();
  private readonly noticeSubscribers = new Set<(notice: RecoveryNotice) => void>();
  private readonly capacityClears = new Map<string, { mapping: string; first: number }>();
  private readonly session = randomBytes(32).toString("hex");
  constructor(private readonly deps: { store: RecoveryHistoryStore; now?: () => number; id?: () => string; saveDelayMs?: number; stopTimeoutMs?: number; onNotice?: (notice: RecoveryNotice) => void }) {}
  private now(): number { return (this.deps.now ?? Date.now)(); }
  snapshot(): RecoveryHistorySnapshot {
    const now = this.now(), at = Number.isSafeInteger(now) && now >= 0 && now <= 8_640_000_000_000_000 ? now : this.history.lastObservedAt;
    const active = this.history.incidents.filter(value => value.phase !== "recovered").sort((a, b) => FINDING_SEVERITY_RANK[a.severity] - FINDING_SEVERITY_RANK[b.severity] || b.lastObservedAt - a.lastObservedAt);
    const resolved = this.history.incidents.filter(value => value.phase === "recovered").sort((a, b) => b.lastObservedAt - a.lastObservedAt);
    return { at, audit: this.audit, ...(this.reason ? { reason: this.reason } : {}), incidents: structuredClone([...active, ...resolved].slice(0, 100)),
      activeCount: active.length, resolvedCount: resolved.length, limited: active.length + resolved.length > 100,
      preferences: { ...this.history.preferences }, overflow: { ...this.history.overflow } };
  }
  /** Opt-in callers still own export/redaction and access checks. No native target mapping. */
  historyForExport(): RecoveryHistory { return structuredClone(this.history); }
  subscribe(listener: (snapshot: RecoveryHistorySnapshot) => void): () => void { if (this.closing) return () => {}; this.subscribers.add(listener); return () => this.subscribers.delete(listener); }
  subscribeNotices(listener: (notice: RecoveryNotice) => void): () => void { if (this.closing) return () => {}; this.noticeSubscribers.add(listener); return () => this.noticeSubscribers.delete(listener); }
  private changed(): void {
    if (this.closing) return; const state = this.snapshot();
    for (const listener of this.subscribers) { if (this.closing) break; try { listener(state); } catch { /* Presentation grants no authority. */ } }
  }
  private failed(error: unknown, fallback: "read-failed" | "write-failed"): void {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    this.reason = error instanceof SyntaxError || error instanceof z.ZodError ? "invalid" : code === "ENOSPC" || code === "EDQUOT" ? "disk-full" : code === "EACCES" || code === "EPERM" ? "permission" : fallback;
    this.audit = "unavailable"; this.pendingNotices.clear(); this.inFlightNotices.clear(); this.dirty = false; this.changed();
  }
  open(): Promise<void> {
    if (this.closing) return this.opening ?? Promise.resolve();
    return this.opening ??= (async () => {
      try {
        const raw = await this.deps.store.load(); if (this.stopped) return;
        const loaded = RecoveryHistorySchema.parse(raw); this.history = pruneRecoveryHistory(loaded, this.now());
        for (const incident of this.history.incidents) if (incident.phase !== "recovered") {
          incident.evidence = "unavailable";
          if (["recovering", "verifying"].includes(incident.phase)) incident.phase = "unresolved";
        }
        this.audit = "available";
        if (JSON.stringify(loaded) !== JSON.stringify(this.history)) {
          this.dirty = true;
          if (!this.closing) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.deps.saveDelayMs ?? 1000);
        }
      } catch (error) { this.failed(error, "read-failed"); }
      this.changed();
    })();
  }
  observe(observations: readonly RecoveryObservation[]): void {
    if (this.closing || this.audit === "starting") return;
    const now = this.now(); if (!Number.isSafeInteger(now) || now < this.history.lastObservedAt) return;
    const previous = this.history;
    let batch;
    try { batch = observations.slice(0, 1000).map(observation => ({ observation: RecoveryObservationSchema.parse(observation), id: (this.deps.id ?? (() => randomBytes(32).toString("hex")))() }))
      .filter(item => item.observation.observedAt <= now && item.observation.facts.every(fact => fact.measuredAt <= now) &&
        item.observation.observedAt >= (previous.incidents.find(incident => incident.key === item.observation.key && incident.phase !== "recovered")?.lastObservedAt ?? 0)); }
    catch (error) { this.failed(error, "write-failed"); return; }
    try { this.history = observeRecoveryIncidents(previous, batch, now); }
    catch (error) { this.failed(error, "write-failed"); return; }
    if (observations.length > 1000) {
      this.history.overflow.lostDetail = true;
      this.history.overflow.coalescedObservations = Math.min(Number.MAX_SAFE_INTEGER, this.history.overflow.coalescedObservations + observations.length - 1000);
    }
    if (JSON.stringify(this.history) === JSON.stringify(previous)) return;
    const before = new Map(previous.incidents.map(value => [value.id, value]));
    const observed = new Set(batch.filter(item => item.observation.observedAt <= now).map(item => item.observation.key));
    for (const incident of this.history.incidents) {
      if (!observed.has(incident.key)) continue;
      const reason = recoveryNoticeDecision(incident, before.get(incident.id), this.history, now, this.session);
      if (reason) { recordRecoveryNotice(incident, now); this.pendingNotices.set(incident.id, { incidentId: incident.id, reason, at: now }); }
      else if (incident.phase === "recovered") this.pendingNotices.delete(incident.id);
      else {
        const pending = this.inFlightNotices.get(incident.id);
        if (pending && pending.incident.severity === incident.severity && pending.incident.severityTransition === incident.severityTransition && pending.notice.at === incident.delivery.lastAt && incident.evidence === "fresh" &&
          ["action-available", "needs-user", "unresolved"].includes(incident.phase) &&
          (pending.incident.evidenceRevision !== incident.evidenceRevision || pending.incident.phase !== incident.phase)) {
          // This admission has not been delivered yet. Carry it to the next coalesced save
          // rather than spending its budget and silently dropping a same-severity update.
          this.pendingNotices.set(incident.id, pending.notice);
        }
      }
    }
    this.changed(); this.dirty = true;
    if (this.audit === "available" && !this.work && !this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.deps.saveDelayMs ?? 1000);
  }
  /** Missing findings never clear a fault: current owners must explicitly verify resolution. */
  observeDiagnostics(snapshot: DiagnosticsSnapshot): void {
    try {
    const observedAt = Date.parse(snapshot.derivedAt);
    const observations: RecoveryObservation[] = primaryFindings(snapshot).filter(finding => finding.severity !== "unmeasured").slice(0, 1000).map(finding => {
      const key = createHash("sha256").update(findingRef(finding)).digest("hex"), facts = recoveryFindingFacts(finding);
      const evidence = finding.stale ? "stale" as const : ["unknown", "unmeasured"].includes(finding.severity) ? "unavailable" as const : "fresh" as const;
      const phase = evidence !== "fresh" ? "observing" as const : finding.remedy ? "action-available" as const : "needs-user" as const;
      const evidenceRevision = createHash("sha256").update(JSON.stringify([finding.kind, finding.severity, phase, evidence, facts.map(fact => [fact.name, fact.value])])).digest("hex");
      return { key, kind: finding.kind, evidenceRevision, observedAt, severity: finding.severity, phase, evidence, facts };
    });
    const seen = new Set(observations.map(value => value.key));
    // An absent source/changed scope is not a successful repair. Keep the current summary
    // but explicitly withdraw its freshness instead of announcing that the fault cleared.
    const missing: RecoveryObservation[] = [];
    for (const incident of this.history.incidents) if (incident.phase !== "recovered" && !seen.has(incident.key) && incident.evidence !== "unavailable") {
      missing.push({ key: incident.key, kind: incident.kind, evidenceRevision: incident.evidenceRevision, observedAt,
        severity: incident.severity, phase: "unresolved", evidence: "unavailable", facts: incident.facts });
    }
    this.observe([...missing, ...observations]);
    } catch (error) { this.failed(error, "read-failed"); }
  }
  /** Domain-specific resolution evidence, independent of finding disappearance. A persisted
   * volume incident qualifies two fresh high readings even after the app was restarted. */
  observeAvailability(app: Pick<ClientState["app"], "storageHealth" | "comfyui">): void {
    if (this.closing || this.audit === "starting") return;
    const now = this.now(), observations: RecoveryObservation[] = [], hash = (value: string) => createHash("sha256").update(value).digest("hex");
    if (!Number.isSafeInteger(now) || now < this.history.lastObservedAt) { this.capacityClears.clear(); return; }
    const active = new Map(this.history.incidents.filter(value => value.phase !== "recovered").map(value => [value.key, value]));
    const resolved = (key: string, resolution: NonNullable<RecoveryObservation["resolution"]>, facts: RecoveryObservation["facts"], evidence: unknown) => {
      const prior = active.get(key); if (!prior) return;
      observations.push({ key, kind: prior.kind, evidenceRevision: hash(JSON.stringify([resolution, evidence])), observedAt: now,
        severity: prior.severity, phase: "recovered", evidence: "fresh", resolution, facts });
    };
    const comfy = app.comfyui, checkedAt = comfy ? Date.parse(comfy.checkedAt) : NaN;
    if (comfy?.engine.state === "ready" && checkedAt <= now && now - checkedAt <= 60000) {
      if (comfy.engine.instanceId) resolved(hash(`comfyui-engine-unavailable:${comfy.engine.instanceId}`), "verified-readiness", [], [comfy.engine.instanceId, checkedAt]);
      resolved(hash("comfyui-engine-unavailable:none"), "verified-readiness", [], [comfy.engine.instanceId, checkedAt]);
    }
    const health = app.storageHealth, groups = new Map<string, NonNullable<typeof health>["roots"]>();
    for (const root of health?.roots ?? []) if (root.capacity) {
      const roots = groups.get(root.capacity.volumeId) ?? []; roots.push(root); groups.set(root.capacity.volumeId, roots);
    }
    const present = new Set<string>();
    for (const [volume, roots] of groups) {
      const key = hash(`storage-pressure:${volume}`); present.add(key);
      if (!active.has(key)) { this.capacityClears.delete(key); continue; }
      const high = roots.every(root => root.state === "measured" && root.capacity!.availableBytes !== null && root.capacity!.measuredAt <= now &&
        now - root.capacity!.measuredAt <= STORAGE_POLICY.forecastMaxAgeMs && root.capacity!.availableBytes! > storageWarningFloor(root.capacity!.totalBytes) + STORAGE_POLICY.clearMarginBytes && !root.forecast?.warning);
      if (!high) { this.capacityClears.delete(key); continue; }
      const mapping = hash(JSON.stringify(roots.map(root => [root.rootId, root.capacity!.mappingRevision]).sort())), measuredAt = Math.min(...roots.map(root => root.capacity!.measuredAt));
      const prior = this.capacityClears.get(key);
      if (!prior || prior.mapping !== mapping || prior.first > measuredAt || prior.first > now) { this.capacityClears.set(key, { mapping, first: measuredAt }); continue; }
      if (measuredAt - prior.first < STORAGE_POLICY.clearSampleGapMs || roots.some(root => root.pressure?.warning || root.pressure?.critical)) continue;
      const available = Math.min(...roots.map(root => root.capacity!.availableBytes!));
      resolved(key, "verified-capacity", [{ name: "available-bytes", value: available, measuredAt }], [mapping, measuredAt, available]); this.capacityClears.delete(key);
    }
    for (const key of this.capacityClears.keys()) if (!present.has(key)) this.capacityClears.delete(key);
    if (observations.length) this.observe(observations);
  }
  /** Presentation-only preferences. Host routing must still enforce who may change them. */
  private async present(change: (history: RecoveryHistory, now: number) => boolean): Promise<boolean> {
    await this.open(); if (this.closing || this.audit !== "available") return false;
    const now = this.now(); if (!Number.isSafeInteger(now) || now < this.history.lastObservedAt) return false;
    const next = structuredClone(this.history); if (!change(next, now)) return false;
    this.history = next; this.dirty = true; this.changed(); await this.flush(); return this.audit === "available";
  }
  setPreferences(patch: Partial<RecoveryHistory["preferences"]>): Promise<boolean> {
    const parsed = z.object({ transientMuted: z.boolean().optional(), desktopOptIn: z.boolean().optional() }).strict().parse(patch);
    return this.present(history => { history.preferences = { ...history.preferences, ...parsed }; return true; });
  }
  acknowledge(id: string): Promise<boolean> {
    return this.present((history, now) => { const incident = history.incidents.find(value => value.id === id); if (!incident) return false; incident.acknowledgedAt = now; return true; });
  }
  snooze(id: string, duration: "one-hour" | "session"): Promise<boolean> {
    if (duration !== "one-hour" && duration !== "session") return Promise.resolve(false);
    return this.present((history, now) => {
      const incident = history.incidents.find(value => value.id === id);
      if (!incident || incident.severity !== "advisory" || incident.phase === "recovered") return false;
      if (duration === "one-hour" && now > 8_640_000_000_000_000 - 3600_000) return false;
      incident.delivery.snoozedUntil = duration === "one-hour" ? now + 3600_000 : null;
      incident.delivery.snoozedSession = duration === "session" ? this.session : null; return true;
    });
  }
  clearResolved(): Promise<boolean> {
    return this.present(history => { history.incidents = history.incidents.filter(value => value.phase !== "recovered"); return true; });
  }
  async flush(): Promise<void> {
    if (this.stopped) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.work) { await this.work; if (this.dirty && this.audit === "available") await this.flush(); return; }
    if (!this.dirty || this.audit !== "available") return;
    this.work = (async () => {
      while (this.dirty && this.audit === "available" && !this.stopped) {
        this.dirty = false; const value = structuredClone(this.history), notices = this.pendingNotices; this.pendingNotices = new Map();
        this.inFlightNotices = new Map([...notices].flatMap(([id, notice]) => {
          const incident = value.incidents.find(value => value.id === id); return incident ? [[id, { notice, incident }] as const] : [];
        }));
        try { await this.deps.store.save(value); }
        catch (error) { this.failed(error, "write-failed"); return; }
        if (!this.closing) for (const notice of notices.values()) {
          if (this.closing) break;
          const captured = value.incidents.find(incident => incident.id === notice.incidentId), current = this.history.incidents.find(incident => incident.id === notice.incidentId);
          if (!captured || !current || this.history.preferences.transientMuted || current.evidence !== "fresh" || current.phase !== captured.phase ||
            current.severity !== captured.severity || current.severityTransition !== captured.severityTransition || current.evidenceRevision !== captured.evidenceRevision || current.delivery.lastAt !== notice.at) continue;
          if (current.severity !== "blocking" && (current.delivery.snoozedSession === this.session || current.delivery.snoozedUntil !== null && this.now() < current.delivery.snoozedUntil)) continue;
          this.inFlightNotices.delete(notice.incidentId);
          if (this.pendingNotices.get(notice.incidentId)?.at === notice.at && this.pendingNotices.get(notice.incidentId)?.reason === notice.reason) this.pendingNotices.delete(notice.incidentId);
          try { this.deps.onNotice?.(notice); } catch { /* A delivery failure never refunds its persisted budget. */ }
          for (const listener of this.noticeSubscribers) { if (this.closing) break; try { listener(notice); } catch { /* Delivery cannot grant authority. */ } }
        }
        this.inFlightNotices.clear();
      }
    })().finally(() => { this.work = null; });
    await this.work;
  }
  closeAdmission(): void { this.closing = true; this.capacityClears.clear(); if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
  async stop(): Promise<void> {
    this.closeAdmission();
    return this.stopping ??= (async () => {
      // SPEC-061 R-28: nonessential diagnostic I/O cannot hold native shutdown indefinitely.
      // An already-issued atomic replacement may finish, but no further batch or publication
      // is admitted. Its outcome stays explicitly unknown; this file grants no repair authority.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const drained = (async () => { await this.opening; await this.flush(); return true; })();
      const complete = await Promise.race([drained, new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), Math.max(1, Math.min(2000, this.deps.stopTimeoutMs ?? 2000))); })]);
      if (timer) clearTimeout(timer);
      if (!complete) { this.audit = "unavailable"; this.reason = this.work ? "write-failed" : "read-failed"; }
      this.stopped = true; this.dirty = false; this.pendingNotices.clear(); this.inFlightNotices.clear(); this.subscribers.clear(); this.noticeSubscribers.clear();
    })();
  }
}
