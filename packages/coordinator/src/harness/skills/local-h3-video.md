# Writing for local H3 Reference Video

What the local H3 Reference Video route does with a prompt, learned making a film scene with it. Read this
before you write or change a shot's prompt for this route.

## 1 · It speaks what it can read

- **Any sentence a person could say aloud, it may have someone say.** On the film, a sentence describing
  what a man felt came out of his mouth as dialogue.
- **Quote only the line that is spoken**, word for word from the script. Write a feeling as what the face
  and body do: "he smiles and looks down at his glass". Never write a sentence of what someone feels or
  thinks, and never a line the script does not have, even as an example.

## 2 · It fills silence with talk

- **Where the clip runs past its line, it may invent more words**, with moving lips and a voice. Padding the
  line's audio with silence did not stop it, and neither does writing that nobody speaks.
- **Ask for a clip only a beat longer than its line**, or plan to cut the take where the line ends. A shot
  that must hold after its line cuts to someone listening.
- **Check before you accept a take.** Call `transcribe_audio` on the take after the line ends, and
  `sample_video` there with a region round the mouths. No words heard is not proof of silence; a mouth
  moving with no line is a failed take, not a detail.

## 3 · It completes what the reference hides

- **What the reference shows on one side, it may draw on both.** On the film, a man with a watch on one
  wrist came out with a watch on each, three takes in a row, the moment his other hand came into view.
  Writing that the other wrist was bare did not stop it, and neither did a start frame that showed that
  forearm.
- **Keep the other hand out of the shot.** Let the hand that wears the mark do everything. End the shot
  before the other hand would show, or move the action that needs it into a closer shot that cannot see it.
  Name the mark once: every "bare" and "no watch" is one more mention of a watch.
- **Look for a second one before you accept a take**, in the shadows too. On the film the second watch was
  small and dark, at the man's knee.

## 4 · It makes 24 frames a second

- Its clips run at 24 frames a second. In a Cut at 30 frames a second, movement in them judders a little.
  Say so when you place them. Redrawing does not fix it; only the Cut's own frame rate does, and that is
  the person's decision.
