import { useEffect, useRef, type ReactNode } from "react";
import { CHAPTER_GOAL_LIMITS, CHAPTER_PLAN_LIMITS, type ChapterGoalSource } from "@arke-studio/contracts";
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp, PanelLeft, Search, Sparkle, X } from "../components/icons.js";
import { cx } from "../components/ui.js";
import { EditableText, SceneTitle } from "./storyboard.js";

/*
 * The writing room's pieces (design turn 227, SPEC-056 §1.6). The chapter workspace wires them in;
 * they hold no chapter state of their own, so the page's autosave, locks and plan writes stay where
 * they were.
 */

const GOAL_SOURCE: Record<ChapterGoalSource, string> = {
  chapter: "This chapter's goal",
  story: "From the story's target",
  median: "The book's usual chapter",
  default: "Default goal",
};

/** The goal ring (R-7, D-2): the chapter's words against its goal, the source on the tooltip. */
export function GoalRing({ words, goal, source }: { words: number; goal: number; source: ChapterGoalSource }) {
  const share = Math.max(0, Math.min(1, goal > 0 ? words / goal : 0));
  return (
    <span className="fy-ch__goal" title={`${GOAL_SOURCE[source]} · ${goal.toLocaleString()} words`} data-testid="chapter-goal">
      <span className="fy-ch__goal-ring" style={{ ["--p" as string]: Math.round(share * 100) }} role="progressbar" aria-label="Chapter goal" aria-valuemin={0} aria-valuemax={goal} aria-valuenow={Math.min(words, goal)} />
      <b>{words.toLocaleString()}</b>
      <span>/ {goal.toLocaleString()}</span>
    </span>
  );
}

/**
 * The one bar above the page (R-7): Brief, the chapter before and after, the views, then the goal
 * and whatever the room still owes the chapter — today the read and Review, until the Chapter view
 * holds them (T-2b).
 */
export function WritingBar({
  brief,
  onBrief,
  previous,
  next,
  onChapter,
  views,
  lead,
  goal,
  children,
}: {
  brief: boolean;
  onBrief: () => void;
  previous: { title: string; id: string } | null;
  next: { title: string; id: string } | null;
  onChapter: (id: string) => void;
  views: ReactNode;
  /** What stands before the goal: the chapter's read. */
  lead?: ReactNode;
  goal: ReactNode;
  /** After the goal, in R-7's order: Focus, then ⋯. */
  children?: ReactNode;
}) {
  return (
    <div className="fy-ch__wbar" role="toolbar" aria-label="Writing">
      <button type="button" className={cx("fy-ch__wbtn", brief && "fy-ch__wbtn--on")} aria-pressed={brief} aria-label="Brief" title="Brief" onClick={onBrief}>
        <PanelLeft size={16} />
      </button>
      <span className="fy-ch__chapnav">
        <button type="button" className="fy-ch__wbtn" aria-label="Previous chapter" title={previous?.title ?? undefined} disabled={previous === null} onClick={() => previous && onChapter(previous.id)}>
          <ChevronLeft size={14} />
        </button>
        <button type="button" className="fy-ch__wbtn" aria-label="Next chapter" title={next?.title ?? undefined} disabled={next === null} onClick={() => next && onChapter(next.id)}>
          <ChevronRight size={14} />
        </button>
      </span>
      {views}
      <span className="fy-ch__wbar-gap" />
      {lead}
      {goal}
      {children}
    </div>
  );
}

/** The top of the document (R-8): the chapter's number, then its title, edited where it reads. */
export function DocHead({ order, title, locked, fresh = false, onTitle, children }: { order: number; title: string; locked: boolean; fresh?: boolean; onTitle: (title: string) => void; children?: ReactNode }) {
  return (
    <div className="fy-ch__dochead">
      <p className="fy-ch__kick">Chapter {order}</p>
      <h1 className="fy-ch__doctitle">
        <SceneTitle title={title} label="Chapter title" locked={locked} startEditing={fresh} onCommit={onTitle} />
      </h1>
      {children}
    </div>
  );
}

/** The point of view's picker value that opens character creation rather than choosing (D-4). */
export const NEW_CHARACTER = "__new-character__";

/**
 * The plan in the Brief (R-10): synopsis, point of view, when and goal, each saved in place through
 * `edit-chapter-plan`. Point of view may be left unset (D-4).
 */
