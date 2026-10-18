import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import {
  HEAR_ONE_PRESS_LIMIT_MICRO_USD, dramaTakeState, formatMicroUsd,
  type EpisodeScriptBlock, type EpisodeTakes, type MissingVoiceChoice,
} from "@arke-studio/contracts";
import { decideDramaTake, hearDramaLines, subscribeDramaHeard, type DramaHeard } from "../lib/store.js";
import { loadPlaylist, playPlaylistLine } from "../lib/audio.js";
import { mediaUrl } from "../lib/media.js";
import { EditorDialog } from "./editor-dialog.js";
import { Button, cx } from "./ui.js";

type Spoken = Extract<EpisodeScriptBlock, { kind: "dialogue" | "narration" }>;
type Quote = DramaHeard;

/**
 * Hear (design turn 230g/h, SPEC-057 R-25..R-28): the selection priced as it changes, so the button
 * can carry the price. One press makes and plays when every speaker has a voice and the price is
 * within the one-press limit; anything else opens the dialog, with only the decision that waits.
 */
export function useHearQuote(worldId: string, productionId: string, episode: number, lines: readonly string[],
  decisions: Record<string, MissingVoiceChoice>, revision: string, retake = false,
  /** The saved script's hash, or null while edits are unsaved: nothing is priced from words not yet kept. */
  scriptHash: string | null = null) {
  const [quote, setQuote] = useState<{ key: string; result: DramaHeard } | null>(null);
  const key = JSON.stringify([lines, decisions, revision, retake, scriptHash]);
  const asked = useRef<string | null>(null);
  useEffect(() => {
    // An answer to the last selection's ask is never taken for this one's (codex on PR 1871).
    asked.current = null;
    if (lines.length === 0 || scriptHash === null) return;
    const timer = setTimeout(() => {
      asked.current = hearDramaLines(worldId, productionId, episode, [...lines], scriptHash, { quoteOnly: true, decisions, ...(retake ? { retake } : {}) });
    }, 300);
    return () => clearTimeout(timer);
  }, [key]);
  useEffect(() => subscribeDramaHeard((result) => {
    if (result.requestId === asked.current) setQuote({ key, result });
  }), [key]);
  return quote?.key === key ? quote.result : null;
}

