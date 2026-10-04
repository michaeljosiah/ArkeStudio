import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { ProviderMark } from "../screens/settings-parts.js";
import { PickerInfo, PickerSearch, PickerSliders, PickerTick } from "./model-chip-icons.js";
import {
  filterGroups, matchSpan, modelCard, phoneDetailRows, squash,
  type PickerGroup, type PickerModel,
} from "./model-picker-data.js";
import { cx } from "./ui.js";

/** How long the pointer rests on a row before its card opens; the keyboard needs none. */
const CARD_DELAY = 280;
/** The card's distance from the list. */
const CARD_GAP = 12;
/** What the card keeps clear of the window's edges. */
const CARD_EDGE = 12;

/** One row of the list, in the order it is drawn. */
interface Row {
  /** Unique in the list: a model in Recent and in its group is two rows. */
  key: string;
  kind: "unset" | "lost" | "model";
  label: string;
  entry?: PickerModel;
  groupName?: string;
  /** The mono word at the row's end: `default`, `saved`, `unavailable`. */
  tag?: string;
  /** What a lost choice was saved as. */
  value?: string;
  ticked: boolean;
  /** Cannot be picked: struck for a model this chat cannot use, and the lost choice. */
  disabled: boolean;
}

interface Section {
  key: string;
  heading?: { text: string; mark?: ReactNode };
  rows: Row[];
}

/** The name with the matched letters in bold. */
function Matched({ label, query }: { label: string; query: string }) {
  const span = matchSpan(label, query);
  if (span === null) return <>{label}</>;
  return <>{label.slice(0, span[0])}<b>{label.slice(span[0], span[1])}</b>{label.slice(span[1])}</>;
}

export interface ModelPickerProps {
  groups: PickerGroup[];
  recent: PickerModel[];
  total: number;
  /** The model in force, by reference. */
  reference: string | undefined;
  /** A remembered choice the catalogue no longer lists: kept at the top, ticked and unpickable. */
  lost: { label: string; tag: string; value: string } | null;
  /** The choice is this chat's: the list starts with a quiet press to let go of it. */
  set: boolean;
  unsetLabel: string;
  listboxId: string;
  panelRef: RefObject<HTMLDivElement | null>;
  /** Set by the picker; asked by the layer on Escape. True means it used the key to clear its search. */
  escapeRef: MutableRefObject<(() => boolean) | null>;
  onChoose: (reference: string | undefined) => void;
  onRemember?: () => void;
  onClear?: () => void;
  onManage: () => void;
  /** Drawn as a phone's bottom sheet (design turn 195): rows of 48, an info press for each, no hover card, no focus taken. */
  sheet?: boolean;
  /** The sheet's head, beside Model: the effort chip, when the model has one. */
  effort?: ReactNode;
}

/**
 * The picker (design turn 195): a search that holds focus, the list in groups, the hovered row's
 * card beside it, and a pinned foot. Rows are options of one listbox and keyboard focus stays in
 * the search, which names the row it is on (`aria-activedescendant`); a pointer moving over the
 * list moves that row the same way, so what is highlighted is always what Enter would pick.
 */
