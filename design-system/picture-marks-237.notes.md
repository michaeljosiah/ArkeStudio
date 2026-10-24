# Turn 237 · Picture marks

Drawn on 24 October 2026 for the owner's review. Not built.

## Asked

A listener asked for many more pictures: seeing more of the story while hearing it. Grouping blocks
into beats (SPEC-047 R-172) made the narration smooth, one take a beat. But a picture can only start
where a block does, so a beat of two minutes shows one picture throughout, and it stops matching the
words. The owner weighed three answers:

1. a second set of blocks for pictures;
2. more pictures per block, composed in the Audio Studio;
3. pictures set on the words.

They chose the third ("Lets go with your recommendations").

## What was checked before drawing

- **Chapter 1 of Na Love or Juju, as it stands.**
  - 26 blocks in 24 beats, 20:28 of narration, 15 pictures.
  - Pictures start at 0:03, 2:05, 3:18, 4:34, 6:23, 7:36, 8:26, 9:32, 10:59, 12:41, 14:42, 15:27,
    16:31, 18:08 and 19:41.
  - The first beat, The goat story, runs 2:12 under one picture.
  - That picture is Tunde pulling the goat face. He pulls it 34 seconds into the take, but the
    picture shows from 0:03, the block's start. The sample in 237a is this beat.
- **The pace is a constant.**
  - `PICTURE_PACE_SEC = 90` (191b) caps a chapter at about one picture every minute and a half.
  - `PICTURE_PROPOSAL_GAP_SEC` and `PICTURE_MIN_HOLD_SEC` hold a picture at least 20 s.
  - Chapter 1's 15 pictures over 20:28 is that pace exactly.
  - So one beat per picture is half of the problem; the 90 s pace is the other half.
- **Pictures are keyed by block.** The chapter record keeps `pictures: Record<blockKey, AudiobookPicture>`,
  and placement keeps one picture per block ("two pictures on one block keep the one set there").
  Joining a block with a picture under another asks "Block N's picture comes off" (198d).
- **The Player is already timed by the clock.**
  - Arke Player's listening document gives each picture an `at` in milliseconds and an optional
    `hold`.
  - The Studio's export works `at` out from the block's start.
  - A picture inside a take is one more entry. No new key, no Player change, no SPEC-058 change.
- **Word timing exists.** `prepareAudiobookWordTiming` gets validated word bounds for a block's take
  from whisper.cpp on this machine (`whisper.cpp/dtw-word-boundaries-v1`). Today the read-along
  highlight and the video's word captions use it, behind a Prepare press.

## The options, and why the third

1. **Picture blocks.** A second segmentation of the same words has to follow every edit, join and
   split, and the two drift.
2. **Several pictures per block.** Still owned by blocks, so regrouping a chapter scrambles which
   block holds which picture.
3. **Marks on the words.** A mark is kept by its sentence's words, as pictures already follow their
   words (R-69). So blocks and beats become the narration's business alone, and the picture's start
   comes from the take's own timing.

Also ruled out:

- going back to small blocks read as grouped requests (185), which makes the narration answer to
  the pictures again;
- motion alone (Slow push), which moves a picture without making it match the words.

## What is real in the frames

- The words, beats, lengths, the 15 standing pictures and their times are Chapter 1's.
- The goat face and the booth two-shot are the chapter's own pictures, as are the portraits.
- The goat face standing at 0:37 is what moving its mark would do. Today it is at 0:03.
- The times of moments inside a take (0:37, 1:20, 1:48 and the proposal's) are drawn as word timing
  would give them, from the words' share of the take. Illustrate's twelve cards are drawn, not run.
- Pace's "~950 for the book" is 11 h 55 m at 45 s.

## Calls (for the owner)

1. Pace's choices, 90 s, 45 s and 20 s, and the default. A production keeps 90 s until Pace is
   changed, so nothing changes by itself.
2. The shortest hold at 10 s, down from 20 s. A closer mark is flagged, not refused.
3. Marks only at the start of a sentence, never mid-sentence.
4. Standing pictures stay at their block's first word until moved. Arke does not guess which
   sentence a picture shows.
