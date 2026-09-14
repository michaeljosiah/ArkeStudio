import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { audiobookDoorLine, audiobookRowLabel, formatMicroUsd, type AudiobookPriceLine, type AudiobookRow } from "@arke-studio/contracts";
import { EditorDialog } from "../components/editor-dialog.js";
import { ChevronRight } from "../components/icons.js";
import { EmptyState } from "../components/layout.js";
import { RemoteVoiceUploadConfirmation } from "../components/remote-voice-upload-confirmation.js";
import { Badge, Button, cx } from "../components/ui.js";
import { useProduction } from "../lib/selectors.js";
import {
  dismissAudiobookBook,
  dismissAudiobookNote,
  openAudiobook,
  readAudiobookBook,
  setAudiobookReading,
  stopAudiobookBook,
  subscribeVoiceUploadConfirmations,
  useAudiobookBooks,
  useAudiobookDoors,
  useAudiobookNotes,
  useAudiobookRecords,
  useAudiobookRuns,
  useStore,
} from "../lib/store.js";

/**
 * The Audiobook door (design turn 146, SPEC-047 R-29): the Chapters door's shape, for the
 * reading. The title over the count and the running time; one primary, `Read the book · N
 * chapters · $X`; `Narrator · Cast` with the voices beside it — the narrator, each speaker with
 * the voice that reads them, `no voice · narrator` in warning; a 4px read bar; then a row a
 * chapter in order: number, title, version, its state or its running time, a chevron. A row
 * opens the chapter in its Audiobook view. Everything on it is the coordinator's answer to
 * `open-audiobook`, asked again whenever the book changes under it.
 */

/** What the rows depend on, as one string: asked again when it moves. */
function doorStamp(production: { chapters: readonly { id: string; version: number; bodyHash?: string; retired?: boolean; audiobook?: unknown }[]; audiobook?: unknown } | null): string {
  if (production === null) return "";
  return JSON.stringify([production.audiobook ?? null, production.chapters.map((c) => [c.id, c.version, c.bodyHash ?? "", c.retired === true, c.audiobook ?? null])]);
}

/** The voices row (R-12): who reads, in what, or why the narrator does instead. */
function VoiceChip({ name, voice, state, blocks }: { name: string; voice?: { label: string; provider: string; local: boolean }; state: string; blocks: number }) {
  const warn = state === "no voice" || state === "voice unavailable";
  const what =
    state === "narrator"
      ? `narrator · ${voice?.provider ?? ""}${voice?.local ? " · local" : ""}`
      : state === "reads" && voice !== undefined
        ? `${voice.label} · ${voice.provider}`
        : `${state} · narrator`;
  return (
    <span className={cx("fy-abdoor__voice", warn && "fy-abdoor__voice--warn")} data-testid="audiobook-voice" data-state={state}>
      <span className="fy-abdoor__voice-name">{name}</span>
      <span className="fy-abdoor__voice-what fy-mono">
        {what} · {blocks} block{blocks === 1 ? "" : "s"}
      </span>
    </span>
  );
}

function priceLineWords(line: AudiobookPriceLine): { who: string; how: string; cost: string; warn: boolean } {
  const cost = `${line.characters.toLocaleString()} · ${line.estimatedMicroUsd === 0 ? "free" : formatMicroUsd(line.estimatedMicroUsd)}`;
  if (line.speaker !== undefined) {
    // The narrator stands in (R-12): said as the speaker, and — when that narrator is a cloud
    // voice — the vendor the speaker's words go to, named here as on every paid line (codex on PR 1187).
    return { who: line.speaker, how: `${line.substituted ?? "no voice"} · narrator${line.local ? "" : ` · ${line.provider}`}`, cost, warn: true };
  }
  return { who: line.label, how: `${line.narrator === true ? "narrator · " : ""}${line.provider}${line.local ? " · local" : ""}`, cost, warn: false };
}

