/**
 * What can be asked of a selected passage, in one list for the two places that ask it: the menu
 * beside the selection and the dock's quick asks. Two lists would drift — the dock would offer a
 * wording the menu had moved past — and the line is what the thread hears, so it has to be one.
 *
 * Each line is said after the dock's subject prefix (`About this passage in chapter 03,
 * paragraph 2: «…»`), so it reads as the second half of that sentence. A revision comes back as
 * one passage change (turn 128), whose replacement the action schema caps at 2,400 characters —
 * twice the most a selection holds — so Expand asks for at most twice the length rather than
 * leaving the model to find the cap by being refused.
 */
export type PassageAction = {
  id: string;
  label: string;
  line: string;
  /** A reply and nothing else: the send says so and the coordinator refuses any action. */
  replyOnly?: boolean;
  /** Only starts the line in the composer, for the author to finish. */
  draft?: boolean;
};

export const PASSAGE_ACTIONS: readonly PassageAction[] = [
  { id: "tighten", label: "Tighten", line: "Tighten this" },
  { id: "expand", label: "Expand", line: "Expand this with more detail and texture, at most twice its length" },
  { id: "simplify", label: "Simplify", line: "Make this plainer and easier to read, keeping what it says" },
  { id: "vivid", label: "Make it vivid", line: "Make this more concrete and sensory, at about the same length" },
  { id: "tone", label: "Change tone…", line: "Make this ", draft: true },
  { id: "style", label: "Check against style", line: "Hold this against the style", replyOnly: true },
  { id: "critique", label: "Critique", line: "What works here and what does not? Quote the words you mean.", replyOnly: true },
  { id: "other", label: "Ask something else…", line: "", draft: true },
];

/** The actions that suit a chapter: without a prose style there is nothing to hold it against. */
export function passageActions(hasStyle: boolean): readonly PassageAction[] {
  return PASSAGE_ACTIONS.filter((action) => action.id !== "style" || hasStyle);
}

export function passageAction(id: string): PassageAction | undefined {
  return PASSAGE_ACTIONS.find((action) => action.id === id);
}
