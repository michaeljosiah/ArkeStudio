import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ARKE_PLAYER_PICTURE_SIZES,
  arkePlayerPartChapters,
  arkePlayerPictureEdge,
  arkePlayerReleaseState,
  chapterBlocksRead,
  guideCounts,
  guideLiving,
  PART_SCHEDULE_DAYS,
  ulid,
  type ArkePlayerPictureSize,
  type AudiobookListening,
  type GuideCounts,
  type ListeningChapter,
  type PartSchedule,
  type PartScheduleDay,
  type ProductionBundle,
  type WebPackagesListed,
  type WorldBundle,
} from "@arke-studio/contracts";
import { downloadMedia } from "../lib/download.js";
import { mediaUrl } from "../lib/media.js";
import { listWebPackages, openExportsFolder, subscribeArkePlayerExported, subscribeWebPackages, exportArkePlayer, useStore, useWorld, type ArkePlayerExported } from "../lib/store.js";
import { Folder, megabytes, Toggle } from "./audiobook-video.js";
import { cx } from "./ui.js";

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
/** The long side a full picture ships at (SPEC-058 R-6); Size's smaller ones are measured against it. */
const FULL_EDGE = 2048;
const LOOP_BYTES = 2_500_000;
const BOOK_BYTES = 600_000;
/** A guide's portrait or place fitted to 1024 px, and its text and voice lines, roughly. */
const GUIDE_ENTRY_BYTES = 160_000;
const AUDIO_SECONDS_PER_SECOND = 40;
const SECONDS_PER_PICTURE = 0.4;

export interface ArkePlayerCounts {
  chapters: number;
  of: number;
  /** `Chapters 1–12`, or how many where they do not run on. */
  range: string;
  pictures: number;
  /** The moments made Tall as well (design turn 235, SPEC-058 R-42). */
  tall: number;
  loops: number;
  /** Chapters whose every block has validated word timing. */
  wordsTimed: number;
  bytes: number;
  minutes: number;
}

/**
 * The chapters a package carries, by the exporter's own test: read whole, by takes or by an
 * Audio Studio chapter's one mix, which may hold no speech block at all.
 */
const readWhole = (chapter: ListeningChapter) => chapter.state === "read" && (chapter.blocks.length > 0 || (chapter.audioStudio !== undefined && chapter.mix !== undefined));
const carried = (plan: AudiobookListening) => plan.chapters.filter(readWhole);

/** `22 Oct 2026`, on the exporter's UTC day as an edition is named. */
const dayOf = (at: string) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** How the Schedule names a day (236d): `Fridays`, `Daily`. */
const dayLabel = (day: PartScheduleDay) => (day === "daily" ? "Daily" : `${day[0]!.toUpperCase()}${day.slice(1)}s`);

type Listed = WebPackagesListed["packages"][number];

export function arkePlayerCounts(plan: AudiobookListening, options: { book: boolean; motion: boolean; size?: ArkePlayerPictureSize }): ArkePlayerCounts {
  const whole = carried(plan);
  // The cover ships with the narration only: a package of the book alone shows no pictures.
  const pictures = new Set<string>(whole.length === 0 ? [] : [...(plan.cover !== null ? [plan.cover] : []), ...whole.flatMap((chapter) => [...chapter.pictures.map((picture) => picture.file), ...(chapter.opening !== null ? [chapter.opening] : [])])]);
  const tall = new Set(whole.flatMap((chapter) => chapter.pictures.flatMap((picture) => (picture.tall !== undefined ? [picture.tall] : []))));
  const loops = new Set(whole.flatMap((chapter) => chapter.pictures.flatMap((picture) => (picture.motion !== undefined ? [picture.motion.file] : []))));
  // A smaller Size shrinks a picture by its area (235d); the estimate's picture is a full one.
  const edge = arkePlayerPictureEdge(options.size) ?? FULL_EDGE;
  const pictureBytes = PICTURE_BYTES * Math.min(1, (edge / FULL_EDGE) ** 2);
  const orders = whole.map((chapter) => chapter.order);
  const runsOn = orders.every((order, index) => index === 0 || order === orders[index - 1]! + 1);
  const seconds = whole.reduce((sum, chapter) => sum + chapter.seconds, 0);
  const shipped = options.motion ? loops.size : 0;
  return {
    chapters: whole.length,
    of: plan.chapters.length,
    range: orders.length === 0 ? "none" : orders.length === 1 ? `Chapter ${orders[0]}` : runsOn ? `Chapters ${orders[0]}–${orders[orders.length - 1]}` : `${orders.length} chapters`,
    pictures: pictures.size,
    tall: tall.size,
    loops: loops.size,
    wordsTimed: whole.filter((chapter) => chapter.blocks.every((block) => (block.words?.length ?? 0) > 0)).length,
    bytes: seconds * AUDIO_BYTES_PER_SECOND + (pictures.size + tall.size) * pictureBytes + shipped * LOOP_BYTES + (options.book ? BOOK_BYTES : 0),
    minutes: Math.max(1, Math.ceil((seconds / AUDIO_SECONDS_PER_SECOND + (pictures.size + tall.size + shipped * 10) * SECONDS_PER_PICTURE) / 60)),
  };
}