export function ModelPicker(props: ModelPickerProps) {
  const { groups, recent, total, reference, lost, set, unsetLabel, listboxId, panelRef, escapeRef, onChoose, onRemember, onClear, onManage, sheet = false, effort } = props;
  const prefix = useId();
  const search = useRef<HTMLInputElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  /** The row Enter would pick, or the struck one the pointer is on: what is highlighted. */
  const [hot, setHot] = useState<string | null>(null);
  /** The row whose card shows. */
  const [cardKey, setCardKey] = useState<string | null>(null);
  /** The row whose card is open in place, on a phone, where there is no hover. */
  const [info, setInfo] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The row whose card is shown or on its way, so a pointer resting on a row does not start it again. */
  const wanted = useRef<string | null>(null);

  const searching = squash(query) !== "";
  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const modelRow = (entry: PickerModel, groupName: string, scope: string): Row => ({
      key: `${scope}:${entry.ref}`,
      kind: "model",
      label: entry.label,
      entry,
      groupName,
      ...(entry.model.isDefault === true && scope === "model" ? { tag: "default" } : {}),
      ticked: entry.ref === reference,
      disabled: entry.locked,
    });
    // Hidden while searching: the list is then only what matches.
    if (!searching) {
      const top: Row[] = [];
      if (set) top.push({ key: "unset", kind: "unset", label: unsetLabel, ticked: false, disabled: false });
      if (lost !== null) top.push({ key: "lost", kind: "lost", label: lost.label, tag: lost.tag, value: lost.value, ticked: true, disabled: true });
      if (top.length > 0) out.push({ key: "top", rows: top });
      if (recent.length > 0) {
        out.push({
          key: "recent",
          heading: { text: "Recent" },
          rows: recent.map((entry) => modelRow(entry, groups.find((group) => group.models.includes(entry))?.name ?? entry.model.provider, "recent")),
        });
      }
    }
    for (const group of filterGroups(groups, query)) {
      out.push({
        key: `group:${group.provider}`,
        heading: { text: group.name, mark: <ProviderMark id={group.provider} label={group.name} size="xs" /> },
        rows: group.models.map((entry) => modelRow(entry, group.name, "model")),
      });
    }
    return out;
  }, [groups, recent, query, searching, reference, lost, set, unsetLabel]);

  const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);
  const usable = useMemo(() => rows.filter((row) => !row.disabled), [rows]);
  const matches = useMemo(() => filterGroups(groups, query).reduce((sum, group) => sum + group.models.length, 0), [groups, query]);
  const domId = (key: string) => `${prefix}${key.replace(/[^\w:-]/g, "_")}`;

  // Opening lands on the model in force, else the first model; typing lands on the first match.
  useLayoutEffect(() => {
    const first = (searching ? undefined : usable.find((row) => row.ticked)) ?? usable.find((row) => row.kind === "model") ?? usable[0];
    // A phone's list lights nothing until a row is opened: the sheet does not take the keyboard.
    setHot(sheet ? null : first?.key ?? null);
    wanted.current = null;
    setCardKey(null);
    setInfo(null);
  }, [searching, query]);
  // A catalogue arriving while open can take the highlighted row away.
  useEffect(() => {
    if (hot !== null && !rows.some((row) => row.key === hot)) setHot(usable.find((row) => row.kind === "model")?.key ?? usable[0]?.key ?? null);
  }, [rows, usable, hot]);

  const focusSearch = () => search.current?.focus({ preventScroll: true });
  // The keyboard does not rise on a phone until the field is pressed.
  useLayoutEffect(() => { if (!sheet) focusSearch(); }, []);
  // The model in force is brought into view on opening, since ninety rows are not all in sight.
  useLayoutEffect(() => {
    if (hot === null) return;
    panelRef.current?.ownerDocument.getElementById(domId(hot))?.scrollIntoView?.({ block: "nearest" });
  }, [hot]);

  escapeRef.current = () => {
    if (query === "") return false;
    setQuery("");
    focusSearch();
    return true;
  };

  const rowOf = (key: string | null) => rows.find((row) => row.key === key);
  const activate = (key: string, immediate: boolean) => {
    setHot(key);
    wanted.current = key;
    clearTimeout(timer.current);
    if (immediate) setCardKey(key);
    else timer.current = setTimeout(() => setCardKey(key), CARD_DELAY);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const pick = (row: Row | undefined) => {
    if (row === undefined || row.disabled) return;
    onChoose(row.kind === "unset" ? undefined : row.entry!.ref);
  };
  const move = (by: 1 | -1) => {
    if (usable.length === 0) return;
    const at = usable.findIndex((row) => row.key === hot);
    const next = at === -1 ? (by === 1 ? 0 : usable.length - 1) : (at + by + usable.length) % usable.length;
    activate(usable[next]!.key, true);
  };
  const onSearchKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(rowOf(hot));
    }
  };

  // The card sits on the side of the list with room, level with its row, never past the window.
  const shown = cardKey === null || sheet ? undefined : rowOf(cardKey);
  const cardData = shown?.entry !== undefined ? modelCard(shown.entry, shown.groupName ?? shown.entry.model.provider) : null;
  useLayoutEffect(() => {
    const element = card.current;
    const panel = panelRef.current;
    if (element === null || panel === null || shown === undefined) return;
    const doc = panel.ownerDocument;
    const view = doc.defaultView;
    const viewWidth = view?.innerWidth || doc.documentElement.clientWidth || 0;
    const viewHeight = view?.innerHeight || doc.documentElement.clientHeight || 0;
    const around = panel.getBoundingClientRect();
    const seat = doc.getElementById(domId(shown.key))?.getBoundingClientRect();
    const { height, width } = element.getBoundingClientRect();
    const fitsLeft = around.left - CARD_GAP - width >= CARD_EDGE;
    const fitsRight = around.right + CARD_GAP + width <= viewWidth - CARD_EDGE;
    element.setAttribute("data-side", fitsLeft ? "left" : fitsRight ? "right" : "none");
    if (!fitsLeft && !fitsRight) return;
    element.style.left = `${fitsLeft ? around.left - CARD_GAP - width : around.right + CARD_GAP}px`;
    const level = seat === undefined ? around.top : seat.top + seat.height / 2 - height / 2;
    const floor = Math.max(CARD_EDGE, around.top);
    const ceiling = Math.max(floor, Math.min(viewHeight - CARD_EDGE - height, around.bottom - height));
    element.style.top = `${Math.min(ceiling, Math.max(floor, level))}px`;
  });

  const renderRow = (row: Row) => {
    const reason = row.entry?.reason;
    // A phone has no hover: a model with facts to show gets a press that opens them under its row.
    const details = sheet && row.entry !== undefined && reason === undefined ? phoneDetailRows(row.entry, row.groupName ?? row.entry.model.provider) : [];
    return (
      <div key={row.key} role="presentation" className="fy-mpick__item">
        <div
          id={domId(row.key)}
          role="option"
          aria-selected={row.ticked}
          aria-disabled={row.disabled || undefined}
          {...(reason !== undefined ? { "aria-label": `${row.label}, ${reason}` } : {})}
          {...(row.entry !== undefined ? { "data-model": row.entry.ref } : row.value !== undefined ? { "data-model": row.value } : {})}
          className={cx(
            "fy-mpick__row",
            row.kind === "unset" && "fy-mpick__row--quiet",
            reason !== undefined && "fy-mpick__row--off",
            sheet && reason !== undefined && "fy-mpick__row--reason",
            details.length > 0 && "fy-mpick__row--info",
            (row.key === hot || (sheet && row.key === info)) && "fy-mpick__row--active",
            row.ticked && "fy-mpick__row--on",
          )}
          onMouseMove={sheet ? undefined : () => { if (row.key !== wanted.current) activate(row.key, false); }}
          onClick={() => pick(row)}
        >
          <span className="fy-mpick__name">{row.entry !== undefined ? <Matched label={row.label} query={searching ? query : ""} /> : row.label}</span>
          {sheet && reason !== undefined && <span className="fy-mpick__reason">{reason}</span>}
          {row.tag !== undefined && <span className="fy-mpick__tag">{row.tag}</span>}
          {row.ticked && <PickerTick />}
        </div>
        {details.length > 0 && (
          <button
            type="button"
            className={cx("fy-mpick__info", info === row.key && "fy-mpick__info--on")}
            aria-label={`Details for ${row.label}`}
            aria-expanded={info === row.key}
            onClick={() => setInfo(info === row.key ? null : row.key)}
          >
            <PickerInfo />
          </button>
        )}
        {info === row.key && details.length > 0 && (
          <div className="fy-mpick__det">
            {details.map((detail) => (
              <span key={detail.label} className="fy-mpick__det-row">
                <b>{detail.label}</b>
                <span>{detail.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <>
      {sheet && (
        <>
          <div className="fy-mpick__grab" aria-hidden="true" />
          <div className="fy-msheet__head">
            <span>Model</span>
            {effort}
          </div>
        </>
      )}
      <div className="fy-mpick__search">
        <PickerSearch />
        <input
          ref={search}
          type="text"
          className="fy-mpick__input"
          role="combobox"
          aria-label="Search models"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={hot === null ? undefined : domId(hot)}
          placeholder="Search models"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKey}
        />
        <span className="fy-mpick__count" aria-live="polite">{searching ? `${matches} of ${total}` : total}</span>
      </div>
      <div
        id={listboxId}
        role="listbox"
        aria-label="Models"
        className="fy-mpick__list"
        // A press on a row keeps focus in the search, so the keyboard carries on from where it was.
        onMouseDown={(event) => event.preventDefault()}
        onMouseLeave={() => { clearTimeout(timer.current); wanted.current = null; setCardKey(null); }}
      >
        {rows.length === 0 && <div className="fy-mpick__empty" role="presentation">No model matches</div>}
        {sections.map((section) => section.heading === undefined ? (
          <div key={section.key} role="presentation" className="fy-mpick__section">{section.rows.map(renderRow)}</div>
        ) : (
          <div key={section.key} role="group" aria-labelledby={domId(`${section.key}:heading`)} className="fy-mpick__section">
            <div id={domId(`${section.key}:heading`)} className="fy-mpick__grp">
              {section.heading.mark}
              {section.heading.text}
            </div>
            {section.rows.map(renderRow)}
          </div>
        ))}
      </div>
      <div className="fy-mpick__foot">
        <button type="button" className="fy-mpick__manage" onClick={onManage}>
          <PickerSliders />
          Manage models
        </button>
        {onRemember !== undefined && <button type="button" className="fy-mpick__quiet" onClick={onRemember}>Every chat in this production</button>}
        {onClear !== undefined && <button type="button" className="fy-mpick__quiet" onClick={onClear}>Clear the production&rsquo;s choice</button>}
      </div>
      {cardData !== null && (
        <div ref={card} className="fy-mchip__card" aria-hidden="true">
          {cardData.why !== undefined && <div className="fy-mchip__why">{cardData.why}</div>}
          <div className="fy-mchip__card-name">{cardData.title}</div>
          <div className="fy-mchip__card-ref">{cardData.reference}</div>
          {cardData.rows.map((row) => (
            <div key={row.label} className="fy-mchip__card-row">
              <b>{row.label}</b>
              <span>{row.value}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
