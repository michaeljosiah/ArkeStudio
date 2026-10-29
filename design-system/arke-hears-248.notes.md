# Turn 248 · Arke hears a read

Drawn on 29 October 2026. Proposed; nothing is built.

## Asked

A Claude Code session designed two voices for each of the six miners in The Red Quiet's visual
novel First Contact, and chose between them on measured evidence. The owner then asked, on
29 October 2026:

- "your ability to assess pace, pitch and wording — how do we ensure the Arke agent has the same
  capability?"
- "You can do that now."

The session had five measures for each audition:

- a local Whisper transcript with word times, against the script;
- words a minute, against the pace in the brief;
- whether the pauses fell at the full stops;
- the median pitch and its range, against the brief and against the rest of the cast;
- a pick between the two, with one sentence of reason.

It said it could not judge how natural an accent sounds. This turn gives Arke the same tools:

- every read carries a measure;
- a tool returns that measure;
- Design a voice auditions two voices before Arke recommends one;
- the table read is checked line by line.

## What already exists, and what is new

Arke can already read media through leased tools (SPEC-041 R-87 and R-95):

- `transcribe_audio`: Voxa word times;
- `review_audio_content`: the wording set against a supplied script;
- `analyze_audio_signal`: peak, RMS and silence;
- `listen_audio`: a local model's impressions;
- `inspect_media`.

None of them gives Arke the session's measures:

- No tool gives pace or pitch.
- No tool checks the stops.
- The signal tool explicitly gives no loudness in LUFS.
- None of them takes a designed voice's audition or a table-read line as a source.

The coordinator already has most of the parts:

- transcript comparison;
- heard-match's tolerant alignment;
- speech-wav's pause finder (`PAUSE_SEC` = 0.15 s) and integrated loudness;
- the take target of −18 LUFS and −1 dBFS.

Only a pitch tracker is missing.

## What it draws

- **248a: Design a voice makes two.**
  - Arke drafts two briefs from Imani's sheet. They are the session's real A and B briefs.
  - It picks two of her own lines: scene 8, "You can complain about my workmanship when we get
    home.", and scene 12, "Dev. Wait for me to tell you."
  - One price covers it all: ~$0.31.
- **248b: Imani's audition, measured.**
  - A runs "home. Dev." together, so Dev joins the first line.
  - B's run-on, "Dev, wait", keeps the meaning.
  - Arke picks B and says why.
  - Both reads are Fast for their briefs.
- **248c: Lin Wei.**
  - A was briefed the higher voice, a light tenor. It reads at 97 Hz, 10 Hz under B's baritone.
  - B has not been played yet, so Use B waits.
- **248d: The cast.**
  - All twelve reads are measured, each pick has a reason, and two picks have been chosen.
  - The pitch panel shows two close pairs:
    - Imani and the narrator: 149 and 148 Hz.
    - Dev, Lin Wei and Tomas: 104–107 Hz.
- **248e: World Chat.**
  - The question: "Do Dev, Lin Wei and Tomas sound different enough?"
  - Arke answers plainly first, then shows the evidence card drawn from the tool's receipt.
  - It also points out that Dev's B, at 139 Hz, would stand apart but cuts a stop.
- **248f: What Arke cannot hear.**
  - The question: "Is Imani's accent right?"
  - "I can't tell."
  - Arke shows what it measured, and offers Play A and Play B.
- **248g: Scene 1 after Voice lines.**
  - Three beats are flagged, each with a priced Redo:
    - beat 7: Run-on;
    - beat 4: Wrong voice;
    - beat 9: Missing words.
  - Beat 1's "Tomas", heard as Thomas, is listed with an ear, to listen for.
  - Arke's panel says the same in five lines and offers Redo 3.
- **248h: Beat 7's voice, opened.**
  - It shows what was heard, the measure, and what Redo sends: 181's pause as Gemini's
    `<short pause>`.
  - The buttons are Keep, Redo and Redo with a pause.

## The numbers, and where each comes from

### The twelve auditions

The audition files are in the session's `scratchpad/voices/*.m4a`. They are copies of the world's
`.cache/voice-previews/*.wav`; the world itself is not read.

**From that session's `first-contact/voices-work/measures.json`:**

- duration;
- words a minute: Whisper words over the span Whisper heard;
- median pitch, 10th and 90th percentile: librosa pYIN, 60–400 Hz.

**Measured again for this turn (`t-arke-hears/stops.py`):**

- the pause at each full stop, measured the way speech-wav finds a pause:
  - 10 ms RMS frames;
  - quiet means 35 dB under the loudest frame, and never above −40 dBFS;
  - a pause lasts at least 0.15 s;
  - Whisper's word times place the pause in the text.
- Using Whisper's word gaps alone would have been wrong:
  - At six of Elsie B's seven stops, Whisper gave 0.00 s where the sound holds 0.15–0.79 s.
  - Whisper's punctuation dropped both of Ana A's full stops, which hold 0.38 s and 0.75 s.

**Measured with the installed app's ffmpeg** (`ebur128`, on the m4a copies): loudness and
peak. Elsie B's copy peaks at +0.4 dBFS. That may be the AAC encode, so it is not drawn as a flag.

