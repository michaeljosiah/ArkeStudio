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
  requestVoiceCatalogue,
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

/**
 * What the door's answer depends on, as one string: asked again when it moves. The chapters'
 * title and order are in it as their version and hash are (codex on PR 1187): a rename or a
 * reorder is frontmatter alone, and the spoken heading — and so a row and its price — follows
 * it. So are the readers (codex on PR 1187, round three): the app's narrator, every sheet's
 * voice, and the catalogue that says which can speak now, since another window changing any
 * of them changes who reads, what stands in for whom, and what a press would spend.
 */
export function useAudiobookDoorStamp(
  production: { chapters: readonly { id: string; order: number; title: string; version: number; bodyHash?: string; retired?: boolean; audiobook?: unknown }[]; audiobook?: unknown } | null,
  world: { sheets: readonly { id: string; voice?: unknown }[] } | null,
): string {
  const store = useStore();
  const narrator = store.state?.app.narrator ?? null;
  const catalogue = store.voiceCatalogue;
  if (production === null) return "";
  return JSON.stringify([
    production.audiobook ?? null,
    production.chapters.map((c) => [c.id, c.order, c.title, c.version, c.bodyHash ?? "", c.retired === true, c.audiobook ?? null]),
    narrator,
    (world?.sheets ?? []).map((sheet) => [sheet.id, sheet.voice ?? null]),
    catalogue === null ? null : catalogue.map((voice) => [voice.provider, voice.model, voice.voiceId, voice.unavailableReason ?? null]),
  ]);
}

/**
 * Whether the book, or any chapter of it, is being read in this window's sight: the seg holds
 * while it is, since a reading switched under a run would leave every take the run files
 * stale (codex on PR 1187).
 */
export function useAudiobookReading(worldId: string | undefined, prodId: string | undefined): boolean {
  const book = useAudiobookBooks()[prodId ?? ""];
  const chapter = useChapterReading(worldId, prodId);
  return book?.state === "reading" || chapter;
}

/**
 * Whether a chapter of the production is being read. While one is, the rows read the run's
 * own counts and the door is not asked again for every take that lands — each ask prepares
 * the whole book, and a long book read block by block would ask once a block (codex on PR
 * 1187); it is asked once more as each chapter's run ends, so a book read chapter by chapter
 * shows each chapter read as it is.
 */
export function useChapterReading(worldId: string | undefined, prodId: string | undefined): boolean {
  const runs = useAudiobookRuns();
  return Object.entries(runs).some(([key, run]) => key.startsWith(`${worldId}/${prodId}/`) && run.state === "reading");
}

/**
 * The voices row (R-12): who reads, in what, or why the narrator does instead. A chip goes to
 * where its voice is set (issue 1191) — the narrator's to Settings, a speaker's to their voice
 * page — and one with nowhere to go, the unattributed lines, is plain.
 */