export function HearBar({ worldId, productionId, episode, lines, script, scriptHash, takes, worldSlug, name, onClear, onHeard, retake = false }: {
  worldId: string; productionId: string; episode: number; lines: readonly string[]; script: readonly EpisodeScriptBlock[];
  /** The saved script's hash; null while the score holds unsaved edits (codex on PR 1871). */
  scriptHash: string | null;
  takes: EpisodeTakes | undefined; worldSlug: string; name: (slug: string) => string; onClear: () => void; onHeard?: () => void;
  /** A new take beside a current one, to wait for the author (R-30). */
  retake?: boolean;
}) {
  const [decisions, setDecisions] = useState<Record<string, MissingVoiceChoice>>({});
  const [open, setOpen] = useState(false);
  const [pressed, setPressed] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const revision = JSON.stringify(script.filter((block) => lines.includes(block.id)));
  const quote = useHearQuote(worldId, productionId, episode, lines, decisions, revision, retake, scriptHash);
  const quoted = quote?.disposition === "quoted" ? quote : null;
  const missing = quoted?.missing ?? [];
  const price = quoted?.quote?.estimatedMicroUsd ?? 0;
  const waits = missing.length > 0 || price > HEAR_ONE_PRESS_LIMIT_MICRO_USD;
  const spoken = script.filter((block): block is Spoken => lines.includes(block.id) && (block.kind === "dialogue" || block.kind === "narration"));
  // A line the author left out is not played either (codex on PR 1871): only what the quote sends or plays.
  const included = quoted?.quote ? new Set(quoted.quote.requests.map((request) => request.block)) : null;

  // Played in script order on the app's player, each line's kept take, or the take that waits —
  // the lines of the press itself, whatever is selected by the time they arrive (codex on PR 1871).
  const pressedPlan = useRef<{ blocks: Spoken[]; included: Set<string> | null }>({ blocks: [], included: null });
  const play = (current: EpisodeTakes | undefined, plan = { blocks: spoken, included }) => {
    const items = plan.blocks.filter((block) => plan.included === null || plan.included.has(block.id)).flatMap((block) => {
      const line = current?.lines[block.id];
      const take = line?.waiting ?? line?.kept;
      if (!take) return [];
      const who = block.kind === "dialogue" ? name(block.speaker) : "Narrator";
      return [{ id: `${block.id}:${take.artifactId}`, url: mediaUrl(worldSlug, take.file), title: take.standIn ? `${who} · narrator stands in` : who, sub: block.words.slice(0, 80),
        lineId: block.id, speakerSheetId: block.kind === "dialogue" ? block.speaker : "narrator" }];
    });
    if (items.length === 0) return;
    loadPlaylist(items);
    void playPlaylistLine(0);
  };
  // The lines just made, and the take each had before: played once every one has a new take
  // in the world (codex on PR 1871), however long the world takes to arrive.
  const beforePress = useRef(takes);
  const [toPlay, setToPlay] = useState<Record<string, string | null> | null>(null);
  const takeOf = (current: EpisodeTakes | undefined, block: string) => { const line = current?.lines[block]; return (line?.waiting ?? line?.kept)?.artifactId ?? null; };
  useEffect(() => {
    if (toPlay === null || Object.entries(toPlay).some(([block, before]) => takeOf(takes, block) === before)) return;
    setToPlay(null);
    play(takes, pressedPlan.current);
  }, [toPlay, takes]);
  useEffect(() => subscribeDramaHeard((result) => {
    if (result.requestId !== pressed) return;
    setPressed(null);
    if (result.disposition === "refused") { setFailure(result.reason ?? "Not heard."); return; }
    if (result.disposition === "quoted") { setOpen(true); return; }
    setOpen(false);
    onHeard?.();
    if (result.reason) setFailure(result.reason);
    if ((result.made ?? []).length === 0) { play(takes, pressedPlan.current); return; }
    setToPlay(Object.fromEntries((result.made ?? []).map((block) => [block, takeOf(beforePress.current, block)])));
  }), [pressed, takes]);

  const hear = () => {
    setFailure(null);
    // Everything already performed: played, and the press finished as a made one is (codex on PR 1871).
    if (price === 0 && missing.length === 0 && quoted?.quote?.requests.every((request) => request.cached)) { setOpen(false); onHeard?.(); play(takes); return; }
    if (!quoted?.quote || scriptHash === null) return;
    beforePress.current = takes;
    pressedPlan.current = { blocks: spoken, included };
    const requestId = hearDramaLines(worldId, productionId, episode, [...lines], scriptHash, { quoteToken: quoted.quote.token, decisions, ...(retake ? { retake } : {}) });
    if (requestId === null) setFailure("The studio is disconnected.");
    setPressed(requestId);
  };

  const count = spoken.length;
  return (
    <div className="fy-ad-hear" role="region" aria-label="Selected lines">
      <span>{count} line{count === 1 ? "" : "s"}</span>
      <span className="gap" />
      {/* A refused price is said with its reason, not left as a dead button (codex on PR 1871). */}
      {(failure ?? (quote?.disposition === "refused" ? quote.reason : null)) && <span className="fy-ad-hear__fail" role="alert">{failure ?? (quote?.disposition === "refused" ? quote.reason : null)}</span>}
      <Button variant="ghost" size="sm" onClick={onClear}>Done</Button>
      <Button variant="primary" size="sm" disabled={!quoted || pressed !== null} onClick={() => waits ? setOpen(true) : hear()}>
        {waits && <i className="fy-ad-hear__dot" aria-label="a decision waits" />}
        {pressed !== null ? "Making…" : `${retake ? "Retake" : `Hear ${count} line${count === 1 ? "" : "s"}`}${price > 0 ? ` · ${formatMicroUsd(price)}` : ""}`}
      </Button>
      <HearDialog open={open} onClose={() => setOpen(false)} quote={quoted} decisions={decisions} worldId={worldId}
        onDecide={(speaker, choice) => setDecisions((current) => ({ ...current, [speaker]: choice }))}
        onHear={hear} busy={pressed !== null} />
    </div>
  );
}

/**
 * The decision that waits (230h), and nothing else: a speaker with no voice — choose one, let the
 * narrator stand in, or leave the line out — and the price. What's sent is one tap inside.
 */
