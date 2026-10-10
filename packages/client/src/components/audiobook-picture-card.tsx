import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Check, ChevronDown } from "./icons.js";
import {
  CLOSE_FRAMES,
  MAIN_PHOTO_LOOK,
  chapterLooksOf,
  characterLabels,
  frameWord,
  lookClothing,
  lookName,
  lookViewFor,
  mainPhotoFor,
  pictureOwnLooks,
  priceLabel,
  type AudiobookLook,
  type PictureOwnLooks,
  type PictureShot,
  type PictureSuggestion,
  type PictureWho,
  type ReferenceKit,
  type WorldBundle,
} from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import { chooseAudiobookLook, rewriteAudiobookPicturePrompt, useAudiobookAsks } from "../lib/store.js";
import type { PictureSuggestionState } from "./audiobook-suggest.js";
import { NewLookSheet } from "./audiobook-new-look.js";
import { Button, Checkbox, Textarea, cx } from "./ui.js";

/**
 * A block's picture card (design turn 193c, rules 13 and 14; SPEC-047 R-122): the picture's slot
 * beside its facts — Frame, Rides, the model and ratio, the price — then In frame, a row a person
 * by their short name with the image that rides ringed and, at its end, the frame's word and their
 * look menu (194g), Not in frame as dashed names, the prompt to edit, and the seven
 * checks, each ticked or marked. The author reads the words, then the card, and sees at once whether
 * the frame, the people and the references are what the words say. A mark never blocks Generate.
 * A look chosen in the menu for this picture alone (193d, R-146) rides at Make again, the row says
 * `this picture only`, and the prompt is marked Look changed, with Update prompt, until that
 * person's clothing words are rewritten for it.
 */

/** Which image of a person rode, as the card words it: a look's close view or full body, else the main photo. */
const VIEWS = ["close view", "full body", "main photo"] as const;
const viewOf = (who: Pick<PictureWho, "look">): (typeof VIEWS)[number] => (who.look === undefined ? "main photo" : who.look.view === "close" ? "close view" : "full body");

/**
 * What rode, as the card's Rides line says it (design turn 193, rules 8 and 16; 194g): one line,
 * `·` between its parts. Everyone who rode the same image is that image alone — `Full body`,
 * `Close view`, `Main photo` — and a face frame whose looks had no close view to give says so after
 * it, `Full body · no close view`. Where people rode different images the line names who rode which,
 * by the names the rows use (`Ade close view · Tunde full body`), because one bare word for each
 * would say two images rode without saying whose; the card never claims one view for a picture that
 * mixed them. Then `Place view`, `no reference`, and `no faces` on a detail.
 */
export function ridesLabel(
  who: readonly PictureWho[],
  shot: Pick<PictureShot, "frame"> | undefined,
  options: {
    /** The name a row shows: the character's short name (turn 194, rule 13). */
    labelOf?: (who: PictureWho) => string;
    /** Whether this person's look has a close view to give; unknown is never reported as missing. */
    hasClose?: (who: PictureWho) => boolean | undefined;
  } = {},
): string {
  const detail = shot !== undefined && frameWord(shot.frame) === "Detail";
  const people = who.filter((entry) => entry.kind === "character" && entry.carried);
  if (people.length === 0) return detail ? "no reference · no faces" : who.some((entry) => entry.kind === "place" && entry.carried) ? "Place view" : "no reference";
  const labelOf = options.labelOf ?? ((entry: PictureWho) => entry.name);
  const groups = VIEWS.map((view) => ({ view, people: people.filter((entry) => viewOf(entry) === view) })).filter((group) => group.people.length > 0);
  const parts = groups.length === 1 ? [groups[0]!.view] : groups.map((group) => `${group.people.map(labelOf).join(", ")} ${group.view}`);
  // The frame asked for faces and a look could only give its full body (rule 8): the line says why.
  const word = frameWord(shot?.frame);
  if (word !== null && CLOSE_FRAMES.has(word) && people.some((entry) => entry.look?.view === "full" && options.hasClose?.(entry) === false)) parts.push("no close view");
  if (detail) parts.push("no faces");
  const line = parts.join(" · ");
  return `${line.charAt(0).toUpperCase()}${line.slice(1)}`;
}