export function BriefFields({
  synopsis,
  pov,
  when,
  goal,
  goalSource,
  characters,
  locked,
  onPlan,
  onNewCharacter,
  page = false,
}: {
  synopsis: string | undefined;
  pov: string | undefined;
  when: string | undefined;
  goal: number;
  goalSource: ChapterGoalSource;
  characters: readonly { id: string; name: string }[];
  locked: boolean;
  onPlan: (changes: { synopsis?: string | null; pov?: string | null; when?: string | null; goal?: number | null }) => void;
  /** New character… (D-4): opens character creation and comes back to choose it. */
  onNewCharacter?: () => void;
  /** At the top of a new chapter's page (R-32) rather than in the Brief. */
  page?: boolean;
}) {
  return (
    <section className={page ? "fy-ch__props" : "fy-bible__panel fy-ch__brief"} data-testid={page ? "chapter-props" : "chapter-brief"}>
      {locked && !synopsis ? null : <label className="fy-ch__brief-field">
        <span>Synopsis</span>
        {locked ? (
          <p>{synopsis}</p>
        ) : (
          <EditableText
            value={synopsis ?? ""}
            placeholder="Synopsis"
            className="fy-sbsynopsis fy-ch__synopsis-clamp fy-ch__brief-synopsis"
            rows={3}
            maxLength={CHAPTER_PLAN_LIMITS.synopsis}
            onCommit={(next) => onPlan({ synopsis: next.trim() === "" ? null : next.trim() })}
          />
        )}
      </label>}
      <label className="fy-ch__brief-field">
        <span>Point of view</span>
        <select
          className="fy-ch__pick"
          aria-label="Point of view"
          value={pov ?? ""}
          disabled={locked}
          onChange={(e) => {
            // Controlled, the picker returns to the chosen point of view on its own.
            if (e.target.value === NEW_CHARACTER) {
              onNewCharacter?.();
              return;
            }
            onPlan({ pov: e.target.value === "" ? null : e.target.value });
          }}
        >
          <option value="">No point of view</option>
          {characters.map((sheet) => (
            <option key={sheet.id} value={sheet.id}>
              {sheet.name}
            </option>
          ))}
          {onNewCharacter !== undefined && <option value={NEW_CHARACTER}>New character…</option>}
        </select>
      </label>
      {locked && !when ? null : <label className="fy-ch__brief-field">
        <span>When</span>
        {locked ? (
          <p>{when}</p>
        ) : (
          <EditableText
            value={when ?? ""}
            placeholder="When"
            className="fy-ch__when"
            rows={1}
            maxLength={CHAPTER_PLAN_LIMITS.when}
            onCommit={(next) => onPlan({ when: next.trim() === "" ? null : next.trim() })}
          />
        )}
      </label>}
      <label className="fy-ch__brief-field">
        <span>Goal</span>
        <GoalField goal={goal} goalSource={goalSource} locked={locked} onPlan={onPlan} />
      </label>
    </section>
  );
}

/** The goal's own field (D-2): in the Brief, and in the compact plan below 1100. */
export function GoalField({ goal, goalSource, locked, onPlan }: {
  goal: number;
  goalSource: ChapterGoalSource;
  locked: boolean;
  onPlan: (changes: { goal?: number | null }) => void;
}) {
  return (
    <input
      type="number"
      className="fy-ch__goal-input"
      aria-label="Goal in words"
      title={GOAL_SOURCE[goalSource]}
      min={CHAPTER_GOAL_LIMITS.min}
      max={CHAPTER_GOAL_LIMITS.max}
      step={100}
      disabled={locked}
      // Keyed so a goal written from elsewhere replaces what the field holds.
      key={`${goal}:${goalSource}`}
      defaultValue={goal}
      onBlur={(e) => {
        const raw = e.currentTarget.value.trim();
        if (raw === "") {
          // Cleared, a chapter's own goal goes and the derived one returns; a derived goal
          // has nothing to clear, so the field shows it again rather than standing blank.
          if (goalSource === "chapter") onPlan({ goal: null });
          else e.currentTarget.value = String(goal);
          return;
        }
        const value = Math.round(Number(raw));
        if (!Number.isFinite(value) || value < CHAPTER_GOAL_LIMITS.min || value > CHAPTER_GOAL_LIMITS.max) {
          e.currentTarget.value = String(goal);
          return;
        }
        // Only a changed figure is written: tabbing through the field must not turn a derived
        // goal into one the chapter states.
        if (value !== goal) onPlan({ goal: value });
      }}
    />
  );
}

