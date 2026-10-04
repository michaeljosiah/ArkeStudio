import { useEffect, useRef, useState } from "react";
import {
  chapterLooksOf,
  estimateCharacterImageMicroUsd,
  lookClothing,
  lookName,
  lookOlderFace,
  mainPhotoFor,
  priceLabel,
  sheetReferencePicture,
  type AudiobookLook,
  type CharacterLook,
  type ChapterAudiobook,
  type LookCharacter,
  type LookTarget,
  type ReferenceKit,
} from "@arke-studio/contracts";
import { resolveModel, worldModel } from "./dispatch-bar.js";
import { EditorDialog } from "./editor-dialog.js";
import { NewLookSheet } from "./audiobook-new-look.js";
import { mediaUrl } from "../lib/media.js";
import { acceptChapterLook, chooseAudiobookLook, deriveAudiobookLook, makeChapterLook, readAudiobookLooks, setAudiobookLook, useAudiobookAsks, useAudiobookRecords, useStore } from "../lib/store.js";
import { Button, Select, Textarea, cx } from "./ui.js";

/**
 * The chapter's Looks (design turn 191c, 193a; SPEC-047 R-98, R-112..R-116): the place, the mood
 * and the light, and for each character the look chosen for this chapter — a kit look, its full-body
 * image, its clothing line, where it is used and where it came from — with a picker over the
 * character's looks, Make a look where there is none, and a conflict row where the chapter's words
 * and the look disagree. Every line is the author's to change and is theirs from then on. The
 * look's image is the reference that rides in this chapter's pictures; the words never override it.
 * 1,040 wide and centred, drawn on the body, opened from the Audiobook head and from a block's
 * panel.
 */

/** `blocks 3, 9` · `block 31` — the numbers the margin shows, by position in the chapter. */
export function blocksLabel(keys: readonly string[] | undefined, numberOf: (key: string) => number | null): string | null {
  const numbers = [...new Set((keys ?? []).map(numberOf).filter((n): n is number => n !== null))].sort((a, b) => a - b);
  if (numbers.length === 0) return null;
  return `block${numbers.length === 1 ? "" : "s"} ${numbers.join(", ")}`;
}

interface Row {
  id: string;
  target: LookTarget;
  label: string | null;
  text: string;
  sheet?: string;
  source: string | null;
  line?: LookCharacter;
}

/** The sheet's rows: the place, the mood, then each character in the look's own order. */
export function lookRows(look: AudiobookLook | null, numberOf: (key: string) => number | null): Row[] {
  if (look === null) return [];
  const rows: Row[] = [];
  if (look.place !== undefined) rows.push({ id: "place", target: { kind: "place" }, label: null, text: look.place.text, source: look.place.by === "author" ? "yours" : "from the prose" });
  if (look.mood !== undefined) rows.push({ id: "mood", target: { kind: "mood" }, label: null, text: look.mood.text, source: look.mood.by === "author" ? "yours" : "from the art direction" });
  for (const [key, line] of Object.entries(look.characters)) {
    const blocks = blocksLabel(line.blocks, numberOf);
    rows.push({
      id: key,
      target: { kind: "character", key },
      label: line.name,
      text: line.text,
      line,
      ...(line.sheet !== undefined ? { sheet: line.sheet } : {}),
      source: [blocks, line.by === "author" ? "yours" : null].filter((part): part is string => part !== null).join(" · ") || null,
    });
  }
  return rows;
}

/** The words of one line, written on leaving the field when they changed (the author's from then on). */
function Field({ row, label, disabled, onWrite }: { row: Row; label: string; disabled: boolean; onWrite: (target: LookTarget, text: string | null) => void }) {
  const [text, setText] = useState(row.text);
  const saved = useRef(row.text);
  useEffect(() => {
    saved.current = row.text;
    setText(row.text);
  }, [row.text]);
  const leave = () => {
    const words = text.replace(/\s+/g, " ").trim();
    if (words === saved.current) return;
    onWrite(row.target, words === "" ? null : words);
  };
  return <Textarea aria-label={label} rows={2} value={text} disabled={disabled} onChange={(event) => setText(event.target.value)} onBlur={leave} />;
}