/** The frame's word at a row's end (194g, `two-shot`): the frame the picture was made for, lower-cased; none where no frame was kept. */
export function frameViewWord(shot: Pick<PictureShot, "frame"> | undefined): string | null {
  return frameWord(shot?.frame)?.toLowerCase() ?? null;
}

function Thumb({ slug, file, on, view }: { slug: string; file: string; on: boolean; view: string }) {
  return <img className={cx("fy-pcard__thumb", on ? "fy-pcard__thumb--on" : "fy-pcard__thumb--dim")} src={mediaUrl(slug, file)} alt="" data-testid="picture-card-thumb" data-view={view} data-on={on ? "true" : "false"} />;
}

/** The chapter a card's block is in, for the look menu: where a choice is filed, and the choices it holds. */
export interface PictureCardChapter {
  productionId: string;
  chapterFile: string;
  order: number;
  look: AudiobookLook | null;
  /**
   * The looks held on this block for its next picture alone (design turn 193d, R-146), as the
   * chapter's record keeps them until the picture is made; absent where none is held.
   */
  own?: PictureOwnLooks;
}

/** What a tile in the menu does (rule 8's two boxes): choose for this picture alone, or set the chapter's choice. */
type LookMode = "only" | "chapter";

/**
 * Who rides once the looks chosen for this picture alone are laid over the card (design turn 193d,
 * R-146): a person with a look of their own rides it — the frame takes its close view or its full
 * body, as the coordinator will — or the main photo; a person whose own look was let go rides the
 * chapter's choice again. Everyone else is as the card was drafted or made.
 */
export function withOwnLooks(who: readonly PictureWho[], own: Readonly<PictureOwnLooks>, chapter: AudiobookLook | null, kits: readonly ReferenceKit[], frame: string | undefined): PictureWho[] {
  return who.map((entry) => {
    if (entry.kind !== "character" || entry.sheet === undefined) return entry;
    const mine = own[entry.key];
    if (mine === undefined && entry.only !== true) return entry;
    const target = mine ?? chapter?.characters[entry.key]?.lookId ?? MAIN_PHOTO_LOOK;
    const kit = kits.find((candidate) => candidate.sheetId === entry.sheet);
    const { look: _look, only: _only, ...base } = entry;
    const tag = mine !== undefined ? { only: true as const } : {};
    const look = target === MAIN_PHOTO_LOOK ? undefined : kit?.looks?.find((candidate) => candidate.id === target && candidate.kind === "costume");
    if (look !== undefined) {
      const view = lookViewFor(frame) === "close" && look.closeFile !== undefined ? "close" : "full";
      return { ...base, reference: `references/${entry.sheet}/${view === "close" ? look.closeFile! : look.file}`, look: { lookId: look.id, view }, ...tag };
    }
    const photo = kit === undefined ? null : mainPhotoFor(kit);
    return { ...base, reference: photo === null ? null : `references/${entry.sheet}/${photo.file}`, carried: photo !== null && entry.carried, ...tag };
  });
}

/**
 * A person's look menu (design turn 193, rule 8 and 11; 193c's popover under the row, 193d): the
 * character's looks, Main photo and New look as tiles, the one that rides ringed, then the two
 * boxes. Only this picture (on as it opens) makes a tile this picture's own look — held on the
 * block until the picture is made, then stamped on it (R-115, R-146); Set for Chapter N makes it
 * the chapter's choice, as before, and this picture follows it.
 */
