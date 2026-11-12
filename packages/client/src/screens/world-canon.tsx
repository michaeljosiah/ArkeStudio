// A world's canon: the search, an entry, a thread and a new entry (issue 2816).
import { useRef, useState, useEffect, useMemo } from "react";
import {
  subscribeCanonContradictions, requestCanonContradictions, useWorld, openThread as openThreadMsg,
  useStore, useAskResults, useCanonSearches, askCanon, searchCanonList, useCanonRefs,
  requestCanonRefs, retireEntity, stageCanonAmendment as stageAmendmentMsg, useArtifactNotices,
  useReading, useTranscripts, useAuthoring, continueStudio, draftWithStudio, settleThread,
  attachFiles, hostCanAttach, attachHostFiles, attachHostText, extractArtifact, stopExtraction,
  stageCanonEntry as stageEntryMsg,
} from "../lib/store.js";
import { useNavigate, useParams, Link, useLocation } from "react-router";
import { useTalkItThrough } from "../lib/talk-it-through.js";
import { Card, Badge, Button, Callout, cx, Textarea, Input } from "../components/ui.js";
import { type CanonEntry, proposalDecisionOf } from "@arke-studio/contracts";
import { useOpenWorldGuard } from "../lib/selectors.js";
import { Plus, Search, ChevronRight } from "../components/icons.js";
import { EmptyState, Screen } from "../components/layout.js";
import { FOLD_QUERY, useMediaQuery, usePhone } from "../lib/media-query.js";
import { useSingleAct, SingleActFeedback } from "../components/single-act.js";
import { ReadAloud } from "../components/read-aloud.js";
import { Portrait, sheetPortraitPath } from "../components/portrait.js";
import { shortDateTime } from "../lib/format.js";
import { HeldBar } from "../components/held-bar.js";
import { Composer } from "../components/composer.js";
import { ExtractionOffer } from "../components/extraction-offer.js";
import { Loading } from "../components/loading.js";
import { ConnectedProposalPanel } from "../domain/connected.js";
import { PageSheet } from "../components/page-sheet.js";

// ---- Canon -----------------------------------------------------------------

function useCanonCandidateCheck(
  worldId: string | undefined,
  title: string,
  statement: string,
  excludeEntryId?: string,
  enabled = true,
) {
  const key = `${title.trim()}\u0000${statement.trim()}\u0000${excludeEntryId ?? ""}`;
  const pending = useRef<{ requestId: string; key: string } | null>(null);
  const [answer, setAnswer] = useState<{ key: string; candidates: Array<{ entryId: string; title: string; statement: string }> } | null>(null);
  useEffect(
    () =>
      subscribeCanonContradictions((result) => {
        if (result.requestId !== pending.current?.requestId) return;
        setAnswer({ key: pending.current.key, candidates: result.candidates });
        pending.current = null;
      }),
    [],
  );
  useEffect(() => {
    pending.current = null;
    setAnswer(null);
    if (!enabled || !worldId || title.trim() === "" || statement.trim() === "") return;
    const timer = setTimeout(() => {
      const requestId = requestCanonContradictions(worldId, title.trim(), statement.trim(), excludeEntryId);
      pending.current = requestId === null ? null : { requestId, key };
    }, 150);
    return () => clearTimeout(timer);
  }, [enabled, worldId, key]);
  return {
    checked: answer?.key === key,
    candidates: answer?.key === key ? answer.candidates : [],
  };
}

function CanonCandidates({
  checked,
  candidates,
  compact = false,
}: {
  checked: boolean;
  compact?: boolean;
  candidates: Array<{ entryId: string; title: string; statement: string }>;
}) {
  if (compact) return <div className="fy-canon-candidates" aria-live="polite">
    <div>Contradiction candidates · {checked ? candidates.length === 0 ? "none" : candidates.length : "not yet checked"}</div>
    {candidates.map(candidate => <div key={candidate.entryId}>{candidate.entryId} · {candidate.title}</div>)}
  </div>;
  return (
    <div className="fy-draftcard">
      <div style={{ font: "600 13px var(--font-sans)" }}>Contradiction candidates · advisory</div>
      {!checked ? (
        <div className="fy-mono">Candidates appear here as you write. This check never blocks acceptance.</div>
      ) : candidates.length === 0 ? (
        <div className="fy-mono">No overlapping canon found. This check never blocks acceptance.</div>
      ) : candidates.map((candidate) => (
        <div key={candidate.entryId} className="fy-listrow">
          <span className="fy-mono">{candidate.entryId}</span>
          <span className="fy-listrow__text">{candidate.title} · {candidate.statement}</span>
        </div>
      ))}
    </div>
  );
}