function HearDialog({ open, onClose, quote, decisions, worldId, onDecide, onHear, busy }: {
  open: boolean; onClose: () => void; quote: Quote | null; decisions: Record<string, MissingVoiceChoice>; worldId: string;
  onDecide: (speaker: string, choice: MissingVoiceChoice) => void; onHear: () => void; busy: boolean;
}) {
  const [sent, setSent] = useState(false);
  const missing = quote?.missing ?? [];
  const requests = quote?.quote?.requests ?? [];
  const price = quote?.quote?.estimatedMicroUsd ?? 0;
  return (
    <EditorDialog open={open} title={`Hear ${requests.length} line${requests.length === 1 ? "" : "s"}`} subtitle={price > 0 ? formatMicroUsd(price) : "already performed"} onClose={onClose} width={520}>
      <div className="fy-ad-heardlg">
        {missing.map((entry) => (
          <section key={entry.speaker} className="fy-ad-heardlg__missing" aria-label={`${entry.name} has no voice`}>
            <h3>{entry.name} has no voice · {entry.blocks.length} line{entry.blocks.length === 1 ? "" : "s"}</h3>
            <div className="fy-ad-heardlg__choices">
              <Link className="ui-btn ui-btn--secondary ui-btn--sm" to={`/w/${worldId}/cast/${entry.speaker}/voice`}>Choose a voice</Link>
              <Button size="sm" variant={decisions[entry.speaker] === "narrator" ? "primary" : "secondary"} onClick={() => onDecide(entry.speaker, "narrator")}>Narrator stands in</Button>
              <Button size="sm" variant={decisions[entry.speaker] === "leave-out" ? "primary" : "secondary"} onClick={() => onDecide(entry.speaker, "leave-out")}>Leave the line out</Button>
            </div>
          </section>
        ))}
        <button type="button" className="fy-linkbtn" aria-expanded={sent} onClick={() => setSent(!sent)}>What's sent</button>
        {sent && (
          <ol className="fy-ad-heardlg__sent">
            {requests.map((request) => (
              <li key={request.block} className={cx(request.cached && "fy-ad-heardlg__cached")}>
                <b>{request.speaker}</b> · {request.voice}{request.standIn ? " · stand-in" : ""} · {request.model}
                <code>{request.cached ? "already performed · not sent" : request.text}</code>
                {request.direction && (request.direction.sent === "not sent"
                  ? <small><s>direction</s> · not sent: {request.direction.reason}</small>
                  : <small>direction sent as {request.direction.sent}: {request.direction.text}</small>)}
                {!request.cached && <small>{formatMicroUsd(request.estimatedMicroUsd)}</small>}
              </li>
            ))}
          </ol>
        )}
        <div className="fy-ad-heardlg__foot">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={missing.length > 0 || busy || !quote} onClick={onHear}>
            {busy ? "Making…" : `Hear${price > 0 ? ` · ${formatMicroUsd(price)}` : ""}`}
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}

/**
 * A line's take, in the score's last column (230i): nothing yet, kept, a stand-in, out of date, a
 * new take waiting to be kept or not, or a take heard to say other words — with Retake.
 */
export function TakeCell({ block, line, voice, worldId, productionId, episode, worldSlug, onRetake }: {
  block: Spoken; line: EpisodeTakes["lines"][string] | undefined; worldId: string; productionId: string; episode: number;
  worldSlug: string; onRetake: () => void;
  /** The role's voice now: a take in another voice reads out of date (R-60). */
  voice?: { provider: string; voiceId: string; model?: string | undefined } | undefined;
}) {
  const state = dramaTakeState(block, line, voice);
  const listen = (file: string) => { loadPlaylist([{ id: file, url: mediaUrl(worldSlug, file), title: "Take", lineId: block.id, speakerSheetId: "take" }]); void playPlaylistLine(0); };
  if (state === "none") return <span className="fy-ad-take fy-ad-take--none" title="Not performed" aria-label="not performed">○</span>;
  if (state === "kept" || state === "stand-in" || state === "out of date") {
    return (
      <span className={cx("fy-ad-take", `fy-ad-take--${state.replace(/ /g, "-")}`)}>
        <button type="button" aria-label="Play the kept take" onClick={(event) => { event.stopPropagation(); listen(line!.kept!.file); }}>●</button>
        {state !== "kept" && <small>{state}</small>}
      </span>
    );
  }
  return (
    <span className="fy-ad-take fy-ad-take--waits" onClick={(event) => event.stopPropagation()}>
      <button type="button" aria-label="Play the new take" onClick={() => listen(line!.waiting!.file)}>◐</button>
      {/* The kept take too, so the two are compared before the choice (codex on PR 1871). */}
      {line?.kept && <button type="button" aria-label="Play the kept take" onClick={() => listen(line.kept!.file)}>●</button>}
      <small>{state === "misread" ? `heard “${line!.waiting!.misread}”` : "new or kept?"}</small>
      <span className="fy-ad-take__acts">
        {state === "misread" && <button type="button" onClick={onRetake}>Retake</button>}
        <button type="button" onClick={() => decideDramaTake(worldId, productionId, episode, block.id, "new", line!.waiting!.artifactId)}>Keep new</button>
        {line?.kept && <button type="button" onClick={() => decideDramaTake(worldId, productionId, episode, block.id, "kept", line.waiting!.artifactId)}>Keep old</button>}
        {!line?.kept && state === "misread" && <button type="button" onClick={() => decideDramaTake(worldId, productionId, episode, block.id, "kept", line!.waiting!.artifactId)}>Discard</button>}
      </span>
    </span>
  );
}
