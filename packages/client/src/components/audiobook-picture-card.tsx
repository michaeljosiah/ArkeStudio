import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Check, ChevronDown } from "./icons.js";
import {
  CLOSE_FRAMES,
  chapterLooksOf,
  characterLabels,
  frameWord,
  lookClothing,
  lookName,
  mainPhotoFor,
  priceLabel,
  type AudiobookLook,
  type PictureShot,
  type PictureSuggestion,
  type PictureWho,
  type ReferenceKit,
  type WorldBundle,
} from "@arke-studio/contracts";
import { mediaUrl } from "../lib/media.js";
import { chooseAudiobookLook } from "../lib/store.js";
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
 * mixed them. Then `Place view`, `no reference`, and a detail's `no reference · no faces`.
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
  if (shot !== undefined && frameWord(shot.frame) === "Detail") return "no reference · no faces";
  const people = who.filter((entry) => entry.kind === "character" && entry.carried);
  if (people.length === 0) return who.some((entry) => entry.kind === "place" && entry.carried) ? "Place view" : "no reference";
  const labelOf = options.labelOf ?? ((entry: PictureWho) => entry.name);
  const groups = VIEWS.map((view) => ({ view, people: people.filter((entry) => viewOf(entry) === view) })).filter((group) => group.people.length > 0);
  const parts = groups.length === 1 ? [groups[0]!.view] : groups.map((group) => `${group.people.map(labelOf).join(", ")} ${group.view}`);
  // The frame asked for faces and a look could only give its full body (rule 8): the line says why.
  const word = frameWord(shot?.frame);
  if (word !== null && CLOSE_FRAMES.has(word) && people.some((entry) => entry.look?.view === "full" && options.hasClose?.(entry) === false)) parts.push("no close view");
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
}

/**
 * A person's look menu (design turn 193, rule 11; 193c's popover under the row): the character's
 * looks, Main photo and New look as tiles, the one chosen ringed, then Only this picture and Set for
 * Chapter N. The record keeps a one-picture look (`only` on the picture's stamp, R-115), but nothing
 * yet makes a picture with one — the press would have to carry the pick to the Bench and rewrite
 * that person's clothing words — so a tile here sets the chapter's choice, which is what Make again
 * then rides, and the boxes say so: Set for Chapter N held on, Only this picture held off.
 */
function LookMenu({ id, label, who, kit, slug, chapter, chosen, off, onChoose, onNewLook, onClose }: {
  id: string;
  label: string;
  who: PictureWho;
  kit: ReferenceKit | null;
  slug: string;
  chapter: PictureCardChapter;
  /** The look the chapter has chosen for them (or was just pressed), null for the main photo. */
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
  useEffect(() => box.current?.scrollIntoView?.({ block: "nearest" }), []);
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
        <button type="button" className={cx("fy-pcard__tile", chosen === null && "fy-pcard__tile--on")} aria-pressed={chosen === null} disabled={off} onClick={() => onChoose(null)} data-testid="picture-card-look-tile" data-look="main">
          {photo !== null && who.sheet !== undefined ? <img src={mediaUrl(slug, `references/${who.sheet}/${photo.file}`)} alt="" /> : <i aria-hidden="true" />}
          <span>Main photo</span>
        </button>
        <button type="button" className="fy-pcard__tile fy-pcard__tile--new" disabled={off} onClick={onNewLook} data-testid="picture-card-look-new">
          <i aria-hidden="true" />
          <span>New look</span>
        </button>
      </div>
      <Checkbox label="Only this picture" checked={false} disabled readOnly data-testid="picture-card-look-only" />
      <Checkbox label={`Set for Chapter ${chapter.order}`} checked disabled readOnly data-testid="picture-card-look-chapter" />
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
  const make = (who: PictureWho) => void navigate(`/w/${worldId}/${who.kind === "place" ? "locations" : "cast"}/${who.sheet}`);
  const newLook = (who: PictureWho) => {
    setMenuFor(null);
    setPressed({});
    const kit = kitOf(who);
    // A look is made from the main photo, over the panel; with none to make it from, on the person's page.
    if (chapter !== undefined && kit !== null && who.sheet !== undefined && mainPhotoFor(kit) !== null) setNewLookFor(who);
    else make(who);
  };
  const chooseFor = (who: PictureWho, lookId: string | null) => {
    if (chapter === undefined) return;
    const now = who.key in pressed ? pressed[who.key]! : chosenIn(who.key);
    if (now === lookId) return;
    const sent = chooseAudiobookLook(worldId, chapter.productionId, chapter.chapterFile, { key: who.key, name: who.name, ...(who.sheet !== undefined ? { sheet: who.sheet } : {}) }, lookId);
    if (sent !== null) setPressed((held) => ({ ...held, [who.key]: lookId }));
  };
  const menuOf = (who: PictureWho) =>
    chapter === undefined || who.kind !== "character" || who.sheet === undefined
      ? undefined
      : {
          open: menuFor === who.key,
          onToggle: () => {
            setMenuFor((open) => (open === who.key ? null : who.key));
            setPressed({});
          },
          render: (id: string) => (
            <LookMenu
              id={id}
              label={labelOf(who)}
              who={who}
              kit={kitOf(who)}
              slug={slug}
              chapter={chapter}
              chosen={who.key in pressed ? pressed[who.key]! : chosenIn(who.key)}
              off={offline}
              onChoose={(lookId) => chooseFor(who, lookId)}
              onNewLook={() => newLook(who)}
              onClose={() => {
                setMenuFor(null);
                setPressed({});
              }}
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
            <b data-testid="picture-card-rides">{ridesLabel(suggestion.who, shot, { labelOf, hasClose })}</b>
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
        {suggestion.who.length === 0 ? (
          <span className="fy-pcard__none">{detail ? "no one · a detail" : "no one"}</span>
        ) : (
          suggestion.who.map((who) => (
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
        <span className="fy-pcard__h">Prompt</span>
        {editing || busy ? (
          <Textarea className="fy-sugg__prompt" aria-label="Prompt" rows={5} value={prompt} disabled={busy} autoFocus={editing} onChange={(event) => state.setPrompt(event.target.value)} />
        ) : (
          <button type="button" className="fy-pcard__prompt" aria-label="Prompt" onClick={() => setEditing(true)} data-testid="picture-card-prompt">
            <span>{prompt}</span>
          </button>
        )}
      </div>
      {shot !== undefined && shot.checks.length > 0 && (
        <ul className="fy-pcard__checks" data-testid="picture-card-checks">
          {shot.checks.map((check) => (
            <li key={check.id} className={cx("fy-pcard__check", !check.ok && "fy-pcard__check--mark")} data-testid="picture-card-check" data-check={check.id} data-ok={check.ok ? "true" : "false"}>
              <i aria-hidden="true">{check.ok ? <Check size={12} /> : "!"}</i>
              <span>{check.label}</span>
              {check.note !== undefined && <span className="fy-mono">{check.note}</span>}
            </li>
          ))}
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
        <Button variant="outline" disabled={offline || busy} onClick={() => onEdit(suggestion, prompt)} data-testid="suggest-edit">
          Edit prompt
        </Button>
        <Button variant="primary" disabled={offline || busy || prompt.trim() === ""} onClick={() => state.generate(suggestion, prompt)} data-testid="suggest-generate">
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
