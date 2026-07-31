import type {
  CanonEntry,
  Job,
  ReferenceTile as ReferenceTileModel,
  RipplePreview,
  Sheet,
  Shot,
  StagedProposal,
  Take,
} from "@arke-studio/contracts";
import { humanNumber, seconds, shortDateTime, usd } from "../lib/format.js";
import { Avatar, Badge, Button, Card, StatusDot, cx, type StatusDotTone } from "../components/ui.js";

/**
 * Arke Studio's domain primitives (SPEC-001 §2.10) — the vocabulary the rest of the specs
 * build on. Defined here, once, because they appear across eight-plus screens.
 */

// ---- SheetCard — cast, locations, factions --------------------------------

export function SheetCard({ sheet, onOpen }: { sheet: Sheet; onOpen?: () => void }) {
  return (
    <Card className="dom-sheetcard" onClick={onOpen}>
      <div className="dom-sheetcard__head">
        <Avatar name={sheet.name} />
        <div className="dom-sheetcard__idblock">
          <div className="dom-sheetcard__name">{sheet.name}</div>
          {sheet.role && <div className="dom-sheetcard__role">{sheet.role}</div>}
          {sheet.region && <div className="dom-sheetcard__role">{sheet.region}</div>}
        </div>
        {sheet.status === "sketch" ? <Badge tone="outline">sketch</Badge> : <Badge>v{sheet.version}</Badge>}
      </div>
      <p className="dom-sheetcard__essence">{sheet.sections[0]?.body.split("\n")[0] ?? ""}</p>
      <div className="dom-sheetcard__foot">
        {sheet.billing && <span>{sheet.billing}</span>}
        {sheet.voice && <span>voice · {sheet.voice.label ?? sheet.voice.provider}</span>}
        {sheet.canonRules.length > 0 && <span>{sheet.canonRules.length} canon rule{sheet.canonRules.length === 1 ? "" : "s"}</span>}
      </div>
    </Card>
  );
}

// ---- CanonEntryRow — canon list, search results, citations ----------------

const CANON_STATUS_TONE: Record<CanonEntry["status"], StatusDotTone> = {
  settled: "ok",
  proposed: "warn",
  open: "busy",
};

export function CanonEntryRow({ entry, onOpen }: { entry: CanonEntry; onOpen?: () => void }) {
  return (
    <button type="button" className="dom-canonrow" onClick={onOpen}>
      <span className="dom-canonrow__id mono">{entry.id}</span>
      <span className="dom-canonrow__title">{entry.title}</span>
      <Badge tone="outline">{entry.type}</Badge>
      <span className="dom-canonrow__lineage">
        {entry.status === "open"
          ? `open since v${entry.introducedAt}`
          : [
              `written v${entry.introducedAt}`,
              entry.settledAt !== undefined && `settled v${entry.settledAt}`,
              entry.amendedAt !== undefined && `amended v${entry.amendedAt}`,
            ]
              .filter(Boolean)
              .join(" · ")}
      </span>
      <StatusDot tone={CANON_STATUS_TONE[entry.status]} label={entry.status} />
    </button>
  );
}

// ---- ShotCard — scene shots, stills frames --------------------------------

export function ShotCard({
  shot,
  accepted,
  takeCount,
  onOpen,
}: {
  shot: Shot;
  accepted?: boolean;
  takeCount?: number;
  onOpen?: () => void;
}) {
  return (
    <Card className="dom-shotcard" onClick={onOpen}>
      <div className="dom-shotcard__frame" aria-hidden>
        <span className="mono">{humanNumber(shot.id, "Shot")}</span>
      </div>
      <div className="dom-shotcard__body">
        <div className="dom-shotcard__title">{shot.title}</div>
        <div className="dom-shotcard__meta">
          {shot.camera && <span>{shot.camera}</span>}
          <span>{seconds(shot.durationSec)}</span>
          {shot.audio && <span>{shot.audio.kind}</span>}
        </div>
      </div>
      <div className="dom-shotcard__state">
        {accepted ? (
          <Badge tone="success">accepted</Badge>
        ) : takeCount !== undefined && takeCount > 0 ? (
          <Badge tone="warning">{takeCount} take{takeCount === 1 ? "" : "s"}</Badge>
        ) : (
          <Badge tone="outline">no takes</Badge>
        )}
      </div>
    </Card>
  );
}

// ---- TakeStrip — generate workspace, contact sheet ------------------------

export type TakeDecision = "accepted" | "rejected" | "pending";