/** One line: the place, the mood, or a character with no sheet to hold a look. */
function LookLine({ row, disabled, onWrite }: { row: Row; disabled: boolean; onWrite: (target: LookTarget, text: string | null) => void }) {
  const store = useStore();
  const world = store.state?.world ?? null;
  const picture = row.sheet !== undefined && world !== null ? sheetReferencePicture(world, row.sheet) : null;
  const tag = row.id === "place" ? "Place" : row.id === "mood" ? "Mood" : null;
  return (
    <div className="fy-look__line" data-testid="look-line" data-key={row.id}>
      {tag !== null ? (
        <span className="fy-look__place fy-mono">{tag}</span>
      ) : picture !== null && world !== null ? (
        <img className="fy-look__thumb" src={mediaUrl(world.meta.slug, picture)} alt="" />
      ) : (
        <i className="fy-look__thumb fy-look__thumb--none" aria-hidden="true" />
      )}
      <div className="fy-look__tx">
        {row.label !== null && <b>{row.label}</b>}
        <Field row={row} label={row.label ?? tag ?? "Line"} disabled={disabled} onWrite={onWrite} />
      </div>
      {row.source !== null && <span className="fy-look__src fy-mono">{row.source}</span>}
    </div>
  );
}

const kitOf = (world: { referenceKits: readonly ReferenceKit[] } | null, sheet: string | undefined): ReferenceKit | null => (world === null || sheet === undefined ? null : (world.referenceKits.find((candidate) => candidate.sheetId === sheet) ?? null));

