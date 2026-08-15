import { useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import type { CharacterImageWorkflow, SizeTier } from "@arke-studio/contracts";
import { Button, Textarea } from "./ui.js";
import { DispatchBar } from "./dispatch-bar.js";
import { Loading } from "./loading.js";
import { Portrait } from "./portrait.js";
import { Plus, X } from "./icons.js";

/**
 * The words to send, or nothing at all — the box read back unchanged is an absence, not a value.
 *
 * Every surface here opens its prompt as something the app composed: the look's own description,
 * the character sheet's inherited direction, the key-art brief. "Nobody overrode this" is then a
 * real state, and it has to travel as an absence, because the coordinator reads a present prompt
 * as "the author has decided" and stops composing or rewriting one of its own. Send the box back
 * unedited and every generation whose dialog was merely opened and closed would silently lose
 * that — identical from this end, opposite at the other (design 64).
 */
export function authoredPrompt(box: string, composed: string): string | undefined {
  return box.trim() === composed.trim() ? undefined : box;
}

/** One thing that came back and can be chosen: a take, an upload, a candidate on the disk. */
export interface GenerationPreview {
  /** Stable across renders and unique within the set — the selection is by key, not by index. */
  key: string;
  /** World-relative path to the image. */
  path: string;
  /** What it is, for the button's accessible name. Falls back to its position in the set. */
  label?: string;
}

/**
 * The one shape an image generation is asked for in: say it, show it something, pick who makes it.
 *
 * Every surface that generates a picture had grown its own arrangement of the same three
 * decisions — a button whose prompt was invisible, a model bar somewhere down the page, and no way
 * at all to hand the model a picture — and the differences between them were accidents of which
 * screen was written first rather than anything about the work. This is that agreement written
 * once, so a generation asked for on the art-direction page and one asked for anywhere else are
 * the same gesture.
 *
 * A native <dialog> with showModal(), for the same reasons ImageDialog uses one: the focus trap,
 * Esc, and background inerting arrive with it rather than being re-implemented per screen. Two
 * behaviours are deliberate and easy to lose — focus returns to whatever opened it, and a click
 * landing on the dialog rather than on its panel is a backdrop click and dismisses.
 *
 * The host owns the words and the model choice. This component owns only the arrangement: it
 * never sends anything, so a screen that has to phrase its request differently still gets to.
 */
export function GenerationDialog({
  open,
  onClose,
  title,
  lede,
  prompt,
  onPrompt,
  promptLabel = "Prompt",
  promptHint,
  promptPlaceholder,
  onResetPrompt,
  resetTitle,
  promptOptional = false,
  extra,
  referenceImages,
  worldSlug,
  reference,
  referenceLabel = "Reference image",
  referenceHint,
  onAttachReference,
  onClearReference,
  workflow,
  capability = "image",
  size = true,
  aspect = true,
  landscape,
  choice,
  onChoice,
  submitLabel,
  onSubmit,
  submitDisabled = false,
  why,
  returnFocus,
  count,
  onCount,
  previews,
  generating = false,
  waitingHint,
  selected = null,
  onSelect,
  commit,
}: {
  open: boolean;
  /** Called for every way out — Esc, the backdrop, Cancel, and a submit that went through. */
  onClose: () => void;
  title: string;
  /** One line under the title saying what this generation is for. */
  lede?: ReactNode;
  prompt: string;
  onPrompt: (value: string) => void;
  promptLabel?: string;
  /** What the app will do to these words before they are sent, said rather than left to trust. */
  promptHint?: ReactNode;
  /** Shown in an empty box — only useful where empty is a state the surface allows. */
  promptPlaceholder?: string;
  /**
   * Put the box back to what the surface composes. Drawn on the prompt when given, because the
   * words open as something derived and an author who has edited them past use needs the way
   * back — retyping a composed prompt from memory is not one.
   */
  onResetPrompt?: () => void;
  /** What the reset control says it will do, on hover. */
  resetTitle?: string;
  /**
   * Whether an empty box is a submittable state (design 66).
   *
   * Off by default, because on most surfaces the prompt **is** the brief and "an empty brief is
   * not a brief" (design 62a). A location view is the case that is genuinely different: the brief
   * is composed from the sheet, its look and the angle's name, and this box only *adds* a camera
   * position to it — so refusing an empty one would demand a sentence nobody needs to write.
   */
  promptOptional?: boolean;
  /**
   * How many references this generation will actually carry, when the host tracks that itself.
   * Overrides the count derived from the dialog's own reference row, because a surface with its
   * own reference controls knows what is riding and the row does not.
   */
  referenceImages?: number;
  /**
   * Surface-specific controls that decide **what travels** with this generation — which
   * references ride along, and what is dropped because the chosen model cannot take them.
   *
   * Deliberately narrow. It is not a second arrangement of the three decisions: the words, the
   * model, the size and the count all stay where they are on every surface, and a host that
   * wants its own version of those has re-created the problem this component was written for.
   */
  extra?: ReactNode;
  worldSlug: string | undefined;
  /**
   * A world-relative image staged for this generation, or null. The host stages it.
   *
   * Undefined is a third state and not the same as null: null is "nothing attached yet, attach
   * one", undefined is "this surface has no way to attach one", and the row is not drawn at all.
   */
  reference?: string | null;
  referenceLabel?: string;
  referenceHint?: ReactNode;
  onAttachReference?: () => void;
  onClearReference?: () => void;
  /** Which kind of work this is, for the estimate the bar shows. */
  workflow: CharacterImageWorkflow;
  capability?: "image" | "video";
  /**
   * Whether size and shape are the author's to choose. Both default on, because this dialog is
   * for surfaces where the picture *is* the deliverable; a host whose request carries no output
   * spec turns them off rather than drawing a control nothing reads.
   */
  size?: boolean;
  aspect?: boolean;
  /** Which way round this surface's output is, where the workflow's own orientation is not it. */
  landscape?: boolean;
  choice: { modelId?: string; tier?: SizeTier; resolution?: string };
  onChoice: (choice: { modelId?: string; tier?: SizeTier; resolution?: string }) => void;
  submitLabel: string;
  onSubmit: () => void;
  submitDisabled?: boolean;
  /** Why it cannot run, when it cannot. A disabled button with no reason reads as broken. */
  why?: ReactNode;
  /** The control that opened this, so the keyboard is put back where it was. */
  returnFocus?: RefObject<HTMLElement | null>;
  /**
   * How many previews to make, 1–`MAX_IMAGE_PREVIEWS`. Both or neither: a count with no way to
   * change it is a number nobody chose, and a setter with no value has nothing to set.
   */
  count?: number;
  onCount?: (count: number) => void;
  /**
   * What has come back and is waiting to be chosen between (design 65).
   *
   * Undefined means this surface has no previews to show and the dialog stays one column — the
   * shape it had before, which is still right for a generation whose result is answered somewhere
   * else. An empty array is a surface that *will* show previews and has none yet, which is a
   * different thing and gets the waiting state.
   */
  previews?: readonly GenerationPreview[];
  /** Something is in flight. Drives the column's own status, not the submit button's. */
  generating?: boolean;
  /** What the column says with nothing in it and nothing running. */
  waitingHint?: ReactNode;
  selected?: string | null;
  onSelect?: (key: string) => void;
  /**
   * What accepting a preview does, and what to say about it. Absent leaves the column a gallery:
   * some surfaces commit elsewhere, and a button that claims to finish the job would be lying.
   */
  commit?: {
    label: string;
    onCommit: () => void;
    disabled?: boolean;
    /** One line under the previews — the consequence, or the reason it just failed. */
    note?: ReactNode;
    /**
     * The other answer, where saying no is a decision rather than an absence — rejecting a take,
     * throwing a set away. It sits beside the primary as a quiet button rather than hiding in the
     * note, because a person who does not want what came back has to answer as deliberately as
     * one who does; a link inside a sentence is not that.
     */
    secondary?: { label: string; onAction: () => void; disabled?: boolean };
  };
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const promptId = useId();
  /*
   * The press itself, said back immediately.
   *
   * Between the click and the first job event there is a round trip — the request is sent, the
   * coordinator resolves a model, prices it and enqueues — and for all of it the button sat
   * unchanged. Somebody who has just spent money on four images and seen nothing happen presses
   * it again, which is the one outcome worth engineering against. Cleared when the host says
   * something is running, and on a timeout as the backstop for a request refused without a job.
   */
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    if (generating) setPressed(false);
  }, [generating]);
  useEffect(() => {
    if (!pressed) return;
    const timer = setTimeout(() => setPressed(false), 20_000);
    return () => clearTimeout(timer);
  }, [pressed]);
  // A dialog reopened after an answer must not still be mid-press from the last one.
  useEffect(() => {
    if (!open) setPressed(false);
  }, [open]);

  /*
   * showModal() is imperative, and the parent's `open` is the truth.
   *
   * Calling it on an already-open dialog throws, and close() on a closed one is a no-op that
   * still fires nothing — so both are guarded on the element's own state rather than on a flag
   * of ours that could drift from it.
   */
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) node.showModal();
    if (!open && node.open) node.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      className={previews === undefined ? "fy-gendialog" : "fy-gendialog fy-gendialog--wide"}
      aria-labelledby={titleId}
      onClose={() => {
        returnFocus?.current?.focus();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.current?.close();
      }}
    >
      <div className="fy-gendialog__panel">
        <div className="fy-gendialog__head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {lede && <p className="fy-gendialog__lede">{lede}</p>}
          </div>
          <button
            type="button"
            className="fy-gendialog__close"
            aria-label={`Close ${title.toLowerCase()}`}
            onClick={() => dialog.current?.close()}
          >
            <X size={18} />
          </button>
        </div>

        <div className="fy-gendialog__columns">
        <div className="fy-gendialog__compose">
        <label className="fy-gendialog__label" htmlFor={promptId}>
          {promptLabel}
        </label>
        <div className="fy-gendialog__promptbox">
          <Textarea
            id={promptId}
            className="fy-gendialog__prompt"
            value={prompt}
            rows={6}
            {...(promptPlaceholder !== undefined ? { placeholder: promptPlaceholder } : {})}
            onChange={(event) => onPrompt(event.target.value)}
          />
          {onResetPrompt && (
            <button
              type="button"
              className="fy-gendialog__reset"
              {...(resetTitle !== undefined ? { title: resetTitle } : {})}
              onClick={onResetPrompt}
            >
              Reset
            </button>
          )}
        </div>
        {promptHint && <p className="fy-gendialog__hint">{promptHint}</p>}
        {extra}

        {/*
          Omitted entirely where the surface has nowhere to stage one (design 64), rather than
          drawn as a slot that opens a picker whose result has no home. The estimate below reads
          the same absence, so a dialog with no reference row prices no reference image.
        */}
        {reference !== undefined && (
          <>
            <div className="fy-gendialog__label">{referenceLabel}</div>
            <div className="fy-gendialog__reference">
              {reference === null ? (
                <button type="button" className="fy-gendialog__slot" onClick={onAttachReference}>
                  <Plus size={16} />
                  <span>Add a reference image</span>
                </button>
              ) : (
                <div className="fy-gendialog__attached">
                  <span className="fy-gendialog__thumb">
                    <Portrait worldSlug={worldSlug} path={reference} label="Reference image" radius={7} />
                  </span>
                  <button type="button" className="fy-gendialog__remove" onClick={onClearReference}>
                    Remove
                  </button>
                </div>
              )}
              {referenceHint && <p className="fy-gendialog__hint">{referenceHint}</p>}
            </div>
          </>
        )}

        {/* Who makes it, how big, and what shape — with the estimate following all three, since
            a per-megapixel row is billed by area and 16:9 and 1:1 are not the same money. */}
        <DispatchBar
          variant="controls"
          size={size}
          aspect={aspect}
          {...(landscape !== undefined ? { landscape } : {})}
          capability={capability}
          workflow={workflow}
          referenceImages={referenceImages ?? (reference === null || reference === undefined ? 0 : 1)}
          {...(count !== undefined && onCount ? { count, onCount } : {})}
          choice={choice}
          onChoice={onChoice}
        />

        {why && <p className="fy-gendialog__why">{why}</p>}
        <div className="fy-gendialog__actions">
          <Button variant="ghost" onClick={() => dialog.current?.close()}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={pressed || generating || submitDisabled || (!promptOptional && prompt.trim().length === 0)}
            onClick={() => {
              setPressed(true);
              onSubmit();
            }}
          >
            {/*
              Two windows, one label. `pressed` covers the round trip before any job exists;
              `generating` covers the run once the host can see it. Saying nothing during the
              first was the complaint — the button sat unchanged while the money was already
              being spent — and reverting to "Generate" the moment the job appeared would have
              swapped one silence for another.
            */}
            {pressed || generating ? "Generating…" : submitLabel}
          </Button>
        </div>
        </div>

        {previews !== undefined && (
          <section className="fy-gendialog__previews" aria-label="Previews">
            <header className="fy-gendialog__previews-head">
              <span>PREVIEWS</span>
              <strong>{generating ? "generating" : previews.length > 0 ? "ready" : "waiting"}</strong>
            </header>
            {/*
              Three states, and the middle one is the one worth being careful about. Something in
              flight with nothing back yet is not "waiting" — the money is already being spent,
              and saying "ready when you are" to somebody who just pressed Generate is the exact
              complaint the main-photo panel was built to answer.
            */}
            {previews.length === 0 && generating ? (
              <div className="fy-gendialog__previews-empty">
                <Loading label="Generating" size={40} />
                <span>You can close this. Previews land here and in Activity.</span>
              </div>
            ) : previews.length === 0 ? (
              <div className="fy-gendialog__previews-empty">
                <strong>Nothing yet</strong>
                {waitingHint && <span>{waitingHint}</span>}
              </div>
            ) : (
              <div className="fy-gendialog__previews-grid">
                {previews.map((preview, index) => (
                  <button
                    type="button"
                    key={preview.key}
                    className={selected === preview.key ? "is-selected" : ""}
                    aria-pressed={selected === preview.key}
                    aria-label={preview.label ?? `Preview ${index + 1}`}
                    onClick={() => onSelect?.(preview.key)}
                  >
                    <Portrait
                      worldSlug={worldSlug}
                      path={preview.path}
                      label={preview.label ?? `Preview ${index + 1}`}
                      radius={10}
                    />
                    <span>{selected === preview.key ? "SELECTED" : `0${index + 1}`}</span>
                  </button>
                ))}
              </div>
            )}
            {commit && (
              <div className="fy-gendialog__commit">
                {commit.note && <span>{commit.note}</span>}
                {commit.secondary && (
                  <Button
                    variant="ghost"
                    disabled={commit.secondary.disabled === true}
                    onClick={commit.secondary.onAction}
                  >
                    {commit.secondary.label}
                  </Button>
                )}
                <Button
                  variant="primary"
                  disabled={commit.disabled === true || selected === null}
                  onClick={commit.onCommit}
                >
                  {commit.label}
                </Button>
              </div>
            )}
          </section>
        )}
        </div>
      </div>
    </dialog>
  );
}
