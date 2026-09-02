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
import { Portrait } from "../components/portrait.js";

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
          Preview only — ripples are recomputed at accept.
        </li>
      )}
    </ul>
  );
}

export interface ProposalGateNotice {
  reason:
    | "stale"
    | "needs-reconfirm"
    | "no-op"
    | "pending-review"
    | "unresolved-conflicts"
    | "open-choices"
    | "target-retired"
    | "invalid"
    /** #70 SS11.4.1: an in-place edit whose outcome is unknown; accepting is not offered. */
    | "draft-unresolved"
    /** Issue 239: a turn is writing into the proposal, so it is not settled enough to act on. */
    | "drafting";
  detail?: string;
  authoritativeSignature?: string;
}

const NOTICE_TITLES: Record<ProposalGateNotice["reason"], string> = {
  stale: "The world moved while this was open",
  "needs-reconfirm": "The consequences changed",
  "no-op": "Nothing to accept",
  "pending-review": "Review the merged result",
  "unresolved-conflicts": "Conflicted fields await a choice",
  "open-choices": "A question still needs your answer",
  "target-retired": "The target was retired",
  invalid: "This draft cannot be written as it stands",
  "draft-unresolved": "An edit to this proposal did not finish",
  drafting: "The studio is still drafting",
};

/**
 * `invalid` covers everything the gate refuses by name, and that is more than one kind of thing:
 * a character role over its limit, and — since the structured records joined the gate's schema
 * fences — a file the scanner would drop. One fixed title announced every one of them as a field
 * being too long, so a malformed scene was reported as a length problem and the way out it
 * offered ("shorten it") was advice for a different fault.
 *
 * The detail already words the problem for a person, so the title only has to frame it and the
 * hint only has to name the exit. A length problem keeps its own words because "shorten it" is
 * the specific, useful thing to say when that is what happened.
 */
function invalidNotice(detail: string | undefined): { title: string; hint: string } {
  return detail !== undefined && /the limit is \d+/.test(detail)
    ? {
        title: "A field is over its limit",
        hint: "Ask the studio to shorten it, or discard this draft. Nothing has landed.",
      }
    : {
        title: NOTICE_TITLES.invalid,
        hint: "Ask the studio to fix it, or discard this draft. Nothing has landed.",
      };
}

