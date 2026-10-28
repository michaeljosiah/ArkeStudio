import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ARKE_PLAYER_PICTURE_SIZES,
  STORY_FORMAT,
  STORY_VERSION,
  storyReadBackLine,
  ulid,
  type ArkePlayerPictureSize,
  type ProductionBundle,
  type StoryExportBlocker,
  type StoryExportState,
  type WebPackagesListed,
} from "@arke-studio/contracts";
import { downloadMedia } from "../lib/download.js";
import { mediaUrl } from "../lib/media.js";
import { useMediaQuery } from "../lib/media-query.js";
import { isRemoteSession } from "../lib/remote-session.js";
import {
  exportArkePlayer,
  exportInteractive,
  listWebPackages,
  openExportsFolder,
  readStoryExport,
  subscribeArkePlayerExported,
  subscribeInteractiveExports,
  subscribeStoryExportState,
  subscribeWebPackages,
  useStore,
  useWorld,
  type ArkePlayerExported,
  type InteractiveExportEvent,
} from "../lib/store.js";
import { Check, Folder, megabytes } from "./audiobook-video.js";
import { TriangleAlert } from "./icons.js";
import { PageSheet } from "./page-sheet.js";
import { cx } from "./ui.js";

/**
 * Export on an interactive movie or a visual novel (design turn 245, SPEC-058 R-89): one sheet,
 * two kinds. Web package is the folder with player.html that the Branch Map wrote (156, 174h),
 * unchanged; Arke Player is the story package, counted by the coordinator the way the export
 * reads the production (245a, 245b), blocked by name with what clears each (245c), and made,
 * read back route by route, beside the world's releases (245d).
 */

type Kind = "web" | "arke";
type Listed = WebPackagesListed["packages"][number];
type Made = Extract<ArkePlayerExported["result"], { ok: true }>;