function LookMenu({ id, label, who, kit, slug, chapter, mode, onMode, chosen, off, onChoose, onNewLook, onClose }: {
  id: string;
  label: string;
  who: PictureWho;
  kit: ReferenceKit | null;
  slug: string;
  chapter: PictureCardChapter;
  mode: LookMode;
  onMode: (mode: LookMode) => void;
  /** The look ringed for the box that is on (or was just pressed), null for the main photo. */
  chosen: string | null;
  off: boolean;
  onChoose: (lookId: string | null) => void;
  onNewLook: () => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const looks = chapterLooksOf(kit);
  const photo = kit === null ? null : mainPhotoFor(kit);
  // Opened from the last row it falls below the panel's held foot, out of sight on a phone: the
  // body scrolls just far enough to show it whole, clear of the foot (its scroll margin).
  // Braced: Chromium 150 returns a Promise here, and an effect that returns it gives React a
  // cleanup that is not a function — closing the menu threw and blanked the chapter screen.
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  // Away from the menu, or Escape, puts it away; the row's control keeps the focus it gave.
  useEffect(() => {
    const away = (event: Event) => {
      const row = box.current?.parentElement;
      if (row !== null && row !== undefined && event.target instanceof Node && row.contains(event.target)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The menu's Escape, not the raised sheet's: on a phone the panel is a modal dialog Escape cancels.
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [onClose]);
  return (
    <div ref={box} id={id} className="fy-pcard__menu" role="group" aria-label={`${label} · look`} data-testid="picture-card-look-menu">
      <div className="fy-pcard__tiles">
        {looks.map((look) => (
          <button key={look.id} type="button" className={cx("fy-pcard__tile", chosen === look.id && "fy-pcard__tile--on")} aria-pressed={chosen === look.id} disabled={off || who.sheet === undefined} title={lookClothing(look)} onClick={() => onChoose(look.id)} data-testid="picture-card-look-tile" data-look={look.id}>
            <img src={mediaUrl(slug, `references/${who.sheet}/${look.file}`)} alt="" />
            <span>{lookName(look)}</span>
          </button>
        ))}
        {/* The main photo for this picture alone has to be there to ride; as the chapter's choice it is choosing none. */}
        <button type="button" className={cx("fy-pcard__tile", chosen === null && "fy-pcard__tile--on")} aria-pressed={chosen === null} disabled={off || (mode === "only" && photo === null)} onClick={() => onChoose(null)} data-testid="picture-card-look-tile" data-look="main">
          {photo !== null && who.sheet !== undefined ? <img src={mediaUrl(slug, `references/${who.sheet}/${photo.file}`)} alt="" /> : <i aria-hidden="true" />}
          <span>Main photo</span>
        </button>
        <button type="button" className="fy-pcard__tile fy-pcard__tile--new" disabled={off} onClick={onNewLook} data-testid="picture-card-look-new">
          <i aria-hidden="true" />
          <span>New look</span>
        </button>
      </div>
      {/* Two boxes as 193d draws them, one of them on: the other is the box turned off. */}
      <Checkbox label="Only this picture" checked={mode === "only"} disabled={off} onChange={(event) => onMode(event.target.checked ? "only" : "chapter")} data-testid="picture-card-look-only" />
      <Checkbox label={`Set for Chapter ${chapter.order}`} checked={mode === "chapter"} disabled={off} onChange={(event) => onMode(event.target.checked ? "chapter" : "only")} data-testid="picture-card-look-chapter" />
    </div>
  );
}

/**
 * One person in frame, or the place (194g): a bordered row — the image that rides, ringed, the
 * name over the look and its view, and at its end the frame's word with the look menu's chevron
 * (`two-shot ▾`). The name is the short one the rows go by (turn 194, rule 13), the full name its
 * tooltip. The expression the prompt names is the expression check's.
 */
function InFrameRow({ who, label, full, kits, slug, shot, onMake, menu }: {
  who: PictureWho;
  label: string;
  full: string | undefined;
  kits: readonly ReferenceKit[];
  slug: string;
  shot: PictureShot | undefined;
  onMake: (who: PictureWho) => void;
  /** The look menu, where the card knows its chapter: absent, the row's end is the frame's word alone. */
  menu: { open: boolean; onToggle: () => void; render: (id: string) => ReactNode } | undefined;
}) {
  const id = useId();
  const kit = who.sheet === undefined ? undefined : kits.find((candidate) => candidate.sheetId === who.sheet);
  const look = who.look === undefined ? undefined : kit?.looks?.find((candidate) => candidate.id === who.look!.lookId);
  const state = who.reference === null ? "none" : who.carried ? "carried" : "over";
  const riding = look !== undefined && who.sheet !== undefined
    ? { file: `references/${who.sheet}/${who.look?.view === "close" && look.closeFile !== undefined ? look.closeFile : look.file}`, view: who.look?.view === "close" && look.closeFile !== undefined ? "close" : "full" }
    : who.reference !== null ? { file: who.reference, view: who.kind === "place" ? "place" : "main" } : null;
  const word = who.kind === "character" ? frameViewWord(shot) : null;
  const view = word !== null && <span className="fy-pcard__view" data-testid="picture-card-view">{word}</span>;
  return (
    <div className={cx("fy-pcard__who", state === "none" && "fy-pcard__who--miss", state === "over" && "fy-pcard__who--over")} data-testid="suggest-who" data-key={who.key} data-state={state}>
      {riding !== null ? <Thumb slug={slug} file={riding.file} on={who.carried} view={riding.view} /> : <i className="fy-pcard__thumb fy-pcard__thumb--none" aria-hidden="true" />}
      <span className="fy-pcard__whotx">
        <b data-testid="picture-card-name" {...(full !== undefined && full !== label ? { title: full } : {})}>{label}</b>
        {who.reference === null ? (
          who.sheet !== undefined && (
            <button type="button" className="fy-sugg__make" onClick={() => onMake(who)} data-testid="suggest-make-reference">
              {who.kind === "place" ? "Make a reference" : "Make a look"}
            </button>
          )
        ) : (
          <span>
            {who.kind === "place" ? "place" : look !== undefined ? `${lookName(look)} · ${who.look?.view === "close" ? "close view" : "full body"}` : "main photo"}
            {who.carried ? "" : " · over the limit"}
          </span>
        )}
      </span>
      {/* A look chosen for this picture alone, not the chapter's (193d). */}
      {who.kind === "character" && who.only === true && (
        <span className="fy-pcard__only" data-testid="picture-card-only">
          this picture only
        </span>
      )}
      {who.kind === "character" && menu !== undefined ? (
        <button type="button" className="fy-pcard__look" aria-label={`${label} · look`} aria-haspopup="true" aria-expanded={menu.open} {...(menu.open ? { "aria-controls": id } : {})} onClick={menu.onToggle} data-testid="picture-card-look">
          {view}
          <ChevronDown size={13} stroke={2} />
        </button>
      ) : (
        view
      )}
      {menu?.open === true && menu.render(id)}
    </div>
  );
}

/**
 * The block's picture as the press that picks another from the world (186c's chooser). 194 draws
 * no Choose in the card's foot, so the picture itself is where choosing lives; it looks as drawn
 * and says what it does to the pointer and to a screen reader.
 */
export function PicturePress({ onChoose, children }: { onChoose: (() => void) | undefined; children: ReactNode }) {
  if (onChoose === undefined) return <>{children}</>;
  return (
    <button type="button" className="fy-pcard__pick" aria-label="Choose another picture" title="Choose another picture" onClick={onChoose} data-testid="audiobook-picture-open">
      {children}
    </button>
  );
}

/**
 * The card (193c; 194g): the picture's slot — the picture itself once one is set — beside Frame,
 * Rides and the model, then In frame, Not in frame, the prompt folded to three lines until it is
 * pressed, and the checks; Remove (or Discard), Edit prompt and Generate — Make again once a
 * picture is set — in the panel's foot.
 */
export function PictureCard({ world, worldId, state, onEdit, offline, picture = null, onRemove, onChoose, chapter }: {
  world: Pick<WorldBundle, "meta" | "referenceKits" | "sheets">;
  worldId: string;
  state: PictureSuggestionState;
  onEdit: (suggestion: PictureSuggestion, prompt: string) => void;
  offline: boolean;
  /** The picture set on the block, drawn in the slot. */
  picture?: string | null;
  onRemove?: () => void;
  /** Pick another picture from the world: the picture is the press. */
  onChoose?: () => void;
  /** The block's chapter: with it, each person's row ends in the look menu. */
  chapter?: PictureCardChapter;
}) {
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  /** The person whose look menu is open, by key. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** The person a look is being made for from the menu. */
  const [newLookFor, setNewLookFor] = useState<PictureWho | null>(null);
  /**
   * Looks pressed in a menu and not yet in the chapter's record, by key: the tile rings at once
   * (after testing local.14). Held only while the menu is open, so a choice the coordinator refused
   * reads as the record has it the next time the menu opens.
   */
  const [pressed, setPressed] = useState<Record<string, string | null>>({});
  /** What a tile does while a menu is open (rule 8): this picture alone as the menu opens, or the chapter's choice. */
  const [mode, setMode] = useState<LookMode>("only");
  /**
   * Looks pressed under Only this picture and not yet in the record, by key — null where a press
   * let one go — ringed and laid over the row at once, as a chapter's press is. Held until the
   * block's held looks next change, or the menu is put away.
   */
  const [pressedOwn, setPressedOwn] = useState<Record<string, string | null>>({});
  /** The look the prompt names once Update prompt has rewritten it (R-146), by key. */
  const [rewrittenFor, setRewrittenFor] = useState<Record<string, string>>({});
  /** Update prompt on its way: the request, and the look each person's words are being rewritten for. */
  const [updating, setUpdating] = useState<{ id: string; to: Record<string, string> } | null>(null);
  const asks = useAudiobookAsks();
  const labels = useMemo(() => characterLabels(world.sheets), [world.sheets]);
  const chapterLook = chapter?.look ?? null;
  const chosenIn = (key: string): string | null => chapterLook?.characters[key]?.lookId ?? null;
  useEffect(() => {
    // A press the record now says is done is no longer held here, so a later change elsewhere shows.
    setPressed((held) => {
      const left = Object.fromEntries(Object.entries(held).filter(([key, lookId]) => (chapterLook?.characters[key]?.lookId ?? null) !== lookId));
      return Object.keys(left).length === Object.keys(held).length ? held : left;
    });
  }, [chapterLook]);
  // The record's answer to a press for this picture alone is the record: what was held here goes.
  const heldOwn = JSON.stringify(chapter?.own ?? null);
  useEffect(() => setPressedOwn({}), [heldOwn]);
  // Another suggestion, or another block's picture: what an Update prompt rewrote was that prompt's.
  const drafted = state.ask?.state === "suggested" ? `${state.ask.suggestion.block}\n${state.ask.suggestion.prompt}` : null;
  useEffect(() => {
    setRewrittenFor({});
    setUpdating(null);
  }, [drafted]);
  const answered = updating === null ? null : (asks[updating.id] ?? null);
  const setPrompt = state.setPrompt;
  useEffect(() => {
    if (updating === null || answered?.state !== "prompt") return;
    // The rewritten prompt is the author's to edit and make, as a draft is; the mark goes with it.
    setPrompt(answered.prompt);
    setRewrittenFor((held) => ({ ...held, ...updating.to }));
    setUpdating(null);
  }, [answered, updating, setPrompt]);
  const { ask, making } = state;
  if (ask === null) return null;
  if (ask.state === "working") return <p className="fy-mono fy-ab__card-line" data-testid="suggest-reading">reading…</p>;
  if (ask.state === "refused") {
    return (
      <div className="fy-sugg" data-testid="suggest-refused">
        <p className="fy-mono fy-ch__who-where--warn">{ask.refused}</p>
        <div className="fy-abp__foot">
          <Button variant="outline" onClick={state.dismiss}>
            Discard
          </Button>
          <span className="fy-ch__panelpush" />
          <Button variant="primary" disabled={offline} onClick={state.suggest}>
            Suggest picture
          </Button>
        </div>
      </div>
    );
  }
  if (ask.state !== "suggested") return null;
  const suggestion = ask.suggestion;
  const shot = suggestion.shot;
  const prompt = state.prompt ?? suggestion.prompt;
  const busy = making?.state === "working";
  const failed = making?.state === "failed" ? making : null;
  const slug = world.meta.slug;
  // A character goes by their short name in the card as in the rows (turn 194, rule 13); a place, or
  // a name no sheet holds, by the name it has.
  const nameOf = (key: string): string => labels.get(key)?.label ?? world.sheets.find((sheet) => sheet.id === key)?.name ?? key;
  const labelOf = (who: PictureWho): string => (who.kind === "character" && who.sheet !== undefined ? (labels.get(who.sheet)?.label ?? who.name) : who.name);
  const kitOf = (who: PictureWho): ReferenceKit | null => (who.sheet === undefined ? null : (world.referenceKits.find((kit) => kit.sheetId === who.sheet) ?? null));
  const hasClose = (who: PictureWho): boolean | undefined => {
    const look = who.look === undefined ? undefined : kitOf(who)?.looks?.find((candidate) => candidate.id === who.look!.lookId);
    return look === undefined ? undefined : look.closeFile !== undefined;
  };
  const detail = shot !== undefined && frameWord(shot.frame) === "Detail";
  // The looks this picture is made with for itself (design turn 193d, R-146): those held on the
  // block, else those it was made with alone, with any just pressed laid over — what Make again
  // sends, and what the rows show riding.
  const held = pictureOwnLooks(chapter?.own, suggestion.look);
  const own: PictureOwnLooks = Object.fromEntries(
    [...Object.entries(held).filter(([key]) => !(key in pressedOwn)), ...Object.entries(pressedOwn).flatMap(([key, lookId]) => (lookId === null ? [] : [[key, lookId] as const]))],
  );
  const riding = chapter === undefined ? suggestion.who : withOwnLooks(suggestion.who, own, chapterLook, world.referenceKits, shot?.frame);
  // Whose look is not the one the prompt was written for (rule 8): their clothing words are marked
  // until Update prompt rewrites them. The prompt was written for what the card was drafted or made
  // with, and since an Update prompt, for what it rewrote it for.
  const lookIdOf = (who: PictureWho): string => who.look?.lookId ?? MAIN_PHOTO_LOOK;
  const changes = chapter === undefined
    ? []
    : riding.flatMap((now, index) => {
        const was = suggestion.who[index];
        if (now.kind !== "character" || was === undefined) return [];
        const from = rewrittenFor[now.key] ?? lookIdOf(was);
        const to = lookIdOf(now);
        return from === to ? [] : [{ key: now.key, from, to }];
      });
  const lookLabel = (key: string, lookId: string): string => {
    if (lookId === MAIN_PHOTO_LOOK) return "main photo";
    const sheet = suggestion.who.find((who) => who.key === key)?.sheet;
    const look = world.referenceKits.find((kit) => kit.sheetId === sheet)?.looks?.find((candidate) => candidate.id === lookId);
    return look === undefined ? "another look" : lookName(look);
  };
  const updatingNow = answered?.state === "working";
  const updateRefused = answered?.state === "refused" ? answered.refused : null;
  const update = () => {
    if (chapter === undefined || changes.length === 0) return;
    const id = rewriteAudiobookPicturePrompt(worldId, chapter.productionId, chapter.chapterFile, suggestion.block, prompt, changes);
    if (id !== null) setUpdating({ id, to: Object.fromEntries(changes.map((change) => [change.key, change.to])) });
  };
  const make = (who: PictureWho) => void navigate(`/w/${worldId}/${who.kind === "place" ? "locations" : "cast"}/${who.sheet}`);
  const closeMenu = () => {
    setMenuFor(null);
    setPressed({});
    setPressedOwn({});
  };
  const newLook = (who: PictureWho) => {
    closeMenu();
    const kit = kitOf(who);
    // A look is made from the main photo, over the panel; with none to make it from, on the person's page.
    if (chapter !== undefined && kit !== null && who.sheet !== undefined && mainPhotoFor(kit) !== null) setNewLookFor(who);
    else make(who);
  };
  const ringed = (key: string): string | null => {
    if (mode === "chapter") return key in pressed ? pressed[key]! : chosenIn(key);
    const mine = own[key];
    return mine === undefined ? chosenIn(key) : mine === MAIN_PHOTO_LOOK ? null : mine;
  };
  const chooseFor = (who: PictureWho, lookId: string | null) => {
    if (chapter === undefined) return;
    const person = { key: who.key, name: who.name, ...(who.sheet !== undefined ? { sheet: who.sheet } : {}) };
    if (mode === "only") {
      // For this picture alone (R-146): held on the block, the chapter's choice left as it is.
      const target = lookId ?? MAIN_PHOTO_LOOK;
      if (own[who.key] === target) return;
      const sent = chooseAudiobookLook(worldId, chapter.productionId, chapter.chapterFile, person, lookId, { block: suggestion.block, only: true });
      if (sent !== null) setPressedOwn((pressing) => ({ ...pressing, [who.key]: target }));
      return;
    }
    // The chapter's choice, as before; this picture lets go of a look of its own for them and follows it.
    const now = who.key in pressed ? pressed[who.key]! : chosenIn(who.key);
    if (now === lookId && own[who.key] === undefined) return;
    const sent = chooseAudiobookLook(worldId, chapter.productionId, chapter.chapterFile, person, lookId, { block: suggestion.block });
    if (sent === null) return;
    setPressed((pressing) => ({ ...pressing, [who.key]: lookId }));
    if (own[who.key] !== undefined) setPressedOwn((pressing) => ({ ...pressing, [who.key]: null }));
  };
  const menuOf = (who: PictureWho) =>
    chapter === undefined || who.kind !== "character" || who.sheet === undefined
      ? undefined
      : {
          open: menuFor === who.key,
          onToggle: () => {
            setMenuFor((open) => (open === who.key ? null : who.key));
            setPressed({});
            setPressedOwn({});
            // Rule 8: Only this picture is on as the menu opens.
            setMode("only");
          },
          render: (id: string) => (
            <LookMenu
              id={id}
              label={labelOf(who)}
              who={who}
              kit={kitOf(who)}
              slug={slug}
              chapter={chapter}
              mode={mode}
              onMode={setMode}
              chosen={ringed(who.key)}
              off={offline}
              onChoose={(lookId) => chooseFor(who, lookId)}
              onNewLook={() => newLook(who)}
              onClose={closeMenu}
            />
          ),
        };
  return (
    <div className="fy-sugg fy-pcard" data-testid="suggest-card">
      <div className="fy-pcard__top">
        {picture !== null ? (
          <PicturePress onChoose={busy ? undefined : onChoose}>
            <img className="fy-pcard__img" src={picture} alt="" data-testid="picture-card-picture" />
          </PicturePress>
        ) : (
          <div className="fy-pcard__slot" aria-hidden="true">
            <span className="fy-mono">{suggestion.aspect ?? ""}</span>
          </div>
        )}
        <div className="fy-pcard__facts" data-testid="picture-card-facts">
          {shot !== undefined && shot.frame !== "" && (
            <div className="fy-pcard__fact">
              <span className="fy-mono">Frame</span>
              <b data-testid="picture-card-frame">{shot.frame}</b>
            </div>
          )}
          <div className="fy-pcard__fact">
            <span className="fy-mono">Rides</span>
            <b data-testid="picture-card-rides">{ridesLabel(riding, shot, { labelOf, hasClose })}</b>
          </div>
          <div className="fy-pcard__fact">
            <span className="fy-mono">Model</span>
            {/* The model and the price, as the master draws it; the shape is on the empty slot, and here as its tooltip. */}
            <b data-testid="picture-card-model" {...(suggestion.aspect !== undefined ? { title: suggestion.aspect } : {})}>
              {suggestion.model.name} · {priceLabel(suggestion.estimatedMicroUsd, suggestion.model.plan)}
            </b>
          </div>
        </div>
      </div>
      <div className="fy-pcard__sec" data-testid="picture-card-in-frame">
        <span className="fy-pcard__h">In frame</span>
        {riding.length === 0 ? (
          <span className="fy-pcard__none">{detail ? "no one · a detail" : "no one"}</span>
        ) : (
          riding.map((who) => (
            <InFrameRow key={who.key} who={who} label={labelOf(who)} full={who.kind === "character" && who.sheet !== undefined ? labels.get(who.sheet)?.full : undefined} kits={world.referenceKits} slug={slug} shot={shot} onMake={make} menu={menuOf(who)} />
          ))
        )}
        {shot !== undefined &&
          shot.details.map((entry) => (
            <span key={`${entry.of}-${entry.part}`} className="fy-pcard__expr fy-mono" data-testid="picture-card-detail">
              {nameOf(entry.of)} · {entry.part}
              {entry.state !== undefined ? ` · ${entry.state}` : ""}
            </span>
          ))}
      </div>
      {shot !== undefined && shot.notInFrame.length > 0 && (
        <div className="fy-abp__kv fy-pcard__out" data-testid="picture-card-not-in-frame">
          <span className="fy-abp__k">Not in frame</span>
          <span className="fy-abp__v fy-abp__v--off">{shot.notInFrame.map(nameOf).join(" · ")}</span>
        </div>
      )}
      <div className="fy-pcard__sec">
        <span className="fy-pcard__hrow">
          <span className="fy-pcard__h">Prompt</span>
          {/* 193d: Update prompt at the Prompt's right while someone's clothing words are not their look's. */}
          {changes.length > 0 && (
            <button type="button" className="fy-pcard__update" disabled={offline || busy || updatingNow} onClick={update} data-testid="picture-card-update-prompt">
              {updatingNow ? "Updating…" : "Update prompt"}
            </button>
          )}
        </span>
        {editing || busy ? (
          <Textarea className="fy-sugg__prompt" aria-label="Prompt" rows={5} value={prompt} disabled={busy} autoFocus={editing} onChange={(event) => state.setPrompt(event.target.value)} />
        ) : (
          <button type="button" className="fy-pcard__prompt" aria-label="Prompt" onClick={() => setEditing(true)} data-testid="picture-card-prompt">
            <span>{prompt}</span>
          </button>
        )}
      </div>
      {((shot !== undefined && shot.checks.length > 0) || changes.length > 0) && (
        <ul className="fy-pcard__checks" data-testid="picture-card-checks">
          {(shot?.checks ?? []).map((check) => (
            <li key={check.id} className={cx("fy-pcard__check", !check.ok && "fy-pcard__check--mark")} data-testid="picture-card-check" data-check={check.id} data-ok={check.ok ? "true" : "false"}>
              <i aria-hidden="true">{check.ok ? <Check size={12} /> : "!"}</i>
              <span>{check.label}</span>
              {check.note !== undefined && <span className="fy-mono">{check.note}</span>}
            </li>
          ))}
          {/* 193d: the prompt still names the look it was written for, until Update prompt rewrites it. */}
          {changes.length > 0 && (
            <li className="fy-pcard__check fy-pcard__check--mark" data-testid="picture-card-look-changed">
              <i aria-hidden="true">!</i>
              <span>Look changed</span>
              <span className="fy-mono">{updateRefused ?? `prompt still says ${[...new Set(changes.map((change) => lookLabel(change.key, change.from)))].join(" · ")}`}</span>
            </li>
          )}
        </ul>
      )}
      {failed !== null && (
        <p className="fy-mono fy-ch__who-where--warn" data-testid="suggest-failed">
          {failed.reason}
        </p>
      )}
      <div className="fy-abp__foot">
        {onRemove !== undefined ? (
          <Button variant="outline" disabled={offline || busy} onClick={onRemove} data-testid="audiobook-picture-remove">
            Remove
          </Button>
        ) : (
          <Button variant="outline" onClick={state.dismiss} disabled={busy}>
            Discard
          </Button>
        )}
        <span className="fy-ch__panelpush" />
        {/* The Bench takes the pictures that will ride: a look chosen for this picture alone among them. */}
        <Button variant="outline" disabled={offline || busy} onClick={() => onEdit({ ...suggestion, who: riding }, prompt)} data-testid="suggest-edit">
          Edit prompt
        </Button>
        <Button variant="primary" disabled={offline || busy || updatingNow || prompt.trim() === ""} onClick={() => state.generate(suggestion, prompt, chapter !== undefined ? own : undefined)} data-testid="suggest-generate">
          {busy ? "Generating…" : `${picture !== null ? "Make again" : "Generate"} · ${priceLabel(suggestion.estimatedMicroUsd, suggestion.model.plan)}`}
        </Button>
      </div>
      {/* New look from a row's menu: 193b's sheet, drawn on the body over the panel (it puts a raised block sheet away while open). */}
      {chapter !== undefined && newLookFor !== null && newLookFor.sheet !== undefined && (
        <NewLookSheet
          open
          onClose={() => setNewLookFor(null)}
          worldId={worldId}
          productionId={chapter.productionId}
          chapterFile={chapter.chapterFile}
          chapterOrder={chapter.order}
          who={{ key: newLookFor.key, name: newLookFor.name, sheet: newLookFor.sheet }}
          line={chapterLook?.characters[newLookFor.key]?.text ?? ""}
        />
      )}
    </div>
  );
}