/** A grounded answer or a refusal with receipts (SPEC-006 §2.6–§2.7). */
function AskOutcome({
  worldId,
  question,
  result,
}: {
  worldId: string;
  question: string;
  result: import("@arke-studio/contracts").AskResult;
}) {
  const navigate = useNavigate();
  const world = useWorld();
  const { talk, starting } = useTalkItThrough(worldId);
  const openAsThread = () => {
    const title = question.length > 80 ? `${question.slice(0, 77)}…` : question;
    openThreadMsg(
      worldId,
      title,
      question,
      result.outcome !== "answer" ? result.closest.map((c) => c.entryId) : [],
    );
    navigate(`/w/${worldId}/canon`);
  };
  /**
   * The question and what the search found travel into the conversation, so the Studio starts
   * where the refusal left off rather than being told the same thing again.
   */
  const talkItThrough = () =>
    talk(question.length > 80 ? `${question.slice(0, 77)}…` : question, {
      kind: "canon-question",
      question,
      candidateEntryIds: result.outcome === "answer" ? [] : result.closest.map((c) => c.entryId),
    });
  if (result.outcome === "answer") {
    return (
      <Card className="scr-answer">
        <Badge tone="success">answered from canon</Badge>
        {result.claims.map((claim, i) => (
          <div key={i} className="scr-answer__claim">
            <div className="scr-prose">{claim.text}</div>
            <button
              type="button"
              className="scr-answer__cite"
              onClick={() => navigate(`/w/${worldId}/canon/${claim.entryId}`)}
            >
              <span className="mono">{claim.entryId}</span>
              <span className="scr-answer__excerpt">“{claim.excerpt}”</span>
            </button>
          </div>
        ))}
        <div className="fy-canon-answer-actions fy-phone-only">
          {[...new Set(result.claims.map((claim) => claim.entryId))].map((id) => <Button key={id} onClick={() => navigate(`/w/${worldId}/canon/${id}`)}>Open {id}</Button>)}
          <Button variant="primary" onClick={() => navigate(`/w/${worldId}/canon/new`, { state: { seed: result.claims.map((claim) => claim.text).join("\n\n"), title: question, entryType: "lore" } })}>Save as lore note</Button>
        </div>
        <div className="scr-answer__foot">
          Every quoted span was verified against its entry. Searched {result.searched} entries.
        </div>
      </Card>
    );
  }
  if (result.outcome === "unavailable") {
    return (
      <Callout tone="warning" title="Canon cannot be asked right now">
        {result.reason}. {result.closest.length > 0 && "The closest entries by search:"}
        <ClosestList worldId={worldId} closest={result.closest} />
      </Callout>
    );
  }
  const isNothing = result.cause === "nothing-retrieved";
  return (
    <Card className="scr-answer scr-answer--refusal">
      <Badge tone="warning">{isNothing ? "canon has not touched this" : "canon has not decided this"}</Badge>
      <div className="scr-prose">
        {isNothing
          ? `Searched all ${result.searched} entries — nothing comes close to this question.`
          : `Searched all ${result.searched} entries. The closest describe the area without deciding the fact${result.detail ? ` — ${result.detail}` : ""}.`}
      </div>
      {result.closest.length > 0 && (
        <div>
          <div className="scr-field__label">Closest, by rank</div>
          <ClosestList worldId={worldId} closest={result.closest} />
        </div>
      )}
      <div className="fy-canon-answer-actions">
        <Button variant="primary" onClick={openAsThread}>
          Open as a thread
        </Button>
        <Button variant="ghost" onClick={talkItThrough} disabled={starting}>
          {starting ? "Starting…" : "Talk it through"}
        </Button>
        <Button
          onClick={() => {
            navigate(`/w/${worldId}/canon/new`, { state: { seed: question } });
          }}
        >
          Draft an answer in context
        </Button>
      </div>
      {world && world.meta.nextCanonId > 0 && (
        <span className="scr-field__hint">
          A thread takes CANON-{String(world.meta.nextCanonId).padStart(3, "0")} now and is citable before it
          settles.
        </span>
      )}
    </Card>
  );
}

function ClosestList({
  worldId,
  closest,
}: {
  worldId: string;
  closest: Array<{ entryId: string; title: string }>;
}) {
  const navigate = useNavigate();
  return (
    <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-2)" }}>
      {closest.map((c) => (
        <Button
          key={c.entryId}
          variant="secondary"
          onClick={() => navigate(`/w/${worldId}/canon/${c.entryId}`)}
        >
          <span className="mono">{c.entryId}</span>&nbsp;{c.title}
        </Button>
      ))}
    </div>
  );
}

/** Generated thread titles are often the question, shortened for storage (issue 1003). */
function threadQuestion(entry: CanonEntry): { text: string; context: string } | null {
  if (entry.status !== "open") return null;
  const title = entry.title.trim().replace(/\s+/g, " ");
  // Refused asks append candidate context; it is not part of the generated title.
  const body = entry.body.replace(/\n+Considered when this was asked: [^\n]* — none of them decides it\.\s*$/, "").trim();
  const question = body.replace(/\s+/g, " ");
  // Only the known 77-character truncation is generated; an authored ellipsis is a title.
  const generated = body.length > 80 && entry.title.trim() === `${body.slice(0, 77)}…`;
  return question && (title === question || generated)
    ? { text: body, context: entry.body.trim().slice(body.length).trim() }
    : null;
}

