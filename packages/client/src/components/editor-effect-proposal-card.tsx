import { useId, useState, type ReactNode } from "react";
import { activeEffectStickyChanges, type EffectClip, type EffectFinalDelta, type EffectHumanIntent, type EffectProposalFamilyView, type EffectProposalVersion,
  type EffectProtectionRule, type EffectStickyScope, type EffectVersionRef, type ProductionTimeline } from "@arke-studio/contracts";
import { effectAudioInputLabel, effectAudioLabel, effectCardDecisions, effectCardRef, effectCardStatus, effectCardTargetLabel, effectFrameLabel, effectName,
  effectPropertyDifferences, effectRangeLabel, effectRuleLabel, effectStickyLabel, sameEffectProposalVersion } from "../lib/editor-effect-proposal-presentation.js";
import { effectProtectionValue } from "../screens/editor-effect-protection.js";

export interface EffectProposalCardProps {
  family: EffectProposalFamilyView; version: EffectProposalVersion; timeline: ProductionTimeline | null; frameRate: number;
  activeReview: { ref: EffectVersionRef; comparison: "current" | "suggested" } | null;
  busy: boolean; readOnly: boolean; statusReason?: string; currentStale?: boolean; dependencyStatus?: "checking" | "stale";
  expanded: boolean; onExpandedChange: (expanded: boolean) => void;
  onReview: (ref: EffectVersionRef) => void; onIntent: (ref: EffectVersionRef, intent: EffectHumanIntent) => void;
  onInspect: (ref: EffectVersionRef, effectId: string) => void; onUpdate: (ref: EffectVersionRef) => void;
  onRetry: (ref: EffectVersionRef) => void; onDiscard: (ref: EffectVersionRef) => void;
}