/** One character: the look chosen (or the main photo), the picker over their looks, the line, and what to do about the rest. */
function CharacterRow({ row, kit, slug, orderOf, usage, off, onWrite, onNewLook, onChoose, closeAsked, onMakeClose, closeTakeFor, onAcceptClose }: {
  row: Row;
  kit: ReferenceKit | null;
  slug: string;
  orderOf: (file: string) => number | null;
  usage: Record<string, number[]>;
  off: boolean;
  onWrite: (target: LookTarget, text: string | null) => void;
  onNewLook: (row: Row) => void;
  onChoose: (row: Row, lookId: string | null) => void;
  closeAsked: Record<string, true>;
  onMakeClose: (row: Row, look: CharacterLook) => void;
  closeTakeFor: (lookId: string) => { id: string; path: string } | null;
  onAcceptClose: (row: Row, look: CharacterLook, takeId: string) => void;
}) {
  const sheet = row.sheet;
  const line = row.line!;
  const looks = chapterLooksOf(kit);
  const chosen = looks.find((look) => look.id === line.lookId) ?? null;
  const photo = kit === null ? null : mainPhotoFor(kit);
  const model = useStore().state;
  const resolved = resolveModel(model, "image", undefined, worldModel(model, "image")).model;
  const closeCost = resolved === null ? "" : priceLabel(estimateCharacterImageMicroUsd(resolved, "character-look", 1, 2));
  const from = line.from !== undefined ? orderOf(line.from) : null;
  const closeTake = chosen === null ? null : closeTakeFor(chosen.id);
  const here = (id: string): string | null => {
    const chapters = usage[id];
    return chapters === undefined || chapters.length === 0 ? null : `chapter${chapters.length === 1 ? "" : "s"} ${[...chapters].sort((a, b) => a - b).join(", ")}`;
  };
  return (
    <div className="fy-look__char" data-testid="look-line" data-key={row.id}>
      <div className="fy-look__charhead">
        {chosen !== null ? (
          <img className="fy-look__full" src={mediaUrl(slug, `references/${sheet}/${chosen.file}`)} alt="" data-testid="look-image" data-view="full" />
        ) : photo !== null && sheet !== undefined ? (
          <img className="fy-look__main" src={mediaUrl(slug, `references/${sheet}/${photo.file}`)} alt="" data-testid="look-image" data-view="main" />
        ) : (
          <i className="fy-look__main fy-look__thumb--none" aria-hidden="true" />
        )}
        <div className="fy-look__tx">
          <b>{row.label}</b>
          <Field row={row} label={row.label ?? "Line"} disabled={off} onWrite={onWrite} />
          <div className="fy-look__facts fy-mono" data-testid="look-facts">
            <span data-testid="look-state">{chosen !== null ? (chosen.closeFile !== undefined ? "full body, close" : "full body · no close view") : looks.length > 0 ? "no look · the main photo rides" : "head and shoulders · no look"}</span>
            {row.source !== null && <span>{row.source}</span>}
            {from !== null && <span data-testid="look-from">from chapter {from}</span>}
            {chosen !== null && kit !== null && lookOlderFace(kit, chosen) && <span className="fy-ch__who-where--warn" data-testid="look-older">older face</span>}
            {chosen !== null && line.by === "author" && <span data-testid="look-edited">line edited</span>}
          </div>
          {(line.conflicts ?? []).map((conflict) => (
            <div key={`${conflict.kind}-${conflict.part}`} className="fy-look__conflict fy-mono" data-testid="look-conflict">
              <b>{conflict.part}</b>
              <span>
                {conflict.kind === "chapter" ? "chapter" : "photo"} {conflict.a} · {conflict.kind === "chapter" ? "look" : "line"} {conflict.b}
              </span>
              {sheet !== undefined && (
                <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onNewLook(row)} data-testid="look-conflict-make">
                  {chosen !== null ? "Make again" : "Make a look"}
                </button>
              )}
            </div>
          ))}
          {chosen !== null && chosen.closeFile === undefined && closeTake === null && (
            <div className="fy-look__facts fy-mono">
              <button type="button" className="fy-sugg__make" disabled={off || closeAsked[chosen.id] === true} onClick={() => onMakeClose(row, chosen)} data-testid="look-make-close">
                {closeAsked[chosen.id] === true ? "Making close view…" : `Make close view${closeCost !== "" ? ` · ${closeCost}` : ""}`}
              </button>
            </div>
          )}
          {chosen !== null && closeTake !== null && (
            <div className="fy-look__facts fy-mono" data-testid="look-close-made">
              <img className="fy-look__closeimg" src={mediaUrl(slug, closeTake.path)} alt="" />
              <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onAcceptClose(row, chosen, closeTake.id)} data-testid="look-accept-close">
                Accept close view
              </button>
            </div>
          )}
        </div>
      </div>
      {sheet !== undefined && (
        <div className="fy-look__picker" role="listbox" aria-label={`${row.label ?? "Character"}'s looks`} data-testid="look-picker">
          <button type="button" role="option" aria-selected={chosen === null} className={cx("fy-look__tile", chosen === null && "fy-look__tile--on")} disabled={off} onClick={() => onChoose(row, null)} data-testid="look-tile" data-look="main">
            {photo !== null ? <img src={mediaUrl(slug, `references/${sheet}/${photo.file}`)} alt="" /> : <i aria-hidden="true" />}
            <span className="fy-mono">Main photo</span>
          </button>
          {looks.map((look) => (
            <button key={look.id} type="button" role="option" aria-selected={chosen?.id === look.id} className={cx("fy-look__tile", chosen?.id === look.id && "fy-look__tile--on")} disabled={off} onClick={() => onChoose(row, look.id)} data-testid="look-tile" data-look={look.id} title={lookClothing(look)}>
              <img src={mediaUrl(slug, `references/${sheet}/${look.file}`)} alt="" />
              <span className="fy-mono">{lookName(look)}</span>
              {here(look.id) !== null && <span className="fy-mono fy-look__tileuse" data-testid="look-usage">{here(look.id)}</span>}
              {kit !== null && lookOlderFace(kit, look) && <span className="fy-mono fy-look__tileuse fy-ch__who-where--warn">older face</span>}
            </button>
          ))}
          <button type="button" className="fy-look__tile fy-look__tile--new" disabled={off} onClick={() => onNewLook(row)} data-testid="look-new">
            <i aria-hidden="true" />
            <span className="fy-mono">{looks.length === 0 ? "Make a look" : "New look"}</span>
          </button>
        </div>
      )}
    </div>
  );
}

