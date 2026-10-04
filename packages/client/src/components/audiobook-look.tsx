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
import { acceptChapterLook, chooseAudiobookLook, deriveAudiobookLook, makeChapterLook, readAudiobookLooks, rejectReferenceTake, setAudiobookLook, useAudiobookAsks, useAudiobookRecords, useStore } from "../lib/store.js";
import { lookJobState, lookJobs, useQueueRefusals } from "./look-jobs.js";
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
  if (look.mood !== undefined) rows.push({ id: "mood", target: { kind: "mood" }, label: null, text: look.mood.text, source: look.mood.by === "author" ? "yours" : "from the art direction · light only" });
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

/**
 * Where a chosen look's close view stands: none yet, being made, refused with its reason, made and
 * waiting to be accepted or discarded, or accepted (shown at once, before the kit's snapshot says so).
 */
export type CloseViewState =
  | { kind: "none" }
  | { kind: "making" }
  | { kind: "failed"; reason: string; retry: boolean }
  | { kind: "made"; take: { id: string; path: string } }
  | { kind: "accepted"; path: string };

/** The price of one close view on this model: one picture from two references, the main photo and the full body, as the job is priced. */
export function closeViewCost(model: Parameters<typeof estimateCharacterImageMicroUsd>[0] | null): string {
  return model === null ? "" : priceLabel(estimateCharacterImageMicroUsd(model, "character-look", 1, 2));
}

