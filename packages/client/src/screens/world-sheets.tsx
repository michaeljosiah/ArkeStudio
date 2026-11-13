// A world's sheets: cast, locations and factions — the grids, a sheet, its edit and a new one (issue 2816).
import {
  type Sheet, worldSheets, type PendingSheet, pendingWorldSheets, pendingSheets, legacyVoiceModel,
  voiceTargetKey, speechPlanLabel, formatMicroUsd, narratorLabelFor, CharacterAliasesInputSchema,
  mainPhotoFor, designatedCompilation, freePlanStop, SHORT_NAME_MAX, defaultShortName,
  type RippleItem, isWrittenVoiceHeading, WRITTEN_VOICE_HEADING, proposalDecisionOf,
  CHARACTER_ROLE_MAX,
} from "@arke-studio/contracts";
import { useRef, useEffect, useState, useMemo, type ReactNode } from "react";
import { useParams, NavLink, useNavigate, useSearchParams } from "react-router";
import {
  useWorld, type AuthoringActivity, useAuthoring, useSheetRefs, requestSheetRefs, useStore,
  providerIdOf, useVoiceCandidates, useVoiceAudio, requestVoiceCandidates, requestVoicePreview,
  subscribeVoiceUploadConfirmations, useVoiceParts, readSheetPage, readSheetSection, setSheetStatus,
  promoteGuest, retireEntity, renameSheet, duplicateSheet, useTranscripts,
  subscribeSheetEditResults, continueStudio, draftWithStudio, restoreSheetVersion, stageSheetEdit,
  createSheetFromSentence,
} from "../lib/store.js";
import { Loading } from "../components/loading.js";
import { PageSheet } from "../components/page-sheet.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { ChevronRight, Plus, Lock, Pencil, Message, Speaker, Copy, Users, Archive } from "../components/icons.js";
import { useOpenWorldGuard, useSheet } from "../lib/selectors.js";
import { useCompact, usePhone } from "../lib/media-query.js";
import { referenceSummary, limitedFeatureCopy } from "./world.js";
import { Button, cx, Callout, Badge, IconButton, Card, Input, Textarea } from "../components/ui.js";
import { EmptyState, Screen, Section, DegradedBanner } from "../components/layout.js";
import { ImageDialog } from "../components/image-dialog.js";
import { characterPortraitPath, Portrait, sheetPortraitPath, locationPortraitPath } from "../components/portrait.js";
import { readOnlyMarkdownText, ReadOnlyMarkdown } from "../components/editor/read-only-markdown.js";
import { type Clip, playClip, enqueueClip, clearQueue } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { ClipPlayButton, TextActions } from "../components/player.js";
import { Wave } from "../components/wave.js";
import { RemoteVoiceUploadConfirmation, useVoiceUploadAsk } from "../components/remote-voice-upload-confirmation.js";
import { type PageReadBlock, usePageRead, PageReadControl } from "../components/page-read.js";
import { useSingleAct, SingleActFeedback } from "../components/single-act.js";
import { useTalkItThrough } from "../lib/talk-it-through.js";
import { ReadAloudConfirmation } from "../components/read-aloud-confirmation.js";
import { FreePlanStop } from "../components/free-plan-stop.js";
import { DictationButton } from "../components/dictation.js";

// ---- Sheet list screens ----------------------------------------------------

/**
 * The sheet-kind switch (design 54c): one Cast tab in the chrome, three ledgers behind it.
 * Each ledger keeps its own address and presentation; this row is how you move between them,
 * with the counts carried so an empty kind says so before you visit it.
 */