export function LookSheet({ open, onClose, worldId, productionId, chapterFile, chapterOrder, record, blockKeys }: {
  open: boolean;
  onClose: () => void;
  worldId: string;
  productionId: string;
  chapterFile: string;
  chapterOrder: number;
  record: ChapterAudiobook | null;
  /** The chapter's blocks in order, for the numbers a line says it comes from. */
  blockKeys: readonly string[];
}) {
  const store = useStore();
  const world = store.state?.world ?? null;
  const connection = store.connection;
  const look = record?.look ?? null;
  const numberOf = (key: string): number | null => {
    const index = blockKeys.indexOf(key);
    return index < 0 ? null : index + 1;
  };
  const answers = useAudiobookRecords();
  const asks = useAudiobookAsks();
  const [asked, setAsked] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [usageAsk, setUsageAsk] = useState<string | null>(null);
  const [making, setMaking] = useState<{ key: string; name: string; sheet: string; line: string } | null>(null);
  const [closeAsked, setCloseAsked] = useState<Record<string, true>>({});
  useEffect(() => {
    if (asked === null) return;
    const landed = Object.values(answers).find((value) => value.requestId === asked);
    if (landed === undefined) return;
    setAsked(null);
    setRefused(landed.refused ?? null);
  }, [answers, asked]);
  const [adding, setAdding] = useState<Array<{ key: string; name: string; sheet?: string }>>([]);
  // Which chapters chose each look (R-114): asked when the sheet opens and again when a choice is made, so a picker is never a chapter behind.
  const chosenSignature = Object.entries(look?.characters ?? {}).map(([key, line]) => `${key}:${line.lookId ?? ""}`).join("|");
  useEffect(() => {
    if (!open) {
      setAdding([]);
      setRefused(null);
      setMaking(null);
      setCloseAsked({});
      return;
    }
    setUsageAsk(readAudiobookLooks(worldId, productionId));
  }, [open, worldId, productionId, chosenSignature]);
  const usageAnswer = usageAsk === null ? undefined : asks[usageAsk];
  const usage = usageAnswer?.state === "looks" ? usageAnswer.usage : {};
  const off = connection !== "open";
  const derive = () => {
    setRefused(null);
    setAsked(deriveAudiobookLook(worldId, productionId, chapterFile));
  };
  const write = (target: LookTarget, text: string | null) => {
    setAudiobookLook(worldId, productionId, chapterFile, target, text);
  };
  const rows = lookRows(look, numberOf);
  // A character the look holds no line for, offered to add: a sheet of the world's, by name.
  const held = new Set(Object.keys(look?.characters ?? {}));
  const addable = (world?.sheets ?? []).filter((sheet) => sheet.type === "character" && sheet.retired !== true && sheet.neverDepicted !== true && !held.has(sheet.id) && !adding.some((entry) => entry.key === sheet.id));
  const count = Object.keys(look?.characters ?? {}).length;
  const chosenCount = Object.values(look?.characters ?? {}).filter((line) => line.lookId !== undefined).length;
  const state = look === null ? null : rows.some((row) => row.source?.includes("yours")) ? "edited" : "derived";
  const slug = world?.meta.slug ?? "";
  const orderOf = (file: string): number | null => world?.productions.find((candidate) => candidate.meta.id === productionId)?.chapters.find((chapter) => chapter.file === file)?.order ?? null;
  const choose = (row: Row, lookId: string | null) => {
    chooseAudiobookLook(worldId, productionId, chapterFile, { key: row.id, ...(row.label !== null ? { name: row.label } : {}), ...(row.sheet !== undefined ? { sheet: row.sheet } : {}) }, lookId);
  };
  const pendingClose = (sheet: string | undefined, lookId: string): { id: string; path: string } | null => {
    if (world === null || sheet === undefined) return null;
    const found = world.referenceTakes.find(
      (take) => take.kind === "look" && take.reference?.sheetId === sheet && take.media !== undefined && take.params["lookFraming"] === "close" && take.params["lookOfLook"] === lookId && !world.referenceReviews.some((review) => review.takeId === take.id),
    );
    return found === undefined ? null : { id: found.id, path: `references/${sheet}/takes/${found.id}/${found.media}` };
  };
  const makeClose = (row: Row, chosen: CharacterLook) => {
    if (row.sheet === undefined) return;
    if (makeChapterLook(worldId, row.sheet, { framing: "close", prompt: chosen.prompt, count: 1, closeOf: { lookId: chosen.id } }) !== null) setCloseAsked((heldAsks) => ({ ...heldAsks, [chosen.id]: true }));
  };
  return (
    <>
      <EditorDialog open={open && making === null} onClose={onClose} width={1040} title={`Looks · Chapter ${chapterOrder}`} panelClassName="fy-look">
        <div className="fy-look__body" data-testid="look-sheet">
          {rows.length === 0 && adding.length === 0 && (
            <p className="fy-mono fy-look__none" data-testid="look-none">
              {asked !== null ? "reading…" : "not read"}
            </p>
          )}
          {rows.map((row) =>
            row.line !== undefined && row.sheet !== undefined ? (
              <CharacterRow
                key={row.id}
                row={row}
                kit={kitOf(world, row.sheet)}
                slug={slug}
                orderOf={orderOf}
                usage={usage}
                off={off}
                onWrite={write}
                onNewLook={(entry) => setMaking({ key: entry.id, name: entry.label ?? entry.id, sheet: entry.sheet!, line: entry.text })}
                onChoose={choose}
                closeAsked={closeAsked}
                onMakeClose={makeClose}
                closeTakeFor={(lookId) => pendingClose(row.sheet, lookId)}
                onAcceptClose={(entry, chosen, takeId) => acceptChapterLook(worldId, entry.sheet!, takeId, { closeFor: chosen.id })}
              />
            ) : (
              <LookLine key={row.id} row={row} disabled={off} onWrite={write} />
            ),
          )}
          {adding.map((entry) => (
            <LookLine
              key={`new-${entry.key}`}
              row={{ id: entry.key, target: { kind: "character", key: entry.key, name: entry.name, ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}) }, label: entry.name, text: "", ...(entry.sheet !== undefined ? { sheet: entry.sheet } : {}), source: null }}
              disabled={off}
              onWrite={(target, text) => {
                write(target, text);
                if (text !== null) setAdding((heldRows) => heldRows.filter((candidate) => candidate.key !== entry.key));
              }}
            />
          ))}
          {look !== null && (
            <div className="fy-look__meta fy-mono">
              <span data-testid="look-summary">
                {count} character{count === 1 ? "" : "s"} · {chosenCount} look{chosenCount === 1 ? "" : "s"} chosen · {state} · saved
              </span>
              <span>used by every picture in this chapter</span>
            </div>
          )}
          {refused !== null && <p className="fy-mono fy-ch__who-where--warn" data-testid="look-refused">{refused}</p>}
          <div className="fy-look__foot">
            {addable.length > 0 && (
              <Select
                label="Add"
                value=""
                disabled={off}
                onChange={(event) => {
                  const sheet = addable.find((candidate) => candidate.id === event.target.value);
                  if (sheet !== undefined) setAdding((heldRows) => [...heldRows, { key: sheet.id, name: sheet.name, sheet: sheet.id }]);
                }}
                data-testid="look-add"
              >
                <option value="">Add a character</option>
                {addable.map((sheet) => (
                  <option key={sheet.id} value={sheet.id}>
                    {sheet.name}
                  </option>
                ))}
              </Select>
            )}
            <span className="fy-ch__panelpush" />
            <Button variant="secondary" disabled={off || asked !== null} onClick={derive} data-testid="look-derive">
              {asked !== null ? "Reading…" : look === null ? "Derive" : "Derive again"}
            </Button>
            <Button variant="primary" onClick={onClose} data-testid="look-done">
              Done
            </Button>
          </div>
        </div>
      </EditorDialog>
      {making !== null && (
        <NewLookSheet open onClose={() => setMaking(null)} worldId={worldId} productionId={productionId} chapterFile={chapterFile} chapterOrder={chapterOrder} who={{ key: making.key, name: making.name, sheet: making.sheet }} line={making.line} />
      )}
    </>
  );
}

/** The panel's one line about the look: how many people it holds, or that it has not been read. */
export function lookCount(look: AudiobookLook | null | undefined): string {
  if (look === undefined || look === null) return "not read";
  const count = Object.keys(look.characters).length;
  return `${count} character${count === 1 ? "" : "s"}`;
}