| Read | s | wpm (brief) | Hz (10–90 %) | Stops (s) | LUFS / peak |
|---|---|---|---|---|---|
| Imani A | 5.3 | 207 (150) | 148 (126–213) | home. 0.00 · Dev. 0.37 | −18.5 / −2.1 |
| Imani B ✓ | 5.1 | 213 (160) | 149 (95–238) | home. 0.64 · Dev. 0.00 | −15.0 / −1.6 |
| Dev A ✓ | 10.0 | 165 (150) | 104 (87–133) | 0.59 0.56 0.94 0.90 0.73 | −17.4 / −0.9 |
| Dev B | 8.4 | 196 (165) | 139 (61–178) | 0.55 0.66 0.63 fired. 0.22 0.78 | −16.2 / −1.3 |
| Lin Wei A | 10.0 | 166 (160) | 97 (84–127) | channel. 0.00 · 0.27 0.47 0.17 | −18.7 / −1.7 |
| Lin Wei B ✓ | 9.6 | 171 (145) | 107 (85–127) | 0.67 0.46 0.65 0.64 | −21.1 / −1.8 |
| Ana A ✓ | 8.0 | 196 (155) | 168 (151–222) | 0.38 0.75 | −15.4 / −0.9 |
| Ana B | 8.2 | 187 (165) | 165 (132–251) | 0.54 0.63 | −17.0 / −1.7 |
| Elsie A ✓ | 12.4 | 168 (160) | 210 (163–262) | 0.57 0.57 0.62 0.80 0.71 0.49 0.50 | −16.6 / −1.4 |
| Elsie B | 12.0 | 173 (160) | 180 (148–223) | 0.51 0.65 route. 0.15 0.72 0.79 0.77 0.59 | −15.8 / +0.4 |
| Tomas A ✓ | 11.2 | 176 (140) | 107 (84–144) | 0.70 0.52 1.71 on. 0.18 0.55 | −20.3 / −1.7 |
| Tomas B | 8.9 | 220 (150) | 94 (60–162) | 0.50 0.51 1.02 on. 0.00 landing. 0.00 | −20.0 / −1.4 |

✓ marks Arke's pick. Every pick agrees with the one the session made and assigned at 07:41.

**Run-on and Short as drawn:**

- Under 0.15 s is no pause: a run-on.
- Under half the read's median stop is Short.

### Scene 1 (248g, 248h)

Scene 1's numbers are from a second session's `first-contact/narrate/checks.json`, made the same
morning. It checked the scene's nine voiced lines.

**Measured:**

- the durations;
- beat 7's run-on: 0.06 s of quiet after "shuttle.", and 0.38 s after "tender.";
- beat 7's pace of 170 a minute and pitch of 83 Hz;
- the sound-alikes heard-match passes: Tomas/Thomas, plain/plane, collar/color, lets/let's.

**Samples:**

- beat 4's wrong voice, at 158 Hz (the real read is 213 Hz and clean);
- beat 9's missing "of fire" (the real read is clean);
- beat 7's loudness.

Scene 1's stills are cropped from the scratchpad's `first-contact/stills-sheet.png`. The six
portraits are from `first-contact/cast-sheet.png`.

## Calls for the owner

1. **When a read is measured.** The app measures every read when it lands, and Arke reads the kept
   measure. The alternative is to measure only when asked.
2. **Two voices by default.** Design a voice makes two, at twice the price, ~$0.31 for Imani.
3. **Use after a play.** A candidate's Use is live only after it has been played.
4. **No Use all.** Each character in a cast is chosen on their own row.
5. **Pace against the brief.**
   - All twelve reads came out faster than their briefs, and five by more than a fifth. So Fast
     may only be saying that Gemini reads fast.
   - The alternative compares the two candidates with each other.
   - Drawn against the brief.
6. **Imani and the narrator.** They sit at 149 and 148 Hz, so Wrong voice cannot tell them apart.
   That may be right for a first-person narration. Redesign one, or keep?
7. **The three men.** Dev, Lin Wei and Tomas sit at 104–107 Hz. Dev B, at 139 Hz, would stand
   apart, but it cuts a stop. Keep A, or try Dev B?
8. **Redo with a pause.** A run-on's Redo offers 181's pause marker at the stop.
9. **The evidence card.** It is drawn from the tool's receipt, never from Arke's own text.

## Rests on

- **132:** the Voice page.
- **132g:** the dialog.
- **174:** the scene's beats and its Arke panel.
- **181:** the pause marker.
- **185:** word-time splitting and the take target.
- **225:** World Chat.
- **246h:** the beat inspector.
- **SPEC-049 R-14:** Design voice.
- **SPEC-041 R-87 and R-95:** leased media reads.
- **SPEC-047 R-60:** `PAUSE_SEC`.
- **SPEC-050 and SPEC-051:** chat reach.
- **The character-audio foundation note:** QC and transcript comparison.

## To regenerate

    node design-system/arke-hears-248.mjs
    node design-system/check-master.mjs --record
    node design-system/build-review.mjs
    node design-system/check-master.mjs
    node design-system/build-review.mjs --check