export function SheetKindNav({ active }: { active: Sheet["type"] | "prop" }) {
  const nav = useRef<HTMLElement>(null);
  useEffect(() => {
    nav.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [active]);
  const { worldId } = useParams();
  const world = useWorld();
  // Props sit beside the sheets they are deliberately not one of (design turn 105; issue 537).
  const count = (t: Sheet["type"] | "prop") =>
    t === "prop"
      ? (world?.props.length ?? 0)
      : worldSheets(world?.sheets ?? []).filter((s) => s.type === t && s.retired !== true).length;
  const items = [
    ["character", "Characters", "cast"],
    ["location", "Locations", "locations"],
    ["faction", "Factions", "factions"],
    ["prop", "Props", "props"],
  ] as const;
  return (
    <nav ref={nav} className="fy-sheetkinds" aria-label="Kind of sheet">
      <div className="fy-seg">
        {items.map(([type, label, slug]) =>
          type === active ? (
            <span key={type} className="fy-seg__item fy-seg__item--active" aria-current="page">
              {label} · {count(type)}
            </span>
          ) : (
            <NavLink key={type} to={`/w/${worldId}/${slug}`} className="fy-seg__item">
              {label} · {count(type)}
            </NavLink>
          ),
        )}
      </div>
    </nav>
  );
}

/** The ledger layout (prototype 1d): one featured portrait, the rest as quiet rows. */
/**
 * What to say about a sheet that has been asked for and has not arrived (issue 228).
 *
 * Four states, and the fourth is the one worth being careful about. `authoring` is folded from
 * events, so it holds only what this client has seen: reload mid-draft and the map comes back
 * empty while the run carries on. Reading that absence as "drafted" would state, of a sheet
 * still being written, that it is finished and waiting — the same class of false claim this
 * whole issue is about, just pointing the other way. So an unknown run says where to look and
 * claims nothing about where it got to.
 *
 * (Whether the studio is still on a proposal is genuinely absent from the snapshot rather than
 * merely unread here — see the follow-up filed from this PR.)
 */
type PendingSheetDestination = "here" | "conversation" | "approvals";

export function pendingSheetDestination(sheet: PendingSheet): PendingSheetDestination {
  if (sheet.decision.mode === "unattended") return "approvals";
  return sheet.decision.owner.kind === "world-chat" ? "conversation" : "here";
}

export function pendingSheetRoute(worldId: string | undefined, sheet: PendingSheet): string | null {
  if (sheet.decision.mode === "unattended") return `/w/${worldId}/proposals`;
  if (sheet.decision.owner.kind === "world-chat") {
    return `/w/${worldId}/chat/${sheet.decision.owner.conversationId}`;
  }
  return null;
}

export function pendingSheetState(activity: AuthoringActivity | undefined, destination: PendingSheetDestination, requiresDraft = false): {
  foot: string;
  body: string;
  tone: "live" | "sketch" | "warn";
} {
  if (requiresDraft && activity?.status !== "running") {
    return { foot: "not drafted", body: "your brief is saved — open it to draft the sheet", tone: "warn" };
  }
  if (activity === undefined) {
    return destination === "here"
      ? { foot: "decision here", body: "open this draft to see where it got to", tone: "sketch" }
      : destination === "conversation"
        ? { foot: "in conversation", body: "open its conversation to see where it got to", tone: "sketch" }
        : { foot: "in Approvals", body: "open it to see where it got to", tone: "sketch" };
  }
  if (activity.status === "running") {
    return { foot: "drafting", body: "the studio is writing this from your sentence", tone: "live" };
  }
  if (activity.status === "completed") {
    return {
      foot: "drafted · awaiting your yes",
      body: destination === "here" ? "ready here" : destination === "conversation" ? "ready in conversation" : "ready in Approvals",
      tone: "sketch",
    };
  }
  return {
    foot: `drafting ${activity.status}`,
    body: activity.detail ?? (destination === "here" ? "open this draft to see what happened" : destination === "conversation" ? "open its conversation to see what happened" : "open Approvals to see what happened"),
    tone: "warn",
  };
}

/**
 * The sheets on their way, drawn on the surface they will land on (issue 228).
 *
 * Drafting takes seconds to minutes, and for all of it the sheet lives in `.proposals/` rather
 * than in `world.sheets` — so this list showed its empty state, and a submitted action looked
 * like a failed one. The card is the whole fix: it sits in the grid where the sheet will be,
 * says which of the three things is true, and keeps an attended decision on this destination.
 */
function PendingSheetCards({
  worldId,
  pending,
}: {
  worldId: string | undefined;
  pending: readonly PendingSheet[];
}) {
  const authoring = useAuthoring();
  const world = useWorld();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedProposal = world?.proposals.find((proposal) => proposal.proposal.id === selected);
  return (
    <>
      {pending.map((sheet) => {
        const destination = pendingSheetDestination(sheet);
        const state = pendingSheetState(authoring[sheet.proposalId], destination, sheet.requiresDraft);
        return (
          <button
            key={sheet.proposalId}
            type="button"
            className="fy-gridcard fy-gridcard--media fy-gridcard--fixed fy-gridcard--pending"
            onClick={() => {
              const route = pendingSheetRoute(worldId, sheet);
              if (route) navigate(route);
              else setSelected(sheet.proposalId);
            }}
            aria-label={`${sheet.name} — ${state.foot}. ${destination === "here" ? "Review here" : destination === "conversation" ? "Open conversation" : "Open Approvals"}.`}
          >
            <div className="fy-gridcard__frame fy-gridcard__frame--pending">
              {state.tone === "live" ? (
                <Loading label={`Drafting ${sheet.name}`} size={40} />
              ) : (
                <span className="fy-gridcard__pendingnote">
                  {state.tone === "warn" ? "not drafted" : "no sheet yet"}
                </span>
              )}
            </div>
            <div className="fy-gridcard__pad">
              <div className="fy-gridcard__title">
                <span className="fy-gridcard__name">{sheet.name}</span>
                <span className={`fy-dot fy-dot--${state.tone}`} style={{ width: 6, height: 6 }} />
              </div>
              <div className="fy-gridcard__body">{state.body}</div>
              <div className="fy-gridcard__foot fy-gridcard__foot--spaced">
                {state.foot}
              </div>
            </div>
          </button>
        );
      })}
      {selectedProposal && (
        <PageSheet open title={`Review ${selectedProposal.review?.targets[0]?.label ?? selectedProposal.proposal.summary}`} onClose={() => setSelected(null)} className="fy-sheet-proposal-review">
          <ConnectedProposalPanel
            key={selectedProposal.proposal.id}
            staged={selectedProposal}
            conversationPath={selectedProposal.proposal.targets[0]?.path}
            onAccepted={() => setSelected(null)}
          />
        </PageSheet>
      )}
    </>
  );
}

/** The same thing in the ledger's shape, for the surfaces that list rows rather than cards. */
function PendingSheetRows({
  worldId,
  pending,
}: {
  worldId: string | undefined;
  pending: readonly PendingSheet[];
}) {
  const authoring = useAuthoring();
  const world = useWorld();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string | null>(null);
  const selectedProposal = world?.proposals.find((proposal) => proposal.proposal.id === selected);
  return (
    <>
      {pending.map((sheet) => {
        const destination = pendingSheetDestination(sheet);
        const state = pendingSheetState(authoring[sheet.proposalId], destination, sheet.requiresDraft);
        return (
          <button
            key={sheet.proposalId}
            type="button"
            className="fy-row fy-row--pending"
            aria-label={`${sheet.name}, ${state.foot}. ${destination === "here" ? "Review here" : destination === "conversation" ? "Open conversation" : "Open Approvals"}.`}
            onClick={() => {
              const route = pendingSheetRoute(worldId, sheet);
              if (route) navigate(route);
              else setSelected(sheet.proposalId);
            }}
          >
            <div className="fy-row__thumb fy-row__thumb--pending">
              {state.tone === "live" && <Loading size={18} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <div className="fy-row__name">
                {sheet.name}
                <span
                  className={`fy-dot fy-dot--${state.tone}`}
                  style={{ width: 6, height: 6 }}
                  aria-hidden="true"
                />
              </div>
              <div className="fy-row__sub">{state.body}</div>
            </div>
            <span className="fy-row__meta">{state.foot}</span>
            <span className="fy-row__chev">
              <ChevronRight />
            </span>
          </button>
        );
      })}
      {selectedProposal && (
        <PageSheet open title={`Review ${selectedProposal.review?.targets[0]?.label ?? selectedProposal.proposal.summary}`} onClose={() => setSelected(null)} className="fy-sheet-proposal-review">
          <ConnectedProposalPanel
            key={selectedProposal.proposal.id}
            staged={selectedProposal}
            conversationPath={selectedProposal.proposal.targets[0]?.path}
            onAccepted={() => setSelected(null)}
          />
        </PageSheet>
      )}
    </>
  );
}

/**
 * " · 2 awaiting a decision", or nothing at all.
 *
 * Not "drafting", which would be a claim about work that in several cases never happens: a
 * duplicated sheet is staged whole and synchronously, and a World Chat candidate is
 * materialised before it is staged. Neither ever runs an agent, so a heading counting them as
 * drafting would say so for as long as they sat there — and would disagree with the card
 * beneath it, which says what it actually knows. Where they all are is the one thing true of
 * every pending sheet, so that is what the count says.
 */
function pendingSuffix(pending: readonly PendingSheet[]): string {
  return pending.length > 0 ? ` · ${pending.length} awaiting a decision` : "";
}

function SheetGrid({
  kind,
  screenId,
  newPath,
  detailPath,
  title,
  hint,
}: {
  kind: Sheet["type"];
  screenId: string;
  newPath: string;
  detailPath: (id: string) => string;
  title: string;
  hint: string;
}) {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const sheetRefs = useSheetRefs();
  const phone = usePhone();
  const compact = useCompact();
  // Ledgers are the world's, so guests are absent from the list and from both tallies — a
  // retired count that included another production's one-offs would not add up to anything the
  // user could click through to (SPEC-020 R-8).
  const worldOwned = worldSheets(world?.sheets ?? []);
  const sheets = worldOwned.filter((s) => s.type === kind && s.retired !== true);
  // A pending guest is not the world's business either — filtering only accepted guests would
  // let every new one sit on this ledger for exactly as long as it took to review (R-8).
  const pending = pendingWorldSheets(pendingSheets(world?.proposals ?? [], kind, world?.conversations ?? []));
  const retired = worldOwned.filter((s) => s.type === kind && s.retired === true).length;
  const locked = sheets.filter((s) => s.status === "locked").length;
  const sketches = sheets.filter((s) => s.status === "sketch").length;
  const featured = sheets[0] ?? null;
  const slug = world?.meta.slug;
  /**
   * The line under a name in the cast list: the role when there is one, the sheet's opening
   * clause when there is not.
   *
   * Cut on a word, never through one. `slice(0, 60)` alone produced "…records in the warm ba",
   * which reads as a broken field rather than a summary — and it sits in the column where every
   * other row shows a clean label, so the one character drafted without a role looked like the
   * one character whose sheet had gone wrong.
   */
  const roleOf = (sheet: Sheet): string => {
    const identity = [sheet.role, sheet.billing].filter(Boolean).join(" · ");
    if (identity) return identity;
    const opening = (sheet.sections[0]?.body.split(/[.!?]/)[0] ?? "").trim();
    return opening.length <= 60 ? opening : `${opening.slice(0, 60).replace(/\s+\S*$/, "")}…`;
  };
  const featureCopy = (sheet: Sheet): string => {
    const identity = [sheet.role, sheet.billing].filter(Boolean).join(" · ");
    let essence =
      sheet.sections.find((section) => section.heading.toLowerCase() === "essence")?.body.trim() ?? "";
    if (sheet.role && essence.toLowerCase().startsWith(`${sheet.role.toLowerCase()}.`)) {
      essence = essence.slice(sheet.role.length + 1).trim();
    }
    return [identity, essence].filter(Boolean).join(" — ");
  };
  const reachOf = (sheet: Sheet): string => {
    const refs = sheetRefs[sheet.id];
    const { total } = referenceSummary(world?.referenceKits.find(kit => kit.sheetId === sheet.id));
    const productions = refs ? `${refs.productions.length} production${refs.productions.length === 1 ? "" : "s"}` : "… productions";
    return `${total} ref${total === 1 ? "" : "s"} · ${productions}`;
  };
  useEffect(() => {
    if (!worldId) return;
    for (const sheet of sheets) requestSheetRefs(worldId, sheet.id);
  }, [worldId, sheets.map((sheet) => sheet.id).join("|")]);
  const ledgerHead = <div className="fy-ledgerhead">
    <div className="fy-ledgerhead__copy">
      <span className="fy-ledgerhead__label">{kind === "character" ? "The cast" : title} · {sheets.length}</span>
      <span className="fy-ledgerhead__meta">{[locked > 0 ? `${locked} locked` : "", sketches > 0 ? `${sketches} sketch${sketches === 1 ? "" : "es"}` : "", retired > 0 ? `${retired} retired` : ""].filter(Boolean).join(" · ")}{pendingSuffix(pending)}</span>
    </div>
    <Button variant="primary" className="fy-kind-new" onClick={() => navigate(newPath)}><Plus /> New</Button>
  </div>;
  return (
    <div data-screen={screenId}>
      <div className="fy-corner">
        <Button variant="primary" onClick={() => navigate(newPath)}>
          New {kind}
        </Button>
      </div>
      <SheetKindNav active={kind} />
      {(phone || (compact && sheets.length === 0 && pending.length === 0)) && <div className="fy-cast-mobile-head">{ledgerHead}</div>}
      {/* An empty state means "nothing here", never "something is on its way" (issue 228). One
          drafting row is enough to make this list a list. */}
      {sheets.length === 0 && pending.length === 0 ? (
        <div style={{ paddingTop: 140 }}>
          <EmptyState title={`No ${kind}s yet`} hint={hint} />
        </div>
      ) : (
        <div className="fy-split">
          {featured && (
            <div className="fy-split__side">
              <div className="fy-feature">
                <div className="fy-feature__frame fy-imghost">
                  {kind === "character" ? (
                    <ImageDialog
                      worldSlug={slug}
                      path={characterPortraitPath(world, featured.id)}
                      label={featured.name}
                      dialogLabel={`${featured.name} portrait`}
                      title={featured.name}
                      subtitle="main photo"
                      triggerLabel={`View larger portrait of ${featured.name}`}
                      closeLabel="Close portrait"
                      triggerClassName="fy-feature__portrait-button"
                      download
                      downloadName={`${featured.name} main photo`}
                    />
                  ) : (
                    <Portrait
                      worldSlug={slug}
                      path={sheetPortraitPath(featured.id)}
                      label={featured.name}
                      radius={9}
                    />
                  )}
                </div>
                <div className="fy-feature__copy">
                <div className="fy-feature__title">
                  <span>{featured.name}</span>
                  <span
                    className={cx("fy-dot", featured.status === "locked" ? "fy-dot--ok" : "fy-dot--sketch")}
                  />
                  <span className="fy-feature__note">
                    <span className={`fy-dot fy-feature__status-dot fy-dot--${featured.status === "locked" ? "ok" : "sketch"}`} />
                    {featured.status === "locked" ? "canon locked" : "sketch"}
                  </span>
                </div>
                <div className="fy-feature__sub">{limitedFeatureCopy(featureCopy(featured))}</div>
                </div>
                <div className="fy-feature__actions">
                  <Button variant="primary" size="sm" onClick={() => navigate(detailPath(featured.id))}>
                    Open sheet
                  </Button>
                  {kind === "character" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/w/${worldId}/cast/${featured.id}/looks`)}
                    >
                      More looks
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}
          <div className="fy-split__main">
            {!phone && ledgerHead}
            <div className="fy-ledger">
              <PendingSheetRows worldId={worldId} pending={pending} />
              {sheets.map((sheet) => (
                <button
                  key={sheet.id}
                  type="button"
                  className={cx("fy-row", featured?.id === sheet.id && "fy-row--selected")}
                  aria-label={`${sheet.name}, ${sheet.status === "locked" ? "canon locked" : "sketch"}, ${reachOf(sheet)}, ${referenceSummary(world?.referenceKits.find(kit => kit.sheetId === sheet.id)).detail}${featured?.id === sheet.id ? ", featured" : ""}. Open sheet`}
                  onClick={() => navigate(detailPath(sheet.id))}
                >
                  <div className="fy-row__thumb">
                    <Portrait
                      worldSlug={slug}
                      path={
                        kind === "character"
                          ? characterPortraitPath(world, sheet.id)
                          : kind === "location"
                            ? locationPortraitPath(world, sheet.id)
                            : sheetPortraitPath(sheet.id)
                      }
                      label={sheet.name}
                      radius={6}
                    />
                  </div>
                  <div className="fy-row__copy" style={{ minWidth: 0 }}>
                    <div className="fy-row__name">{sheet.name}</div>
                    <div className="fy-row__sub">{roleOf(sheet)}</div>
                  </div>
                  {/*
                    The status is a word, not a tint (issue 1010, U3). A dot after every name on a
                    list of names is the same colour on most of them and carries no key, so it
                    reads as decoration; the head above already counts the two states, and the
                    row's own strip is where the rest of its facts are.
                  */}
                  <span className="fy-row__meta" title={referenceSummary(world?.referenceKits.find(kit => kit.sheetId === sheet.id)).detail}>
                    {sheet.status === "locked" ? "locked" : "sketch"} · {reachOf(sheet)}
                  </span>
                  <span className="fy-row__chev">
                    <ChevronRight />
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function CastScreen() {
  const { worldId } = useParams();
  return (
    <SheetGrid
      kind="character"
      screenId="cast"
      title="Cast"
      hint="Start with a sentence."
      newPath={`/w/${worldId}/cast/new`}
      detailPath={(id) => `/w/${worldId}/cast/${id}`}
    />
  );
}

/**
 * First sentence of a sheet's first section — the card sub-line.
 *
 * Length is deliberately not this function's business. It used to hand back a 120-character
 * slice, which cut mid-word with no ellipsis ("They tax what moves, pardon ") and still wrapped
 * to a different number of lines per card. The card clamps to two lines in CSS instead, which
 * ellipsises at the real line break; here we only pick the sentence and flatten the markdown's
 * hard wrapping so it measures as one run of text.
 */
function SheetPreview({ text }: { text: string }) {
  // Parse before choosing the sentence: markup can straddle its punctuation or carry link labels.
  // Memoize by source so unrelated snapshot updates do not reparse every visible card.
  return useMemo(() => firstSentence(readOnlyMarkdownText(text) ?? text), [text]);
}

/** One sentence of prose on one line: markdown's hard wrapping flattened, the rest dropped. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const stop = flat.indexOf(". ");
  return stop > 0 ? flat.slice(0, stop + 1) : flat;
}

export function LocationsScreen() {
  const phone = usePhone();
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const places = (world?.sheets ?? []).filter((s) => s.type === "location" && !s.retired);
  const pending = pendingSheets(world?.proposals ?? [], "location", world?.conversations ?? []);
  return (
    <div data-screen="locations">
      <div className="fy-corner">
        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/locations/new`)}>
          New location
        </Button>
      </div>
      <SheetKindNav active="location" />
      <div className="fy-hero fy-kind-head">
        <div className="fy-hero__eyebrow">
          {phone ? `${places.filter(s => s.status === "locked").length} canon-locked · ${places.filter(s => s.status !== "locked").length} sketches` : `${world?.meta.name} · ${places.length} place${places.length === 1 ? "" : "s"}`}
          {pendingSuffix(pending)}
        </div>
        <h1 className="fy-hero__title fy-kind-title">
          {phone ? `Places · ${places.length}` : "Locations"}
        </h1>
        <Button variant="primary" className="fy-kind-new" onClick={() => navigate(`/w/${worldId}/locations/new`)}><Plus /> New</Button>
      </div>
      <div
        className={`fy-cardgrid fy-location-grid fy-kind-grid fy-kind-grid--${Math.min(Math.max(places.length + pending.length, 2), 4)}`}
      >
        {/* Pending cards lead, and it has to be the markup rather than a comment: a world with
            a screen's worth of places would otherwise put the one just submitted below the
            fold, which is the same "did that work?" the empty state caused (issue 228). */}
        <PendingSheetCards worldId={worldId} pending={pending} />
        {places.map((s) => (
          <button
            key={s.id}
            type="button"
            className="fy-gridcard fy-gridcard--media fy-gridcard--fixed"
            onClick={() => navigate(`/w/${worldId}/locations/${s.id}`)}
          >
            <div className="fy-gridcard__frame">
              <Portrait
                worldSlug={world?.meta.slug}
                path={locationPortraitPath(world, s.id)}
                label={`${s.name}: establishing view`}
              />
            </div>
            <div className="fy-gridcard__pad">
              {/* No dot: the foot two lines below already says locked or sketch (issue 1010). */}
              <div className="fy-gridcard__title">
                <span className="fy-gridcard__name">{s.name}</span>
              </div>
              <div className="fy-gridcard__body"><SheetPreview text={s.sections[0]?.body ?? ""} /></div>
              <div className="fy-gridcard__foot fy-gridcard__foot--spaced">
                {s.status === "locked" ? `locked · v${s.version}` : `sketch · v${s.version}`}
                {s.canonRules.length > 0 ? ` · ${s.canonRules.join(", ")}` : ""}
              </div>
            </div>
          </button>
        ))}
        {/* An empty state means "nothing here", never "something is on its way" (issue 228). */}
        {places.length === 0 && pending.length === 0 && (
          <EmptyState title="No locations yet" hint="Where the world happens — look, sound, customs." />
        )}
      </div>
    </div>
  );
}

export function FactionsScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const factions = (world?.sheets ?? []).filter((s) => s.type === "faction" && !s.retired);
  const pending = pendingSheets(world?.proposals ?? [], "faction", world?.conversations ?? []);
  const facet = (s: (typeof factions)[number], heading: string) =>
    s.sections.find((x) => x.heading.toLowerCase().includes(heading))?.body ?? null;
  return (
    <div data-screen="factions">
      <div className="fy-corner">
        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/factions/new`)}>
          New faction
        </Button>
      </div>
      <SheetKindNav active="faction" />
      <div className="fy-hero fy-kind-head">
        <div className="fy-hero__eyebrow">
          {world?.meta.name} · {factions.length} faction{factions.length === 1 ? "" : "s"}
          {pendingSuffix(pending)}
        </div>
        <h1 className="fy-hero__title fy-kind-title">
          Factions
        </h1>
        <Button variant="primary" className="fy-kind-new" onClick={() => navigate(`/w/${worldId}/factions/new`)}><Plus /> New</Button>
      </div>
      <div
        className={`fy-cardgrid fy-faction-grid fy-kind-grid fy-kind-grid--${Math.min(Math.max(factions.length + pending.length, 2), 3)}`}
      >
        <PendingSheetCards worldId={worldId} pending={pending} />
        {factions.map((s) => {
          const wants = facet(s, "want");
          const fears = facet(s, "fear");
          return (
            <button
              key={s.id}
              type="button"
              className="fy-gridcard fy-gridcard--media fy-gridcard--fixed fy-gridcard--fixed-faction"
              onClick={() => navigate(`/w/${worldId}/factions/${s.id}`)}
            >
              <div className="fy-gridcard__frame">
                <Portrait
                  worldSlug={world?.meta.slug}
                  path={sheetPortraitPath(s.id)}
                  label={`${s.name}: emblem or scene`}
                />
              </div>
              <div className="fy-gridcard__pad">
                {/* No dot: the foot says locked or sketch in words (issue 1010). */}
                <div className="fy-gridcard__title">
                  <span className="fy-gridcard__name">{s.name}</span>
                </div>
                <div className="fy-gridcard__body"><SheetPreview text={s.sections[0]?.body ?? ""} /></div>
                {/*
                  Both lines render whichever facets the sheet has. A faction with no fears keeps
                  a blank line rather than a shorter card, so a sketch sits level beside a written
                  one — the rule the cast fan follows for an empty role.
                */}
                <div className="fy-wants">
                  <div className="fy-wants__line">
                    {wants && (
                      <>
                        <b>wants:</b> <SheetPreview text={wants} />
                      </>
                    )}
                  </div>
                  <div className="fy-wants__line">
                    {fears && (
                      <>
                        <b>fears:</b> <SheetPreview text={fears} />
                      </>
                    )}
                  </div>
                </div>
                <div className="fy-gridcard__links">
                  {s.links.slice(0, 3).map((l) => (
                    <span key={l} className="fy-pill" style={{ padding: "2px 10px", fontSize: 11 }}>
                      {l}
                    </span>
                  ))}
                </div>
                <div className="fy-gridcard__foot" style={{ marginTop: 10 }}>
                  {s.status === "locked" ? "locked" : "sketch"} · v{s.version}
                </div>
              </div>
            </button>
          );
        })}
        {factions.length === 0 && pending.length === 0 && (
          <EmptyState title="No factions yet" hint="Groups with wants and fears." />
        )}
      </div>
    </div>
  );
}

// ---- Sheet detail ----------------------------------------------------------

/**
 * The voice card's play control (design 3a): hear the character in their own voice, reading
 * their own line. Local voices synthesise free and immediately, so the control is the plain
 * circle. A cloud voice that has not been generated yet states its price on the control before
 * it is pressed (SPEC-011 R-10) and becomes the circle once there is something to replay.
 */
function VoiceCard({
  worldId,
  sheet,
  worldSlug,
  onChange,
}: {
  worldId: string | undefined;
  sheet: Sheet;
  worldSlug: string;
  onChange: () => void;
}) {
  const voice = sheet.voice;
  const models = useStore().state?.app.manifest?.models ?? [];
  const world = useWorld();
  const sample = world?.referenceKits.find(k => k.sheetId === sheet.id)?.designatedVoiceSample;
  const sampleClip: Clip | null = sample ? { id: `${sheet.id}/${sample.file}`, url: mediaUrl(worldSlug, `references/${sheet.id}/${sample.file}`), title: `${sheet.name} · assigned voice reference` } : null;
  const provider = voice ? providerIdOf(voice.provider) : null;
  const candidates = useVoiceCandidates()[sheet.id];
  const voiceAudio = useVoiceAudio();
  const [requestId, setRequestId] = useState<string | null>(null);
  const pendingRequest = useRef<string | null>(null);
  const result = requestId ? voiceAudio[requestId] : undefined;
  const [uploadConfirmation, setUploadConfirmation] = useState<{
    destinationLabel: string;
    confirmationToken: string;
    destinationNotice?: string;
  } | null>(null);
  const played = useRef<string | null>(null);
  const voiceModel = voice
    ? (voice.model ?? legacyVoiceModel(voice.provider, voice.voiceId, world?.clonedVoices ?? []) ?? null)
    : null;
  const cloudPrice =
    voice && voiceModel
      ? (candidates?.previewMicroUsdByVoice[
          voiceTargetKey({ provider: voice.provider, model: voiceModel, voiceId: voice.voiceId })
        ] ??
        candidates?.cloudPreviewMicroUsd ??
        null)
      : (candidates?.cloudPreviewMicroUsd ?? null);

  // The price of a cloud preview rides along with the catalogue, which costs nothing to ask for.
  useEffect(() => {
    if (worldId && provider !== null && provider !== "kokoro" && !candidates)
      requestVoiceCandidates(worldId, sheet.id);
  }, [worldId, provider, candidates, sheet.id]);

  const clip: Clip | null =
    result?.status === "ready" && result.file
      ? {
          id: result.requestId,
          url: mediaUrl(worldSlug, result.file),
          title: `${sheet.name} · voice`,
          sub: `${voice?.label ?? provider} · reads their own line`,
        }
      : null;

  useEffect(() => {
    if (clip && played.current !== clip.id) {
      played.current = clip.id;
      void playClip(clip);
    }
  }, [clip?.id]);

  const busy = Boolean(requestId && !result);
  const start = (voiceUploadConfirmedFor?: string) => {
    if (worldId && provider && voice && voiceModel) {
      const next = requestVoicePreview(
        worldId,
        sheet.id,
        provider,
        voiceModel,
        voice.voiceId,
        voiceUploadConfirmedFor,
      );
      pendingRequest.current = next;
      setRequestId(next);
    }
  };
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== pendingRequest.current) return;
        setUploadConfirmation(confirmation);
      }),
    [],
  );
  return (
    <>
      <div className="fy-voicecard">
        {/* Not generated, and generating would charge: the price goes on the control rather than
          behind it (R-10). Everything else is the plain circle. */}
        {sampleClip ? <ClipPlayButton large clip={sampleClip} label={`Hear ${sheet.name}’s assigned voice reference`} /> : voice && provider !== "kokoro" && !clip ? (
          <Button variant="ghost" disabled={busy} onClick={() => start()}>
            {busy
              ? "Preparing…"
              : `Hear this voice${cloudPrice !== null ? ` · ${speechPlanLabel(models.find(model => model.provider === voice.provider && model.id === voiceModel)) ?? `${models.some(model => model.provider === voice.provider && model.id === voiceModel && model.pricing.kind === "perToken") ? "~" : ""}${formatMicroUsd(cloudPrice)}`}` : ""}`}
          </Button>
        ) : (
          voice &&
          provider && (
            <ClipPlayButton
              large
              clip={clip}
              busy={busy}
              onStart={() => start()}
              label={`Hear ${sheet.name}'s voice`}
            />
          )
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="fy-voicecard__label">
            {sample ? "Character voice reference assigned" : voice ? (voice.label ?? voice.provider) : "No voice assigned"}
          </div>
          <div className="fy-voicecard__meta">
            {result?.status === "failed" && result.error
              ? result.error
              : sample ? "Recorded sample · compatible scene models" : voice
                ? `${voice.provider} · text-to-speech assignment`
                : "Assign a recorded reference or choose a text-to-speech voice"}
          </div>
          {voice && !sample && (
            <div className="fy-voicecard__wave">
              <Wave
                seed={`${voice.provider}/${voiceModel ?? "legacy"}/${voice.voiceId}`}
                height={22}
                stretch
              />
            </div>
          )}
        </div>
        <div className="fy-voicecard__side">
          <Button onClick={onChange}>Manage voice</Button>
        </div>
      </div>
      {uploadConfirmation && (
        <RemoteVoiceUploadConfirmation
          destinationLabel={uploadConfirmation.destinationLabel}
          destinationNotice={uploadConfirmation.destinationNotice}
          onCancel={() => {
            setUploadConfirmation(null);
            pendingRequest.current = null;
            setRequestId(null);
          }}
          onConfirm={() => {
            const token = uploadConfirmation.confirmationToken;
            setUploadConfirmation(null);
            setRequestId(null);
            start(token);
          }}
        />
      )}
    </>
  );
}

function SheetDetail({ screenId, kindLabel }: { screenId: string; kindLabel: string }) {
  const phone = usePhone();
  const compact = useCompact();
  const { worldId, sheetId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const sheet = useSheet(worldId, sheetId);
  const navigate = useNavigate();
  const voiceAudio = useVoiceAudio();
  // Read-aloud is shared across the sheet's sections; the state tracks which one the user last
  // asked to hear so the clip, cost note and failure attach to the right block. Any section the
  // sheet's shape declares, not the original Essence/Appearance pair (issue 857) — a location's
  // Look and a faction's Wants are prose of the same kind, on screens that could not be heard.
  const [read, setRead] = useState<{ requestId: string; section: string } | null>(null);
  const readResult = read ? voiceAudio[read.requestId] : undefined;
  const [submittedRead, setSubmittedRead] = useState<string | null>(null);
  // A cloned narrator's recording is asked about before the price (issue 1215); the answer rides
  // on every later frame of the section's read. The page read keeps its own in `usePageRead`.
  const liveRead = useRef<string | null>(null);
  liveRead.current = read?.requestId ?? null;
  const upload = useVoiceUploadAsk(() => liveRead.current);
  // Reading a section aloud is narration, not dialogue: it uses the app's narrator, so it does
  // not depend on this character having a voice of their own. Gating it on `sheet.voice` was
  // the client half of the same mistake the coordinator made — prose ABOUT somebody read in
  // their voice, and unreadable for the many characters who have none. Named as this world will
  // hear it (SPEC-046 R-37): a clone is its own world's, a choice that cannot narrate here is
  // named as the shipped local voice it falls to, and once the section lands, the voice that read it.
  const storedNarrator = useStore().state?.app.narrator ?? null;
  const manifestModels = useStore().state?.app.manifest?.models ?? [];
  // The reader names its plan where a price would show (design turn 182): `· free plan`.
  const readerPlan = speechPlanLabel(manifestModels.find((model) => model.provider === (readResult?.provider ?? storedNarrator?.provider) && model.id === (readResult?.model ?? storedNarrator?.model)));
  const narratorLabel = `${narratorLabelFor(storedNarrator, worldId, readResult?.status === "ready" ? readResult : undefined)}${readerPlan !== null ? ` · ${readerPlan}` : ""}`;
  /*
   * A long section arrives in pieces — a local read's synthesis chunks, and a cloud read over
   * its reader's cap (issue 1208) — each queued as it lands so the first sounds while the rest
   * are still being made; the player walks on to the next. This screen used to play only the
   * newest event, so a second piece replaced the first mid-sentence. A short section still
   * arrives whole and takes the single-clip path below, unchanged.
   *
   * Cloud pieces land in whatever order the reader finishes them, so the effect follows how
   * many exist rather than how far the array reaches (codex on PR 1210): a second piece landing
   * first fills the array to its final length, and the first piece filling the gap behind it
   * would otherwise change nothing the effect watches.
   */
  const parts = useVoiceParts()[read?.requestId ?? ""] ?? [];
  const landed = parts.filter((file) => file !== undefined).length;
  const queued = useRef(0);
  useEffect(() => {
    if (!read || !world || !sheet) return;
    for (let i = queued.current; i < parts.length; i += 1) {
      const file = parts[i];
      if (file === undefined) return; // a gap means the piece is still being made; wait for it
      void enqueueClip({
        id: read.requestId,
        url: mediaUrl(world.meta.slug, file),
        title: `${sheet.name} · ${read.section}`,
        sub: `read aloud · ${narratorLabel}`,
        part: i,
      });
      queued.current = i + 1;
    }
  }, [read?.requestId, read?.section, landed, world?.meta.slug, sheet?.name, narratorLabel]);
  // A read the user asked for plays as soon as it lands, rather than making them click twice.
  useEffect(() => {
    if (parts.length > 0) return; // a streamed read is already sounding
    if (read && readResult?.status === "ready" && readResult.file && world && sheet) {
      void playClip({
        id: readResult.requestId,
        url: mediaUrl(world.meta.slug, readResult.file),
        title: `${sheet.name} · ${read.section}`,
        sub: `read aloud · ${narratorLabel}`,
      });
    }
  }, [
    read?.section,
    readResult?.requestId,
    readResult?.status,
    readResult?.file,
    parts.length,
    world?.meta.slug,
    sheet?.name,
    narratorLabel,
  ]);
  /*
   * What the sheet reads as a page, and in what order (issue 859).
   *
   * Declared, never derived — and declared to match what the screen draws: the Essence is
   * lifted out as the lead paragraph and the rest follow in the grid, so that is the order.
   * Between them sit a portrait, a voice card and a row of buttons, and narration taken from
   * the page as laid out would try to read those. Empty blocks never enter, so the page never
   * announces a heading and then says nothing.
   */
  const pageBlocks = useMemo<PageReadBlock[]>(() => {
    const sections = sheet?.sections ?? [];
    const lead = sheet?.type === "character" ? sections.find((s) => s.heading === "Essence") : undefined;
    return (lead ? [lead, ...sections.filter((s) => s !== lead)] : sections)
      .filter((s) => s.body.trim() !== "" && s.body.trim() !== "—")
      .map((s) => ({ heading: s.heading, body: s.body }));
  }, [sheet?.type, sheet?.sections]);
  const pageRead = usePageRead({
    pageId: sheet?.id,
    title: sheet?.name ?? "",
    narrator: storedNarrator,
    worldId,
    worldSlug: world?.meta.slug,
    blocks: pageBlocks,
    start: (requestId, confirmationToken, voiceUploadConfirmedFor, defaultNarrator) =>
      readSheetPage(
        worldId ?? "",
        sheet?.id ?? "",
        pageBlocks.map((block) => block.heading),
        requestId,
        confirmationToken,
        voiceUploadConfirmedFor,
        defaultNarrator,
      ),
  });
  const sheetRefsMap = useSheetRefs();
  const [renaming, setRenaming] = useState<string | null>(null);
  // A character's short name, edited with the name (design turn 194, rule 12b); empty is the default.
  const [shortDraft, setShortDraft] = useState("");
  const [aliasesDraft, setAliasesDraft] = useState("");
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const lifecycle = useSingleAct();
  const { talk: talkAboutSheet, starting: sheetTalkStarting } = useTalkItThrough(worldId);

  useEffect(() => {
    if (worldId && sheetId) requestSheetRefs(worldId, sheetId);
  }, [worldId, sheetId]);

  if (!world || !sheet) {
    return (
      <Screen id={screenId}>
        <EmptyState title={`Opening ${kindLabel}…`} />
      </Screen>
    );
  }
  const rules = world.canon.filter((c) => sheet.canonRules.includes(c.id));
  const kit = world.referenceKits.find((k) => k.sheetId === sheet.id);
  const sheetPath = `${sheet.type === "character" ? "characters" : `${sheet.type}s`}/${sheet.id}.md`;
  const refs = sheetRefsMap[sheet.id];
  const sheetTakes = refs ? Object.values(refs.takesByVersion).reduce((a, b) => a + b, 0) : 0;
  const references = referenceSummary(kit);
  const isCharacter = sheet.type === "character";
  const aliasNames = aliasesDraft.split(/\r?\n/).map(name => name.trim()).filter(Boolean);
  const aliasesValid = CharacterAliasesInputSchema.safeParse(aliasNames).success;
  const mainPhoto = kit ? mainPhotoFor(kit) : null;
  const characterSheet = kit ? designatedCompilation(kit) : null;
  const slug = world.meta.slug;
  // The Essence is the lead paragraph under the name (design 3a); the grid holds the rest.
  const essence = isCharacter ? sheet.sections.find((s) => s.heading === "Essence") : undefined;
  const gridSections = essence ? sheet.sections.filter((s) => s !== essence) : sheet.sections;
  // The read controls, the loaded clip and the cost note for one section. Every section shares
  // this; each shows its own speaker on hover and its own "preparing"/confirmation state.
  const sectionAudio = (heading: string) => {
    const active = read?.section === heading ? readResult : undefined;
    const clip: Clip | null =
      active?.status === "ready" && active.file
        ? {
            id: active.requestId,
            url: mediaUrl(slug, active.file),
            title: `${sheet.name} · ${heading}`,
            sub: `read aloud · ${narratorLabel}`,
          }
        : null;
    // `shipped` reads this section once in the shipped narrator: a free plan's limit (turn 182).
    const readSection = (shipped: boolean) => {
      if (!worldId) return;
      // A second read replaces the first: two voices over one another is never what was meant.
      pageRead.stop();
      queued.current = 0;
      clearQueue();
      upload.drop();
      setRead({ requestId: readSheetSection(worldId, sheet.id, heading, undefined, undefined, undefined, shipped || undefined), section: heading });
    };
    const onRead = () => readSection(false);
    const quote = `${read?.requestId}:${active?.confirmationToken ?? ""}`;
    const cancel = () => { upload.drop(); setRead(null); };
    // The vendor's question comes before the price (issue 1215), and both are this section's
    // only while its read is the live one.
    const confirmation = read?.section === heading && upload.asked !== null ? (
      <RemoteVoiceUploadConfirmation
        destinationLabel={upload.asked.destination}
        destinationNotice={upload.asked.notice}
        onCancel={cancel}
        onConfirm={() => {
          const token = upload.answer();
          if (worldId && read && token !== null) readSheetSection(worldId, sheet.id, heading, read.requestId, undefined, token);
        }}
      />
    ) : active?.status === "confirmation-required" && quote !== submittedRead ? (
      <ReadAloudConfirmation title={`${sheet.name} · ${heading}`} result={active} onCancel={cancel} onConfirm={token => {
        if (worldId && read) {
          setSubmittedRead(quote);
          readSheetSection(worldId, sheet.id, heading, read.requestId, token, upload.allowed());
        }
      }} />
    ) : null;
    const note = read?.section === heading && (!active || (active.status === "confirmation-required" && submittedRead === quote))
      ? <span className="fy-textactions__note">Preparing audio…</span> : undefined;
    return { clip, onRead, onReadShipped: () => readSection(true), note, confirmation };
  };
  // Text with the hover read-aloud/copy affordance (design 3a). The prose element differs by
  // section — a lead paragraph, a grid cell — so the caller passes it; the host is the same.
  const readableProse = (heading: string, body: string, prose: ReactNode) => {
    const { clip, onRead, onReadShipped, note, confirmation } = sectionAudio(heading);
    return (
      <div className="fy-texthost">
        {confirmation}
        {prose}
        <TextActions clip={clip} onRead={onRead} copyText={body} readLabel="Read aloud" note={note} />
        {read?.section === heading && readResult?.status === "failed" && freePlanStop(readResult.error) !== null && (
          <FreePlanStop error={readResult.error} onDefaultNarrator={onReadShipped} />
        )}
        {read?.section === heading && readResult?.status === "failed" && freePlanStop(readResult.error) === null && (
          <Callout tone="warning" title="Read aloud unavailable">
            {readResult.error}{" "}
            {sheet.voice?.provider === "kokoro" && (
              <Button variant="ghost" onClick={() => navigate("/settings/providers?provider=voxa")}>
                Local voices
              </Button>
            )}
          </Callout>
        )}
      </div>
    );
  };
  const side = isCharacter ? (
    <div className="fy-sheet__side">
      <div className="fy-fan__drift">
        <div className="fy-designcard">
          <div className="fy-designcard__frame">
            {/*
                  The main photo is a way in, not a thing to look at.

                  It used to open a larger copy of itself, which is the one thing somebody
                  looking at a character's identity anchor already has — the picture is right
                  there. What they want from it is the set it anchors: the kit, its tiles, and
                  what is still outstanding. So the picture goes where the picture leads.
                */}
            <button
              type="button"
              className="fy-designcard__portrait-button"
              aria-label={`Open ${sheet.name}'s identity reference set`}
              onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/kit`)}
            >
              <Portrait
                worldSlug={slug}
                path={mainPhoto ? `references/${sheet.id}/${mainPhoto.file}` : sheetPortraitPath(sheet.id)}
                label={`${sheet.name}: main photo`}
                radius={8}
              />
            </button>
          </div>
          <div className="fy-designcard__caption">
            <span className="fy-designcard__title">Main photo</span>
            <span className={`fy-dot fy-designcard__desktop-dot fy-dot--${mainPhoto ? "ok" : "sketch"}`} />
            <span className="fy-designcard__note"><span className={`fy-dot fy-designcard__compact-dot fy-dot--${mainPhoto ? "ok" : "sketch"}`} />{mainPhoto ? "Chosen" : "Not made yet"}</span>
          </div>
        </div>
      </div>
      <button
        type="button"
        className="fy-overview-sheet"
        onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/kit`)}
      >
        <span>
          <Portrait
            worldSlug={slug}
            path={characterSheet ? `references/${sheet.id}/${characterSheet.file}` : ""}
            label="Not made yet"
            radius={9}
          />
        </span>
        <strong>Character sheet</strong>
        <small className={characterSheet ? undefined : "fy-overview-sheet__missing"}>{characterSheet ? "Current" : "Not made yet"}</small>
        <span className="fy-overview-sheet__chevron"><ChevronRight /></span>
      </button>
    </div>
  ) : null;
  const characterTabs = isCharacter && (
    <nav className="fy-seg fy-character-overview-tabs" aria-label="Character pages">
      <span className="fy-seg__item fy-seg__item--active" aria-current="page">Overview</span>
      <button type="button" className="fy-seg__item" onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/kit`)}>
        Reference
      </button>
      <button type="button" className="fy-seg__item" onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/looks`)}>
        More looks
      </button>
      <button type="button" className="fy-seg__item" onClick={() => navigate(`/w/${worldId}/cast/${sheet.id}/voice`)}>
        Voice
      </button>
    </nav>
  );
  const sheetHeading = (
    <h1
      className={isCharacter ? "fy-sheet__name" : "fy-locdetail__name"}
      style={isCharacter ? undefined : { marginTop: 10 }}
    >
      {sheet.name}
    </h1>
  );
  const header = <div className="fy-sheet__header">
    <div className="fy-sheet__eyebrow">{sheet.type}{sheet.role ? ` · ${sheet.role}` : ""}</div>
    {isCharacter ? <div className="fy-sheet__heading">{sheetHeading}{characterTabs}</div> : sheetHeading}
  </div>;
  const details = (
    <>
      <div
        className="fy-sheet__grid"
        style={isCharacter ? undefined : { gridTemplateColumns: "1fr", gap: 14 }}
      >
        {gridSections.filter((s) => s.body.trim() !== "" && s.body.trim() !== "—").map((s) => {
          // Every section carries authored prose, so every one earns the hover read-aloud — once
          // it holds real text. It used to be Appearance alone, which meant a location sheet or a
          // faction sheet had no readable block at all.
          const body = <div className="fy-sheet__secbody"><ReadOnlyMarkdown value={s.body} ariaLabel={`${sheet.name} · ${s.heading}`} /></div>;
          return (
            <div key={s.heading}>
              {/* Every heading on a location record used to carry the sheet's status as a dot —
                  the same colour on all of them, saying once per section what the badge under the
                  name says once for the record (issue 1010, U3). */}
              <div className="fy-sheet__sechead">{s.heading}</div>
              {readableProse(s.heading, s.body, body)}
            </div>
          );
        })}
      </div>
      {rules.length > 0 && (
        <Section title="Canon rules" aside={<span>owned by canon — edit in canon, not here</span>}>
          {rules.map((rule) => (
            <div key={rule.id} className="scr-canonrule">
              {compact ? (
                <button className="fy-sheet-canon-link mono" aria-label={`Edit ${rule.id} in canon`} onClick={() => navigate(`/w/${worldId}/canon/${rule.id}`)}>{rule.id}</button>
              ) : <span className="mono" style={{ color: "var(--muted-foreground)" }}>{rule.id}</span>}
              <span className="scr-prose">{rule.body}</span>
              {!compact && <span className="scr-canonrule__note">
                <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/canon/${rule.id}`)}>
                  Edit in canon →
                </Button>
              </span>}
            </div>
          ))}
        </Section>
      )}
      {(sheet.links.length > 0 || (refs?.incomingLinks.length ?? 0) > 0) && (
        <Section title="Linked">
          <div className="fy-sheet-links">
            {sheet.links.map((link) => {
              const other = world.sheets.find((s) => s.id === link);
              if (!other)
                return (
                  <Badge key={link} tone="outline">
                    {link}
                  </Badge>
                );
              const base = other.type === "character" ? "cast" : `${other.type}s`;
              return (
                <Button
                  key={link}
                  variant="secondary"
                  className="fy-sheet-link"
                  onClick={() => navigate(`/w/${worldId}/${base}/${link}`)}
                >
                  <span className="fy-sheet-link__face"><Portrait worldSlug={slug} path={sheetPortraitPath(other.id)} label="" radius={16} /></span>
                  {other.name} →
                </Button>
              );
            })}
            {(refs?.incomingLinks ?? [])
              .filter((id) => !sheet.links.includes(id))
              .map((id) => {
                const other = world.sheets.find((s) => s.id === id);
                const base = other ? (other.type === "character" ? "cast" : `${other.type}s`) : "cast";
                return (
                  <Button key={id} variant="ghost" className="fy-sheet-link" onClick={() => navigate(`/w/${worldId}/${base}/${id}`)}>
                    {other && <span className="fy-sheet-link__face"><Portrait worldSlug={slug} path={sheetPortraitPath(other.id)} label="" radius={16} /></span>}
                    ← {other?.name ?? id}
                  </Button>
                );
              })}
          </div>
        </Section>
      )}
      {[references.total, refs?.productions.length ?? 0, refs?.artifacts.length ?? 0, sheetTakes].some((n) => n > 0) && <Section title="From this sheet">
        <div className="lay-stats">
          {references.total > 0 && <div className="lay-stats__item">
            <div className="lay-stats__value">{references.total}</div>
            <div className="lay-stats__label" title={references.detail}>accepted {references.total === 1 ? "reference" : "references"}</div>
          </div>}
          {refs && <>
            {refs.productions.length > 0 && <div className="lay-stats__item">
              <div className="lay-stats__value">{refs.productions.length}</div>
              <div className="lay-stats__label">{refs.productions.length === 1 ? "production" : "productions"}</div>
            </div>}
            {refs.artifacts.length > 0 && <div className="lay-stats__item">
              <div className="lay-stats__value">{refs.artifacts.length}</div>
              <div className="lay-stats__label">{refs.artifacts.length === 1 ? "artifact" : "artifacts"}</div>
            </div>}
            {sheetTakes > 0 && <div className="lay-stats__item">
              <div className="lay-stats__value">{sheetTakes}</div>
              <div className="lay-stats__label">
                {sheetTakes === 1 ? "take" : "takes"}
                {Object.keys(refs.takesByVersion).length > 1
                  ? ` across v${Object.keys(refs.takesByVersion).sort().join(", v")}`
                  : ""}
              </div>
            </div>}
          </>}
        </div>
      </Section>}
    </>
  );
  const main = (
    <div
      className={isCharacter ? "fy-sheet__main" : undefined}
      style={isCharacter ? undefined : { display: "grid", gap: "var(--space-4)", alignContent: "start" }}
    >
      <div>
        {!(phone && isCharacter) && header}
        <div className="fy-sheet__badges">
          {compact && isCharacter ? <><Badge tone="outline">v{sheet.version}</Badge><Badge tone="outline">{sheet.status === "locked" && <Lock size={10} />}{sheet.status === "locked" ? "locked" : "sketch"}</Badge></> : <Badge tone={sheet.status === "sketch" ? "outline" : "neutral"}>
            {sheet.status === "sketch" ? `sketch · v${sheet.version}` : `v${sheet.version} · locked`}
          </Badge>}
          {sheet.retired && <Badge tone="danger">retired</Badge>}
          {/* A guest reached from the world's own address says whose it is, or the sheet reads
                as a member of a cast it was deliberately kept out of (SPEC-020 R-10). */}
          {sheet.production !== undefined && <Badge tone="outline">guest of {sheet.production}</Badge>}
          {sheet.origin && (
            <Badge tone="outline">
              from {sheet.origin.sheet} v{sheet.origin.version}
            </Badge>
          )}
        </div>
        {essence && readableProse("Essence", essence.body, <div className="fy-sheet__lead"><ReadOnlyMarkdown value={essence.body} ariaLabel={`${sheet.name} · Essence`} /></div>)}
      </div>
      <div className="fy-sheet__actions">
        {/* Reference, More looks and Voice live in the tab row (design 54): a destination
              appears once per screen, so this row keeps only what the tabs do not offer. */}
        <Button
          variant={compact && isCharacter ? "primary" : "secondary"}
          onClick={() =>
            navigate(
              `/w/${worldId}/${sheet.type === "character" ? "cast" : `${sheet.type}s`}/${sheet.id}/edit`,
            )
          }
        >
          {compact && isCharacter && <Pencil />} Edit the sheet
        </Button>
        <Button
          className="fy-sheet__icon-action"
          aria-label={sheetTalkStarting ? "Starting…" : sheet.type === "character" ? "Talk about them" : "Talk about it"}
          onClick={() =>
            talkAboutSheet(sheet.name, { kind: "sheet", sheetKind: sheet.type, sheetId: sheet.id })
          }
          disabled={sheetTalkStarting}
        >
          <span className="fy-sheet__action-icon"><Message /></span>
          <span className="fy-sheet__action-label">{sheetTalkStarting ? "Starting…" : sheet.type === "character" ? "Talk about them" : "Talk about it"}</span>
        </Button>
        {/* Page scale (issue 859). The speaker on each paragraph reads that paragraph; this
              reads the sheet through, in the order declared above. Offered only when there is
              more than one block — a page read of one block is the block read with more words
              on the button. */}
        {pageBlocks.length > 1 && (compact && isCharacter && !pageRead.reading
          ? <IconButton label="Read the sheet" onClick={pageRead.begin}><Speaker /></IconButton>
          : <PageReadControl read={pageRead} label="Read the sheet" />)}
        <Button
          className="fy-sheet__icon-action"
          aria-label={sheet.status === "locked" ? "Unlock" : "Lock to canon"}
          onClick={() => {
            if (!worldId) return;
            lifecycle.track(setSheetStatus(worldId, sheetPath, sheet.status === "locked" ? "sketch" : "locked"));
          }}
          title={
            sheet.status === "locked"
              ? "Unlocking ripples: everything citing this did so as settled"
              : "Locking makes the identity settled — no image required first"
          }
        >
          <span className="fy-sheet__action-icon"><Lock /></span>
          <span className="fy-sheet__action-label">{sheet.status === "locked" ? "Unlock" : "Lock to canon"}</span>
        </Button>
      </div>
      {isCharacter && (
        <VoiceCard
          worldId={worldId}
          sheet={sheet}
          worldSlug={slug}
          onChange={() => navigate(`/w/${worldId}/cast/${sheet.id}/voice`)}
        />
      )}
      {/* A second row of words under three primary buttons read as six things to do rather than
          three and a housekeeping drawer (issue 1010, U1). The verbs are their own glyphs now,
          with the word — and, where it earns one, the consequence — in the tip. */}
      <div className="fy-sheet__quiet">
        <IconButton
          label="Rename"
          aria-pressed={renaming !== null}
          onClick={() => {
            setShortDraft(sheet.shortName ?? "");
            setAliasesDraft((sheet.aliases ?? []).join("\n"));
            setRenaming(renaming === null ? sheet.name : null);
          }}
        >
          <Pencil />
        </IconButton>
        <IconButton
          label="Duplicate"
          aria-pressed={duplicating !== null}
          onClick={() => setDuplicating(duplicating === null ? `${sheet.name} (copy)` : null)}
        >
          <Copy />
        </IconButton>
        {/* One way only (SPEC-020 R-15, D7): a sheet promoted by mistake is retired, because
              demotion would either break the citations outside the production or need an
              exception for widely-cited guests. */}
        {sheet.production !== undefined && (
          <IconButton
            label="Promote to the world"
            hint={`out of ${sheet.production}, keeping the id, every citation and the reference kit`}
            onClick={() => worldId && lifecycle.track(promoteGuest(worldId, sheetPath))}
          >
            <Users />
          </IconButton>
        )}
        <IconButton
          label="Retire"
          hint="stays resolvable for existing citations; leaves pickers for new work"
          disabled={sheet.retired === true}
          onClick={() => worldId && retireEntity(worldId, sheetPath)}
        >
          <Archive />
        </IconButton>
      </div>
      {renaming !== null && (
        <Card className="scr-form fy-sheet-inline-form">
          <div className="scr-field">
            <label className="scr-field__label">New name — the id and every citation stay</label>
            <Input value={renaming} onChange={(e) => setRenaming(e.target.value)} />
          </div>
          {/* What rows, filters and panel titles call a character; the full name stays here and on the Cast page. */}
          {isCharacter && (
            <div className="scr-field">
              <label className="scr-field__label">Short name</label>
              <Input
                value={shortDraft}
                maxLength={SHORT_NAME_MAX}
                placeholder={defaultShortName(renaming)}
                data-testid="sheet-short-name"
                onChange={(e) => setShortDraft(e.target.value)}
              />
            </div>
          )}
          {isCharacter && (
            <div className="scr-field">
              <label className="scr-field__label" htmlFor="sheet-aliases">Other names</label>
              <Textarea id="sheet-aliases" rows={2} value={aliasesDraft} maxLength={2904} data-testid="sheet-aliases" aria-describedby="sheet-aliases-hint" onChange={event => setAliasesDraft(event.target.value)} />
              <p id="sheet-aliases-hint" className="scr-field__hint">One name per line. Shared names need review. Saved pictures and recordings keep their identity.</p>
              {!aliasesValid && <p role="alert" className="fy-ch__who-where--warn">Use at most 24 names, each up to 120 characters.</p>}
            </div>
          )}
          <div className="fy-sheet-inline-form__actions">
            <Button
              variant="primary"
              disabled={renaming.trim().length === 0 || (isCharacter && !aliasesValid) || (renaming.trim() === sheet.name && (!isCharacter || (shortDraft.trim() === (sheet.shortName ?? "") && aliasesDraft.trim() === (sheet.aliases ?? []).join("\n"))))}
              onClick={() => {
                if (worldId) lifecycle.track(renameSheet(worldId, sheetPath, renaming.trim(), isCharacter && shortDraft.trim() !== (sheet.shortName ?? "") ? shortDraft.trim() : undefined, isCharacter && aliasesDraft.trim() !== (sheet.aliases ?? []).join("\n") ? aliasNames : undefined));
              }}
            >
              {renaming.trim() === sheet.name && aliasesDraft.trim() !== (sheet.aliases ?? []).join("\n") ? "Save other names" : "Rename"}
            </Button>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      {duplicating !== null && (
        <Card className="scr-form fy-sheet-inline-form">
          <div className="scr-field">
            <label className="scr-field__label">
              Duplicate as — a sketch recording its origin at v{sheet.version}; {sheet.name} is untouched
            </label>
            <Input value={duplicating} onChange={(e) => setDuplicating(e.target.value)} />
          </div>
          <div className="fy-sheet-inline-form__actions">
            <Button
              variant="primary"
              disabled={duplicating.trim().length === 0}
              onClick={() => {
                if (worldId) lifecycle.track(duplicateSheet(worldId, sheetPath, duplicating.trim()));
              }}
            >
              Duplicate
            </Button>
            <Button variant="ghost" onClick={() => setDuplicating(null)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}
      <SingleActFeedback
        result={lifecycle.result}
        undoLabel={
          lifecycle.result?.operation === "sheet-duplicate" || lifecycle.result?.operation === "guest-promotion"
            ? "Retire it"
            : "Undo"
        }
        onUndo={lifecycle.undo}
      />
      {isCharacter ? <div className="fy-sheet__details">{details}</div> : details}
    </div>
  );
  if (isCharacter) {
    return (
      <div className="fy-sheet" data-screen={screenId}>
        {phone && header}
        {side}
        {main}
      </div>
    );
  }
  // Locations and factions (prototype 23b): full-height establishing view, facts to the right.
  // A location also carries a Reference tab (issue 243, turn 57); a faction has no view set, so the
  // tabs appear only where there is a second place to go.
  const locationTabs = sheet.type === "location" && (
    <nav className="fy-seg fy-location-tabs">
      <span className="fy-seg__item fy-seg__item--active">Overview</span>
      <button
        type="button"
        className="fy-seg__item"
        onClick={() => navigate(`/w/${worldId}/locations/${sheet.id}/reference`)}
      >
        Reference
      </button>
    </nav>
  );
  return (
    <div className="fy-locdetail" data-screen={screenId}>
      <div className="fy-locdetail__hero">
        <div className="fy-locdetail__frame">
          <Portrait
            worldSlug={slug}
            path={
              sheet.type === "location" ? locationPortraitPath(world, sheet.id) : sheetPortraitPath(sheet.id)
            }
            label={`${sheet.name}: establishing view`}
            radius={12}
          />
        </div>
      </div>
      <div className="fy-locdetail__side">
        {locationTabs}
        {main}
      </div>
    </div>
  );
}

export const CharacterDetailScreen = () => <SheetDetail screenId="character-detail" kindLabel="character" />;
export const LocationDetailScreen = () => <SheetDetail screenId="location-detail" kindLabel="location" />;

// ---- Sheet edit ------------------------------------------------------------

export const CharacterEditScreen = () => <SheetEdit screenId="character-edit" />;
export const LocationEditScreen = () => <SheetEdit screenId="location-edit" />;
export const FactionEditScreen = () => <SheetEdit screenId="faction-edit" />;

function SheetEdit({ screenId }: { screenId: string }) {
  const { worldId, sheetId } = useParams();
  const sheet = useSheet(worldId, sheetId);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [stagedAt, setStagedAt] = useState<string | null>(null);
  const [editResult, setEditResult] = useState<{
    disposition: "accepted" | "merged" | "restored" | "refused";
    reason?: string;
    ripples: RippleItem[];
    undoVersion?: number;
  } | null>(null);
  const undoRequest = useRef<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const { state } = useStore();
  const harnessReady = state?.app.health.harness.status === "healthy";

  // null while untouched, so an unedited sheet stages nothing for the field at all.
  const [editedRole, setEditedRole] = useState<string | null>(null);

  const formSections = [...(sheet?.sections ?? [])];
  if (sheet?.type === "character" && !formSections.some(s => isWrittenVoiceHeading(s.heading))) formSections.push({ heading: WRITTEN_VOICE_HEADING, body: "" });
  const voiceHeading = formSections.find(s => isWrittenVoiceHeading(s.heading))?.heading;
  const sections = formSections.map((s) => ({
    heading: s.heading,
    body: edited[s.heading] ?? s.body,
  }));
  const changed = sections.filter(s => s.body !== (sheet?.sections.find(original => original.heading === s.heading)?.body ?? ""));
  // Role is a character's short line on the world hub card, and the one frontmatter field this
  // form edits. It is capped so the card can hold it on a single line (SPEC-007 §2.3.1).
  const editsRole = sheet?.type === "character";
  const role = editedRole ?? sheet?.role ?? "";
  const roleChanged = editsRole && editedRole !== null && role.trim() !== (sheet?.role ?? "");
  const changedCount = changed.length + (roleChanged ? 1 : 0);
  const dirty = changed.length > 0 || roleChanged;
  const [mode, setMode] = useState<"form" | "chat">("form");
  const world = useOpenWorldGuard(worldId);
  const worldSlug = world?.meta.slug;

  // The sheet's open studio conversation, if one is staged — sends continue it.
  const sheetDir = sheet ? (sheet.type === "character" ? "characters" : `${sheet.type}s`) : "characters";
  const chatPath = sheet ? `${sheetDir}/${sheet.id}.md` : null;
  const targetProposal =
    chatPath === null
      ? null
      : (world?.proposals.find((p) => p.proposal.targets.some((t) => t.path === chatPath)) ?? null);
  const targetDecision = targetProposal
    ? proposalDecisionOf(targetProposal.proposal, world?.conversations ?? [])
    : null;
  const chatProposal = targetDecision?.mode === "attended" && targetDecision.owner.kind === "proposal-conversation"
    ? targetProposal
    : null;
  const transcript = useTranscripts()[chatProposal?.proposal.id ?? ""] ?? [];
  const chatActivity = useAuthoring()[chatProposal?.proposal.id ?? ""];
  const chatRunning = chatActivity?.status === "running";
  useEffect(
    () =>
      subscribeSheetEditResults((result) => {
        if (result.worldId !== worldId || result.path !== chatPath) return;
        if (result.action === "edit") {
          if (result.requestId !== stagedAt) return;
          setStagedAt(null);
          setEditResult({
            disposition: result.disposition,
            ripples: result.ripples ?? [],
            ...(result.reason !== undefined ? { reason: result.reason } : {}),
            ...(result.undoVersion !== undefined ? { undoVersion: result.undoVersion } : {}),
          });
          if (result.disposition === "accepted" || result.disposition === "merged") {
            setEdited({});
            setEditedRole(null);
          }
          if (result.disposition === "merged" && result.proposalId === chatProposal?.proposal.id) setMode("chat");
          return;
        }
        if (result.requestId !== undoRequest.current) return;
        undoRequest.current = null;
        setEditResult({
          disposition: result.disposition,
          ripples: [],
          ...(result.reason !== undefined ? { reason: result.reason } : {}),
        });
      }),
    [chatPath, chatProposal?.proposal.id, stagedAt, worldId],
  );
  const sendToStudio = () => {
    if (!sheet || !worldId || !chatPath || instruction.trim().length === 0) return;
    if (chatProposal) {
      continueStudio(worldId, chatPath, chatProposal.proposal.id, instruction.trim());
    } else {
      draftWithStudio(worldId, chatPath, instruction.trim(), `Studio draft: ${sheet.name}`);
    }
    setInstruction("");
  };

  return (
    <div className="fy-gate" data-screen={screenId}>
      <div className="fy-gate__main">
        <div className="fy-gate__head">
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="fy-eyebrow-sm">EDIT SHEET{sheet ? ` · v${sheet.version}` : ""}</span>
              {sheet && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                  <span
                    className={`fy-dot fy-dot--${sheet.status === "locked" ? "ok" : "sketch"}`}
                    style={{ width: 6, height: 6 }}
                  />
                  <span className="fy-mono">
                    {sheet.status === "locked"
                      ? "canon locked · edits stay versioned"
                      : "sketch — still yours to shape"}
                  </span>
                </span>
              )}
            </div>
            <h1 className="fy-story__h1">
              {mode === "chat"
                ? `What has changed about ${sheet ? sheet.name.split(" ")[0] : "them"}?`
                : "The sheet, field by field."}
            </h1>
          </div>
          <span className="fy-seg" style={{ marginTop: 4 }}>
            <button
              type="button"
              className={cx("fy-seg__item", mode === "chat" && "fy-seg__item--active")}
              onClick={() => setMode("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              className={cx("fy-seg__item", mode === "form" && "fy-seg__item--active")}
              onClick={() => setMode("form")}
            >
              Form
            </button>
          </span>
        </div>
        <div className="fy-gate__body" style={{ gap: 14 }}>
          {editResult && (
            <div className="dom-proposal__notice" role={editResult.disposition === "refused" ? "alert" : "status"}>
              <strong>
                {editResult.disposition === "refused"
                  ? "This edit was not written."
                  : editResult.disposition === "merged"
                    ? "Your fields joined the proposal already here."
                    : editResult.disposition === "restored"
                      ? "The previous sheet version is restored."
                      : "The sheet is updated."}
              </strong>{" "}
              {editResult.reason}
              {editResult.ripples.length > 0 && (
                <div style={{ marginTop: 8 }}>
                  <div className="fy-mono">What this changed elsewhere</div>
                  {editResult.ripples.map((ripple, index) => (
                    <div key={`${ripple.kind}-${index}`} className="fy-ripplerow">
                      <span className="fy-dot fy-dot--warn" />
                      {ripple.summary}
                    </div>
                  ))}
                </div>
              )}
              <div className="dom-proposal__noticeactions">
                {editResult.disposition === "accepted" && editResult.undoVersion !== undefined && chatPath && worldId && (
                  <Button
                    onClick={() => {
                      undoRequest.current = restoreSheetVersion(worldId, chatPath, editResult.undoVersion!);
                    }}
                    disabled={undoRequest.current !== null}
                  >
                    Undo edit
                  </Button>
                )}
                <Button variant="ghost" onClick={() => setEditResult(null)}>
                  Dismiss
                </Button>
              </div>
            </div>
          )}
          {mode === "form" ? (
            <>
              {editsRole && (
                <div>
                  <div className="fy-fieldlabel">
                    Role
                    {roleChanged && <span className="fy-changedtag">· changed</span>}
                    <span className="fy-fieldcount">
                      {role.length} of {CHARACTER_ROLE_MAX}
                    </span>
                  </div>
                  <Input
                    value={role}
                    maxLength={CHARACTER_ROLE_MAX}
                    placeholder="Tide-caller"
                    onChange={(e) => setEditedRole(e.target.value)}
                  />
                </div>
              )}
              {/*
                A sheet's sections are paragraphs, not a line each, and the shared textarea's
                112px showed about four lines of them behind an inner scrollbar — two nested
                scrollers on a page that already scrolls (issue 1007). The editor is the point
                of this screen, so it gets the room; the column scrolls, as it did.
              */}
              {sections.map((s) => {
                const isChanged = changed.some(change => change.heading === s.heading);
                return (
                  <div key={s.heading}>
                    <div className="fy-fieldlabel">
                      {s.heading}
                      {isChanged && <span className="fy-changedtag">· changed</span>}
                    </div>
                    <Textarea
                      aria-label={s.heading}
                      className="fy-sheetedit__prose"
                      value={s.body}
                      onChange={(e) => setEdited((prev) => ({ ...prev, [s.heading]: e.target.value }))}
                    />
                    {editsRole && s.heading === voiceHeading && <p style={{ color: "var(--muted-foreground)", fontSize: 13 }}>The audiobook director uses up to 240 characters from the start of this section, with whitespace collapsed. Longer notes stay on the sheet.</p>}
                  </div>
                );
              })}
            </>
          ) : (
            <>
              {transcript.length === 0 && (
                <div className="fy-bubble--gate">What has changed?</div>
              )}
              {transcript.map((turn, i) => (
                <div
                  key={i}
                  className={turn.role === "user" ? "fy-bubble--user" : "fy-bubble--gate"}
                  style={{ whiteSpace: "pre-wrap" }}
                >
                  {turn.text}
                </div>
              ))}
              {chatRunning && (
                <div className="fy-bubble--gate">
                  <Loading
                    inline
                    label={
                      chatActivity?.lines[chatActivity.lines.length - 1] ?? "drafting inside the proposal…"
                    }
                  />
                </div>
              )}
              {chatProposal && <ConnectedProposalPanel key={chatProposal.proposal.id} staged={chatProposal} />}
              <div style={{ marginTop: "auto" }}>
                <Textarea
                  placeholder={
                    chatProposal
                      ? "Keep shaping her — the draft on this proposal follows the conversation."
                      : "Give her a scar from the night the verse rose early — appearance and relationships should both feel it."
                  }
                  value={instruction}
                  onChange={(e) => setInstruction(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && harnessReady && !chatRunning) {
                      e.preventDefault();
                      sendToStudio();
                    }
                  }}
                  style={{ minHeight: 110 }}
                />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                  <DictationButton
                    onText={(text) => setInstruction((prev) => (prev ? `${prev} ${text}` : text))}
                  />
                  <span className="fy-h1row__push" />
                  <Button
                    variant="primary"
                    disabled={
                      !harnessReady || !sheet || !worldId || instruction.trim().length === 0 || chatRunning
                    }
                    title={harnessReady ? undefined : "Authoring needs the harness running"}
                    onClick={sendToStudio}
                  >
                    {chatRunning ? "Drafting…" : chatProposal ? "Send" : "Draft with the studio"}
                  </Button>
                </div>
              </div>
            </>
          )}
          <DegradedBanner component="harness" />
        </div>
      </div>
      <div className="fy-gate__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>Sheet edit</div>
          <span className="fy-mono" style={{ color: dirty ? "var(--warning)" : undefined }}>
            {sheet
              ? `v${sheet.version + 1} draft · ${changedCount} field${changedCount === 1 ? "" : "s"} changed`
              : ""}
          </span>
        </div>
        <div className="fy-draftcard">
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <span style={{ width: 38, height: 44, borderRadius: 6, overflow: "hidden", flex: "none" }}>
              <Portrait
                worldSlug={worldSlug}
                path={sheet ? sheetPortraitPath(sheet.id) : ""}
                label=""
                radius={6}
              />
            </span>
            <div>
              <div style={{ font: "600 15px var(--font-sans)" }}>{sheet?.name}</div>
              <div className="fy-mono" style={{ marginTop: 2 }}>
                {sheet
                  ? `v${sheet.version} → v${sheet.version + 1}${
                      changedCount > 0
                        ? ` · ${[...(roleChanged ? ["role"] : []), ...changed.map((c) => c.heading.toLowerCase())].join(", ")}`
                        : ""
                    }`
                  : ""}
              </div>
            </div>
          </div>
          {roleChanged && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ font: "600 12.5px var(--font-sans)" }}>Role</span>
                <span className="fy-changedtag">changed</span>
              </div>
              <div
                style={{
                  font: "400 12px/1.6 var(--font-sans)",
                  color: "var(--muted-foreground)",
                  marginTop: 3,
                }}
              >
                {role.trim() === "" ? "cleared — the card shows no role" : role.trim()}
              </div>
            </div>
          )}
          {changed.slice(0, 3).map((c) => (
            <div key={c.heading} style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ font: "600 12.5px var(--font-sans)" }}>{c.heading}</span>
                <span className="fy-changedtag">changed</span>
              </div>
              <div
                style={{
                  font: "400 12px/1.6 var(--font-sans)",
                  color: "var(--muted-foreground)",
                  marginTop: 3,
                }}
              >
                {c.body.length > 160 ? `${c.body.slice(0, 157)}…` : c.body}
              </div>
            </div>
          ))}
          {changedCount === 0 && (
            <div className="fy-mono" style={{ marginTop: 12 }}>nothing changed yet</div>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 16 }} />
        <div style={{ display: "grid", gap: 8 }}>
          <Button
            variant="primary"
            disabled={!sheet || !worldId || !dirty || stagedAt !== null}
            title={dirty ? undefined : "Nothing changed yet"}
            onClick={() => {
              if (!sheet || !worldId) return;
              const dir = sheet.type === "character" ? "characters" : `${sheet.type}s`;
              const requestId = stageSheetEdit(
                worldId,
                `${dir}/${sheet.id}.md`,
                `Edit ${sheet.name}`,
                sections,
                changed.map((section) => section.heading),
                roleChanged ? role.trim() : undefined,
              );
              if (requestId !== null) {
                setStagedAt(requestId);
                setEditResult(null);
              }
            }}
          >
            {stagedAt ? "Saving…" : `Save edit · the sheet becomes v${(sheet?.version ?? 0) + 1}`}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setEdited({});
              setEditedRole(null);
            }}
            disabled={!dirty}
          >
            Discard edits · v{sheet?.version ?? "…"} stands
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- Voice ----------------------------------------------------------------

// ---- New sheet screens -----------------------------------------------------

function NewSheetScreen({
  screenId,
  title,
  sheetType,
}: {
  screenId: string;
  title: string;
  sheetType: "character" | "location" | "faction";
}) {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const { state } = useStore();
  const [name, setName] = useState("");
  const [sentence, setSentence] = useState("");
  const [tab, setTab] = useState<"sentence" | "image" | "duplicate">("sentence");
  const [copyName, setCopyName] = useState("");
  const [copySource, setCopySource] = useState<string | null>(null);
  const duplicate = useSingleAct();
  const harnessReady = state?.app.health.harness.status === "healthy";
  const characters = world?.sheets.filter((s) => s.type === "character" && !s.retired) ?? [];
  const listPath = sheetType === "character" ? "cast" : `${sheetType}s`;
  // Opened from a chapter's point of view (SPEC-056 D-4): back there with the name, and the chapter
  // chooses the character once its sheet arrives. Only an in-app address is followed.
  const [searchParams] = useSearchParams();
  const then = sheetType === "character" ? searchParams.get("then") : null;
  const returnTo = then !== null && then.startsWith("/w/") && !then.startsWith("//") ? then : null;
  const contextPills = (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
      <span className="fy-mono">drafts with:</span>
      <span className="fy-pill">
        {world?.meta.name} · canon v{world?.meta.canonRevision}
      </span>
      {world?.meta.tone && <span className="fy-pill">Tone · {world.meta.tone}</span>}
      <span className="fy-pill">
        {characters.length} existing character{characters.length === 1 ? "" : "s"}
      </span>
    </div>
  );
  const draftCta = (
    <Button
      variant="primary"
      disabled={!worldId || name.trim().length === 0 || sentence.trim().length === 0}
      onClick={() => {
        if (!worldId) return;
        createSheetFromSentence(worldId, sheetType, name.trim(), sentence.trim());
        // The time goes with the name, so the chapter takes the proposal this press stages and not
        // an older one waiting under the same name (codex on PR 1799).
        navigate(returnTo !== null ? `${returnTo}${returnTo.includes("?") ? "&" : "?"}pov-name=${encodeURIComponent(name.trim())}&pov-since=${encodeURIComponent(new Date().toISOString())}` : `/w/${worldId}/${listPath}`);
      }}
    >
      {harnessReady ? "Draft the sheet" : "Create as sketch"}
    </Button>
  );

  if (sheetType === "character") {
    // Prototype 5b: the cast-join dialog over the world's key art.
    return (
      <div className="fy-app" data-screen={screenId} style={{ minHeight: "calc(100vh - 44px)" }}>
        <div className="fy-scrim">
          <div className="fy-scrim__art">
            <Portrait worldSlug={world?.meta.slug} path={world?.keyArt ?? ""} label="" radius={0} />
          </div>
          <div className="fy-scrim__wash" />
          <div className="fy-scrim__center">
            <div className="fy-dialog" style={{ maxWidth: 620 }}>
              <div>
                <div style={{ font: "650 22px var(--font-sans)", letterSpacing: "-0.02em" }}>
                  Who's joining the cast?
                </div>
                <div
                  style={{
                    font: "400 13px/1.55 var(--font-sans)",
                    color: "var(--muted-foreground)",
                    marginTop: 6,
                  }}
                >
                  Start with a sentence. The sheet gets drafted from it, inside the canon, alongside the{" "}
                  {characters.length} who already live here.
                </div>
              </div>
              <span className="fy-seg" style={{ width: "fit-content" }}>
                {(
                  [
                    ["sentence", "From a sentence"],
                    ["image", "From an image"],
                    ["duplicate", "Duplicate a sheet"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={cx("fy-seg__item", tab === id && "fy-seg__item--active")}
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </span>
              {tab === "sentence" && (
                <>
                  <Input placeholder="Their name" value={name} onChange={(e) => setName(e.target.value)} />
                  <Textarea
                    placeholder="Who are they, and what do they want?"
                    value={sentence}
                    onChange={(e) => setSentence(e.target.value)}
                    style={{ minHeight: 96, font: "400 15px/1.6 var(--font-sans)" }}
                  />
                  {contextPills}
                </>
              )}
              {tab === "image" && (
                <div className="fy-notecard" style={{ marginTop: 0 }}>
                  <span className="fy-dot fy-dot--sketch" />
                  Drafting from an image arrives later. Meanwhile: file the image under Artifacts, then draft
                  from a sentence — appearance can cite it.
                </div>
              )}
              {tab === "duplicate" && (
                <>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                    {characters.map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        className="fy-minisheet"
                        style={
                          copySource === s.id
                            ? { border: "1.5px solid var(--foreground)", background: "var(--neutral-50)" }
                            : undefined
                        }
                        onClick={() => setCopySource(s.id)}
                      >
                        <span className="fy-minisheet__thumb">
                          <Portrait
                            worldSlug={world?.meta.slug}
                            path={sheetPortraitPath(s.id)}
                            label=""
                            radius={5}
                          />
                        </span>
                        <span style={{ minWidth: 0 }}>
                          <span className="fy-minisheet__name" style={{ display: "block" }}>
                            {s.name}
                          </span>
                          <span className="fy-minisheet__sub">
                            sheet v{s.version} · {s.status}
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                    <Input
                      placeholder="Name the copy · e.g. Bray's brother"
                      value={copyName}
                      onChange={(e) => setCopyName(e.target.value)}
                    />
                    <span className="fy-mono" style={{ flex: "none" }}>
                      copies as a new sketch · links to the source · the source is untouched
                    </span>
                  </div>
                </>
              )}
              <DegradedBanner component="harness" />
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <span style={{ font: "400 11.5px/1.5 var(--font-sans)", color: "var(--muted-foreground)" }}>
                  Lands as a sketch. Nothing is canon until you lock it.
                </span>
                <span style={{ flex: 1 }} />
                <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/${listPath}`)}>
                  Cancel
                </Button>
                {tab === "duplicate" ? (
                  <Button
                    variant="primary"
                    disabled={!worldId || copySource === null || copyName.trim().length === 0}
                    onClick={() => {
                      if (!worldId || !copySource) return;
                      duplicate.track(duplicateSheet(worldId, `characters/${copySource}.md`, copyName.trim()));
                    }}
                  >
                    Duplicate as sketch
                  </Button>
                ) : (
                  draftCta
                )}
              </div>
              <SingleActFeedback result={duplicate.result} undoLabel="Retire copy" onUndo={duplicate.undo} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Prototype 10a: the location form beside its live draft preview.
  return (
    <div className="fy-gate" data-screen={screenId}>
      <div className="fy-gate__main">
        <div className="fy-gate__head">
          <div style={{ flex: 1 }}>
            <div className="fy-eyebrow-sm">{title.toUpperCase()}</div>
            <h1 className="fy-story__h1">Just the fields.</h1>
          </div>
        </div>
        <div className="fy-gate__body">
          <div>
            <div className="fy-fieldlabel">Name</div>
            <Input placeholder="The Bell Market" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <div className="fy-fieldlabel">One sentence to draft from</div>
            <Textarea
              placeholder="A church that forgot it was one — stalls in the nave, the great bell still hanging."
              value={sentence}
              onChange={(e) => setSentence(e.target.value)}
            />
            <span className="fy-mono" style={{ display: "block", marginTop: 6 }}>
              {harnessReady
                ? "the studio drafts look, sound and customs from this, against canon and tone"
                : "without the harness running, the sentence seeds the sheet as-is — still a sketch through the gate"}
            </span>
          </div>
          {contextPills}
          <DegradedBanner component="harness" />
        </div>
      </div>
      <div className="fy-gate__side">
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <div style={{ font: "600 15px var(--font-sans)" }}>{title} draft</div>
          <span className="fy-mono" style={{ color: "var(--warning)" }}>
            proposed
          </span>
        </div>
        <div className="fy-draftcard" style={{ padding: 14 }}>
          <div style={{ width: "100%", height: 130 }}>
            <Portrait worldSlug={world?.meta.slug} path="" label="Establishing view: drop or generate" />
          </div>
          <div style={{ padding: "12px 4px 2px" }}>
            <div style={{ font: "600 16px var(--font-sans)", letterSpacing: "-0.01em" }}>
              {name.trim() || "Unnamed"}
            </div>
            <div
              style={{
                font: "400 12px/1.55 var(--font-sans)",
                color: "var(--muted-foreground)",
                marginTop: 8,
              }}
            >
              {sentence.trim() || "The sheet drafts from your sentence — look, sound and customs land here."}
            </div>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 16 }} />
        <div style={{ display: "grid", gap: 8 }}>
          {draftCta}
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/${listPath}`)}>
            Discard · nothing saved
          </Button>
          <div
            style={{
              font: "400 11px/1.5 var(--font-sans)",
              color: "var(--muted-foreground)",
              textAlign: "center",
            }}
          >
            Lands as a sketch. Lock it when the look settles.
          </div>
        </div>
      </div>
    </div>
  );
}

export const NewCharacterScreen = () => (
  <NewSheetScreen screenId="new-character" title="New character" sheetType="character" />
);
export const NewLocationScreen = () => (
  <NewSheetScreen screenId="new-location" title="New location" sheetType="location" />
);
export const NewFactionScreen = () => (
  <NewSheetScreen screenId="new-faction" title="New faction" sheetType="faction" />
);