function VoiceChip({ name, voice, state, blocks, to }: { name: string; voice?: { label: string; provider: string; local: boolean }; state: string; blocks: number; to?: string }) {
  const navigate = useNavigate();
  const warn = state === "no voice" || state === "voice unavailable";
  const what =
    state === "narrator"
      ? `narrator · ${voice?.provider ?? ""}${voice?.local ? " · local" : ""}`
      : state === "reads" && voice !== undefined
        ? `${voice.label} · ${voice.provider}`
        : `${state} · narrator`;
  const inside = (
    <>
      <span className="fy-abdoor__voice-name">{name}</span>
      <span className="fy-abdoor__voice-what fy-mono">
        {what} · {blocks} block{blocks === 1 ? "" : "s"}
      </span>
    </>
  );
  const className = cx("fy-abdoor__voice", warn && "fy-abdoor__voice--warn");
  return to === undefined ? (
    <span className={className} data-testid="audiobook-voice" data-state={state}>
      {inside}
    </span>
  ) : (
    <button type="button" className={className} data-testid="audiobook-voice" data-state={state} onClick={() => navigate(to)}>
      {inside}
    </button>
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
  const { world, production } = useProduction(worldId, prodId);
  const navigate = useNavigate();
  const connection = useStore().connection;
  const held = useAudiobookDoors()[prodId ?? ""];
  const door = held?.door ?? null;
  const book = useAudiobookBooks()[prodId ?? ""];
  const note = useAudiobookNotes()[prodId ?? ""];
  const runs = useAudiobookRuns();
  const records = useAudiobookRecords();
  const stamp = useAudiobookDoorStamp(production, world);
  const running = useAudiobookReading(worldId, prodId);
  const chapterReading = useChapterReading(worldId, prodId);
  // The chapters' runs ending and the record's writes move the rows: asked again once they
  // land — not once a block while a chapter is being read, when the rows read the run's own
  // counts — and always when this window holds no door yet, as one that joins a run going
  // elsewhere does not (codex on PR 1187).
  const runStamp = JSON.stringify(Object.entries(runs).filter(([key]) => key.startsWith(`${worldId}/${prodId}/`)).map(([key, run]) => [key, run.state]));
  const recordStamp = Object.entries(records)
    .filter(([key]) => key.startsWith(`${worldId}/${prodId}/`))
    .map(([, held]) => held.seq)
    .join(",");
  useEffect(() => {
    if (!worldId || !prodId || connection !== "open" || (chapterReading && door !== null)) return;
    openAudiobook(worldId, prodId);
  }, [worldId, prodId, connection, chapterReading, door === null, stamp, runStamp, recordStamp, book?.state, note?.seq]);
  // The catalogue says who can speak now (turn 130's rule): asked for once the door is open,
  // and again as the engines come and go — the local runtime, the studio's ComfyUI — so a
  // voice gone unavailable, or back, moves the voices row and the price (codex on PR 1187).
  const app = useStore().state?.app;
  const engines = JSON.stringify([app?.runtime ?? null, app?.comfyui ?? null]);
  useEffect(() => {
    if (connection === "open") requestVoiceCatalogue(worldId);
  }, [connection, worldId, engines]);

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
          <button type="button" className={cx("fy-seg__item", reading === "narrator" && "fy-seg__item--active")} disabled={running} onClick={() => setAudiobookReading(worldId, prodId, "narrator")}>
            Narrator
          </button>
          <button type="button" className={cx("fy-seg__item", reading === "cast" && "fy-seg__item--active")} disabled={running} onClick={() => setAudiobookReading(worldId, prodId, "cast")}>
            Cast
          </button>
        </nav>
        {(door?.voices ?? []).map((voice) => (
          <VoiceChip
            key={`${voice.sheet ?? ""}:${voice.name}`}
            name={voice.name}
            voice={voice.voice}
            state={voice.state}
            blocks={voice.blocks}
            to={voice.state === "narrator" ? "/settings/general" : voice.sheet !== undefined ? `/w/${worldId}/cast/${encodeURIComponent(voice.sheet)}/voice` : undefined}
          />
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
            // A chapter the book has read while the door's answer is still the old one reads
            // as its run ended (codex on PR 1187): every block not made was tried (R-16), so
            // the made and the flagged are the row's plus the run's; the time waits for the door.
            const ended = run !== undefined && run.state !== "reading" && run.state !== "priced" && run.made + run.flagged > 0 && !row.planned && row.castTrouble === undefined
              ? { ...row, made: Math.min(row.total, row.made + run.made), stale: 0, flagged: run.flagged, notMade: Math.max(0, row.total - row.made - run.made - run.flagged), seconds: null }
              : row;
            const label = run?.state === "reading" ? `reading… ${run.made} of ${run.toMake}` : audiobookRowLabel(ended);
            const warn = row.castTrouble !== undefined || (ended.flagged > 0 && run?.state !== "reading");
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
        {(price.notices ?? []).map((notice) => <div key={notice} className="fy-ms__line" data-testid="read-book-notice">{notice}</div>)}
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
