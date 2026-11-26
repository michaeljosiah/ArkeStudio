# Sound and pace in the cut

How a picture editor and a sound mixer finish a scene's cut. Read this before you change the Cut's music,
mix or effects, or where a clip starts and ends, and before you show anyone a cut or an export.

## 1 · Music the room plays

- **Music playing in the place itself is part of the room**: a club, a party, a car radio. Keep it under the
  whole scene, from the first frame to the last, at one low level: about 8 to 10 LU under the voices, for
  example voices about -20 LUFS and the room's music about -29.
- **Turn ducking off for it, on its own track.** Ducking drops the music under each line and lifts it
  between lines, so the room seems to breathe in and out. Put the room's music on a track of its own and
  set that track to hold under speech (`set-track` with `ducks` false). Set its level once on the track
  (`levelDb`), not clip by clip.
- **Fade it only where the scene starts and ends**, over about a second.
- **Cross one piece into the next at even power.** Where one piece of the room's music ends and the next
  begins, overlap them by about a second and give both fades the even-power shape (`sound-fade` with
  `power` true). Two straight fades dip in the middle of the join; these hold one level through it.
- **Score is different.** Music the people cannot hear may duck under speech, on a track of its own that
  still does; music the room plays does not.

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

A conversation cut with no line crossing a cut, and every take's run-up and tail left in, plays as stitched.
Splitting the cuts and trimming the waits can take a sixth out of a scene without losing a line.

## 5 · One room under every take

- **Each take makes its own room tone, and it changes at every cut.** Lay one room tone for each place
  under the whole of it.
- **Keep a take's own sound only for what it does well**: its voice, and an action sound that lands on its
  action and stands clear of its room by about 10 dB. Gate the rest of it away, so the shared room runs
  beneath: detach the take's audio, then `sound-gate` on that sound clip. The gate is measured from the
  clip's own sound, and its card says how many stretches it keeps. Check the words after it, as section 7
  says: a take that talks from its first frame to its last leaves a gate little room to find.
- **Set every line to one loudness.** `match-loudness` on each voice clip, about -20 LUFS. It measures the
  stretch the clip plays as the cut's mix plays it, so a recording in one channel and a take's own sound
  in two land at the same level, where their files' own figures sit 3 LU apart.
- **Lay an effect where the take's own sound is faint or off its action.** Place it by its peak on the
  frame where the thing happens. Find that frame in the pictures, not in the sound.
- **Measure a made room tone before you use it.** One can come back silent, and one made for a crowd can
  carry words: check its level and transcribe it.
- **Never let a room tone repeat.** A looped room tone brings back every laugh and every glass on the same
  beat, and the ear finds it within a minute. Make several takes of the place's sound, from different
  corners and distances, and lay the room from them with `lay-room`. It cuts them into pieces of a few
  seconds and lays them end to end, each crossing into the next over about a second,
  each piece used once in the scene while another is unused. Four tracks lay a second row under the
  first, a few seconds apart and a little quieter, for a fuller room. Give it about as many seconds of
  bed as the scene is long for each row; with less, pieces come round again.

## 6 · A laid line sits on the take's voice

- **When a take speaks the line in its own reading** and the recorded line is laid instead, place the
  recording by the take's voice, not by where it was sent. The lips follow the take's voice. Compare the
  two with `transcribe_audio` word times; they can sit a tenth of a second apart, and drift.
- **Check that the take says every word you lay over it.** Set the take's own words beside the laid line's.
  A take can stop speaking before its line ends: break into a laugh, take a sip, look away. The words it
  never said then play over a mouth that is not saying them. Cut to the listener for those words (an
  L-cut), and keep the speaker's face only while their mouth says the line.
- **Check the sync at the end of a cut as well as at its start.** Drift adds up cut by cut: a picture one
  frame short at each cut puts the voices most of a second off the lips by the end of a two-minute scene.

## 7 · Watch and listen before you show it

A cut is not ready because it was built. Play it through and check it before anyone else sees it.

- **Hear every line where it belongs.** Call `review_export` on the finished cut. It reads the words in it and
  sets them beside its lines: its findings name a line that is not heard, one barely or partly heard, one heard
  out of its place or under another shot than its own, a name to listen to, and words nobody wrote. For a
  film that was cut outside the Studio, name the scene it was cut from in `script`. Every line must be heard
  once, in the script's order, and nothing the script does not say. Each line plays in the shot of the person who
  says it, or runs over the next shot or the one before where you split that cut on purpose (section 4).
  A line heard anywhere else, or twice, means a sound has lost its place in the mix. Recognised words can be
  misheard, names most of all: listen to whatever a finding names (`transcribe_audio` on that stretch) before
  you call it a fault.
- **Look at the mouths while the lines play.** `sample_video` with a region round the mouth, at each line's
  words and in the silences between them, wherever the speaker's own face is on screen. A speaker's mouth
  that moves with nothing heard, and the speaker's own shut or laughing mouth on screen while their words
  play, are the same fault. A listener's still face under the end of a split line is not.
- **Measure the room shot by shot.** The quiet between lines should stay within about 3 dB from shot to shot.
  `review_export` names a shot whose room drops. A song that reaches its own ending, or a bed that stops,
  drops the room under the talk. Bring the next piece of the room's music in under the ending.
- **Make each version from the last one that was shown and accepted.** Every note already given then stays
  done. Before you show a new version, check the notes that earlier versions answered.
- **Fix what you find in the edit first**: trim, move a cut, cut to the listener, or use another take's part
  (the continuity skill's section 6). Make a take again only when no cut can hide the fault.

A cut built from an older version can quietly lose notes already answered: its room tone, gated takes and
effects. A sound that loses its place in the mix can play a line over the wrong shot while the right shot's
mouth moves in silence. Both are found only by watching and listening to the whole cut.
