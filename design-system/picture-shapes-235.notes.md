# Turn 235 · Picture shapes

Drawn and approved as drawn by the owner on 23 October 2026, with the three calls below. Built in ArkeStudio PRs #2165, #2166 and #2167, merged the same day (518d668f4).

## Asked

On a phone, Arke Player letterboxes a 16:9 picture into the top 62% of the listen screen. The owner
chose the plain engineering answer over cropping: a production picks the shapes its pictures are made
in, more than one, so a phone gets a picture made for it. Separately, a smaller picture size at
export saves space. Audio quality was left for later.

## What was checked before drawing

- **The ChatGPT route makes 9:16.** On 23 October 2026, Codex Image on the owner's ChatGPT plan made
  941 × 1672 from a prompt asking for a tall 9:16 portrait. The wide pictures it made for The
  Undersong are 1672 × 941. Its image tool takes the shape in the prompt and has no size setting.
- **Tall from Wide holds the moment.** Block p004 (1672 × 941) with "recompose the attached picture as
  a tall 9:16 portrait, the same moment…" came back as 941 × 1672. It kept Maren's face, braids and
  oilskin, the ledger, the lamp, the glass float and the window with the lighthouse. That pair is the
  sample in 235b and in Player P14.
- **The API routes were not tested live.** On 23 October the OpenAI account returned
  `credit_balance_exhausted` and fal returned `User is locked. Reason: TOP_UP`; nothing was spent.
  OpenAI's image guide documents custom sizes for GPT Image 2: both edges multiples of 16, the long
  edge under 3840, a ratio of at most 3:1, and 655,360 to 8,294,400 pixels. So 1024 × 1792 is a
  valid 9:16. The Studio's own rows don't match that (rule 8).
- **Where the space goes.** The 22 October Ledger of Nights package is 417 MB: narration 325 MB
  (78%), pictures 88 MB (21%), the guide 3.5 MB, the book 0.2 MB. The 290 pictures average about
  300 KB at 1672 × 941. A Tall set doubles the pictures; Size brings them back down.

## Found by P14

A phone draws its transport over the lowest third of a Tall picture. A full-height picture can only be
trimmed at its sides, so the focus can't lift the subject out from under the controls. In the p004
pair the open ledger sits under the scrub bar. Hence rule 4: the Tall instruction asks for the subject
in the upper two-thirds.

## Calls (approved 23 October 2026)

1. The two shapes and their names (Wide 16:9, Tall 9:16), with Wide alone the default.
2. Size's choices: Full, 1280 px and 960 px on the long side, Full the default.
3. A Tall made from an earlier Wide is marked and kept playing until remade, rather than removed.

## Completion of the existing workflow (issue 2164, 1 November 2026)

The Tall slot opens the same existing-image picker as Wide. Selecting an image associates it
with the Wide that was shown; a changed Wide refuses the stale selection. It makes no paid
request and does not replace Wide. Portrait video and its preview use the available Tall,
including one marked from an earlier picture, with Wide as the fallback. Wide focus and motion
belong to Wide and are not applied to Tall. Landscape video is unchanged.

The direct OpenAI custom-size live qualification remains separate; this completion does not
claim a new verified provider capability or change that model's supported sizes.
