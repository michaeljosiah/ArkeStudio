# Writing for local H3 Reference Video

What the local H3 Reference Video route does with a prompt, learned making a film scene with it, and where its
first-frame sibling, Local · H3 Video, differs (section 5), and which to use when someone comes into the shot
(section 6). Read this before you write or change a shot's prompt for either route.

## 1 · It speaks what it can read

- **Any sentence a person could say aloud, it may have someone say.** On the film, a sentence describing
  what a man felt came out of his mouth as dialogue.
- **Quote only the line that is spoken**, word for word from the script. Write a feeling as what the face
  and body do: "he smiles and looks down at his glass". Never write a sentence of what someone feels or
  thinks, and never a line the script does not have, even as an example.
- **Quote the line whole in a shot that speaks.** A voice line riding is not enough. On the film, a shot whose
  words only said how a man delivered his line ("with total seriousness") gave him words of its own over the
  voice line, with his lips on them. With the line quoted whole, the same shot spoke it on the voice line's
  own timing.

## 2 · It fills silence with talk

- **Where the clip runs past its line, it may invent more words**, with moving lips and a voice. Padding the
  line's audio with silence did not stop it, and neither does writing that nobody speaks.
- **Ask for a clip only a beat longer than its line**, or plan to cut the take where the line ends. A shot
  that must hold after its line cuts to someone listening.
- **Check before you accept a take.** Call `transcribe_audio` on the take after the line ends, and
  `sample_video` there with a region round the mouths. No words heard is not proof of silence; a mouth
  moving with no line is a failed take, not a detail.
- **It says the line again, in its own way.** It does not play the voice you give it: it speaks the line
  anew in that voice, and can get the words wrong. On the film, "I am enjoying the company" came out as
  "I am in drunk-guide". Read the words `transcribe_audio` gives for the line itself, not only whether
  speech is there. When the words are wrong but the mouth keeps the line's timing, play the shot's own
  voice line under the picture in the Cut instead of the take's sound.
- **It keeps the voice line's timing, its silences too.** So a beat inside a line with no words in it, a face
  pulled or a look, is made by cutting that silence into the voice line before the clip is made. On the film a
  pause of 1.25 seconds after "like this" gave a man a second of a goat's face, his mouth shut, before the
  rest of the line. It may make a small sound in that silence: play the voice line under the picture.
- **Its sound may carry music.** On the film, a take for a lull between songs had the club's drum under it.
  Before you play a take's own sound, listen for music and for talk; play another take's room if it has either.

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

## 5 · The first-frame route, Local · H3 Video

- **It opens on the shot's start frame, exactly.** The reference route draws an opening that only looks like
  its pictures. So a shot that must open in the pose the last shot ends on, seen from a new angle, is made
  here: draw its start frame in that pose, then make the clip from it. On the film, a man folded over the table
  at the end of one shot opened the next, from behind his friend, in the same fold.
- **It takes 2,000 characters at most**; the reference route takes 8,000. A clip made from a shot's page sends
  the shot's wording as its prompt, so keep a shot meant for this route under 2,000 characters, or it cannot be
  sent until someone cuts it. On the film two shots ran over, at 2,007 and 2,561.
- **It can hold the frame a moment before anything moves**: about three quarters of a second on one shot of the
  film, none on another, where a hand already moving in the frame carried straight on. Look where the movement
  begins, and start the clip in the Cut just before it, so the cut falls on it.

## 6 · People who come into the shot

- **Someone who is not in the start frame comes out a stranger on the first-frame route.** Only the frame rides,
  so a person who enters later is drawn from the words alone. On the film a woman who crosses behind a man came
  out in another dress, with another build.
- **So does a face the start frame hides.** A man folded over a table, face down in the frame, lifted his head
  into a stranger's face: rounder, a fuller beard, no grey. The same route had drawn him well once, by luck.
  When a face turns or rises into view, make the shot on the reference route.
- **Make such a shot on the reference route**, where that person's own picture rides with the shot's start frame
  and the others. It opens near the start frame, not on it: on the film once close enough to hold a matched cut,
  the glass in the same hand at the same height, and once it lost the glass the frame showed. Compare its first
  frames with the end of the shot before, as you would any cut.
- **On the reference route a person crossing a medium shot may walk through the foreground**, between the camera
  and the table, instead of behind the one you are on. On the film, a shot a step closer, where the only open
  floor was behind his shoulder, kept her there.
- **When the opening and the entrance pull different ways, split the shot.** End the first where it still
  holds, before anyone comes in, and give the entrance a closer shot of its own on the reference route. The
  step in size makes it read as the camera moving in, not a jump.
- **Draw the start frame of an entrance shot before the person is in it.** A frame drawn from wording that
  says someone crosses "within the first second" may show them already there, walking away.