/** A version in the conversation. Only Review asks the editor to enter Suggested. */
export function EffectProposalCard(props: EffectProposalCardProps) {
  const { family, version, timeline, frameRate, activeReview, busy, readOnly, expanded, onExpandedChange } = props;
  const id = useId(), ref = effectCardRef(family, version), active = sameEffectProposalVersion(activeReview?.ref, ref);
  const decisions = effectCardDecisions(family, version), pending = family.status === "pending";
  const retained = activeEffectStickyChanges(decisions);
  const decisionChanged = version.decisionRevision !== family.decisionRevision;
  const disabled = busy || readOnly || !pending || decisionChanged || props.currentStale === true || !!props.dependencyStatus || !timeline;
  const status = !timeline && pending ? "Current unavailable · inspection only" : props.currentStale && pending ? "Current changed · Update proposal"
    : pending && props.dependencyStatus === "checking" ? "Checking sources and render settings"
    : pending && props.dependencyStatus === "stale" ? "Sources or render settings changed · Update proposal" : effectCardStatus(family, version, active);
  const sourceMissing = version.dependencies.reactions.some(row => row.status !== "off" && row.status !== "ready") || version.dependencies.issues.length > 0;
  const effects = version.state.tracks.flatMap(track => track.effects);
  const changes = version.delta.filter((change): change is Extract<EffectFinalDelta, { kind: "effect-result" }> => change.kind === "effect-result");
  const tracks = version.delta.filter((change): change is Extract<EffectFinalDelta, { kind: "effect-track-result" }> => change.kind === "effect-track-result");
  const releases = version.delta.filter((change): change is Extract<EffectFinalDelta, { kind: "release-result" }> => change.kind === "release-result");
  const intent = (value: EffectHumanIntent) => props.onIntent(ref, value);
  const audio = family.scope.audio.kind === "off" ? "Off" : effectAudioInputLabel(family.scope.audio.input, timeline);
  return <section className="fy-effect-proposal" aria-label={`Effect arrangement version ${version.number}`} data-effect-version={version.id} data-reviewing={active || undefined}>
    <div className="fy-effect-proposal__heading"><span className="fy-effect-proposal__version">Version {version.number}</span><strong>{status}</strong></div>
    <p className="fy-effect-proposal__summary">{version.summary}</p>
    <dl className="fy-effect-proposal__bindings">
      <div><dt>Visual target</dt><dd>{effectCardTargetLabel(family.scope.target, timeline)}</dd></div>
      <div><dt>Requested range</dt><dd>{effectRangeLabel(family.scope.range.startFrame, family.scope.range.endFrame, frameRate)}</dd></div>
      <div><dt>Audio reaction</dt><dd>{audio}</dd></div>
    </dl>
    {active && <p className="fy-effect-proposal__note">{activeReview?.comparison === "current" ? "Comparing Current. This reviewed version stays retained." : "Suggested is active in the timeline."}</p>}
    {props.statusReason && <p role="status" className="fy-effect-proposal__notice">{props.statusReason}</p>}
    {readOnly && <p className="fy-effect-proposal__notice">Inspection only. Editing is unavailable on this connection.</p>}
    {version.conflicts.map(conflict => <div className="fy-effect-proposal__notice" key={conflict.id}>
      <strong>{conflict.kind === "protection" ? "Protected setting" : "Needs your decision"}</strong><p>{conflict.reason}</p>
      {conflict.remedies.length > 0 && <p>{conflict.remedies.join(" · ")}</p>}
    </div>)}
    {version.dependencies.issues.map((issue, index) => <p className="fy-effect-proposal__notice" key={`${issue.kind}:${index}`}>{issue.reason}</p>)}
    <div className="fy-effect-proposal__actions">
      {pending && <button type="button" className="fy-effect-proposal__primary" disabled={busy || readOnly} onClick={() => props.onReview(ref)}>
        {active ? `Review version ${version.number} again` : version.number === 1 ? "Review in timeline" : `Review version ${version.number}`}
      </button>}
      <button type="button" aria-expanded={expanded} aria-controls={id} onClick={() => onExpandedChange(!expanded)}>{version.delta.length} {version.delta.length === 1 ? "change" : "changes"} · {expanded ? "Hide details" : "Show details"}</button>
    </div>
    <div id={id} hidden={!expanded} className="fy-effect-proposal__details">
      {expanded && <>
      {version.delta.length === 0 && <p>No authored changes to apply. Review any requested decisions below.</p>}
      <PagedRows label="Effect changes" rows={changes.map(change => {
        const effect = change.after ?? change.before!;
        return <EffectChange key={effect.id} change={change} {...props} disabled={disabled}
          canInspect={active && !!change.after && activeReview?.comparison === "suggested"} />;
      })} size={6} />
      {tracks.map(change => <div className="fy-effect-proposal__change" key={`track:${change.trackId}`}><h4>{change.after ? change.before ? "Change effect track" : "Add effect track" : "Remove effect track"}</h4>
        <p>{change.before?.name ?? "Not present"} → {change.after?.name ?? "Not present"}</p>
        {change.before && change.after && <p>{change.before.muted ? "Hidden" : "Visible"} → {change.after.muted ? "Hidden" : "Visible"} · stacking {change.before.order} → {change.after.order}</p>}
      </div>)}
      {version.state.protection.length > 0 && <section aria-label="Preserved protection"><h4>Protected</h4>
        <p className="fy-effect-proposal__note">Existing rules stay in place. New rules are marked Protect on Apply. You can still edit protected settings yourself.</p>
        <PagedRows label="Protected rules" rows={version.state.protection.map(rule => {
          const segments = effects.filter(value => value.lineageId === rule.lineageId), effect = segments[0];
          const added = version.delta.some(change => change.kind === "protect-result" && change.ruleId === rule.id);
          return <div className="fy-effect-proposal__decision" key={rule.id}><strong>{effect ? effectName(effect) : "Effect"} · {effectRuleLabel(rule, frameRate)}</strong>
            {effect && <span>{[...new Set(segments.map(value => effectCardTargetLabel(value.target, timeline)))].join(", ")} · {effectRangeLabel(Math.min(...segments.map(value => value.startFrame)), Math.max(...segments.map(value => value.startFrame + value.durationFrames)), frameRate)}</span>}
            <span>{added ? "Protect on Apply" : "Protected"} · {ruleValue(rule, effects, frameRate, timeline)}</span>
            <button type="button" disabled={disabled} onClick={() => intent({ kind: "release", ruleId: rule.id })}>Release {effectRuleLabel(rule, frameRate)} on Apply</button>
          </div>;
        })} size={8} />
      </section>}
      {decisions.length > 0 && <section aria-label="Human decisions for this version"><h4>Your retained decisions</h4>
        <PagedRows label="Retained decisions" rows={decisions.flatMap(decision => {
          if (decision.kind === "adjust" || decision.kind === "keep-current") return retained.filter(change => change.decisionId === decision.id).flatMap((change, changeIndex) => change.scopes.map((scope, scopeIndex) => {
            const effect = change.after ?? change.before;
            return <div className="fy-effect-proposal__decision" key={`${decision.id}:${changeIndex}:${scopeIndex}`}>
              <strong>{decision.kind === "keep-current" ? "Keep current" : "Adjusted by you"} · retained in revisions</strong>
              <span>{effect ? effectName(effect) : "Effect"} · {effectStickyLabel(scope)}</span>
              {effect && scope.kind === "property" && <span>{effectProtectionValue(effect, scope.property, timeline ?? undefined)}</span>}
              <button type="button" disabled={disabled} onClick={() => intent({ kind: "permit-revision", adjustmentIds: [decision.id], scopes: [scope] })}>Allow Arke to revise {effectStickyLabel(scope)}</button>
            </div>;
          }));
          if (decision.kind === "exclude") return [<div className="fy-effect-proposal__decision" key={decision.id}><strong>Excluded · retained in revisions</strong><span>Origin {decision.originId}</span></div>];
          if (decision.kind === "permit-revision") return [<div className="fy-effect-proposal__decision" key={decision.id}><strong>Permission to revise</strong><span>{decision.scopes.map(effectStickyLabel).join(" · ")}</span><span>Permanent protection stays in place.</span></div>];
          return [];
        })} size={8} />
      </section>}
      {releases.length > 0 && <section aria-label="Release on Apply"><h4>Release on Apply</h4><p className="fy-effect-proposal__note">Only these named rules will be released when this exact reviewed version is applied. Current is unchanged.</p>
        {releases.map(change => <div className="fy-effect-proposal__decision" key={change.ruleId}><strong>{effectRuleLabel(change.before, frameRate)}</strong><span>Release on Apply · rule {change.ruleId}</span></div>)}
      </section>}
      {version.dependencies.reactions.length > 0 && <section aria-label="Frozen audio readiness"><h4>Audio readiness for this version</h4>
        <PagedRows label="Audio readiness" rows={version.dependencies.reactions.map(row => {
          const effect = effects.find(value => value.id === row.effectId);
          return <p key={row.effectId}><strong>{effect ? effectName(effect) : row.effectId}</strong> · {row.status === "off" ? "Reaction Off" : row.status === "ready" ? "Ready" : `${row.status} · ${row.reason}`}</p>;
        })} size={8} />
      </section>}
      {version.requestedActions.length > 0 && <section aria-label="Requested human decisions"><h4>Arke is asking for your decision</h4>
        {version.requestedActions.map((request, index) => <div className="fy-effect-proposal__decision" key={`${request.kind}:${index}`}><p>{request.reason}</p>
          {request.kind === "protect" && <><span>{effectRuleLabel(request.rule, frameRate)}</span><button type="button" disabled={disabled} onClick={() => intent({ kind: "protect", rule: request.rule })}>Protect {effectRuleLabel(request.rule, frameRate)}</button></>}
          {request.kind === "release" && (() => {
            const rule = version.state.protection.find(value => value.id === request.ruleId);
            return rule ? <><span>{effectRuleLabel(rule, frameRate)} · {ruleValue(rule, effects, frameRate, timeline)}</span><button type="button" disabled={disabled} onClick={() => intent({ kind: "release", ruleId: rule.id })}>Release {effectRuleLabel(rule, frameRate)} on Apply</button></> : <span>The named rule is no longer present in this version.</span>;
          })()}
          {request.kind === "new-slot" && <><span>{effectCardTargetLabel(family.scope.target, timeline)} · {effectRangeLabel(family.scope.range.startFrame, family.scope.range.endFrame, frameRate)}</span>
            <button type="button" disabled={disabled} onClick={() => intent({ kind: "grant-new-slot", target: family.scope.target, range: family.scope.range, count: request.count })}>Allow {request.count} new {request.count === 1 ? "effect" : "effects"} in this scope</button></>}
          {request.kind === "identity" && <span>Identity {request.entityId}. Resolve the named conflict before revising.</span>}
        </div>)}
      </section>}
      {pending && <div className="fy-effect-proposal__actions">
        <button type="button" disabled={busy || readOnly || !timeline} onClick={() => props.onUpdate(ref)}>Update proposal</button>
        {sourceMissing && <button type="button" disabled={disabled} onClick={() => props.onRetry(ref)}>Retry preparation</button>}
        <button type="button" disabled={busy || readOnly} onClick={() => props.onDiscard(ref)}>Discard arrangement</button>
      </div>}
      </>}
    </div>
    {pending && <p className="fy-effect-proposal__note">{busy ? "An effects action is awaiting its response." : "Review in timeline to adjust and apply. Current stays unchanged until Apply reviewed version."}</p>}
  </section>;
}