export function ProposalPanel({
  staged,
  notice,
  onAccept,
  onDiscard,
  onRebase,
  onResolve,
  onResolveChoice,
  onMarkSeen,
  onSendBack,
  disabledReason,
}: {
  staged: StagedProposal;
  notice?: ProposalGateNotice;
  onAccept?: (confirmSignature?: string) => void;
  onDiscard?: () => void;
  onRebase?: () => void;
  onResolve?: (path: string, field: string, choice: "mine" | "theirs") => void;
  onResolveChoice?: (choiceId: string, optionId: string) => void;
  onMarkSeen?: () => void;
  /** Present only for a proposal that came from a conversation there is still somewhere to send it to. */
  onSendBack?: () => void;
  disabledReason?: string;
}) {
  const { proposal, ripple } = staged;
  const conflicts = proposal.conflicts ?? [];
  const unresolved = conflicts.filter((c) => c.resolution === undefined);
  const openChoices = proposal.openChoices ?? [];
  return (
    <Card className="dom-proposal">
      <div className="dom-proposal__head">
        <Badge tone="warning">proposal</Badge>
        <span className="dom-proposal__kind mono">{proposal.kind}</span>
        <span className="dom-proposal__source">{proposal.source}</span>
        {proposal.pendingReview && <Badge tone="danger">rebased — review</Badge>}
      </div>
      <div className="dom-proposal__summary">{proposal.summary}</div>
      {staged.review ? (
        <div className="dom-review">
          {staged.review.targets.map((t) => (
            <div key={t.path} className="dom-review__target">
              <div className="dom-review__head">
                <span className="dom-review__label">{t.label}</span>
                <span className="dom-review__kind mono">{t.kind}</span>
              </div>
              {t.fields.map((f) => (
                <div key={f.field} className="dom-review__field">
                  <div className="dom-review__name">{f.field}</div>
                  {f.before !== null && (
                    <div className="dom-review__was">
                      <span className="dom-review__tag mono">was</span>
                      <span>{f.before}</span>
                    </div>
                  )}
                  {f.proposed !== null ? (
                    <div className="dom-review__now">
                      <span className="dom-review__tag mono">now</span>
                      <span>{f.proposed}</span>
                    </div>
                  ) : (
                    <div className="dom-review__now">
                      <span className="dom-review__tag mono">now</span>
                      <span className="dom-review__removed">removed</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : (
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
      )}
      {notice && (
        <div className="dom-proposal__notice" role="alert">
          <strong>{notice.reason === "invalid" ? invalidNotice(notice.detail).title : NOTICE_TITLES[notice.reason]}.</strong>{" "}
          {notice.detail}
          {notice.reason === "stale" && onRebase && (
            <div className="dom-proposal__noticeactions">
              <Button onClick={onRebase}>Rebase onto current</Button>
            </div>
          )}
          {notice.reason === "needs-reconfirm" && onAccept && notice.authoritativeSignature && (
            <div className="dom-proposal__noticeactions">
              <Button variant="primary" onClick={() => onAccept(notice.authoritativeSignature)}>
                Accept with these consequences
              </Button>
            </div>
          )}
          {/* There is no way to hand-edit a staged proposal, so say what the way out is. */}
          {notice.reason === "invalid" && (
            <div className="dom-proposal__noticehint">{invalidNotice(notice.detail).hint}</div>
          )}
        </div>
      )}
      {conflicts.length > 0 && (
        <div className="dom-proposal__conflicts">
          {conflicts.map((c) => (
            <div key={`${c.path}#${c.field}`} className="dom-conflict">
              <div className="dom-conflict__field mono">
                {c.field}
                {c.resolution && <Badge tone="success">kept {c.resolution === "mine" ? "the proposal" : "the world"}</Badge>}
              </div>
              {!c.resolution && (
                <div className="dom-conflict__choices">
                  <button type="button" className="dom-conflict__choice" onClick={() => onResolve?.(c.path, c.field, "mine")}>
                    <span className="dom-conflict__label">This proposal</span>
                    <span className="dom-conflict__value">{c.mine ?? "(removed)"}</span>
                  </button>
                  <button type="button" className="dom-conflict__choice" onClick={() => onResolve?.(c.path, c.field, "theirs")}>
                    <span className="dom-conflict__label">The world now</span>
                    <span className="dom-conflict__value">{c.theirs ?? "(removed)"}</span>
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {openChoices.length > 0 && (
        <div className="dom-proposal__conflicts">
          {openChoices.map((choice) => (
            <div key={choice.choiceId} className="dom-conflict">
              <div className="dom-conflict__field">{choice.question}</div>
              <div className="dom-conflict__choices">
                {choice.options.map((option) => (
                  <button
                    key={option.optionId}
                    type="button"
                    className="dom-conflict__choice"
                    disabled={!onResolveChoice}
                    onClick={() => onResolveChoice?.(choice.choiceId, option.optionId)}
                  >
                    <span className="dom-conflict__value">{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      <RippleList ripple={ripple} />
      <div className="dom-proposal__actions">
        {proposal.pendingReview ? (
          <Button variant="primary" onClick={onMarkSeen} disabled={!onMarkSeen}>
            I've reviewed the merged result
          </Button>
        ) : (
          <Button
            variant="primary"
            onClick={() => onAccept?.()}
            disabled={!onAccept || unresolved.length > 0 || openChoices.length > 0}
            title={openChoices.length > 0 ? "Answer the question above before accepting" : disabledReason}
          >
            Accept
          </Button>
        )}
        {onSendBack && (
          <Button variant="ghost" onClick={onSendBack} title="Reopens the conversation this came from">
            Send back to the conversation
          </Button>
        )}
        <Button variant="ghost" onClick={onDiscard} disabled={!onDiscard} title={disabledReason}>
          Discard
        </Button>
        {disabledReason && <span className="dom-proposal__why">{disabledReason}</span>}
      </div>
    </Card>
  );
}

// ---- ReferenceTile — reference kits ---------------------------------------

export function ReferenceTile({
  tile,
  worldSlug,
  sheetId,
}: {
  tile: ReferenceTileModel;
  /** With both, the tile renders its actual image; without, the quiet placeholder. */
  worldSlug?: string;
  sheetId?: string;
}) {
  const renderable = worldSlug !== undefined && sheetId !== undefined && tile.file !== undefined && tile.status !== "empty";
  return (
    <div className={cx("dom-reftile", tile.status === "empty" && "dom-reftile--empty")}>
      <div className="dom-reftile__image" aria-hidden>
        {renderable ? (
          <Portrait worldSlug={worldSlug} path={`references/${sheetId}/${tile.file!}`} label={tile.angle} radius={6} />
        ) : tile.status === "empty" ? (
          "empty slot"
        ) : (
          tile.angle
        )}
      </div>
      <div className="dom-reftile__foot">
        <span className="dom-reftile__angle">{tile.angle.replaceAll("-", " ")}</span>
        {tile.status === "locked" && <Badge tone="success">locked · v{tile.sheetVersion}</Badge>}
        {tile.status === "generated" && <Badge tone="warning">generated · v{tile.sheetVersion}</Badge>}
        {(tile.status === "pending" || tile.status === "rendering") && <Badge tone="outline">{tile.status}</Badge>}
        {tile.status === "superseded" && <Badge tone="outline">superseded</Badge>}
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
