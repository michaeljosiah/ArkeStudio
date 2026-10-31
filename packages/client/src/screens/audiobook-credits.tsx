import { useEffect, useRef, useState } from "react";
import {
  AUDIOBOOK_CREDITS_ID,
  audiobookCreditWarning,
  formatMicroUsd,
  type AudiobookCreditKey,
  type AudiobookCreditView,
  type AudiobookCreditsView,
  CREDIT_WORDS_MAX,
} from "@arke-studio/contracts";
import { ChevronRight, PlaySolid, X } from "../components/icons.js";
import { Portrait } from "../components/portrait.js";
import { Button, cx } from "../components/ui.js";
import { mediaUrl } from "../lib/media.js";
import { RemoteVoiceUploadConfirmation, useVoiceUploadAsk } from "../components/remote-voice-upload-confirmation.js";
import { dismissAudiobookRun, readAudiobookChapter, setAudiobookCredits, useAudiobookRuns } from "../lib/store.js";
import { NoteRow } from "./chapter-audiobook.js";

/*
 * The audiobook's opening and closing credits (design turn 252, SPEC-047 R-210 – R-213): a row at
 * each end of Chapters in the chapter row's own markup, and the Credits sheet, which is the Reading
 * sheet's. They are read as a chapter is, under their reserved id, so a read here is priced,
 * confirmed and followed as a chapter's.
 */

const NAMES: Record<AudiobookCreditKey, string> = { opening: "Opening credits", closing: "Closing credits" };
const DETAIL_MAX = 200;

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};

/** What a credit's row and label say beside its length: a warning first, then its state. */
function creditState(credit: AudiobookCreditView): { word: string | null; warn: boolean } {
  const warning = audiobookCreditWarning(credit.missing);
  if (warning !== null) return { word: warning, warn: true };
  if (credit.state === "made") return { word: null, warn: false };
  if (credit.state === "flagged") return { word: "flagged", warn: true };
  return { word: credit.state === "stale" ? "changed" : "not read", warn: false };
}

/** A credit as a row of Chapters (252a, 252b): the cover, its name, its length and state, its words. */
export function CreditRow({ which, credit, slug, art, onOpen }: { which: AudiobookCreditKey; credit: AudiobookCreditView; slug: string | undefined; art: string | null; onOpen: () => void }) {
  const name = NAMES[which];
  const { word, warn } = creditState(credit);
  return (
    <div className="fy-abshow__ep" data-testid="audiobook-credit-row" data-credit={which} data-state={credit.state}>
      <button type="button" className="fy-abshow__ep-main" aria-label={`Open ${name}`} onClick={onOpen}>
        {art === null ? (
          <span className="fy-abshow__th fy-abshow__th--none" aria-hidden="true" />
        ) : (
          <span className="fy-abshow__th" aria-hidden="true">
            <Portrait worldSlug={slug} path={art} label="" radius={0} loading="lazy" />
          </span>
        )}
        <span className="fy-abshow__tx">
          <span className="fy-abshow__nm">{name}</span>
          <span className="fy-abshow__m">
            {credit.seconds !== undefined && credit.state !== "not made" && <span className="fy-abshow__d">{clock(credit.seconds)} recorded</span>}
            {word !== null && <span className={cx("fy-abshow__st", warn && "fy-abshow__w")} data-testid="audiobook-credit-state">{word}</span>}
          </span>
        </span>
        <span className="fy-abshow__syn">{credit.words}</span>
      </button>
      <button type="button" className="fy-abshow__go" aria-label={`Open ${name}`} title="Open" onClick={onOpen}>
        <ChevronRight size={16} stroke={1.9} />
      </button>
    </div>
  );
}

/** A credit's words over its field, its state where a note has its count (252b, 252c). */
function CreditWords({ which, credit, disabled, onHear, onCommit }: { which: AudiobookCreditKey; credit: AudiobookCreditView; disabled: boolean; onHear: (() => void) | null; onCommit: (words: string | null) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? credit.words;
  const { word, warn } = creditState(credit);
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim().slice(0, CREDIT_WORDS_MAX);
    setDraft(null);
    if (next !== credit.words) onCommit(next === "" ? null : next);
  };
  return (
    <div className="fy-abshow__credit" data-testid="audiobook-credit" data-credit={which}>
      <div className="fy-abshow__lbl">
        <span>{NAMES[which]}</span>
        {word !== null ? (
          <span className={cx("fy-abshow__mono", warn && "fy-abshow__w")} data-testid="audiobook-credit-label-state">{word}</span>
        ) : onHear !== null && credit.seconds !== undefined ? (
          <button type="button" className="fy-abshow__hear fy-abshow__mono" onClick={onHear} aria-label={`Hear ${NAMES[which]}`} data-testid="audiobook-credit-hear">
            <PlaySolid size={10} />
            {clock(credit.seconds)}
          </button>
        ) : null}
      </div>
      <textarea
        className="fy-abshow__credit-words"
        aria-label={NAMES[which]}
        value={shown}
        maxLength={CREDIT_WORDS_MAX}
        rows={3}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </div>
  );
}

/**
 * The Credits sheet (252b, 252c): the four details the words are drafted from, then each credit's
 * words. Read is a chapter's read: a press reads, and where the read asks a price first (a cloud
 * voice past what is free) the button then carries it and the next press confirms it. Opening the
 * sheet reads nothing (codex on PR 2274): a free or local reader would otherwise make both credits
 * before the author had pressed anything or written a word.
 */
