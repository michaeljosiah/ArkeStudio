import { useEffect, useRef, useState, type ReactNode } from "react";
import { ulid, type AudiobookListening, type ProductionBundle } from "@arke-studio/contracts";
import { downloadMedia } from "../lib/download.js";
import { mediaUrl } from "../lib/media.js";
import { listWebPackages, openExportsFolder, subscribeArkePlayerExported, subscribeWebPackages, exportArkePlayer, useStore, type ArkePlayerExported } from "../lib/store.js";
import { Folder, megabytes, Toggle, wholeChapters } from "./audiobook-video.js";

/**
 * Export → Arke Player (design turn 233, SPEC-058 R-1 – R-8): the world package a person adds by
 * hand in Arke Player — the book whole, the narration of the chapters read whole with its pictures
 * fitted for a phone, Text timed and the pictures' loops. Counted from the same listening plan the
 * player plays, so the sheet's rows are the package's.
 */

// What the estimate assumes: AAC at 128 kb/s, a fitted picture, a loop and the book, and how fast
// this machine joins audio and fits pictures. An estimate, said with `~`.
const AUDIO_BYTES_PER_SECOND = 16_000;
const PICTURE_BYTES = 450_000;
const LOOP_BYTES = 2_500_000;
const BOOK_BYTES = 600_000;
const AUDIO_SECONDS_PER_SECOND = 40;
const SECONDS_PER_PICTURE = 0.4;

export interface ArkePlayerCounts {
  chapters: number;
  of: number;
  /** `Chapters 1–12`, or how many where they do not run on. */
  range: string;
  pictures: number;
  loops: number;
  /** Chapters whose every block has validated word timing. */
  wordsTimed: number;
  bytes: number;
  minutes: number;
}

export function arkePlayerCounts(plan: AudiobookListening, options: { book: boolean; motion: boolean }): ArkePlayerCounts {
  const whole = wholeChapters(plan);
  const pictures = new Set<string>([...(plan.cover !== null ? [plan.cover] : []), ...whole.flatMap((chapter) => [...chapter.pictures.map((picture) => picture.file), ...(chapter.opening !== null ? [chapter.opening] : [])])]);
  const loops = new Set(whole.flatMap((chapter) => chapter.pictures.flatMap((picture) => (picture.motion !== undefined ? [picture.motion.file] : []))));
  const orders = whole.map((chapter) => chapter.order);
  const runsOn = orders.every((order, index) => index === 0 || order === orders[index - 1]! + 1);
  const seconds = whole.reduce((sum, chapter) => sum + chapter.seconds, 0);
  const shipped = options.motion ? loops.size : 0;
  return {
    chapters: whole.length,
    of: plan.chapters.length,
    range: orders.length === 0 ? "none" : orders.length === 1 ? `Chapter ${orders[0]}` : runsOn ? `Chapters ${orders[0]}–${orders[orders.length - 1]}` : `${orders.length} chapters`,
    pictures: pictures.size,
    loops: loops.size,
    wordsTimed: whole.filter((chapter) => chapter.blocks.every((block) => (block.words?.length ?? 0) > 0)).length,
    bytes: seconds * AUDIO_BYTES_PER_SECOND + pictures.size * PICTURE_BYTES + shipped * LOOP_BYTES + (options.book ? BOOK_BYTES : 0),
    minutes: Math.max(1, Math.ceil((seconds / AUDIO_SECONDS_PER_SECOND + (pictures.size + shipped * 10) * SECONDS_PER_PICTURE) / 60)),
  };
}

/** The chapters the book holds (R-2): every chapter still in the manuscript. */
export const bookChapters = (production: ProductionBundle) => production.chapters.filter((chapter) => chapter.retired !== true && (chapter.words === undefined || chapter.words > 0)).length;

/** `21 Oct 2026`, today, as the edition the package will carry. */
const edition = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

const holds = (result: Extract<ArkePlayerExported["result"], { ok: true }>) =>
  [result.chapters > 0 ? `${result.chapters} chapter${result.chapters === 1 ? "" : "s"}` : null, result.pictures > 0 ? `${result.pictures} picture${result.pictures === 1 ? "" : "s"}` : null, result.book ? "the book" : null].filter((part) => part !== null).join(" · ");

