# Sound and pace in the cut

How a picture editor and a sound mixer finish a scene's cut. Read this before you change the Cut's music,
mix or effects, or where a clip starts and ends, and before you show anyone a cut or an export.

## 1 · Music the room plays

- **Music playing in the place itself is part of the room**: a club, a party, a car radio. Keep it under the
  whole scene, from the first frame to the last, at one low level: about 8 to 10 LU under the voices. On the
  film, the voices sat about -20 LUFS and the club's music about -29.
- **Turn ducking off for it.** Ducking drops the music under each line and lifts it between lines, so the
  room seems to breathe in and out. Set the mix's ducking to 0 dB and lower the music clip's own gain
  instead. Ducking is set for the whole Cut: if score elsewhere needs it, say so and ask.
- **Fade it only where the scene starts and ends**, over about a second.
- **Score is different.** Music the people cannot hear may duck under speech; music the room plays does not.

## 2 · No mouth moves without a line

- **A mouth moving with no line heard is the first thing a viewer notices.** Never leave one in the cut.
- If a take keeps talking after its line, cut it where the line ends, or use another take. If the picture
  must run on, cut to someone listening.
- **If a take starts talking before its line, start the line there.** A wide that opens a conversation may show
  a mouth moving before the first line. Rather than cutting the wide to a flash, start the line under the wide
  where the mouth starts, and cut into the close shot in the middle of the sentence. Start the close shot's
  picture that much later into its take, so its lips stay on the words.
- Look for it at the end of every shot with a line: `sample_video` on the last second, with a region round
  the mouths.

## 3 · How long a shot holds

- **An insert lasts about a second**: a hand, a card machine, a glass, a phone. Long enough to read what it
  shows, then back to the people. Two seconds is the most, and only when the thing shown changes.
- **A shot holds while it is telling something.** Cut out when its beat has landed: the line said and
  answered, the look given, the movement finished. A shot that runs on after that is where a scene slows.

## 4 · Split the cuts in a conversation

A line need not stop at its own cut. The voice sits on its own track: trim the picture, never the line.

- **Run the last words over the listener.** Cut to the person hearing a line on its last two or three
  words, so their face takes it in (an L-cut). Leave at least a quarter of a second before they answer.
- **Start an interruption under the shot before.** When someone cuts in, or a line is about the person on
  screen, start it under that picture and cut to the speaker mid-sentence (a J-cut). Start the speaker's
  picture that much later into its take, so its lips stay on the words.
- **Cut the waiting.** A generated take holds a second or more before its line and after it. Trim both to
  the beat the moment needs. A pause before a deadpan answer is a choice; a model's run-up is not.
- **Cut straight on the beats that land**: a punchline, a name, a look held a beat too long.

On the film (2026-11-25), no line crossed a cut. Every shot waited 0.5 to 1.7 s before its line and up to 2.4 s
after it, and the scene played as stitched. Splitting the cuts and trimming the waits took about 20 s out of
each two-minute part, and no line was lost.

## 5 · One room under every take

- **Each take makes its own room tone, and it changes at every cut.** Lay one room tone for each place
  under the whole of it: the club, the car, the house.
- **Keep a take's own sound only for what it does well**: its voice, and an action sound that lands on its
  action and stands clear of its room by about 10 dB. Gate the rest of it away, so the shared room runs
  beneath.
- **Lay an effect where the take's own sound is faint or off its action.** Place it by its peak on the
  frame where the thing happens. Find that frame in the pictures, not in the sound.
- **Measure a made room tone before you use it.** One came back silent, and one made for a club can carry
  words: check its level and transcribe it.

## 6 · A laid line sits on the take's voice

- **When a take speaks the line in its own reading** and the recorded line is laid instead, place the
  recording by the take's voice, not by where it was sent. The lips follow the take's voice. Compare the
  two with `transcribe_audio` word times. On the film, five such lines sat 60 to 120 ms off, and one
  drifted.
- **Check the sync at the end of a cut as well as at its start.** Drift adds up cut by cut: a picture one
  frame short at each cut put the voices 0.7 s off the lips by the end of a two-minute part.

## 7 · Watch and listen before you show it

A cut is not ready because it was built. Play it through and check it before anyone else sees it.

- **Hear every line where it belongs.** Transcribe the finished film with word times (`transcribe_audio` on
  the export, a minute at a time) and set it beside the script, shot by shot. Every line must be heard once,
  in the script's order, inside the shot whose mouth says it, and nothing the script does not say. A line
  heard in the wrong shot, or twice, means a sound has lost its place in the mix.
- **Look at the mouths while the lines play.** `sample_video` with a region round the mouth, at each line's
  words and in the silences between them. A mouth that moves with nothing heard and a line heard over a shut
  mouth are the same fault.
- **Measure the room shot by shot.** The quiet between lines should stay within about 3 dB from shot to shot.
  A song that reaches its own ending, or a bed that stops, drops the room under the talk. Bring the next song
  in under the ending, as the DJ would.
- **Make each version from the last one that was shown and accepted.** Every note already given then stays
  done. Before you show a new version, check the notes that earlier versions answered.

On the film (2026-11-26), a cut of shots 9 to 20 was built from an older list than the last one shown. It lost
the club's room tone, the gated takes and the effects the owner had asked for the day before. Three sounds also
lost their place: shots 19 and 20 moved their mouths in silence while their lines played over shot 9. The owner
heard it first: "Watch and listen to this before sending this to me."