export function TakeStrip({
  takes,
  decisions,
  selectedTakeId,
  onSelect,
}: {
  takes: Take[];
  decisions: Record<string, TakeDecision>;
  selectedTakeId?: string | null;
  onSelect?: (takeId: string) => void;
}) {
  if (takes.length === 0) return <div className="dom-takestrip dom-takestrip--empty">No takes yet.</div>;
  return (
    <div className="dom-takestrip" role="list">
      {takes.map((take) => {
        const decision = decisions[take.id] ?? "pending";
        return (
          <button
            type="button"
            role="listitem"
            key={take.id}
            className={cx(
              "dom-take",
              take.id === selectedTakeId && "dom-take--selected",
              decision === "rejected" && "dom-take--rejected",
            )}
            onClick={() => onSelect?.(take.id)}
          >
            <span className="dom-take__thumb" aria-hidden>
              {take.kind}
            </span>
            <span className="dom-take__meta">
              <span className="mono">{take.id.slice(0, 8)}…</span>
              <span>{take.model}</span>
              <span>{usd(take.cost.actualMicroUsd ?? take.cost.estimatedMicroUsd)}</span>
            </span>
            {decision === "accepted" && <Badge tone="success">accepted</Badge>}
            {decision === "rejected" && <Badge tone="danger">rejected</Badge>}
            {decision === "pending" && <Badge tone="outline">review</Badge>}
          </button>
        );
      })}
    </div>
  );
}

// ---- ProposalPanel + RippleList — every accept gate (SPEC-001 D6) ---------

export function RippleList({ ripple }: { ripple: RipplePreview | null }) {
  if (!ripple || ripple.items.length === 0) {
    return <div className="dom-ripples dom-ripples--none">No ripples — this change touches nothing else.</div>;
  }
  return (
    <ul className="dom-ripples">
      {ripple.items.map((item, i) => (
        <li key={i} className="dom-ripples__item">
          <Badge tone="outline">{item.kind}</Badge>
          <span>{item.summary}</span>
        </li>
      ))}
      {!ripple.governing && (
        <li className="dom-ripples__note">
          Preview only — ripples are recomputed at accept, under the world lock.
        </li>
      )}
    </ul>
  );
}

export function ProposalPanel({
  staged,
  onAccept,
  onDiscard,
  disabledReason,
}: {
  staged: StagedProposal;
  onAccept?: () => void;
  onDiscard?: () => void;
  disabledReason?: string;
}) {
  const { proposal, ripple } = staged;
  return (
    <Card className="dom-proposal">
      <div className="dom-proposal__head">
        <Badge tone="warning">proposal</Badge>
        <span className="dom-proposal__kind mono">{proposal.kind}</span>
        <span className="dom-proposal__source">{proposal.source}</span>
      </div>
      <div className="dom-proposal__summary">{proposal.summary}</div>
      <div className="dom-proposal__targets">
        {proposal.targets.map((t) => (
          <div key={t.path} className="dom-proposal__target mono">
            {t.path}
            <span className="dom-proposal__base">
              {t.baseVersion === null ? "new file" : `against v${t.baseVersion}`}
            </span>
          </div>
        ))}
      </div>
      <RippleList ripple={ripple} />
      <div className="dom-proposal__actions">
        <Button variant="primary" onClick={onAccept} disabled={!onAccept} title={disabledReason}>
          Accept
        </Button>
        <Button variant="ghost" onClick={onDiscard} disabled={!onDiscard} title={disabledReason}>
          Discard
        </Button>
        {disabledReason && <span className="dom-proposal__why">{disabledReason}</span>}
      </div>
    </Card>
  );
}

// ---- ReferenceTile — reference kits ---------------------------------------

export function ReferenceTile({ tile }: { tile: ReferenceTileModel }) {
  return (
    <div className={cx("dom-reftile", tile.status === "empty" && "dom-reftile--empty")}>
      <div className="dom-reftile__image" aria-hidden>
        {tile.status === "empty" ? "empty slot" : tile.angle}
      </div>
      <div className="dom-reftile__foot">
        <span className="dom-reftile__angle">{tile.angle.replaceAll("-", " ")}</span>
        {tile.status === "locked" && <Badge tone="success">locked · v{tile.sheetVersion}</Badge>}
        {tile.status === "draft" && <Badge tone="warning">draft · v{tile.sheetVersion}</Badge>}
        {tile.status === "empty" && <Badge tone="outline">empty</Badge>}
      </div>
    </div>
  );
}

// ---- JobRow — activity ----------------------------------------------------

const JOB_TONE: Record<Job["status"], StatusDotTone> = {
  queued: "muted",
  submitting: "busy",
  running: "busy",
  succeeded: "ok",
  failed: "danger",
  cancelled: "muted",
  "needs-reconciliation": "warn",
};

export function JobRow({ job }: { job: Job }) {
  return (
    <div className="dom-jobrow">
      <StatusDot tone={JOB_TONE[job.status]} />
      <span className="dom-jobrow__target">
        {job.target.kind}
        {job.target.id ? ` · ${job.target.id}` : ""}
      </span>
      <span className="dom-jobrow__model mono">
        {job.provider}/{job.model}
      </span>
      <span className="dom-jobrow__cost">{usd(job.estimatedMicroUsd)} est.</span>
      <span className="dom-jobrow__when">{shortDateTime(job.updatedAt)}</span>
      <Badge
        tone={
          job.status === "succeeded"
            ? "success"
            : job.status === "failed" || job.status === "needs-reconciliation"
              ? "danger"
              : "neutral"
        }
      >
        {job.status}
      </Badge>
      {job.error && <div className="dom-jobrow__error">{job.error}</div>}
    </div>
  );
}