/**
 * The Arke Player kind of the Export sheet: its rows (233a), what stood in the way (233d), and the
 * package made with its size and SHA-256 (233c). The package is made on the desktop that holds the
 * world, whichever window asked (233f).
 */
export function useArkePlayerExport({ worldId, worldSlug, production, plan, worldName, committed, remote, phone, onClose }: {
  worldId: string;
  worldSlug: string | undefined;
  production: ProductionBundle;
  plan: AudiobookListening | null;
  worldName: string;
  /** The chapters the book holds: every committed chapter, in manuscript order (R-2). */
  committed: number;
  remote: boolean;
  phone: boolean;
  onClose: () => void;
}): { rows: ReactNode; lines: ReactNode; foot: ReactNode; sub: string | null } {
  const connection = useStore().connection;
  const [options, setOptions] = useState({ book: committed > 0, motion: true });
  const [result, setResult] = useState<ArkePlayerExported["result"] | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const listing = useRef<string | null>(null);
  useEffect(() => {
    const offExported = subscribeArkePlayerExported((answer) => {
      if (answer.exportId !== making) return;
      setMaking(null);
      setResult(answer.result);
    });
    // A reconnect can lose the one answer (as the player's export, codex on PR 1498): the
    // packages are listed again, and this export's package is the answer.
    const offPackages = subscribeWebPackages((answer) => {
      if (answer.requestId !== listing.current || making === null) return;
      const found = answer.packages.find((entry) => entry.kind === "arke-player" && entry.exportId === making);
      if (found?.file === undefined || found.sha256 === undefined) return;
      setMaking(null);
      setResult({ ok: true, file: found.file, bytes: found.bytes ?? 0, sha256: found.sha256, edition: found.exportedAt.slice(0, 10), chapters: 0, pictures: 0, book: false });
    });
    return () => {
      offExported();
      offPackages();
    };
  }, [making]);
  useEffect(() => {
    if (connection === "open" && making !== null) listing.current = listWebPackages(worldId);
  }, [connection, worldId]);

  const counts = plan === null ? null : arkePlayerCounts(plan, options);
  const empty = counts !== null && counts.chapters === 0 && !options.book;
  const start = () => {
    const id = `ap_${ulid()}`;
    setResult(null);
    setCopied(false);
    if (exportArkePlayer(worldId, production.meta.id, id, options) !== null) setMaking(id);
  };
  const made = result?.ok === true ? result : null;
  const name = made === null ? "" : made.file.slice("exports/".length);
  const [handing, setHanding] = useState(false);
  const [handed, setHanded] = useState<string | null>(null);
  const canShare = typeof navigator !== "undefined" && typeof navigator.canShare === "function";
  const download = async () => {
    if (made === null) return;
    setHanding(true);
    const outcome = await downloadMedia(worldSlug, made.file, name, "package");
    setHanding(false);
    setHanded(outcome.ok || outcome.cancelled === true ? null : outcome.reason);
  };
  const share = async () => {
    if (made === null || worldSlug === undefined) return;
    setHanding(true);
    setHanded(null);
    try {
      const response = await fetch(mediaUrl(worldSlug, made.file));
      if (!response.ok) throw new Error(String(response.status));
      const file = new File([await response.blob()], name, { type: "application/zip" });
      if (!navigator.canShare({ files: [file] })) setHanded("this phone cannot share the package · use Download");
      else await navigator.share({ files: [file], title: worldName });
    } catch (error) {
      // Closing the share sheet is an answer, not a failure.
      if (!(error instanceof DOMException && error.name === "AbortError")) setHanded("the package could not be shared · use Download");
    } finally {
      setHanding(false);
    }
  };

  const opt = (label: string, middle: ReactNode, tail?: string) => (
    <div className="fy-abv-opt">
      <b>{label}</b>
      {middle}
      <span className="grow" />
      {tail !== undefined && !phone && <i>{tail}</i>}
    </div>
  );
  const rows = made !== null ? null : (
    <>
      {!phone && opt("World", <span>{worldName}</span>, "key art · logline")}
      {opt("Book", committed === 0 ? <span>None</span> : <Toggle on={options.book} onChange={(book) => setOptions({ ...options, book })}>The book</Toggle>, committed === 0 ? "no chapter has prose" : `${committed} chapter${committed === 1 ? "" : "s"} · EPUB`)}
      {opt("Narration", <span>{counts === null ? "…" : `${counts.chapters} of ${counts.of}${phone ? "" : " · read whole"}`}</span>, counts?.range)}
      {opt("Pictures", <span>{counts === null ? "…" : `${counts.pictures}${phone ? "" : " · fitted for a phone"}`}</span>, "2048 px · cover before the first")}
      {opt("Text", <span>{phone ? "Timed" : "Phrases, timed"}</span>, counts === null || counts.chapters === 0 ? undefined : `words timed in ${counts.wordsTimed} of ${counts.chapters}`)}
      {opt("Motion", counts !== null && counts.loops === 0 ? <span>None</span> : <Toggle on={options.motion} onChange={(motion) => setOptions({ ...options, motion })}>Loops</Toggle>, counts === null || counts.loops === 0 ? undefined : `${counts.loops} · each with its still`)}
      {!phone && opt("Edition", <span className="fy-abv-field">{edition()}</span>)}
    </>
  );
  const lines = (
    <>
      {made === null && (
        <div className="fy-abv-est" data-testid="arke-player-estimate">
          <b>{counts === null ? "…" : `~${megabytes(counts.bytes)} · ~${counts.minutes} min ${remote ? "on the desktop" : "on this machine"}`}</b>
          {!phone && counts !== null && <span className="m">{[`${counts.chapters} chapter${counts.chapters === 1 ? "" : "s"}`, `${counts.pictures} pictures`, options.book ? "the book" : null].filter(Boolean).join(" · ")}</span>}
        </div>
      )}
      {making !== null && <div className="fy-abv-note" data-testid="arke-player-making">Making package · follow it in Activity</div>}
      {result?.ok === false && result.blockers.map((blocker) => <div key={blocker} className="fy-abv-warn">{blocker}</div>)}
      {made !== null && (
        <div className="fy-abv-made" data-testid="arke-player-done">
          <div className="fy-abv-est">
            <b>1 package · {megabytes(made.bytes)}</b>
            <span className="m">{made.file}</span>
            <span style={{ flex: 1 }} />
            {!remote && (
              <button type="button" className="fy-abv-btn" onClick={() => openExportsFolder(worldId)}>
                <Folder />
                Show in folder
              </button>
            )}
            {!phone && <button type="button" className="fy-abv-btn" disabled={connection !== "open"} onClick={start}>Make again</button>}
          </div>
          <div className="fy-abv-file">
            <div>{name}</div>
            <div className="m">{[holds(made), megabytes(made.bytes)].filter(Boolean).join(" · ")}</div>
          </div>
          <div className="fy-abv-sha">
            <b>SHA-256</b>
            <code>{made.sha256}</code>
            <button type="button" className="fy-abv-btn" onClick={() => void navigator.clipboard?.writeText(made.sha256).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
          </div>
          {/* From a paired phone (233f): the package was made on the desktop; Download keeps it,
              Share hands it to the phone's share sheet, where Arke Player takes it. */}
          {remote && (
            <div className="fy-abv-acts">
              <button type="button" className="fy-abv-btn" disabled={handing} onClick={() => void download()}>Download</button>
              {canShare && <button type="button" className="fy-abv-btn" disabled={handing} onClick={() => void share()}>Share</button>}
            </div>
          )}
          {handed !== null && <div className="fy-abv-warn">{handed}</div>}
        </div>
      )}
    </>
  );
  const foot = (
    <div className="fy-abv-foot">
      <span className="grow" />
      {made !== null ? (
        <button type="button" className="fy-abv-btn pri" onClick={onClose}>Done</button>
      ) : (
        <>
          <button type="button" className="fy-abv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="fy-abv-btn pri" style={phone ? { flex: 1 } : undefined} disabled={making !== null || connection !== "open" || counts === null || empty} onClick={start} data-testid="arke-player-start">
            Make package
          </button>
        </>
      )}
    </div>
  );
  return { rows, lines, foot, sub: made === null ? null : `arke player · made ${made.edition}` };
}