export function CanonScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const { state } = useStore();
  const askResults = useAskResults();
  const searches = useCanonSearches();
  const [query, setQuery] = useState("");
  const [askId, setAskId] = useState<string | null>(null);
  const [askedQuestion, setAskedQuestion] = useState("");
  const [searchId, setSearchId] = useState<string | null>(null);
  const harnessReady = state?.app.health.harness.status === "healthy";

  const serverSearch = searchId ? searches[searchId] : undefined;
  const entries = useMemo(() => {
    const all = world?.canon ?? [];
    if (serverSearch) {
      const ranked = new Map(serverSearch.candidates.map((c, i) => [c.entryId, i]));
      return all
        .filter((c) => ranked.has(c.id))
        .sort((a, b) => (ranked.get(a.id) ?? 99) - (ranked.get(b.id) ?? 99));
    }
    return [...all].sort(
      (a, b) => (a.status === "open" ? -1 : 0) - (b.status === "open" ? -1 : 0) || a.id.localeCompare(b.id),
    );
  }, [world, serverSearch]);

  const ask = () => {
    if (!worldId || query.trim().length === 0) return;
    const id = `ask_${Date.now().toString(36)}`;
    setAskId(id);
    setAskedQuestion(query.trim());
    askCanon(worldId, id, query.trim());
  };
  const runSearch = (value: string) => {
    setQuery(value);
    if (!worldId) return;
    if (value.trim().length === 0) {
      setSearchId(null);
      return;
    }
    const id = `search_${Date.now().toString(36)}`;
    setSearchId(id);
    searchCanonList(worldId, id, value.trim());
  };

  const result = askId ? askResults[askId] : undefined;
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const typeCounts = new Map<string, number>();
  for (const c of world?.canon ?? []) typeCounts.set(c.type, (typeCounts.get(c.type) ?? 0) + 1);
  const shown = entries.filter((e) => typeFilter === null || e.type === typeFilter);

  return (
    <div data-screen="canon">
      <div className="fy-corner fy-canon-corner">
        <Button variant="primary" onClick={() => navigate(`/w/${worldId}/canon/new`)}>
          New entry
        </Button>
      </div>
      <div className="fy-hero">
        <div className="fy-document-head">
          <div className="fy-document-head__text">
            <div className="fy-hero__eyebrow">
              {world?.meta.name} · {world?.canon.length ?? 0} entries
            </div>
            <h1 className="fy-hero__title fy-document-title">Canon</h1>
          </div>
          <Button className="fy-phone-only" variant="primary" onClick={() => navigate(`/w/${worldId}/canon/new`)}><Plus size={16} /> New</Button>
        </div>
        <div className="fy-askbar">
          <Search size={15} />
          <input
            placeholder="Ask the world anything: “who rings the bells?”"
            value={query}
            onChange={(e) => runSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") ask();
            }}
          />
          <Button
            variant="primary"
            onClick={ask}
            disabled={!harnessReady || query.trim().length === 0}
            title={harnessReady ? undefined : "Asking needs the harness running; search still works"}
          >
            Ask
          </Button>
        </div>
        <div className="fy-filterrow">
          <button
            type="button"
            className={cx("fy-filterchip", typeFilter === null && "fy-filterchip--active")}
            onClick={() => setTypeFilter(null)}
          >
            All {world?.canon.length ?? 0}
          </button>
          {[...typeCounts.entries()].map(([t, n]) => (
            <button
              key={t}
              type="button"
              className={cx("fy-filterchip", typeFilter === t && "fy-filterchip--active")}
              onClick={() => setTypeFilter(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)} {n}
            </button>
          ))}
        </div>
      </div>
      {(result || (askId && !result) || serverSearch) && (
        <div className="fy-canon-result">
          {askId && !result && <Callout title="Asking canon…">{null}</Callout>}
          {result && worldId && <AskOutcome worldId={worldId} question={askedQuestion} result={result} />}
          {serverSearch && (
            <span className="fy-mono">
              {serverSearch.candidates.length} match{serverSearch.candidates.length === 1 ? "" : "es"} across{" "}
              {serverSearch.searched} searchable entries · open threads and retired entries are not searched
            </span>
          )}
        </div>
      )}
      <div className="fy-cardgrid fy-canon-grid">
        {shown.map((entry) => {
          const question = threadQuestion(entry);
          const body = question?.context ?? entry.body;
          return entry.status === "open" ? (
            <div key={entry.id} className="fy-gridcard fy-gridcard--quiet">
              <div className="fy-gridcard__id" style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className="fy-dot fy-dot--warn" style={{ width: 7, height: 7 }} />
                Open question
              </div>
              <div className="fy-gridcard__title">{question?.text ?? entry.title}</div>
              {body && <div className="fy-gridcard__body">
                {body.length > 150 ? `${body.slice(0, 147)}…` : body}
              </div>}
              <div style={{ marginTop: 12 }}>
                <Button onClick={() => navigate(`/w/${worldId}/canon/${entry.id}/thread`)}>
                  Answer with Arke
                </Button>
              </div>
            </div>
          ) : (
            <button
              key={entry.id}
              type="button"
              className="fy-gridcard"
              onClick={() => navigate(`/w/${worldId}/canon/${entry.id}`)}
            >
              <div className="fy-gridcard__id">
                {entry.type}
                {entry.retired ? " · retired" : ""}
              </div>
              <div className="fy-gridcard__title">{entry.title}</div>
              <div className="fy-gridcard__body">
                {entry.body.length > 150 ? `${entry.body.slice(0, 147)}…` : entry.body}
              </div>
            </button>
          );
        })}
        {shown.length === 0 && (
          <EmptyState title="No matches" hint="The closest entries appear in the ask refusal above." />
        )}
      </div>
    </div>
  );
}

