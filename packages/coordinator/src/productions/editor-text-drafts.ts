import { TEXT_DRAFT_PNG_MAX, TEXT_TYPEFACES, TEXT_TYPEFACE_DATA_MAX, TEXT_TYPEFACE_IDS,
  type TextDraftAnswer, type TextDraftCommand, type TextDraftResult, type TextTypefaceBytes, type TextTypefacesCommand } from "@arke-studio/contracts";
import { readTextFaceFile } from "../media/text-typefaces.js";
import type { TransportRequester } from "../transport.js";
import { measureTextPicture, paintTextDraft, textPicturePng } from "./editor-text-pictures.js";

/**
 * Words being typed, drawn for the window typing them (SPEC-065 R-32, §2.3). A draft is the
 * painter with words not yet saved: the same checks, the same picture a commit would keep and the
 * same refusal in the same words, answered on the asking socket alone and kept nowhere once it is
 * sent. This class holds no store and no world. It writes no file, emits no event and logs no
 * line, so nothing a person types reaches a disk, another window or the change log until the field
 * commits and the timeline command writes it.
 *
 * A window asks on every pause in its typing, so the asks are bounded here as well as there. Each
 * window has a slot for a paint and one for a measure: an ask takes its kind's slot, and the ask it
 * displaces is answered `superseded` and never drawn, so no window waits on it and none can queue
 * work without end. One ask is drawn at a time, across every window in turn, each on its own turn
 * of the event loop, so other messages are handled between paints. A paint costs about 20 ms at the
 * Viewer's frame and a measure of fifty clips under 30 ms, which is why this runs on the loop and
 * not in a worker.
 */

type Requester = Pick<TransportRequester, "signal" | "textDraft" | "textTypefaces">;
/** A draft's PNG is shown once and replaced on the next pause, so it is deflated for speed (`encodePng`). */
const DRAFT_LEVEL = 3;

// Thrown by a bug rather than refused by a rule: said as plainly as the painter would say it, and
// never a reason to stop answering the rest.
const UNDRAWN: TextDraftResult = { ok: false, reason: "These words could not be drawn", field: "words" };

export class TextDrafts {
  /** Each window's waiting asks, oldest first, at most one of each kind. */
  private readonly waiting = new WeakMap<Requester, TextDraftCommand[]>();
  /** The windows with an ask waiting, in the order they will be served. */
  private readonly turns: Requester[] = [];
  private next: ReturnType<typeof setImmediate> | null = null;
  private stopped = false;
  private faces: TextTypefaceBytes[] | null = null;

  /**
   * `from` is where the fonts folder is looked for, as the painter reads it. `failed` hears that a
   * draft threw, and nothing else: not the words, the look or the error, whose message could carry
   * either.
   */
  constructor(private readonly options: { from?: string; failed?: () => void } = {}) {}

  ask(message: TextDraftCommand, requester: Requester): void {
    if (this.stopped || requester.signal.aborted) return;
    const queue = this.waiting.get(requester) ?? [];
    const displaced = queue.findIndex(held => held.ask.kind === message.ask.kind);
    if (displaced === -1) queue.push(message);
    else {
      // In the place of the one it displaces, so a window's paint is not sent behind its own measure.
      const [old] = queue.splice(displaced, 1, message);
      this.answer(requester, old!.requestId, { kind: "superseded" });
    }
    if (!this.waiting.has(requester)) { this.waiting.set(requester, queue); this.turns.push(requester); }
    this.schedule();
  }

  /** The Regular file of every face whose file is the one shipped, read and checked once (§2.5). */
  typefaces(message: TextTypefacesCommand, requester: Requester): void {
    if (this.stopped || requester.signal.aborted) return;
    this.faces ??= TEXT_TYPEFACE_IDS.flatMap(id => {
      const { file, sha256 } = TEXT_TYPEFACES[id].files.regular, read = readTextFaceFile(file, sha256, this.options.from);
      const data = read.ok ? read.bytes.toString("base64") : "";
      // A face that cannot be read is left out, and its name is drawn in the shell's face: the
      // painter refuses that face by name anyway.
      return read.ok && data.length <= TEXT_TYPEFACE_DATA_MAX ? [{ id, data }] : [];
    });
    try { requester.textTypefaces?.(message.requestId, this.faces); }
    catch { /* A window that cannot be answered is not this class's to fail over. */ }
  }

  /** Drops every waiting ask without drawing it. A stopped coordinator answers nobody. */
  stop(): void {
    this.stopped = true;
    if (this.next !== null) clearImmediate(this.next);
    this.next = null;
    this.turns.length = 0;
  }

  private schedule(): void {
    if (this.next !== null || this.stopped || !this.turns.length) return;
    this.next = setImmediate(() => { this.next = null; this.drawOne(); this.schedule(); });
  }

  private drawOne(): void {
    const requester = this.turns.shift();
    if (requester === undefined) return;
    const queue = this.waiting.get(requester) ?? [], message = queue.shift();
    if (queue.length) this.turns.push(requester); else this.waiting.delete(requester);
    // A window that closed while its ask waited is never drawn for: there is nobody to show it to.
    if (message === undefined || requester.signal.aborted) return;
    let answer: TextDraftAnswer;
    try { answer = this.drawn(message); }
    catch {
      answer = { kind: "drawn", results: message.ask.kind === "paint" ? [UNDRAWN] : message.ask.items.map(() => UNDRAWN) };
      this.options.failed?.();
    }
    this.answer(requester, message.requestId, answer);
  }

  private drawn({ frame, ask }: TextDraftCommand): TextDraftAnswer {
    const { width, height } = frame, { from } = this.options;
    if (ask.kind === "measure") {
      return { kind: "drawn", results: ask.items.map(({ text, look }): TextDraftResult => {
        const measured = measureTextPicture({ text, look, width, height }, from);
        return measured.ok ? { ok: true, drawnSize: measured.drawnSize } : measured;
      }) };
    }
    const painted = paintTextDraft({ text: ask.item.text, look: ask.item.look, width, height }, from);
    if (!painted.ok) return { kind: "drawn", results: [painted] };
    const png = Buffer.from(textPicturePng(painted, { level: DRAFT_LEVEL })).toString("base64");
    // A delivery frame of ink with nothing deflated still fits; a picture that somehow did not is
    // answered without one, and the Viewer goes on showing what it showed.
    return { kind: "drawn", results: [{ ok: true, drawnSize: painted.drawnSize }],
      ...(png.length <= TEXT_DRAFT_PNG_MAX ? { picture: { name: painted.name, png } } : {}) };
  }

  private answer(requester: Requester, requestId: string, answer: TextDraftAnswer): void {
    try { requester.textDraft?.(requestId, answer); }
    catch { /* As above: a reply that cannot be sent leaves the next ask to be drawn. */ }
  }
}