/** What the world's Guide makes public (SPEC-059 R-15), as the Export sheet's Guide row counts it. */
export function exportGuideCounts(world: WorldBundle): GuideCounts {
  const sheets = (type: string) => guideLiving(world.sheets.filter((sheet) => sheet.type === type));
  return guideCounts(world.guide, { characters: sheets("character"), locations: sheets("location"), factions: sheets("faction"), canon: guideLiving(world.canon) });
}

/** The chapters the book holds (R-2): every chapter still in the manuscript. */
export const bookChapters = (production: ProductionBundle) => production.chapters.filter((chapter) => chapter.retired !== true && (chapter.words === undefined || chapter.words > 0)).length;

/** `2026-10-21 09:12` in this device's time: when the package was made (233c). */
const madeStamp = (at: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/**
 * `21 Oct 2026`: the edition the package will carry, on the exporter's own clock — the UTC day —
 * so a phone in another time zone, or a desktop near midnight, previews the edition it gets.
 */
const edition = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

const holds = (result: Extract<ArkePlayerExported["result"], { ok: true }>) =>
  [result.chapters > 0 ? `${result.chapters} chapter${result.chapters === 1 ? "" : "s"}` : null, result.pictures > 0 ? `${result.pictures} picture${result.pictures === 1 ? "" : "s"}` : null, result.book ? "the book" : null, result.guide === true ? "the guide" : null].filter((part) => part !== null).join(" · ");

/**
 * The Arke Player kind of the Export sheet: its rows (233a), what stood in the way (233d), and the
 * package made with its size and SHA-256 (233c). The package is made on the desktop that holds the
 * world, whichever window asked (233f).
 */
export function useArkePlayerExport({ worldId, worldSlug, keyArt, production, plan, worldName, committed, remote, phone, onClose }: {
  worldId: string;
  worldSlug: string | undefined;
  /** The world's key art, world-relative: the package's picture in the made row (233c). */
  keyArt: string | null;
  production: ProductionBundle;
  plan: AudiobookListening | null;
  worldName: string;
  /** The chapters the book holds: every committed chapter, in manuscript order (R-2). */
  committed: number;
  remote: boolean;
  phone: boolean;
  onClose: () => void;
}): { rows: ReactNode; lines: ReactNode; foot: ReactNode; made: boolean; sub: string | null } {
  const connection = useStore().connection;
  const world = useWorld();
  const [options, setOptions] = useState<{ book: boolean; motion: boolean; size: ArkePlayerPictureSize }>({ book: committed > 0, motion: true, size: "full" });
  const [result, setResult] = useState<ArkePlayerExported["result"] | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [madeAt, setMadeAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const listing = useRef<string | null>(null);
  // What this production has released (236d, SPEC-058 R-43): listed when the sheet opens and again
  // once a package is made, so Release knows what a part follows and the made sheet the releases.
  const [listed, setListed] = useState<Listed[] | null>(null);
  const releasesAsk = useRef<string | null>(null);
  const [release, setRelease] = useState<"whole" | "part">("whole");
  // How many of the chapters ready to release are ticked; all of them until the author unticks one.
  const [upTo, setUpTo] = useState<number | null>(null);
  const [schedule, setSchedule] = useState<PartSchedule | null>(null);
  useEffect(() => subscribeWebPackages((answer) => {
    if (answer.requestId === releasesAsk.current) setListed(answer.packages);
  }), []);
  // Asked once a sheet, never again on a reconnect: that listing is the export's own recovery's
  // (codex on PR 1498), which answers by its own request.
  useEffect(() => {
    if (connection === "open" && releasesAsk.current === null) releasesAsk.current = listWebPackages(worldId);
  }, [connection, worldId]);
  useEffect(() => {
    const offExported = subscribeArkePlayerExported((answer) => {
      if (answer.exportId !== making) return;
      setMaking(null);
      setResult(answer.result);
      setMadeAt(new Date());
      if (answer.result.ok) releasesAsk.current = listWebPackages(worldId);
    });
    // A reconnect can lose the one answer (as the player's export, codex on PR 1498): the
    // packages are listed again, and this export's package is the answer.
    const offPackages = subscribeWebPackages((answer) => {
      if (answer.requestId !== listing.current || making === null) return;
      const found = answer.packages.find((entry) => entry.kind === "arke-player" && entry.exportId === making);
      if (found?.file === undefined || found.sha256 === undefined) return;
      setMaking(null);
      setResult({ ok: true, file: found.file, bytes: found.bytes ?? 0, sha256: found.sha256, edition: found.exportedAt.slice(0, 10), chapters: found.chapters ?? 0, pictures: found.pictures ?? 0, book: found.book ?? false, guide: found.guide ?? false, ...(found.release?.part !== undefined ? { part: found.release.part.number } : {}) });
      setMadeAt(new Date(found.exportedAt));
      setListed(answer.packages);
    });
    return () => {
      offExported();
      offPackages();
    };
  }, [making]);
  useEffect(() => {
    if (connection === "open" && making !== null) listing.current = listWebPackages(worldId);
  }, [connection, worldId]);

  // Release (236d): a production with an edition may release the chapters read whole since, as a
  // part. They run on from the last release and stop at the first not read whole (R-44).
  const releaseState = listed === null ? null : arkePlayerReleaseState(listed, production.meta.id);
  const after = plan !== null && releaseState !== null ? arkePlayerPartChapters(plan.chapters, releaseState) : null;
  const unready = after === null ? -1 : after.ready.findIndex((chapter) => !readWhole(chapter));
  const ready = after === null ? [] : unready === -1 ? after.ready : after.ready.slice(0, unready);
  const waiting = after === null ? [] : [...after.ready.slice(ready.length), ...after.waiting];
  const parting = release === "part" && releaseState !== null;
  const ticked = ready.slice(0, Math.min(upTo ?? ready.length, ready.length));
  // The newest part's schedule carries on until the author changes it (R-48).
  const kept: PartSchedule = schedule ?? releaseState?.schedule ?? {};
  const keep = (day: PartScheduleDay | undefined, next: string | undefined) => setSchedule({ ...(day !== undefined ? { day } : {}), ...(next !== undefined ? { next } : {}) });
  // The releases the made sheet lists (236e): the edition parts follow, then each part, in order.
  const releases: Listed[] = (() => {
    if (listed === null || releaseState === null) return [];
    const mine = listed.filter((entry) => entry.productionId === production.meta.id && entry.release !== undefined);
    const edition = mine.find((entry) => entry.release!.part === undefined && entry.release!.fingerprint === releaseState.edition.fingerprint);
    const parts = mine.filter((entry) => entry.release!.part?.fingerprint === releaseState.edition.fingerprint).sort((a, b) => a.release!.part!.number - b.release!.part!.number);
    return [...(edition !== undefined ? [edition] : []), ...parts];
  })();

  const guide = world === null ? null : exportGuideCounts(world);
  const guided = guide !== null && guide.characters.public + guide.places.public + guide.lore.public + guide.teasers.chosen > 0;
  // A part carries its chapters alone: no cover, and no guide (R-45).
  const planned = plan === null ? null : parting ? arkePlayerCounts({ ...plan, cover: null, chapters: ticked }, { ...options, book: options.book && ticked.length > 0 }) : arkePlayerCounts(plan, options);
  // The guide rides in every package once something is public (R-15), and the estimate counts it.
  const counts = planned === null || !guided || parting ? planned : { ...planned, bytes: planned.bytes + (guide.characters.public + guide.places.public + guide.teasers.chosen) * GUIDE_ENTRY_BYTES };
  const empty = parting ? ticked.length === 0 : counts !== null && counts.chapters === 0 && !options.book;
  const start = () => {
    const id = `ap_${ulid()}`;
    setResult(null);
    setCopied(false);
    const part = parting ? { chapters: ticked.map((chapter) => chapter.chapterId), ...(kept.day !== undefined || kept.next !== undefined ? { schedule: kept } : {}) } : undefined;
    if (exportArkePlayer(worldId, production.meta.id, id, { ...options, ...(part !== undefined ? { part } : {}) }) !== null) setMaking(id);
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

  const opt = (label: string, middle: ReactNode, tail?: string, action?: ReactNode) => (
    <div className="fy-abv-opt">
      <b>{label}</b>
      {middle}
      <span className="grow" />
      {tail !== undefined && !phone && <i>{tail}</i>}
      {action}
    </div>
  );
  const releaseRow = opt(
    "Release",
    releaseState === null ? (
      <span>Whole world</span>
    ) : (
      <span className="fy-seg" role="radiogroup" aria-label="Release" data-testid="arke-player-release">
        {(["whole", "part"] as const).map((kind) => (
          <button key={kind} type="button" role="radio" aria-checked={release === kind} className={cx("fy-seg__item", release === kind && "fy-seg__item--active")} onClick={() => setRelease(kind)}>
            {kind === "whole" ? "Whole world" : "New chapters"}
          </button>
        ))}
      </span>
    ),
    releaseState === null ? undefined : `since ${dayOf(releaseState.last.exportedAt)}${releaseState.last.chapter !== null ? ` · Chapter ${releaseState.last.chapter.order}` : ""}`,
  );
  const picturesLine = counts === null ? "…" : counts.tall > 0 ? `${counts.pictures} wide · ${counts.tall} tall` : `${counts.pictures}${phone ? "" : " · fitted for a phone"}`;
  const partRows = (
    <>
      {!phone && opt("World", <span>{worldName}</span>, "key art · logline")}
      {releaseRow}
      <div className="fy-abv-opt fy-abv-opt--top">
        <b>Chapters</b>
        <div className="fy-abv-chs" data-testid="arke-player-chapters">
          {ready.length === 0 && waiting.length === 0 && <span className="fy-abv-ch no"><span className="t">None</span></span>}
          {ready.map((chapter, index) => (
            <label key={chapter.chapterId} className="fy-abv-ch">
              <input type="checkbox" checked={index < ticked.length} onChange={(event) => setUpTo(event.target.checked ? index + 1 : index)} />
              <span className="t">{chapter.order} · {chapter.title}</span>
              {!phone && <i>read whole · {Math.max(1, Math.round(chapter.seconds / 60))} min · {chapter.pictures.length} picture{chapter.pictures.length === 1 ? "" : "s"}</i>}
            </label>
          ))}
          {/* The first chapter not read whole, and how far it has got: it cannot be ticked (R-44). */}
          {waiting.slice(0, 1).map((chapter) => {
            const { read, of } = chapterBlocksRead(chapter);
            return (
              <label key={chapter.chapterId} className="fy-abv-ch no">
                <input type="checkbox" checked={false} disabled />
                <span className="t">{chapter.order} · {chapter.title}</span>
                <i>{chapter.state === "part" ? `read ${read} of ${of} blocks` : "not read"}</i>
              </label>
            );
          })}
        </div>
      </div>
      {opt("Pictures", <span data-testid="arke-player-pictures">{picturesLine}</span>, options.size === "full" ? "Full" : `${options.size} px`)}
      {opt(
        "Schedule",
        <span className="fy-abv-sched">
          <select className="fy-abv-field" aria-label="Day" data-testid="arke-player-day" value={kept.day ?? ""} onChange={(event) => keep(event.target.value === "" ? undefined : (event.target.value as PartScheduleDay), kept.next)}>
            <option value="">None</option>
            {PART_SCHEDULE_DAYS.map((day) => <option key={day} value={day}>{dayLabel(day)}</option>)}
          </select>
          <label className="fy-abv-field">
            Next
            <input type="date" aria-label="Next" data-testid="arke-player-next" value={kept.next ?? ""} onChange={(event) => keep(kept.day, event.target.value === "" ? undefined : event.target.value)} />
          </label>
        </span>,
      )}
    </>
  );
  const rows = made !== null ? null : parting ? partRows : (
    <>
      {!phone && opt("World", <span>{worldName}</span>, "key art · logline")}
      {releaseState !== null && releaseRow}
      {guide !== null && opt(
        "Guide",
        <span data-testid="arke-player-guide">{guided ? [`${guide.characters.public} characters · ${guide.places.public} places · ${guide.lore.public} lore`, guide.teasers.chosen > 0 ? `${guide.teasers.chosen} teaser${guide.teasers.chosen === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ") : "None public"}</span>,
        guide.after > 0 ? `${guide.after} after a chapter` : undefined,
        // A hash link, as the app routes: the sheet is drawn outside a router in its tests too.
        <a className="fy-abv-btn" href={`#/w/${worldId}/guide`} onClick={onClose}>Edit</a>,
      )}
      {opt("Book", committed === 0 ? <span>None</span> : <Toggle on={options.book} onChange={(book) => setOptions({ ...options, book })}>The book</Toggle>, committed === 0 ? "no chapter has prose" : `${committed} chapter${committed === 1 ? "" : "s"} · EPUB`)}
      {opt("Narration", <span>{counts === null ? "…" : `${counts.chapters} of ${counts.of}${phone ? "" : " · read whole"}`}</span>, counts?.range)}
      {opt("Pictures", <span data-testid="arke-player-pictures">{picturesLine}</span>, "cover before the first")}
      {/* 235d: the long side every picture of the narration ships at; Full is R-6's 2048. */}
      {opt(
        "Size",
        <span className="fy-seg" role="radiogroup" aria-label="Picture size" data-testid="arke-player-size">
          {ARKE_PLAYER_PICTURE_SIZES.map((size) => (
            <button key={size} type="button" role="radio" aria-checked={options.size === size} className={cx("fy-seg__item", options.size === size && "fy-seg__item--active")} onClick={() => setOptions({ ...options, size })}>
              {size === "full" ? "Full" : `${size} px`}
            </button>
          ))}
        </span>,
        "long side",
      )}
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
          {!phone && counts !== null && <span className="m">{[`${counts.chapters} chapter${counts.chapters === 1 ? "" : "s"}`, `${counts.pictures + counts.tall} picture${counts.pictures + counts.tall === 1 ? "" : "s"}`, options.book && (!parting || ticked.length > 0) ? "the book" : null, guided && !parting ? "the guide" : null].filter(Boolean).join(" · ")}</span>}
        </div>
      )}
      {making !== null && <div className="fy-abv-note" data-testid="arke-player-making">Making package · follow it in Activity</div>}
      {result?.ok === false && result.blockers.map((blocker) => <div key={blocker} className="fy-abv-warn">{blocker}</div>)}
      {made !== null && (
        <div className="fy-abv-made" data-testid="arke-player-done">
          <div className="fy-abv-est">
            <b>{made.part !== undefined ? "1 part" : "1 package"} · {megabytes(made.bytes)}</b>
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
            {keyArt !== null && worldSlug !== undefined ? <img src={mediaUrl(worldSlug, keyArt)} alt="" /> : <span className="ph" />}
            <div>
              <div>{name}</div>
              <div className="m">{[holds(made), megabytes(made.bytes)].filter(Boolean).join(" · ")}</div>
            </div>
            <span />
          </div>
          <div className="fy-abv-sha">
            <b>SHA-256</b>
            <code>{made.sha256}</code>
            <button type="button" className="fy-abv-btn" onClick={() => void navigator.clipboard?.writeText(made.sha256).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
          </div>
          {/* 236e: the world's releases in order, the edition then each part, the new one marked. */}
          {made.part !== undefined && releases.length > 0 && (
            <div className="fy-abv-opts" data-testid="arke-player-releases">
              {releases.map((entry) => (
                <div key={entry.dir} className={cx("fy-abv-rel", entry.file === made.file && "now")}>
                  <span className="d">{dayOf(entry.exportedAt)}</span>
                  <span className="k">{entry.release?.part !== undefined ? "Part" : "Edition"}</span>
                  <span className="w">{entry.holds}</span>
                  <span className="grow" />
                  <span className="m">{megabytes(entry.bytes ?? 0)}</span>
                </div>
              ))}
            </div>
          )}
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
            {parting ? "Make part" : "Make package"}
          </button>
        </>
      )}
    </div>
  );
  return { rows, lines, foot, made: made !== null, sub: made === null ? null : `arke player · ${made.part !== undefined ? "part · " : ""}made ${madeAt === null ? made.edition : madeStamp(madeAt)}` };
}