function ruleValue(rule: EffectProtectionRule, effects: readonly EffectClip[], fps: number, timeline: ProductionTimeline | null): string {
  const segments = effects.filter(effect => effect.lineageId === rule.lineageId);
  if (rule.kind === "passage-coverage") return "Retain covered frames in the fixed passage";
  if (!segments.length) return "Protected effect is absent in this version";
  if (rule.kind === "boundary") return effectFrameLabel(rule.boundary === "start" ? Math.min(...segments.map(effect => effect.startFrame)) : Math.max(...segments.map(effect => effect.startFrame + effect.durationFrames)), fps);
  const scope = rule.scope;
  const scoped = scope.kind === "whole" ? segments : segments.filter(effect => effect.startFrame < scope.endFrame && effect.startFrame + effect.durationFrames > scope.startFrame);
  const values = [...new Set(scoped.map(effect => effectProtectionValue(effect, rule.property, timeline ?? undefined)))];
  return values.length === 1 ? values[0]! : values.length ? `Varies across ${scoped.length} segments` : "No covered frames in this passage";
}

function EffectChange(props: EffectProposalCardProps & { change: Extract<EffectFinalDelta, { kind: "effect-result" }>; disabled: boolean; canInspect: boolean }) {
  const { change, family, version, timeline, frameRate, disabled } = props;
  const effect = change.after ?? change.before!, ref = effectCardRef(family, version);
  const segment = family.identities.segments.find(value => value.clipId === effect.id), origin = family.identities.origins.find(value => value.originId === segment?.originId);
  const rows = effectPropertyDifferences(change, family, timeline, frameRate);
  const keep = (scope: EffectStickyScope) => segment && props.onIntent(ref, { kind: "keep-current", entityId: segment.segmentId, scope });
  return <article className="fy-effect-proposal__change" aria-label={`${change.before ? change.after ? "Change" : "Remove" : "Add"} ${effectName(effect)}`}>
    <h4><span>{change.before ? change.after ? "Change" : "Remove" : "Add"}</span> {effectName(effect)}</h4>
    <dl className="fy-effect-proposal__bindings"><div><dt>Visual target</dt><dd>{effectCardTargetLabel(effect.target, timeline)}</dd></div>
      <div><dt>Time</dt><dd>{effectRangeLabel(effect.startFrame, effect.startFrame + effect.durationFrames, frameRate)}</dd></div>
      <div><dt>Audio reaction</dt><dd>{effectAudioLabel(effect, timeline)}</dd></div></dl>
    <div className="fy-effect-proposal__actions">
      {change.after && <button type="button" disabled={!props.canInspect} onClick={() => props.onInspect(ref, effect.id)}>Inspect effect</button>}
      {origin?.kind === "current" && <button type="button" disabled={disabled || !segment} onClick={() => keep({ kind: "whole-effect" })}>Keep current effect</button>}
      {origin?.kind === "addition" && <button type="button" disabled={disabled} onClick={() => props.onIntent(ref, { kind: "exclude", originId: origin.originId })}>Exclude effect</button>}
    </div>
    {change.after && !props.canInspect && <p className="fy-effect-proposal__note">Review this version in Suggested to open its Inspector.</p>}
    <details><summary>Before and after · {rows.length} {rows.length === 1 ? "setting" : "settings"}</summary>
      <PagedRows label={`${effectName(effect)} settings`} rows={rows.map(row => <div className="fy-effect-proposal__property" key={row.key}>
        <strong>{row.label}</strong><dl><div><dt>Current</dt><dd>{row.before}</dd></div><div><dt>Suggested</dt><dd>{row.after}</dd></div></dl>
        {origin?.kind === "current" && row.keepScope && <button type="button" disabled={disabled || !segment} onClick={() => keep(row.keepScope!)}>Keep current {row.label}</button>}
      </div>)} size={10} />
    </details>
  </article>;
}

function PagedRows({ rows, label, size }: { rows: ReactNode[]; label: string; size: number }) {
  const [page, setPage] = useState(0), pages = Math.max(1, Math.ceil(rows.length / size)), current = Math.min(page, pages - 1);
  if (!rows.length) return null;
  return <div className="fy-effect-proposal__rows">{rows.slice(current * size, (current + 1) * size)}{pages > 1 && <nav className="fy-effect-proposal__actions" aria-label={`${label} pages`}>
    <button type="button" disabled={current === 0} onClick={() => setPage(current - 1)}>Previous</button><span>{current + 1} / {pages}</span><button type="button" disabled={current + 1 === pages} onClick={() => setPage(current + 1)}>Next</button>
  </nav>}</div>;
}