/** One character: the look chosen (or the main photo), the picker over their looks, the line, and what to do about the rest. */
function CharacterRow({ row, kit, slug, orderOf, usage, off, onWrite, onNewLook, onChoose, closeState, onMakeClose, onAcceptClose, onDiscardClose }: {
  row: Row;
  kit: ReferenceKit | null;
  slug: string;
  orderOf: (file: string) => number | null;
  usage: Record<string, number[]>;
  off: boolean;
  onWrite: (target: LookTarget, text: string | null) => void;
  onNewLook: (row: Row) => void;
  onChoose: (row: Row, lookId: string | null) => void;
  closeState: (look: CharacterLook) => CloseViewState;
  onMakeClose: (row: Row, look: CharacterLook) => void;
  onAcceptClose: (row: Row, look: CharacterLook, take: { id: string; path: string }) => void;
  onDiscardClose: (look: CharacterLook, takeId: string, again: boolean) => void;
}) {
  const sheet = row.sheet;
  const line = row.line!;
  const looks = chapterLooksOf(kit);
  const chosen = looks.find((look) => look.id === line.lookId) ?? null;
  const photo = kit === null ? null : mainPhotoFor(kit);
  const model = useStore().state;
  const closeCost = closeViewCost(resolveModel(model, "image", undefined, worldModel(model, "image")).model);
  const from = line.from !== undefined ? orderOf(line.from) : null;
  const close: CloseViewState = chosen === null ? { kind: "none" } : chosen.closeFile !== undefined ? { kind: "accepted", path: `references/${sheet}/${chosen.closeFile}` } : closeState(chosen);
  const priced = (label: string) => `${label}${closeCost !== "" ? ` · ${closeCost}` : ""}`;
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
            <span data-testid="look-state">{chosen !== null ? (close.kind === "accepted" ? "full body, close" : "full body · no close view") : looks.length > 0 ? "no look · the main photo rides" : "head and shoulders · no look"}</span>
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
          {chosen !== null && (close.kind === "none" || close.kind === "making") && (
            <div className="fy-look__facts fy-mono">
              <button type="button" className="fy-sugg__make" disabled={off || close.kind === "making"} onClick={() => onMakeClose(row, chosen)} data-testid="look-make-close">
                {close.kind === "making" ? "Making close view…" : priced("Make close view")}
              </button>
            </div>
          )}
          {chosen !== null && close.kind === "failed" && (
            <div className="fy-look__facts fy-mono" data-testid="look-close-failed">
              <span className="fy-ch__who-where--warn" data-testid="look-close-reason">Close view {close.reason}</span>
              {close.retry && (
                <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onMakeClose(row, chosen)} data-testid="look-close-retry">
                  {priced("Try again")}
                </button>
              )}
            </div>
          )}
          {chosen !== null && close.kind === "made" && (
            <div className="fy-look__facts fy-mono" data-testid="look-close-made">
              <img className="fy-look__closeimg" src={mediaUrl(slug, close.take.path)} alt="" />
              <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onAcceptClose(row, chosen, close.take)} data-testid="look-accept-close">
                Accept close view
              </button>
              <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onDiscardClose(chosen, close.take.id, true)} data-testid="look-close-again">
                {priced("Make again")}
              </button>
              <button type="button" className="fy-sugg__make" disabled={off} onClick={() => onDiscardClose(chosen, close.take.id, false)} data-testid="look-close-discard">
                Discard
              </button>
            </div>
          )}
          {chosen !== null && close.kind === "accepted" && chosen.closeFile === undefined && (
            <div className="fy-look__facts fy-mono" data-testid="look-close-accepted">
              <img className="fy-look__closeimg" src={mediaUrl(slug, close.path)} alt="" />
              <span>close view · saving…</span>
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

/** The words a target's line holds in a look, or null where it holds none. */
export function lineOf(look: AudiobookLook | null, target: LookTarget): string | null {
  if (look === null) return null;
  if (target.kind === "place") return look.place?.text ?? null;
  if (target.kind === "mood") return look.mood?.text ?? null;
  return look.characters[target.key]?.text ?? null;
}

/**
 * The look with choices laid over it that were pressed and not yet answered: a look chosen takes
 * that look's clothing line, the main photo takes back the chapter's own reading, as the
 * coordinator's `chooseLook` will write them.
 */
export function withChoices(look: AudiobookLook | null, choosing: Record<string, { lookId: string | null }>, kitLook: (sheet: string, lookId: string) => CharacterLook | null): AudiobookLook | null {
  if (look === null || Object.keys(choosing).length === 0) return look;
  const characters = { ...look.characters };
  for (const [key, press] of Object.entries(choosing)) {
    const line = characters[key];
    if (line === undefined) continue;
    if (press.lookId === null) {
      const { lookId: _id, from: _from, conflicts: _conflicts, reading, ...rest } = line;
      characters[key] = { ...rest, text: reading ?? line.text };
      continue;
    }
    const chosen = line.sheet === undefined ? null : kitLook(line.sheet, press.lookId);
    if (chosen === null) continue;
    const { from: _from, conflicts: _conflicts, ...rest } = line;
    characters[key] = { ...rest, text: lookClothing(chosen), lookId: press.lookId, ...(line.lookId === undefined ? { reading: line.text } : {}) };
  }
  return { ...look, characters };
}

/** The look with line writes not yet answered laid over it: a sheet closed and opened again still shows the words written (codex on PR 1559). */
export function withWrites(look: AudiobookLook | null, writing: ReadonlyArray<{ target: LookTarget; text: string | null }>): AudiobookLook | null {
  if (look === null || writing.length === 0) return look;
  let next = look;
  for (const { target, text } of writing) {
    // A line taken away (null) is shown gone, as the record will have it.
    if (target.kind === "place" && next.place !== undefined) {
      const { place: _place, ...rest } = next;
      next = text === null ? rest : { ...next, place: { ...next.place, text } };
    } else if (target.kind === "mood" && next.mood !== undefined) {
      const { mood: _mood, ...rest } = next;
      next = text === null ? rest : { ...next, mood: { ...next.mood, text } };
    } else if (target.kind === "character" && next.characters[target.key] !== undefined) {
      const { [target.key]: line, ...others } = next.characters;
      next = { ...next, characters: text === null ? others : { ...next.characters, [target.key]: { ...line!, text } } };
    } else if (target.kind === "character" && text !== null && target.name !== undefined) {
      // A character added here and not yet in the record: drawn from the write, so the row stays
      // and Add does not offer them twice (codex on PR 1559).
      next = { ...next, characters: { ...next.characters, [target.key]: { name: target.name, ...(target.sheet !== undefined ? { sheet: target.sheet } : {}), text, by: "author" as const } } };
    }
  }
  return next;
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
  const answers = useAudiobookRecords();
  // The newest of the record the chapter holds and the records this sheet's own writes were
  // answered with: the sheet never waits on the chapter view to take the answer first.
  const asking = useRef(new Set<string>());
  const current = Object.values(answers).reduce<ChapterAudiobook | null>((newest, answer) => (answer.record !== undefined && answer.requestId !== undefined && asking.current.has(answer.requestId) && (newest === null || answer.record.updatedAt > newest.updatedAt) ? answer.record : newest), record);
  useEffect(() => {
    asking.current = new Set();
  }, [chapterFile]);
  const look = current?.look ?? null;
  const numberOf = (key: string): number | null => {
    const index = blockKeys.indexOf(key);
    return index < 0 ? null : index + 1;
  };
  const asks = useAudiobookAsks();
  const jobs = store.state?.app.jobs ?? [];
  const queueRefused = useQueueRefusals();
  const [asked, setAsked] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [usageAsk, setUsageAsk] = useState<string | null>(null);
  const [making, setMaking] = useState<{ key: string; name: string; sheet: string; line: string } | null>(null);
  /** Close views asked for here, by look: the request whose job is that row's. */
  const [closeAsked, setCloseAsked] = useState<Record<string, string>>({});
  /** Close views accepted or discarded here, shown so at once: the kit's snapshot follows. */
  // Held only until the world's next snapshot, which the coordinator sends after every accept: if
  // that snapshot's kit has no close view the accept did not land, and the row offers it again
  // rather than saying `saving…` for good (codex on PR 1559).
  const [closeAccepted, setCloseAccepted] = useState<Record<string, { path: string; under: unknown }>>({});
  // Hidden until the next snapshot, which records the rejection or shows the take still pending.
  const [discarded, setDiscarded] = useState<ReadonlyArray<{ takeId: string; under: unknown }>>([]);
  /**
   * Choices and line writes pressed and not yet in the record (2026-10-04, 0.5.60-local.14): the
   * coordinator wrote the choice, but the record it answers with took seconds to come back and the
   * sheet said `no look · 0 looks chosen` all that time, so the author thought nothing happened.
   * The sheet shows what was pressed at once, says `saving…`, and lets the record or a refusal
   * settle it.
   */
  const [choosing, setChoosing] = useState<Record<string, { lookId: string | null; requestId: string }>>({});
  const [writing, setWriting] = useState<ReadonlyArray<{ requestId: string; target: LookTarget; text: string | null }>>([]);
  useEffect(() => {
    const landed = (id: string) => Object.values(answers).find((value) => value.requestId === id);
    if (asked !== null && landed(asked) !== undefined) {
      setRefused(landed(asked)!.refused ?? null);
      setAsked(null);
    }
    const answered = Object.entries(choosing).filter(([, press]) => landed(press.requestId) !== undefined);
    const wrote = writing.filter((press) => landed(press.requestId) !== undefined);
    const refusal = [...answered.map(([, press]) => press.requestId), ...wrote.map((press) => press.requestId)].map((id) => landed(id)!.refused).find((said) => said !== undefined);
    if (refusal !== undefined) setRefused(refusal);
    if (answered.length > 0) setChoosing((held) => Object.fromEntries(Object.entries(held).filter(([key]) => !answered.some(([done]) => done === key))));
    if (wrote.length > 0) setWriting((held) => held.filter((press) => !wrote.includes(press)));
  }, [answers, asked, choosing, writing]);
  // A press the record already shows is settled, whichever answer brought it: answers to quick
  // presses replace one another in the store, so its own may never be read.
  useEffect(() => {
    if (look === null) return;
    const shown = Object.entries(choosing).filter(([key, press]) => (look.characters[key]?.lookId ?? null) === press.lookId);
    if (shown.length > 0) setChoosing((held) => Object.fromEntries(Object.entries(held).filter(([key]) => !shown.some(([done]) => done === key))));
    const written = writing.filter((press) => (lineOf(look, press.target) ?? null) === press.text);
    if (written.length > 0) setWriting((held) => held.filter((press) => !written.includes(press)));
  }, [look]);
  const [adding, setAdding] = useState<Array<{ key: string; name: string; sheet?: string }>>([]);
  // Which chapters chose each look (R-114): asked when the sheet opens and again when a choice is made, so a picker is never a chapter behind.
  const chosenSignature = Object.entries(look?.characters ?? {}).map(([key, line]) => `${key}:${line.lookId ?? ""}`).join("|");
  useEffect(() => {
    if (!open) {
      setAdding([]);
      setRefused(null);
      setMaking(null);
      setCloseAsked({});
      setCloseAccepted({});
      setDiscarded([]);
      // Presses still on their way are kept: closed and opened again, the sheet still shows them
      // until their answer or the record settles them (codex on PR 1559).
      return;
    }
    setUsageAsk(readAudiobookLooks(worldId, productionId));
  }, [open, worldId, productionId, chosenSignature]);
  const usageAnswer = usageAsk === null ? undefined : asks[usageAsk];
  const usage = usageAnswer?.state === "looks" ? usageAnswer.usage : {};
  const off = connection !== "open";
  const derive = () => {
    setRefused(null);
    const requestId = deriveAudiobookLook(worldId, productionId, chapterFile);
    if (requestId !== null) asking.current.add(requestId);
    setAsked(requestId);
  };
  const write = (target: LookTarget, text: string | null) => {
    // A new write starts clean: an earlier refusal is not this one's (codex on PR 1559).
    setRefused(null);
    const requestId = setAudiobookLook(worldId, productionId, chapterFile, target, text);
    if (requestId === null) return;
    asking.current.add(requestId);
    setWriting((held) => [...held, { requestId, target, text }]);
  };
  // What the sheet draws: the record, with the choices pressed and not yet answered laid over it.
  const shownLook = withWrites(withChoices(look, choosing, (sheet, lookId) => chapterLooksOf(kitOf(world, sheet)).find((candidate) => candidate.id === lookId) ?? null), writing);
  const rows = lookRows(shownLook, numberOf);
  // A character the look holds no line for, offered to add: a sheet of the world's, by name.
  const held = new Set(Object.keys(shownLook?.characters ?? {}));
  const addable = (world?.sheets ?? []).filter((sheet) => sheet.type === "character" && sheet.retired !== true && sheet.neverDepicted !== true && !held.has(sheet.id) && !adding.some((entry) => entry.key === sheet.id));
  const count = Object.keys(shownLook?.characters ?? {}).length;
  const chosenCount = Object.values(shownLook?.characters ?? {}).filter((line) => line.lookId !== undefined).length;
  const state = look === null ? null : rows.some((row) => row.source?.includes("yours")) ? "edited" : "derived";
  const saving = Object.keys(choosing).length > 0 || writing.length > 0;
  const slug = world?.meta.slug ?? "";
  const orderOf = (file: string): number | null => world?.productions.find((candidate) => candidate.meta.id === productionId)?.chapters.find((chapter) => chapter.file === file)?.order ?? null;
  const choose = (row: Row, lookId: string | null) => {
    // The row already shows what was pressed and not yet answered: the same press again sends nothing.
    if ((row.line?.lookId ?? null) === lookId) return;
    setRefused(null);
    const requestId = chooseAudiobookLook(worldId, productionId, chapterFile, { key: row.id, ...(row.label !== null ? { name: row.label } : {}), ...(row.sheet !== undefined ? { sheet: row.sheet } : {}) }, lookId);
    if (requestId === null) return;
    asking.current.add(requestId);
    setChoosing((pressed) => ({ ...pressed, [row.id]: { lookId, requestId } }));
  };
  const pendingClose = (sheet: string, lookId: string): { id: string; path: string } | null => {
    if (world === null) return null;
    const found = world.referenceTakes
      .filter((take) => take.kind === "look" && take.reference?.sheetId === sheet && take.media !== undefined && take.params["lookFraming"] === "close" && take.params["lookOfLook"] === lookId && !discarded.some((entry) => entry.takeId === take.id && entry.under === world) && !world.referenceReviews.some((review) => review.takeId === take.id))
      .sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    return found === undefined ? null : { id: found.id, path: `references/${sheet}/takes/${found.id}/${found.media}` };
  };
  /** The close view's row (R-118): accepted here, made and waiting, being made, or refused with its reason — never a spinner on a job that ended. */
  const closeStateFor = (sheet: string, chosen: CharacterLook): CloseViewState => {
    const accepted = closeAccepted[chosen.id];
    if (accepted !== undefined && accepted.under === world) return { kind: "accepted", path: accepted.path };
    // A close view waiting to be accepted is the row's (a discarded one is gone at once, and Make
    // again discards before it asks, so a newer request never stands behind an older picture).
    const take = pendingClose(sheet, chosen.id);
    if (take !== null) return { kind: "made", take };
    const request = closeAsked[chosen.id];
    if (request !== undefined && queueRefused[request] !== undefined) return { kind: "failed", reason: queueRefused[request]!.reason, retry: true };
    // A request asked here is followed by its own job; otherwise the newest close job of this look.
    const job = request !== undefined ? lookJobs(jobs, (params) => params["lookBatch"] === request)[0] : lookJobs(jobs, (params) => params["lookFraming"] === "close" && params["lookOfLook"] === chosen.id)[0];
    const ended = lookJobState(job);
    if (ended?.state === "failed") return { kind: "failed", reason: ended.reason, retry: ended.retry };
    return ended?.state === "making" || request !== undefined ? { kind: "making" } : { kind: "none" };
  };
  const makeClose = (row: Row, chosen: CharacterLook) => {
    if (row.sheet === undefined) return;
    const request = makeChapterLook(worldId, row.sheet, { framing: "close", prompt: lookClothing(chosen), count: 1, closeOf: { lookId: chosen.id } });
    if (request !== null) setCloseAsked((heldAsks) => ({ ...heldAsks, [chosen.id]: request }));
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
                closeState={(chosen) => closeStateFor(row.sheet!, chosen)}
                onMakeClose={makeClose}
                onAcceptClose={(entry, chosen, take) => {
                  // Shown at once only when the command went: a closed connection sends nothing.
                  if (!acceptChapterLook(worldId, entry.sheet!, take.id, { closeFor: chosen.id })) return;
                  setCloseAccepted((heldViews) => ({ ...heldViews, [chosen.id]: { path: take.path, under: world } }));
                }}
                onDiscardClose={(chosen, takeId, again) => {
                  // Hidden at once only when the command went (codex on PR 1559); a take another window
                  // decided is gone from the snapshot anyway.
                  if (!rejectReferenceTake(worldId, takeId, "close view", again ? "made again" : "discarded")) return;
                  setDiscarded((heldTakes) => [...heldTakes, { takeId, under: world }]);
                  setCloseAsked(({ [chosen.id]: _gone, ...rest }) => rest);
                  if (again) makeClose(row, chosen);
                }}
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
                {count} character{count === 1 ? "" : "s"} · {chosenCount} look{chosenCount === 1 ? "" : "s"} chosen · {state} · {saving ? "saving…" : "saved"}
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