function useCanonEntry(): { entry: CanonEntry | null; worldId: string | undefined } {
  const { worldId, entryId } = useParams();
  const world = useOpenWorldGuard(worldId);
  return { entry: world?.canon.find((c) => c.id === entryId) ?? null, worldId };
}

export function CanonEntryScreen() {
  const { entry, worldId } = useCanonEntry();
  const navigate = useNavigate();
  const world = useWorld();
  const refs = useCanonRefs();
  const phone = usePhone();
  const amendmentRef = useRef<HTMLDivElement>(null);
  const [amending, setAmending] = useState(false);
  const [statement, setStatement] = useState("");
  const amendment = useSingleAct();
  useEffect(() => { if (phone && amending) amendmentRef.current?.scrollIntoView({ block: "start" }); }, [phone, amending]);
  const candidates = useCanonCandidateCheck(worldId, entry?.title ?? "", statement, entry?.id, amending);
  const { talk: talkAbout, starting: talkStarting } = useTalkItThrough(worldId);
  /**
   * "Amend this entry" is the direct route and stays the primary one. This is for the case the
   * form cannot serve: when what the entry should say is the thing still being worked out.
   */
  const talkThroughEntry = () => {
    if (entry) talkAbout(entry.title, { kind: "canon-entry", entryId: entry.id });
  };

  /*
   * Asked again whenever canon moves, not only when the entry opens.
   *
   * The detail is computed server-side and nothing pushes an update for it, so an entry left open
   * across an accept used to keep showing the cited-by and ripples from before it. Its history now
   * comes from here too (issue 289), and history going stale on screen would be the more obvious
   * fault of the two. Every canon commit advances the revision, and the snapshot that carries the
   * new revision is broadcast after the index has been rebuilt, so this asks once and asks late.
   */
  const canonRevision = world?.meta.canonRevision;
  useEffect(() => {
    if (worldId && entry) requestCanonRefs(worldId, entry.id);
  }, [worldId, entry?.id, canonRevision]);

  if (!entry) {
    return (
      <Screen id="canon-entry">
        <EmptyState title="Opening entry…" />
      </Screen>
    );
  }
  const detail = refs[entry.id];
  // Read per entry, not filtered out of the world's recent-change tail (issue 289): a bulk write
  // fills that tail and the panel would then say an entry has no history while its records sit
  // intact on disk. Undefined until the detail arrives, so the empty line waits for an answer.
  const history = detail?.history;
  const citedBy = detail && detail.canonRevision === canonRevision ? detail.citedBy : undefined;
  const question = threadQuestion(entry);
  const referenceLink = (id: string, kind: "canon" | "sheet" | "production" | null) => {
    // Slugs are unique within a kind, not across sheets and productions.
    const canon = kind === "canon" ? world?.canon.find((candidate) => candidate.id === id) : undefined;
    const sheet = kind === "sheet" ? world?.sheets.find((candidate) => candidate.id === id) : undefined;
    const production = kind === "production" ? world?.productions.find((candidate) => candidate.meta.id === id) : undefined;
    const to = canon ? `canon/${id}` : sheet ? `${sheet.type === "character" ? "cast" : `${sheet.type}s`}/${id}` : production ? `p/${id}` : null;
    const label = canon ? `${id} · ${canon.title}` : sheet?.name ?? production?.meta.title ?? id;
    return to ? <Link key={id} to={`/w/${worldId}/${to}`}>{label}</Link> : <span key={id}>{label}</span>;
  };
  const retireButton = (
    <Button variant="ghost" disabled={entry.retired === true}
      onClick={() => { if (worldId) retireEntity(worldId, `canon/${entry.id}.md`); }}
      title="Stays resolvable for existing citations; drops out of retrieval">
      Retire
    </Button>
  );
  return (
    <div className="fy-entry" data-screen="canon-entry">
      <div className="fy-entry__main">
        <div style={{ animation: "fy-fade-up 0.6s var(--ease-out) both" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span className="fy-mono">
              {entry.id} · {entry.type}
            </span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span
                className={`fy-dot fy-dot--${entry.status === "open" ? "warn" : "ok"}`}
                style={{ width: 6, height: 6 }}
              />
              <span className="fy-mono">{entry.status === "open" ? "open thread" : "settled"}</span>
            </span>
            {entry.retired && <Badge tone="danger">retired</Badge>}
          </div>
          {!question && <h1 className="fy-entry__title">{entry.title}</h1>}
          {/* The statement is the one thing on this screen somebody reads rather than scans. */}
          <div className="fy-texthost">
            {question
              ? <>
                  <h1 className="fy-entry__title">{question.text}</h1>
                  {question.context && <div className="fy-entry__body">{question.context}</div>}
                </>
              : <div className="fy-entry__body">{entry.body}</div>}
            <ReadAloud
              source={{ of: "canon", canonId: entry.id }}
              title={`${entry.id} · ${entry.title}`}
              text={entry.body}
            />
          </div>
          <div className="fy-mono" style={{ marginTop: 14 }}>
            written v{entry.introducedAt}
            {entry.settledAt !== undefined && ` · settled v${entry.settledAt}`}
            {entry.amendedAt !== undefined && ` · last amended v${entry.amendedAt}`}
          </div>
          {citedBy && (citedBy.sheets.length > 0 || citedBy.entries.length > 0) && (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 16 }}>
              {citedBy.sheets.map((s) => (
                <span key={s.id} className="fy-pill">
                  <span className="fy-pill__avatar">
                    <Portrait
                      worldSlug={world?.meta.slug}
                      path={sheetPortraitPath(s.id)}
                      label=""
                      radius={99}
                    />
                  </span>
                  {referenceLink(s.id, "sheet")}
                  {s.atVersion !== null ? ` · v${s.atVersion}` : ""}
                </span>
              ))}
              {citedBy.entries.map((id) => (
                <span
                  key={id}
                  className="fy-pill"
                >
                  {referenceLink(id, "canon")}
                </span>
              ))}
            </div>
          )}
        </div>
          <section aria-label="Cited by" style={{ marginTop: 30, animation: "fy-fade-up 0.7s var(--ease-out) 0.15s both" }}>
            <div className="fy-entry-section-title fy-entry-cited-title">Cited by</div>
            {!citedBy && <div className="fy-mono">Loading citations…</div>}
            {citedBy && citedBy.sheets.length + citedBy.entries.length + citedBy.productions.length === 0 && (
              <div className="fy-mono">No citations yet.</div>
            )}
            {citedBy?.sheets.map((s) => (
              <div key={s.id} className="fy-citerow">
                <span style={{ flex: 1 }}>
                  {referenceLink(s.id, "sheet")}
                  {s.atVersion !== null ? `, sheet v${s.atVersion}` : ""}
                </span>
                <span className="fy-mono">canon reference</span>
                <ChevronRight size={13} />
              </div>
            ))}
            {citedBy?.entries.map((id) => (
              <div
                key={id}
                className="fy-citerow"
              >
                <span style={{ flex: 1 }}>{referenceLink(id, "canon")}</span>
                <span className="fy-mono">canon cross-reference</span>
                <ChevronRight size={13} />
              </div>
            ))}
            {citedBy?.productions.map((id) => (
              <div key={id} className="fy-citerow">
                <span style={{ flex: 1 }}>{referenceLink(id, "production")}</span>
                <span className="fy-mono">production reference</span>
                <ChevronRight size={13} />
              </div>
            ))}
          </section>
      </div>
      <div className="fy-entry__side">
        <div className="fy-entry-section-title">History</div>
        <div style={{ marginTop: 4 }}>
          {history?.length === 0 && (
            <div className="fy-mono" style={{ padding: "9px 0" }}>
              no recorded changes yet
            </div>
          )}
          {[...(history ?? [])].reverse().map((c, i) => (
            <div key={i} className="fy-historyrow">
              <span className="fy-historyrow__v" style={i === 0 ? { color: "var(--foreground)" } : undefined}>
                v{String(c.canonRevisionAfter ?? c.toVersion ?? "?")}
              </span>
              <div className="fy-historyrow__text">
                <div style={i === 0 ? { color: "var(--foreground)" } : undefined}>
                  {c.fieldsChanged ? c.fieldsChanged.join(", ") : "changed"}
                </div>
                <div className="fy-historyrow__when">
                  {shortDateTime(c.ts)} · {c.source}
                </div>
              </div>
            </div>
          ))}
          {detail?.historyTruncated === true && (
            <div className="fy-mono" style={{ padding: "9px 0" }}>
              older changes not shown
            </div>
          )}
        </div>
        {detail && detail.ripples.length > 0 && (
          <div className="fy-draftcard fy-entry-ripples">
            <div className="fy-entry-section-title">Changing this ripples</div>
            <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
              {detail.ripples.map((r, i) => (
                <div key={i} className="fy-ripplerow">
                  <span className="fy-dot fy-dot--warn" />
                  <div>
                    {r.summary}
                    {r.targets.length > 0 && <div className="fy-mono" style={{ display: "flex", flexWrap: "wrap", gap: 7, marginTop: 4 }}>
                      {r.targets.map((id) => referenceLink(id, r.kind === "productions-see-new-revision" ? "production" :
                        r.kind === "contradiction-candidates" || r.kind === "gains-cross-reference" ? "canon" : null))}
                    </div>}
                  </div>
                </div>
              ))}
            </div>
            {/* Said as it now happens (issue 747): the amendment is ripple-checked and versioned
                on the press, so describing a proposal step set up the same wait the button did. */}
            <div className="fy-mono" style={{ marginTop: 10 }}>
              ripple-checked, then versioned
            </div>
          </div>
        )}
        {amending && worldId && (
          <div className="fy-draftcard fy-entry-amendment" ref={amendmentRef}>
            <div className="fy-fieldlabel">Amended statement</div>
            <Textarea value={statement} onChange={(e) => setStatement(e.target.value)} />
            <CanonCandidates checked={candidates.checked} candidates={candidates.candidates} />
            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <Button
                variant="primary"
                disabled={statement.trim().length === 0 || statement.trim() === entry.body.trim()}
                onClick={() => {
                  amendment.track(stageAmendmentMsg(worldId, entry.id, statement.trim()));
                }}
              >
                Accept amendment
              </Button>
              <Button variant="ghost" onClick={() => setAmending(false)}>
                Cancel
              </Button>
            </div>
            <SingleActFeedback result={amendment.result} undoLabel="Restore previous version" onUndo={amendment.undo} />
          </div>
        )}
        <div style={{ flex: 1, minHeight: 16 }} />
        <HeldBar className="fy-entry-actions">
          {entry.status === "open" ? (
            <Button variant="primary" onClick={() => navigate(`/w/${worldId}/canon/${entry.id}/thread`)}>
              Open thread
            </Button>
          ) : (
            <>
              {/* The door states its act (issue 747, after the same fix on Art direction). What
                  it opens commits with `Accept amendment` and lands on the press — the coordinator
                  runs it as a single act, with the previous version one undo away — so "Propose a
                  change" promised a review step nothing here queues. */}
              <Button
                variant="primary"
                onClick={() => {
                  setStatement(entry.body);
                  setAmending(true);
                }}
              >
                {phone ? "Amend" : "Amend this entry"}
              </Button>
              <Button variant="ghost" onClick={talkThroughEntry} disabled={talkStarting}>
                {talkStarting ? "Starting…" : "Talk it through"}
              </Button>
              {phone ? (
                <details className="fy-bar-menu">
                  <summary aria-label="Entry options">⋯</summary>
                  <div>{retireButton}</div>
                </details>
              ) : retireButton}
            </>
          )}
        </HeldBar>
      </div>
    </div>
  );
}