/** `47:12`, or `1:02:03` past an hour. */
export const clipClock = (ms: number) => {
  const total = Math.round(ms / 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return total >= 3600 ? `${Math.floor(total / 3600)}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${Math.floor(total / 60)}:${pad(total % 60)}`;
};

/** `28 Oct 2026`, on the exporter's UTC day as an edition is named. */
const dayOf = (at: string) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** `2026-10-28 09:12` in this device's time: when the package was made (245d). */
const madeStamp = (at: Date) => {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
};

/**
 * The world's releases in order (245d, as 236e lists them): the newest edition of each book, the
 * newest album, then the newest story of each production, each a package of its own.
 */
export function storyReleases(packages: readonly Listed[], worldName: string): Array<Listed & { label: string; what: string }> {
  const arke = packages.filter((entry) => entry.kind === "arke-player" && entry.file !== undefined && entry.release?.part === undefined);
  const classOf = (entry: Listed) => (entry.story !== undefined ? 2 : entry.tracks !== undefined ? 1 : 0);
  const newest = new Map<string, Listed>();
  for (const entry of arke) {
    const key = `${classOf(entry)} ${entry.productionId}`;
    const kept = newest.get(key);
    if (kept === undefined || kept.exportedAt < entry.exportedAt) newest.set(key, entry);
  }
  const prefix = `${worldName} · `;
  return [...newest.values()]
    .sort((a, b) => classOf(a) - classOf(b) || (a.exportedAt < b.exportedAt ? -1 : 1))
    .map((entry) => {
      const name = entry.title.startsWith(prefix) ? entry.title.slice(prefix.length) : entry.title;
      // A story says its scenes (245d: `Low Water · 14 scenes`); the read-back line above says its routes.
      const holds = entry.story !== undefined ? `${entry.story.scenes} scene${entry.story.scenes === 1 ? "" : "s"}` : entry.holds;
      return { ...entry, label: ["Edition", "Album", "Story"][classOf(entry)]!, what: [name, holds].filter((part) => part !== undefined && part !== "").join(" · ") };
    });
}

/** What the Branch Map does with a blocker's press: open its scene, or play the route that reaches it. */
export interface StoryExportPresses {
  onGoTo?: (sceneId: string) => void;
  onShow?: (route: string[]) => void;
}

export function StoryExportSheet({ worldId, production, onClose, onGoTo, onShow }: { worldId: string; production: ProductionBundle; onClose: () => void } & StoryExportPresses) {
  const connection = useStore().connection;
  const world = useWorld();
  const phone = useMediaQuery("(max-width: 599px)");
  const remote = isRemoteSession();
  const [kind, setKind] = useState<Kind>("arke");
  const [size, setSize] = useState<ArkePlayerPictureSize>("full");
  const [state, setState] = useState<StoryExportState | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const asked = useRef<string | null>(null);
  const [making, setMaking] = useState<string | null>(null);
  const [result, setResult] = useState<ArkePlayerExported["result"] | null>(null);
  const [madeAt, setMadeAt] = useState<Date | null>(null);
  const [copied, setCopied] = useState(false);
  const [listed, setListed] = useState<Listed[] | null>(null);
  const listing = useRef<string | null>(null);
  const [web, setWeb] = useState<{ busy: boolean; answer: InteractiveExportEvent | null }>({ busy: false, answer: null });
  const [handed, setHanded] = useState<string | null>(null);

  // Read again whenever what the export reads moves: the routing, a scene, a take or a choice of picture.
  const stamp = JSON.stringify([production.routing?.version ?? null, production.scenes.map((scene) => [scene.id, scene.version]), production.selections, production.takes.length, production.meta.aspect ?? null]);
  useEffect(() => subscribeStoryExportState((answer) => {
    if (answer.requestId !== asked.current) return;
    setState(answer.state);
    setRefused(answer.refused ?? null);
  }), []);
  useEffect(() => {
    if (connection !== "open") return;
    asked.current = readStoryExport(worldId, production.meta.id, size);
  }, [connection, worldId, production.meta.id, size, stamp]);
  useEffect(() => subscribeWebPackages((answer) => {
    if (answer.worldId !== worldId) return;
    setListed(answer.packages);
    // A reconnect can lose the export's one answer (codex on PR 1498): its package, listed, is the answer.
    if (answer.requestId !== listing.current || making === null) return;
    const found = answer.packages.find((entry) => entry.kind === "arke-player" && entry.exportId === making);
    if (found?.file === undefined || found.sha256 === undefined || found.story === undefined) return;
    setMaking(null);
    setResult({ ok: true, file: found.file, bytes: found.bytes ?? 0, sha256: found.sha256, edition: found.exportedAt.slice(0, 10), chapters: 0, pictures: found.pictures ?? 0, book: false, guide: false, story: found.story });
    setMadeAt(new Date(found.exportedAt));
  }), [worldId, making]);
  useEffect(() => {
    if (connection === "open" && making !== null) listing.current = listWebPackages(worldId);
  }, [connection, worldId]);
  useEffect(() => subscribeArkePlayerExported((answer) => {
    if (answer.exportId !== making) return;
    setMaking(null);
    setResult(answer.result);
    setMadeAt(new Date());
    if (answer.result.ok) listing.current = listWebPackages(worldId);
  }), [making, worldId]);
  useEffect(() => subscribeInteractiveExports((event) => {
    if (event.productionId !== production.meta.id) return;
    setWeb({ busy: false, answer: event });
  }), [production.meta.id]);

  const start = () => {
    const id = `ap_${ulid()}`;
    setResult(null);
    setCopied(false);
    if (exportArkePlayer(worldId, production.meta.id, id, { book: false, motion: false, ...(state?.kind === "novel" ? { size } : {}) }) !== null) setMaking(id);
  };
  const made: Made | null = result?.ok === true ? result : null;
  const novel = state?.kind === "novel";
  const blockers = state?.blockers ?? [];
  // A press refused after it was made: its problems are blockers too, with what clears each.
  const failed = result?.ok === false ? (result.problems ?? result.blockers.map((detail): StoryExportBlocker => ({ detail, row: "story" }))) : [];
  const blocked = blockers.length > 0;
  const toClear = (row: StoryExportBlocker["row"]) => blockers.filter((blocker) => blocker.row === row).length;

  const opt = (label: string, middle: ReactNode, tail?: string, action?: ReactNode) => (
    <div className="fy-abv-opt">
      <b>{label}</b>
      {middle}
      <span className="grow" />
      {tail !== undefined && !phone && <i>{tail}</i>}
      {action}
    </div>
  );
  const goTo = (sceneId: string) => {
    if (onGoTo !== undefined) onGoTo(sceneId);
    else window.location.hash = `#/w/${worldId}/p/${production.meta.id}/scenes/${sceneId}`;
    onClose();
  };
  const block = (blocker: StoryExportBlocker, index: number) => (
    <div key={`${index} ${blocker.detail}`} className="fy-abv-block" data-testid="story-export-blocker">
      <TriangleAlert size={15} />
      <span className="c">{blocker.detail}</span>
      {blocker.route !== undefined && onShow !== undefined ? (
        <button type="button" className="fy-abv-btn sm" onClick={() => { onShow(blocker.route!); onClose(); }}>Show</button>
      ) : blocker.sceneId !== undefined ? (
        <button type="button" className="fy-abv-btn sm" onClick={() => goTo(blocker.sceneId!)}>Go to</button>
      ) : null}
    </div>
  );

  const keyArt = world?.keyArt ?? null;
  const worldRow = !phone && opt("World", <>{keyArt !== null && world !== null ? <img src={mediaUrl(world.meta.slug, keyArt)} alt="" /> : null}<span>{world?.meta.name ?? ""}</span></>, "key art · logline");
  const storyRow = state === null ? opt("Story", <span>…</span>) : opt("Story", <span>{`${state.scenes} scene${state.scenes === 1 ? "" : "s"} · ${state.choices} choice${state.choices === 1 ? "" : "s"}`}</span>, toClear("story") > 0 ? `${toClear("story")} to clear` : `${state.facts} fact${state.facts === 1 ? "" : "s"} · ${state.endings} ending${state.endings === 1 ? "" : "s"}`);
  const hidden = state === null ? 0 : state.closed.count - state.closed.reasoned;
  const closedRow = state !== null && opt("Closed choices", <span>{state.closed.count === 0 ? "None" : `${state.closed.count} · ${state.closed.reasoned} with a reason`}</span>, hidden > 0 ? `${hidden} hidden` : undefined);
  const clips = state?.clips;
  const clipsRow = clips !== undefined && opt(
    "Clips",
    <span>{blocked && toClear("media") > 0 ? `${clips.count} of ${clips.of}` : `${clips.count} · ${clipClock(clips.ms)}`}</span>,
    blocked && toClear("media") > 0 ? `${toClear("media")} to clear` : clips.width !== undefined && clips.height !== undefined ? `${clips.width} × ${clips.height} · ${clips.reencoded === 0 ? "as made" : `${clips.reencoded} re-encoded`}` : undefined,
  );
  const pictures = state?.pictures;
  const wideOnly = pictures === undefined ? 0 : pictures.wide - pictures.tall;
  const picturesRow = pictures !== undefined && opt(
    "Pictures",
    <span data-testid="story-export-pictures">{`${pictures.wide} wide · ${pictures.tall} tall`}</span>,
    blocked && toClear("media") > 0 ? `${toClear("media")} to clear` : wideOnly > 0 ? `${wideOnly} wide only` : undefined,
    // A visual novel's beat has no Tall of its own yet: 235's Tall flow is the audiobook's moments.
    !blocked && wideOnly > 0 ? <button type="button" className="fy-abv-btn sm" disabled title="Not built yet: a beat's Tall">Make tall</button> : undefined,
  );
  const rows = state === null ? (
    <>{worldRow}{storyRow}</>
  ) : blocked ? (
    <>{storyRow}{closedRow}{clipsRow}{picturesRow}</>
  ) : (
    <>
      {worldRow}
      {storyRow}
      {closedRow}
      {clipsRow}
      {!novel && opt("Shape", <span>{state.shape}</span>)}
      {picturesRow}
      {novel && opt(
        "Size",
        <span className="fy-seg" role="radiogroup" aria-label="Picture size" data-testid="story-export-size">
          {ARKE_PLAYER_PICTURE_SIZES.map((option) => (
            <button key={option} type="button" role="radio" aria-checked={size === option} className={cx("fy-seg__item", size === option && "fy-seg__item--active")} onClick={() => setSize(option)}>
              {option === "full" ? "Full" : `${option} px`}
            </button>
          ))}
        </span>,
        "long side",
      )}
      {state.voices !== undefined && opt("Voices", <span>{`${state.voices.voiced} of ${state.voices.lines} line${state.voices.lines === 1 ? "" : "s"}`}</span>, state.voices.lines > state.voices.voiced ? `${state.voices.lines - state.voices.voiced} as text` : undefined)}
      {opt("Format", <span>{`${STORY_FORMAT} ${STORY_VERSION}`}</span>, "from routing")}
      {!phone && opt("Edition", <span className="fy-abv-field">{new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}</span>)}
    </>
  );
  const estimate = state !== null && !blocked && (
    <div className="fy-abv-est" data-testid="story-export-estimate">
      <b>{`~${megabytes(state.bytes)} · ~${Math.max(1, Math.ceil(state.seconds / 60))} min ${remote ? "on the desktop" : "on this machine"}`}</b>
      {!phone && <span className="m">{novel && pictures !== undefined ? [`${pictures.beats} beat${pictures.beats === 1 ? "" : "s"}`, `${pictures.files} picture${pictures.files === 1 ? "" : "s"}`, state.voices !== undefined && state.voices.voiced > 0 ? `${state.voices.voiced} line${state.voices.voiced === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ") : `${clips?.count ?? 0} clip${clips?.count === 1 ? "" : "s"} · 1 story`}</span>}
    </div>
  );

  const name = made === null ? "" : made.file.slice("exports/".length);
  const releases = made === null || listed === null ? [] : storyReleases(listed, world?.meta.name ?? "");
  const download = async () => {
    if (made === null) return;
    const outcome = await downloadMedia(world?.meta.slug, made.file, name, "package");
    setHanded(outcome.ok || outcome.cancelled === true ? null : outcome.reason);
  };
  const madeBody = made !== null && (
    <div className="fy-abv-made" data-testid="story-export-done">
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
      </div>
      <div className="fy-abv-sha">
        <b>SHA-256</b>
        <code>{made.sha256}</code>
        <button type="button" className="fy-abv-btn" onClick={() => void navigator.clipboard?.writeText(made.sha256).then(() => setCopied(true))}>{copied ? "Copied" : "Copy"}</button>
      </div>
      {made.story !== undefined && (
        <div className="fy-abv-back" data-testid="story-export-read-back">
          <Check />
          <b>Read back</b>
          <span>{storyReadBackLine(made.story)}</span>
          <span className="grow" />
          <span className="m">{`${STORY_FORMAT} ${STORY_VERSION}`}</span>
        </div>
      )}
      {releases.length > 0 && (
        <div className="fy-abv-opts" data-testid="story-export-releases">
          {releases.map((entry) => (
            <div key={entry.dir} className={cx("fy-abv-rel", entry.file === made.file && "now")}>
              <span className="d">{dayOf(entry.exportedAt)}</span>
              <span className="k">{entry.label}</span>
              <span className="w">{entry.what}</span>
              <span className="grow" />
              <span className="m">{megabytes(entry.bytes ?? 0)}</span>
            </div>
          ))}
        </div>
      )}
      {remote && (
        <div className="fy-abv-acts">
          <button type="button" className="fy-abv-btn" onClick={() => void download()}>Download</button>
        </div>
      )}
      {handed !== null && <div className="fy-abv-warn">{handed}</div>}
    </div>
  );

  const webDone = web.answer?.disposition === "exported" ? web.answer.dir ?? null : null;
  const webBody = (
    <>
      <div className="fy-abv-opts">
        {storyRow}
        {closedRow}
        {opt("Format", <span>player.html</span>, "any browser")}
      </div>
      {web.busy && <div className="fy-abv-note">exporting…</div>}
      {web.answer?.disposition === "refused" && (web.answer.blockers ?? []).map((blocker) => <div key={blocker} className="fy-abv-warn">{blocker}</div>)}
      {webDone !== null && <div className="fy-abv-note" data-testid="story-export-web-done">{webDone}</div>}
    </>
  );

  const foot = (
    <div className="fy-abv-foot">
      <span className="grow" />
      {kind === "web" ? (
        webDone !== null ? (
          <>
            {!remote && (
              <button type="button" className="fy-abv-btn" onClick={() => openExportsFolder(worldId, webDone.slice("exports/".length))}>
                <Folder />
                Show in folder
              </button>
            )}
            <button type="button" className="fy-abv-btn pri" onClick={onClose}>Done</button>
          </>
        ) : (
          <>
            <button type="button" className="fy-abv-btn" onClick={onClose}>Cancel</button>
            <button type="button" className="fy-abv-btn pri" disabled={web.busy || connection !== "open"} onClick={() => { setWeb({ busy: true, answer: null }); exportInteractive(worldId, production.meta.id); }} data-testid="story-export-web-start">
              Export
            </button>
          </>
        )
      ) : made !== null ? (
        <>
          {!phone && <button type="button" className="fy-abv-btn" disabled={connection !== "open" || making !== null} onClick={start}>Make again</button>}
          <button type="button" className="fy-abv-btn pri" onClick={onClose}>Done</button>
        </>
      ) : (
        <>
          <button type="button" className="fy-abv-btn" onClick={onClose}>Cancel</button>
          <button type="button" className="fy-abv-btn pri" style={phone ? { flex: 1 } : undefined} disabled={making !== null || connection !== "open" || state === null || blocked} onClick={start} data-testid="story-export-start">
            Make package
          </button>
        </>
      )}
    </div>
  );

  const kindLabel = state === null ? "…" : state.kind === "novel" ? `Visual novel · ${state.scenes} scene${state.scenes === 1 ? "" : "s"} · ${state.pictures?.beats ?? 0} beat${state.pictures?.beats === 1 ? "" : "s"}` : `Interactive movie · ${state.scenes} scene${state.scenes === 1 ? "" : "s"} · ${state.shape}`;
  const subtitle = made !== null ? `arke player · story · made ${madeAt === null ? made.edition : madeStamp(madeAt)}` : kindLabel;
  return (
    <PageSheet open onClose={onClose} title={`Export · ${production.meta.title}`} subtitle={subtitle} preserveReturnFocus footer={foot} className={phone ? "fy-abv-modal fy-abv-modal--phone" : "fy-abv-modal"}>
      <div className="fy-abv-sheet fy-story-export" data-testid="story-export">
        {made === null && (
          <div className="fy-abv-kinds" role="radiogroup" aria-label="Export">
            {([["web", "Web package", "player.html · any browser"], ["arke", "Arke Player", "phone · offline · remembers choices"]] as const).map(([value, label, line]) => (
              <button key={value} type="button" role="radio" aria-checked={kind === value} className={cx("fy-abv-kind", kind === value && "on")} onClick={() => setKind(value)} data-testid={`story-export-${value}`}>
                <span className="r" />
                <div>
                  <b>{label}</b>
                  <span>{line}</span>
                </div>
              </button>
            ))}
          </div>
        )}
        {kind === "web" ? webBody : made !== null ? madeBody : (
          <>
            <div className="fy-abv-opts">{rows}</div>
            {refused !== null && <div className="fy-abv-warn">{refused}</div>}
            {estimate}
            {blockers.map(block)}
            {making !== null && <div className="fy-abv-note" data-testid="story-export-making">Making package · follow it in Activity</div>}
            {!blocked && failed.map(block)}
          </>
        )}
      </div>
    </PageSheet>
  );
}