/**
 * Find (R-7, from ⋯ or Ctrl+F): a line under the bar with the query, `n of m`, and the way between
 * matches. Enter steps on, Shift+Enter back, Esc closes. The matches are the editor's to draw.
 */
export function FindBar({ query, count, current, opened, onQuery, onStep, onClose }: {
  query: string;
  count: number;
  current: number;
  /** Counts each time Find is asked for, so Ctrl+F on an open bar brings the field back. */
  opened: number;
  onQuery: (query: string) => void;
  onStep: (delta: 1 | -1) => void;
  onClose: () => void;
}) {
  const field = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, [opened]);
  return (
    <div className="fy-ch__find" role="search" aria-label="Find in chapter" data-testid="chapter-find">
      <Search size={14} />
      <input
        ref={field}
        type="search"
        className="fy-ch__find-input"
        aria-label="Find"
        placeholder="Find"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
      />
      <span className="fy-ch__find-count fy-mono" aria-live="polite">
        {query.trim() === "" ? "" : count === 0 ? "No matches" : `${current + 1} of ${count}`}
      </span>
      <button type="button" className="fy-ch__wbtn" aria-label="Previous match" disabled={count === 0} onClick={() => onStep(-1)}>
        <ChevronUp size={14} />
      </button>
      <button type="button" className="fy-ch__wbtn" aria-label="Next match" disabled={count === 0} onClick={() => onStep(1)}>
        <ChevronDown size={14} />
      </button>
      <button type="button" className="fy-ch__wbtn" aria-label="Close find" onClick={onClose}>
        <X size={14} />
      </button>
    </div>
  );
}

/**
 * Arke's change, decided on the page (SPEC-056 R-21, R-24, R-27): one held bar at the foot of the
 * page while a revision or a draft waits where it will land. It says what was asked, how much it
 * changes, and the two ways out: refuse it, or keep it (in part, when edits are refused one by one).
 */
export function PageHeldBar({ name, detail, versions, refuse, keep }: {
  name: string;
  detail: string;
  /**
   * Versions of a passage revision (R-25, D-6): which is shown of how many, the way between them,
   * and another asked for at the last, up to three. `note` is a version that failed, in one clause.
   */
  versions?: { at: number; count: number; max: number; asking: boolean; note?: string; onPrevious: () => void; onNext: () => void };
  refuse: { label: string; onPress: () => void; disabled?: boolean };
  keep: { label: string; onPress: () => void; blocked?: string };
}) {
  const last = versions !== undefined && versions.at === versions.count - 1;
  return (
    <div className="fy-pageheld" role="region" aria-label="Arke's change" data-testid="page-held-bar">
      <Sparkle size={14} />
      <strong>{name}</strong>
      <span className="fy-pageheld__detail">{detail}</span>
      {versions !== undefined && (
        <span className="fy-pageheld__versions" data-testid="page-held-versions">
          <button type="button" className="fy-ch__wbtn" aria-label="Previous version" disabled={versions.at === 0} onClick={versions.onPrevious}>
            <ChevronLeft size={14} />
          </button>
          <span className="fy-mono">{versions.asking ? "asking…" : `${versions.at + 1} of ${versions.count}`}</span>
          <button
            type="button"
            className="fy-ch__wbtn"
            aria-label={last ? "Another version" : "Next version"}
            title={last ? (versions.count >= versions.max ? `At most ${versions.max} versions` : "Another version") : undefined}
            disabled={versions.asking || (last && versions.count >= versions.max)}
            onClick={versions.onNext}
          >
            <ChevronRight size={14} />
          </button>
          {versions.note !== undefined && <span className="fy-pageheld__note">{versions.note}</span>}
        </span>
      )}
      <span className="fy-pageheld__push" />
      <button type="button" className="ui-btn ui-btn--ghost ui-btn--default" disabled={refuse.disabled} onClick={refuse.onPress}>{refuse.label}</button>
      <button type="button" className="ui-btn ui-btn--primary ui-btn--default" disabled={keep.blocked !== undefined} title={keep.blocked} onClick={keep.onPress}>
        {keep.blocked ?? keep.label}
      </button>
    </div>
  );
}