const SETTLE_TYPES = ["rule", "lore", "location", "faction", "timeline", "tone"] as const;

export function CanonThreadScreen() {
  const { entry, worldId } = useCanonEntry();
  const question = entry ? threadQuestion(entry) : null;
  const context = question?.context ?? entry?.body;
  const world = useWorld();
  const navigate = useNavigate();
  const phone = usePhone();
  const fold = useMediaQuery(FOLD_QUERY);
  const [settleOpen, setSettleOpen] = useState(false);
  // The entry's whole text opened the thread as one card (issue 1403): on a Fold, CANON-044 was
  // about 1,100px of it, and the composer came after. Below desktop it opens clamped.
  const [contextOpen, setContextOpen] = useState(false);
  useEffect(() => { if (!phone) setSettleOpen(false); }, [phone]);
  const { state } = useStore();
  const [resolvedType, setResolvedType] = useState<(typeof SETTLE_TYPES)[number]>("lore");
  const [statement, setStatement] = useState("");
  const settlement = useSingleAct();
  const candidates = useCanonCandidateCheck(worldId, entry?.title ?? "", statement, entry?.id, phone && settleOpen);
  const [message, setMessage] = useState("");
  const harnessReady = state?.app.health.harness.status === "healthy";
  // What has been attached here this session. Dismissing a chip stops the conversation
  // referring to it; the artifact stays filed in the world, because filing is the point.
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const attached = useStore()
    .attached.filter((a) => a.worldId === worldId && !dismissed.includes(a.artifactId))
    .map(({ artifactId, file, kind }) => ({ id: artifactId, file, kind }));
  // Refusals are news, not a list: only what the world turned away since this screen opened
  // shows on a chip here. The Artifacts screen keeps the fuller account.
  const notices = useArtifactNotices();
  const noticesAtOpen = useRef(notices.length);
  const refusals = notices.slice(noticesAtOpen.current).map((n) => ({
    name: n.sourcePath.split(/[\\/]/).pop() || "that file",
    reason: n.reason,
  }));

  // The offer to read a document, for the most recent one attached here. Only documents: an
  // image or a recording has nothing to quote from, so they file with no offer at all. One at a
  // time — a strip per attachment would be a queue of decisions nobody asked for.
  const reading = useReading();
  const [offerDone, setOfferDone] = useState<readonly string[]>([]);
  const offerable = [...attached].reverse().find((a) => a.kind === "document" && !offerDone.includes(a.id));
  const offer = offerable
    ? {
        id: offerable.id,
        file: offerable.file,
        state: reading[offerable.id]?.state,
        found: reading[offerable.id]?.found ?? 0,
        dropped: reading[offerable.id]?.dropped ?? 0,
        reason: reading[offerable.id]?.reason,
      }
    : null;

  // Draft-in-context (18a): the thread's conversation runs on a proposal over the entry file.
  const chatPath = entry ? `canon/${entry.id}.md` : null;
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
  const sendToStudio = () => {
    if (!entry || !worldId || !chatPath || message.trim().length === 0) return;
    if (chatProposal) {
      continueStudio(worldId, chatPath, chatProposal.proposal.id, message.trim());
    } else {
      draftWithStudio(worldId, chatPath, message.trim(), `Answer: ${entry.title}`);
    }
    setMessage("");
  };

  const settlementFields = (
    <div className="fy-thread-fields">
      <div className="fy-fieldlabel">What it turned out to be</div>
      <div className="fy-choicerow">
        {SETTLE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className={cx("fy-filterchip", t === resolvedType && "fy-filterchip--active")}
            style={{ border: t === resolvedType ? "none" : "1px solid var(--border)" }}
            onClick={() => setResolvedType(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="fy-fieldlabel" style={{ marginTop: 15 }}>
        The settled statement
      </div>
      <Textarea
        placeholder="What is now established as true in this world?"
        value={statement}
        onChange={(e) => setStatement(e.target.value)}
      />
    </div>
  );
  const proposalPreview = (
    <div className="fy-thread-preview">
      {!phone && <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
        <div style={{ font: "600 15px var(--font-sans)" }}>Proposed entry</div>
        <span className="fy-mono" style={{ color: "var(--warning)" }}>
          settles the thread
        </span>
      </div>}
      <div className="fy-draftcard">
        <div className="fy-gridcard__id">
          {entry?.id ?? "CANON-…"} · {resolvedType}
        </div>
        {entry && !question && <div style={{ font: "600 16px var(--font-sans)", letterSpacing: "-0.01em", marginTop: 7 }}>
          {entry.title}
        </div>}
        <div
          style={{
            font: "400 12.5px/1.65 var(--font-sans)",
            color: "var(--muted-foreground)",
            marginTop: 8,
            whiteSpace: "pre-wrap",
          }}
        >
          {statement.trim() || "The settled statement appears here as you write it."}
        </div>
      </div>

    </div>
  );
  const settlementActions = (
    <div className="fy-settlement-actions">
      <Button
        variant="primary"
        disabled={!entry || !worldId || statement.trim().length === 0}
        onClick={() => {
          if (!entry || !worldId) return;
          settlement.track(settleThread(worldId, entry.id, resolvedType, statement.trim()));
        }}
      >
        Settle thread
      </Button>
      <div
        style={{
          font: "400 11px/1.5 var(--font-sans)",
          color: "var(--muted-foreground)",
          textAlign: "center",
        }}
      >
        {phone ? `The canon moves to v${(world?.meta.canonRevision ?? 0) + 1}.` : "This press accepts the settlement. The canon revision moves once."}
      </div>
      <SingleActFeedback result={settlement.result} undoLabel="Reopen thread" onUndo={settlement.undo} />
    </div>
  );
  const composerBar = (
    <HeldBar className="fy-thread-composer">
      {phone && <button type="button" className="fy-thread-peek" onClick={() => setSettleOpen(true)} aria-haspopup="dialog">
        <span><b>Proposed entry{entry ? ` · ${entry.id}` : ""}</b><span>{resolvedType} · draft · {candidates.checked ? `${candidates.candidates.length} contradiction candidates` : "not yet checked"}</span></span><ChevronRight size={18} />
      </button>}
      <Composer
        value={message}
        onChange={setMessage}
        onSubmit={sendToStudio}
        placeholder="Keep shaping the entry…"
        agentLabel="Arke"
        busy={chatRunning}
        busyLabel="drafting against the canon…"
        onDictate={(text) => setMessage((prev) => (prev ? `${prev} ${text}` : text))}
        {...(worldId === undefined ? {} : { onAttach: () => attachFiles(worldId) })}
        {...(worldId !== undefined && hostCanAttach()
          ? {
              onAttachFiles: (files: readonly File[]) =>
                // Dropped on the world's own shelf, so it says so — same statement the
                // "Copy it anyway" button makes, and the one dedup needs to re-home a
                // scoped artifact rather than silently leave it scoped (SPEC-020 §2.5).
                attachHostFiles({ kind: "file-artifact", worldId, production: null }, files),
              onAttachText: (text: string) =>
                attachHostText({ kind: "file-artifact", worldId }, text, "pasted-note.txt"),
            }
          : {})}
        attachments={attached}
        refusals={refusals}
        onRemoveAttachment={(id) => setDismissed((prev) => [...prev, id])}
        {...(harnessReady
          ? {}
          : { disabledReason: "Chat needs the harness running — the form still settles it." })}
      />
      {offer && worldId !== undefined && (
        <ExtractionOffer
          file={offer.file}
          {...(offer.state !== undefined ? { state: offer.state } : {})}
          found={offer.found}
          dropped={offer.dropped}
          {...(offer.reason !== undefined ? { reason: offer.reason } : {})}
          onRead={() => extractArtifact(worldId, offer.id)}
          onStop={() => stopExtraction(worldId, offer.id)}
          onReview={() => navigate(`/w/${worldId}/artifacts`)}
          onDismiss={() => setOfferDone((prev) => [...prev, offer.id])}
        />
      )}
    </HeldBar>
  );
  return (
    <div className="fy-gate" data-screen="canon-thread">
      <div className="fy-gate__main">
        <div className="fy-gate__head">
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span className="fy-dot fy-dot--warn" style={{ width: 7, height: 7 }} />
              <span className="fy-eyebrow-sm">
                {phone ? "Open thread" : "OPEN THREAD"}{entry ? ` · ${entry.id} · since v${entry.introducedAt}` : ""}
              </span>
            </div>
            <h1 className="fy-story__h1">{question?.text ?? entry?.title ?? "Thread"}</h1>
          </div>
        </div>
        <div className="fy-gate__body" style={{ gap: 14 }}>
          {context && (phone || fold ? (
            <div className={cx("fy-bubble--gate", "fy-thread-context", contextOpen && "fy-thread-context--open")}>
              <div className="fy-thread-context__text">{context}</div>
              <button type="button" className="fy-thread-context__more" aria-expanded={contextOpen} onClick={() => setContextOpen((open) => !open)}>
                {contextOpen ? "Show less" : "Show all"}
              </button>
            </div>
          ) : <div className="fy-bubble--gate">{context}</div>)}
          {transcript.length === 0 && (
            <div className="fy-bubble--gate">
              Talk it through — the studio drafts the answer on a proposal over this entry, checked against
              the canon. Or settle it directly below.
              <div className="fy-bubble__note">
                settling is an ordinary accept — the staged proposal shows its ripples first
              </div>
            </div>
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
                label={chatActivity?.lines[chatActivity.lines.length - 1] ?? "drafting against the canon…"}
              />
            </div>
          )}
          {chatProposal && <ConnectedProposalPanel key={chatProposal.proposal.id} staged={chatProposal} />}
          {!fold && composerBar}
          {!phone && !fold && settlementFields}
        </div>
        {/* On a Fold the composer is the column's foot, not the scroll's end (issue 1403): inside
            the body it came after the whole entry and the transcript, off the bottom of the screen. */}
        {fold && composerBar}
      </div>
      {!phone && <div className="fy-gate__side">
        {proposalPreview}
        {fold && <details className="fy-thread-edit"><summary>Edit proposed entry</summary>{settlementFields}</details>}
        <div style={{ flex: 1, minHeight: 16 }} />
        {settlementActions}
      </div>}
      <PageSheet open={phone && settleOpen} title="Proposed entry" onClose={() => setSettleOpen(false)} footer={settlementActions}>
        {settlementFields}{proposalPreview}
        <CanonCandidates compact checked={candidates.checked} candidates={candidates.candidates} />
      </PageSheet>
    </div>
  );
}

export function NewCanonScreen() {
  const { worldId } = useParams();
  const world = useOpenWorldGuard(worldId);
  const navigate = useNavigate();
  const location = useLocation();
  const phone = usePhone();
  const initial = location.state as { seed?: string; title?: string; entryType?: "lore" } | null;
  const seed = initial?.seed;
  const [entryType, setEntryType] = useState<(typeof SETTLE_TYPES)[number]>(initial?.entryType === "lore" ? "lore" : "rule");
  const [title, setTitle] = useState(initial?.title ?? "");
  const [statement, setStatement] = useState(seed ?? "");
  const creation = useSingleAct();
  const candidates = useCanonCandidateCheck(worldId, title, statement);
  const nextId = world ? `CANON-${String(world.meta.nextCanonId).padStart(3, "0")}` : "CANON-…";
  return (
    <div className="fy-gate" data-screen="new-canon">
      <div className="fy-gate__main">
        <div className="fy-gate__head">
          <div style={{ flex: 1 }}>
            <div className="fy-eyebrow-sm">{phone ? "New canon entry · will be" : "NEW CANON ENTRY · WILL BE"} {nextId}</div>
            <h1 className="fy-story__h1">The entry, field by field.</h1>
          </div>
        </div>
        <div className="fy-gate__body">
          <div>
            <div className="fy-fieldlabel">Type</div>
            <div className="fy-choicerow">
              {SETTLE_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={cx("fy-filterchip", t === entryType && "fy-filterchip--active")}
                  style={{ border: t === entryType ? "none" : "1px solid var(--border)" }}
                  onClick={() => setEntryType(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="fy-fieldlabel">Title</div>
            <Input placeholder="Tide-calling" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div>
            <div className="fy-fieldlabel">Statement</div>
            <Textarea
              placeholder="A caller cannot move a tide she has not stood in…"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
            />
          </div>
          {phone && <CanonCandidates compact checked={candidates.checked} candidates={candidates.candidates} />}
          <div className="fy-mono fy-canon-id-note">
            ids are permanent — the entry reserves {nextId} at staging and keeps it forever · retired ids are
            never reused, so citations never drift
          </div>
        </div>
      </div>
      <div className="fy-gate__side">
        <div className="fy-canon-proposal-title">
          <div style={{ font: "600 15px var(--font-sans)" }}>Proposed entry</div>
          <span className="fy-mono" style={{ color: "var(--warning)" }}>
            draft · enters as proposed
          </span>
        </div>
        <div className="fy-draftcard">
          <div className="fy-gridcard__id">
            {nextId} · {entryType}
          </div>
          <div style={{ font: "600 16px var(--font-sans)", letterSpacing: "-0.01em", marginTop: 7 }}>
            {title.trim() || "Untitled"}
          </div>
          <div
            style={{
              font: "400 12.5px/1.65 var(--font-sans)",
              color: "var(--muted-foreground)",
              marginTop: 8,
              whiteSpace: "pre-wrap",
            }}
          >
            {statement.trim() || "The statement appears here as you write it."}
          </div>
        </div>
        {!phone && <CanonCandidates checked={candidates.checked} candidates={candidates.candidates} />}
        <div style={{ flex: 1, minHeight: 16 }} />
        <HeldBar className="fy-new-canon-actions">
          <Button
            variant="primary"
            disabled={!worldId || title.trim().length === 0 || statement.trim().length === 0}
            onClick={() => {
              if (!worldId) return;
              creation.track(stageEntryMsg(worldId, entryType, title.trim(), statement.trim()));
            }}
          >
            Add to canon · {nextId}
          </Button>
          <SingleActFeedback result={creation.result} undoLabel="Retire entry" onUndo={creation.undo} />
          <Button variant="ghost" onClick={() => navigate(`/w/${worldId}/canon`)}>
            {phone ? "Discard" : "Discard · nothing saved"}
          </Button>
        </HeldBar>
      </div>
    </div>
  );
}