export function CreditsSheet({ worldId, productionId, slug, credits, refused, connected, onClose }: {
  worldId: string;
  productionId: string;
  slug: string | undefined;
  credits: AudiobookCreditsView;
  refused: string | undefined;
  connected: boolean;
  onClose: () => void;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const run = useAudiobookRuns()[`${worldId}/${productionId}/${AUDIOBOOK_CREDITS_ID}`];
  const reading = run?.state === "reading";
  const toRead = (["opening", "closing"] as const).filter((key) => credits[key].state !== "made");
  // A cloned narrator's recording goes to its vendor only on the author's word (SPEC-046 R-17,
  // codex on PR 2274), asked as a chapter's read asks it: the word is held for the run, so the
  // price asked next carries it, and spent when the run ends or a fresh press starts another.
  const live = useRef<string | null>(null);
  live.current = run?.requestId ?? null;
  const upload = useVoiceUploadAsk(() => live.current);
  const ended = run !== undefined && run.state !== "reading" && run.state !== "priced";
  const drop = upload.drop;
  useEffect(() => {
    if (ended) drop();
  }, [ended]);
  useEffect(() => {
    shell.current?.focus();
    return () => audio.current?.pause();
  }, []);
  const hear = (credit: AudiobookCreditView) => {
    if (credit.file === undefined) return null;
    const file = credit.file;
    return () => {
      audio.current?.pause();
      audio.current = new Audio(mediaUrl(slug ?? "", file));
      void audio.current.play().catch(() => {});
    };
  };
  const setDetail = (detail: "title" | "author" | "narrator" | "copyright") => (value: string | null) => setAudiobookCredits(worldId, productionId, { details: { [detail]: value ?? "" } });
  const label = toRead.length === 2 ? "Read credits" : toRead.length === 1 ? `Read ${toRead[0]}` : null;
  const price = run?.state === "priced" ? run.price : undefined;
  const read = () => {
    const consent = upload.allowed();
    readAudiobookChapter(worldId, productionId, AUDIOBOOK_CREDITS_ID, {
      ...(price !== undefined ? { confirmationToken: price.confirmationToken } : {}),
      ...(consent !== undefined ? { voiceUploadConfirmedFor: consent } : {}),
    });
  };
  return (
    <>
      <div className="fy-abshow__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={shell}
        className="fy-abshow__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="audiobook-credits-title"
        tabIndex={-1}
        data-testid="credits-sheet"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="fy-abshow__sheet-hd">
          <h3 id="audiobook-credits-title">Credits</h3>
          <button type="button" className="fy-abshow__x" aria-label="Close" onClick={onClose}>
            <X size={15} stroke={1.9} />
          </button>
        </div>
        <div className="fy-abshow__sheet-bdy">
          <NoteRow label="Title" value={credits.details.title} max={DETAIL_MAX} disabled={reading} onCommit={setDetail("title")} />
          <NoteRow label="Written by" value={credits.details.author} max={DETAIL_MAX} disabled={reading} onCommit={setDetail("author")} />
          <NoteRow label="Narrated by" value={credits.details.narrator} max={DETAIL_MAX} disabled={reading} onCommit={setDetail("narrator")} />
          <NoteRow label="Copyright" value={credits.details.copyright} max={DETAIL_MAX} disabled={reading} onCommit={setDetail("copyright")} />
          {(["opening", "closing"] as const).map((key) => (
            <CreditWords
              key={key}
              which={key}
              credit={credits[key]}
              disabled={reading}
              onHear={hear(credits[key])}
              onCommit={(words) => setAudiobookCredits(worldId, productionId, { words: { [key]: words } })}
            />
          ))}
          {refused !== undefined && <p className="fy-abshow__mono fy-abshow__w" role="status">{refused}</p>}
          {run?.state === "failed" && run.reason !== undefined && <p className="fy-abshow__mono fy-abshow__w" role="status">{run.reason}</p>}
        </div>
        <div className="fy-abshow__sheet-ft">
          {label !== null && (
            <Button
              variant="primary"
              size="sm"
              disabled={!connected || reading}
              data-testid="credits-read"
              onClick={() => {
                // A press with no price waiting starts a read of its own: no earlier word rides on it.
                if (price === undefined) upload.drop();
                read();
              }}
            >
              {reading ? "Reading…" : price !== undefined ? `${label} · ~${formatMicroUsd(price.estimatedMicroUsd)}` : label}
            </Button>
          )}
          <Button variant={label === null ? "primary" : "secondary"} size="sm" onClick={onClose} data-testid="credits-done">
            Done
          </Button>
        </div>
      </div>
      {/* Over the sheet, not in its scrolling body. */}
      {upload.asked !== null && (
        <RemoteVoiceUploadConfirmation
          destinationLabel={upload.asked.destination}
          destinationNotice={upload.asked.notice}
          onCancel={() => {
            upload.drop();
            dismissAudiobookRun(worldId, productionId, AUDIOBOOK_CREDITS_ID);
          }}
          onConfirm={() => {
            if (upload.answer() !== null) read();
          }}
        />
      )}
    </>
  );
}