export function AudiobookScreen() {
  const { prodId, worldId } = useParams();
  const { production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const connection = useStore().connection;
  const held = useAudiobookDoors()[prodId ?? ""];
  const door = held?.door ?? null;
  const book = useAudiobookBooks()[prodId ?? ""];
  const note = useAudiobookNotes()[prodId ?? ""];
  const runs = useAudiobookRuns();
  const records = useAudiobookRecords();
  const stamp = doorStamp(production);
  // The chapters' runs and the record's writes move the rows: asked again once they land.
  const runStamp = JSON.stringify(Object.entries(runs).filter(([key]) => key.startsWith(`${worldId}/${prodId}/`)).map(([key, run]) => [key, run.state, run.made]));
  const recordStamp = Object.entries(records)
    .filter(([key]) => key.startsWith(`${worldId}/${prodId}/`))
    .map(([, held]) => held.seq)
    .join(",");
  useEffect(() => {
    if (!worldId || !prodId || connection !== "open") return;
    openAudiobook(worldId, prodId);
  }, [worldId, prodId, connection, stamp, runStamp, recordStamp, book?.state, note?.seq]);

  // A cloned voice's recording leaving the machine (SPEC-022, SPEC-046): asked under the book's request, the answer kept for the price's answer and spent with the run (codex on PR 1180).
  const [upload, setUpload] = useState<{ destination: string; token: string; notice?: string } | null>(null);
  const uploadAllowed = useRef<string | null>(null);
  useEffect(
    () =>
      subscribeVoiceUploadConfirmations((confirmation) => {
        if (confirmation.requestId !== book?.requestId) return;
        setUpload({ destination: confirmation.destinationLabel, token: confirmation.confirmationToken, ...(confirmation.destinationNotice !== undefined ? { notice: confirmation.destinationNotice } : {}) });
      }),
    [book?.requestId],
  );
  const ended = book !== undefined && book.state !== "reading" && book.state !== "priced";
  useEffect(() => {
    if (ended) uploadAllowed.current = null;
  }, [ended]);
  useEffect(() => {
    uploadAllowed.current = null;
  }, [prodId]);
  const send = useCallback(
    (options: { confirmationToken?: string; voiceUploadConfirmedFor?: string } = {}) => {
      if (!worldId || !prodId) return;
      const consent = options.voiceUploadConfirmedFor ?? uploadAllowed.current ?? undefined;
      readAudiobookBook(worldId, prodId, {
        ...(options.confirmationToken !== undefined ? { confirmationToken: options.confirmationToken } : {}),
        ...(consent !== undefined ? { voiceUploadConfirmedFor: consent } : {}),
      });
    },
    [worldId, prodId],
  );
  const begin = () => {
    if (book?.state === "reading" || book?.state === "priced") return;
    setUpload(null);
    uploadAllowed.current = null;
    send();
  };

  if (!worldId || !prodId || production === null) return null;
  const rows: AudiobookRow[] = door?.rows ?? [];
  const line = audiobookDoorLine(rows);
  const totalBlocks = rows.reduce((sum, row) => sum + row.total, 0);
  const madeBlocks = rows.reduce((sum, row) => sum + row.made, 0);
  const reading = door?.reading ?? production.audiobook?.reading ?? "narrator";
  const readingNow = book?.state === "reading";
  const price = door?.price ?? null;
  const pad = (order: number) => String(order).padStart(2, "0");
  const bookNote =
    book?.state === "stopped"
      ? "stopped · the takes made stand"
      : book?.state === "failed" || book?.state === "unavailable"
        ? `could not read · ${book.reason ?? "the run failed"}`
        : book?.state === "read" && book.chaptersRefused > 0
          ? book.chaptersRefused === 1
            ? "1 chapter left to its row"
            : `${book.chaptersRefused} chapters left to their rows`
          : null;
  const primary = (() => {
    if (upload !== null && book?.state !== "read") {
      return (
        <RemoteVoiceUploadConfirmation
          destinationLabel={upload.destination}
          destinationNotice={upload.notice}
          onCancel={() => {
            setUpload(null);
            uploadAllowed.current = null;
            dismissAudiobookBook(prodId);
          }}
          onConfirm={() => {
            uploadAllowed.current = upload.token;
            setUpload(null);
            send({ voiceUploadConfirmedFor: upload.token });
          }}
        />
      );
    }
    if (readingNow) {
      return (
        <span className="fy-ab__control">
          <span className="fy-mono">
            reading… {book.done} of {book.chapters} chapter{book.chapters === 1 ? "" : "s"}
          </span>
          <Button variant="ghost" onClick={() => stopAudiobookBook(worldId, prodId)}>
            Stop
          </Button>
        </span>
      );
    }
    if (price === null || price.chapters === 0) return null;
    return (
      <Button variant="primary" disabled={connection !== "open" || book?.state === "priced"} onClick={begin} data-testid="read-book">
        Read the book · {price.chapters} chapter{price.chapters === 1 ? "" : "s"}
        {price.estimatedMicroUsd > 0 ? ` · ${formatMicroUsd(price.estimatedMicroUsd)}` : ""}
      </Button>
    );
  })();
  return (
    <div className="fy-prodmain" data-screen="audiobook">
      <div className="fy-h1row">
        <h1 className="fy-h1">Audiobook</h1>
        <span className="fy-h1row__meta" data-testid="audiobook-line">
          {door === null ? "…" : line.line}
        </span>
        <span className="fy-h1row__push" />
        {primary}
      </div>
      <div className="fy-abdoor__voices" data-testid="audiobook-voices">
        <nav className="fy-seg" aria-label="Reading">
          <button type="button" className={cx("fy-seg__item", reading === "narrator" && "fy-seg__item--active")} disabled={readingNow} onClick={() => setAudiobookReading(worldId, prodId, "narrator")}>
            Narrator
          </button>
          <button type="button" className={cx("fy-seg__item", reading === "cast" && "fy-seg__item--active")} disabled={readingNow} onClick={() => setAudiobookReading(worldId, prodId, "cast")}>
            Cast
          </button>
        </nav>
        {(door?.voices ?? []).map((voice) => (
          <VoiceChip key={`${voice.sheet ?? ""}:${voice.name}`} name={voice.name} voice={voice.voice} state={voice.state} blocks={voice.blocks} />
        ))}
        {door !== null && door.unattributed > 0 && <VoiceChip name="unattributed" state="no voice" blocks={door.unattributed} />}
      </div>
      {(bookNote !== null || note !== undefined) && (
        <div className="fy-abdoor__note fy-mono" data-testid="audiobook-note">
          {bookNote !== null && (
            <span className={cx(book?.state !== "read" && "fy-ch__who-where--warn")}>
              {bookNote}
              <button type="button" className="fy-ab__cue-x" aria-label="Put away" onClick={() => dismissAudiobookBook(prodId)}>
                ×
              </button>
            </span>
          )}
          {note !== undefined && (
            <span>
              {note.dropped} control{note.dropped === 1 ? "" : "s"} dropped · {note.chapters} chapter{note.chapters === 1 ? "" : "s"}
              <button type="button" className="fy-ab__cue-x" aria-label="Put away" onClick={() => dismissAudiobookNote(prodId)}>
                ×
              </button>
            </span>
          )}
        </div>
      )}
      <div className="fy-ch__target fy-ch__target--page" role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(1, totalBlocks)} aria-valuenow={madeBlocks} data-testid="audiobook-bar">
        <span style={{ width: `${totalBlocks === 0 ? 0 : Math.round((madeBlocks / totalBlocks) * 100)}%` }} />
      </div>
      {rows.length > 0 ? (
        <div className="fy-ledger" data-testid="audiobook-rows">
          {rows.map((row) => {
            const run = runs[`${worldId}/${prodId}/${row.chapterId}`];
            const label = run?.state === "reading" ? `reading… ${run.made} of ${run.toMake}` : audiobookRowLabel(row);
            const warn = row.castTrouble !== undefined || (row.flagged > 0 && run?.state !== "reading");
            return (
              <button
                key={row.chapterId}
                type="button"
                className="fy-row"
                data-testid="audiobook-row"
                data-state={row.planned ? "planned" : label}
                onClick={() => navigate(`/w/${worldId}/p/${prodId}/story/chapters/${encodeURIComponent(row.chapterId)}?view=audiobook`)}
              >
                <span className="fy-mono">{pad(row.order)}</span>
                <span className="fy-row__name">{row.title}</span>
                <Badge tone="outline">v{row.version}</Badge>
                <span className={cx("fy-row__meta", warn && "fy-ch__who-where--warn", row.planned && "fy-abdoor__planned")}>{label}</span>
                <span className="fy-row__chev">
                  <ChevronRight size={15} />
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyState title={door === null ? (held?.refused ?? "Opening…") : "No chapters yet"} />
      )}
      {book?.state === "priced" && book.price !== undefined && (
        <BookPriceSheet
          price={book.price}
          onClose={() => dismissAudiobookBook(prodId)}
          onConfirm={() => send({ confirmationToken: book.price!.confirmationToken })}
        />
      )}
    </div>
  );
}

/**
 * The price, once (R-17, frame 146c): the chapters and characters the press would read, each
 * voice with what it reads and what it costs — the narrator's share free, a speaker with no
 * voice in warning — and where the words go. Confirm carries the figure.
 */
function BookPriceSheet({ price, onClose, onConfirm }: {
  price: Extract<import("@arke-studio/contracts").DomainEvent, { type: "audiobook.book-priced" }>;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const vendors = [...new Set(price.voices.filter((line) => !line.local).map((line) => line.provider))];
  return (
    <EditorDialog open title="Read the book" subtitle={`${price.chapters} chapter${price.chapters === 1 ? "" : "s"} · ${price.characters.toLocaleString()} characters · ${price.cloudBlocks} cloud line${price.cloudBlocks === 1 ? "" : "s"}`} onClose={onClose} width={460} labelledBy="read-book-title">
      <div className="fy-exsheet" data-testid="read-book-sheet">
        <div className="fy-abdoor__lines">
          {price.voices.map((line, index) => {
            const words = priceLineWords(line);
            return (
              <div key={index} className={cx("fy-abdoor__line", words.warn && "fy-abdoor__line--warn")} data-testid="read-book-line">
                <span className="fy-abdoor__line-who">{words.who}</span>
                <span className="fy-abdoor__line-how fy-mono">{words.how}</span>
                <span className="fy-abdoor__line-cost fy-mono">{words.cost}</span>
              </div>
            );
          })}
        </div>
        {vendors.length > 0 && <div className="fy-ms__line">words and the voice to {vendors.join(", ")} · text in Activity</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} data-testid="read-book-confirm">
            Confirm {price.characters.toLocaleString()} characters · {formatMicroUsd(price.estimatedMicroUsd)}
          </Button>
        </div>
      </div>
    </EditorDialog>
  );
}
