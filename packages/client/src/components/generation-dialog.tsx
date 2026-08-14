import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";
import type { CharacterImageWorkflow, SizeTier } from "@arke-studio/contracts";
import { Button, Textarea } from "./ui.js";
import { DispatchBar } from "./dispatch-bar.js";
import { Portrait } from "./portrait.js";
import { Plus, X } from "./icons.js";

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
  worldSlug: string | undefined;
  /** A world-relative image staged for this generation, or null. The host stages it. */
  reference: string | null;
  referenceLabel?: string;
  referenceHint?: ReactNode;
  onAttachReference: () => void;
  onClearReference: () => void;
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
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const promptId = useId();

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
      className="fy-gendialog"
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

        <label className="fy-gendialog__label" htmlFor={promptId}>
          {promptLabel}
        </label>
        <Textarea
          id={promptId}
          className="fy-gendialog__prompt"
          value={prompt}
          rows={6}
          onChange={(event) => onPrompt(event.target.value)}
        />
        {promptHint && <p className="fy-gendialog__hint">{promptHint}</p>}

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

        {/* Who makes it, how big, and what shape — with the estimate following all three, since
            a per-megapixel row is billed by area and 16:9 and 1:1 are not the same money. */}
        <DispatchBar
          variant="controls"
          size={size}
          aspect={aspect}
          {...(landscape !== undefined ? { landscape } : {})}
          capability={capability}
          workflow={workflow}
          referenceImages={reference === null ? 0 : 1}
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
            disabled={submitDisabled || prompt.trim().length === 0}
            onClick={onSubmit}
          >
            {submitLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
