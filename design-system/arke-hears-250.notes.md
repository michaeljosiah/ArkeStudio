# Turn 250 · Arke hears a read

Drawn on 29 October 2026, revised the same day, and corrected again the same day. Proposed;
nothing is built.

## Asked

A Claude Code session designed two voices for each of the six miners in The Red Quiet's visual
novel First Contact, and chose between them on measured evidence. The owner then asked, on
29 October 2026:

- "your ability to assess pace, pitch and wording — how do we ensure the Arke agent has the same
  capability?"
- "You can do that now."

The first drawing answered with eight frames across the Voice page, a Cast voices view, World
Chat, a scene's beats and the beat inspector. The owner then asked:

- "Do we really need a UI for this feature. Would an Agent tool not be sufficient along with a
  card design in the chat window?"

The recommendation:

- Keep the measure, the `measure_read` tool, and designing two voices through chat.
- Drop the Voice page's two-candidate panel, the Cast voices view, the take-measure panel and the
  table read's per-line flags.
- Replace the flags with a card Arke posts when a table read finishes.

The owner answered "yes please redraw".

The second drawing put the World Chat cards beside a world page that does not exist ("YOUR
WORLD · The Red Quiet", tabs Overview / Characters / Places / Lore, a grid of character photos).
The owner said: "that's not how it looks, if you're going to show potential new features make
sure to use the exact design so that it does not confuse me. This looked like a major regression
at first glance."

This correction draws every existing screen as it is today. The cards are unchanged in what they
say; where the real panel or page forced a change, it is listed below.

## What is new, and what is today's

In every frame:

- **New:** the cards, and the words of the receipt line under a reply.
- **Today's:** everything else: the page beside the chat, the top bar, the Chat panel's head,
  its bubbles, Listen and Copy, the prompts and the composer.

| Frame | New | Today's, and its source |
|---|---|---|
| 250a | The voices card, Imani open | World home + World Chat |
| 250b | The voices card, Lin Wei open | World home + World Chat |
| 250c | The evidence card; ✓ Read 4 measures | World home + World Chat |
| 250d | The not-measured card; ✓ Read 2 measures | World home + World Chat |
| 250e | Arke's post after Voice lines and its check card | Scene 1's beats + Builder Chat |
| 250f | The one-read card; ✓ Read 1 measure | Scene 2's beats at shot 2 + Builder Chat |

250a and 250b also hold the approved quote card and the reply carrying ✓ Designed 12 voices ·
$1.86, above the voices card. They are scrolled out of view, as they would be in the panel.

## Sources

### The pages beside the chat: real screenshots

The pages are pictures of the shipped client, not drawings:

- **The client:** `origin/main` at 50b479f19.
- **The data:** a scratch dev root in the session scratchpad. The live world and the D: copy were
  not used.
- **The setup:** 1360 × 850, shot at 2x in light and dark, with the Chat panel open at its default
  400 wide.
- **The panel's area** is painted flat in the pictures (`assets/t250-ctx-*.jpg`), and the frame
  draws the panel over it.

| Picture | Route | Code |
|---|---|---|
| `t250-ctx-world-{light,dark}.jpg` | `#/w/<world>` | `WorldOverviewScreen`, `screens/world.tsx` |
| `t250-ctx-scene1-{light,dark}.jpg` | `#/w/<world>/p/first-contact/scenes/sc_fc-001` | `scene-workspace/workspace.tsx`, `beats.tsx` |
| `t250-ctx-scene2-{light,dark}.jpg` | `…/scenes/sc_fc-002`, scrolled to shot 2 | the same |

The scene pictures are in the default Grid view, at the top for scene 1 and at shot 2's lines for
scene 2.

**No master frame was used for these pages, because none is current:**

- **World home:** desktop 63a/63b (turn 63) predate most of `world.tsx`. 160a/b are phone and
  Fold. 225b's world page is the invented one the second drawing copied.
- **Scene page:** 174b's beats list (one row a line, a still each) is not what ships. The shipped
  page has one card a shot, with its lines inside, "after the line", Show when, the Cast row, the
  Location card, Review scene and Generate frames.

### The Chat panels: HTML, matched to the shipped panel

The panels are drawn in HTML because the cards sit inside them. Every value was measured from
the running client:

- `global-chat.tsx` / `.css`;
- `fidelity.css` `.fy-chat__*`;
- `player.css` `.fy-replyacts`;
- the composer's `.fy-cx`;
- `ModelChip` (read-only);
- the scene dock's `.fy-arke`.

The icons are copied from the client's DOM.

**Checked pixel for pixel:**

- **The same conversations:** the panel code was run with the same conversations the real panel
  was shot with, without the cards (`v3/work/cal.mjs`). Every pixel matched at threshold 40/255,
  World Chat and Builder Chat, light and dark.
- **The six frames:** each was rendered at a whole-pixel position (`v3/work/verify.py`, flat
  renders). Against the real app, these match at 0.00%: the page, the top bar, the panel's head
  and the panel's foot (prompts and composer).
- **What differs:** only the transcript, where the cards are.

**World Chat (250a–d), as it ships:**

- **Head:** World Chat / The Red Quiet / Voices for the miners, with ⋯ and ×.
- **Your messages:** right, on `--primary`, or `--neutral-700` in dark. Radius 14 14 4 14.
- **Replies:** on `--secondary`. Radius 14 14 14 4.
- **Under every reply:** Listen and Copy.
- **Composer:** "Keep going…", attach, dictate, and the model named read-only (GPT-5.4).
  - Read replies keeps only its icon beside the chip.
  - Send is at 45 % until something is typed.

**Builder Chat beside a scene (250e, 250f), as it ships:**

- **The scene dock:** a `--secondary` well holds the conversation.
- **Your messages:** on `--foreground`, 12 px.
- **Replies:** white and bordered, 12 px, then Listen and Copy.
- **Prompts:** the scene's two, "What is missing from this scene?" and "Which shots need a frame?".
- **Composer:** "Ask Arke about this scene…" and Read replies with its label. There is no model
  chip, by turn 143.

### The data in the scratch world: samples

**The world:**

- **Cast:** the six miners, from the turn's own portrait crops, each with the role "Miner".
- **Logline:** invented ("A survey crew signs off a dead moon, and the moon answers.").
- **Canon:** none.

**First Contact:**

- **The scenes:** fifteen, from this session's scratch copy (`first-contact/edits/before`), with
  the real scene titles.
- **Scenes 1 and 2:** laid out as `narrate/checks.json` records them, with the real shot ids,
  block ids, speakers and lines. Scene 1 is four shots and nine lines; scene 2 is five shots and
  eleven lines.
- **Pictures:** the turn's still crops.

**The conversations** use the turn's own words. The cards are the only thing a seed cannot hold.

**The browser rewrote three pieces of the coordinator's data**, never the client's code or styles:

- the harness reads healthy, with GPT-5.4 as World Chat's model, so the composer is live;
- each table-read line has a voice, as it does after Voice lines (9 of 9, 11 of 11 voiced).

## What changed from the second drawing (v2)

**The pages:**

- **250a–d:** the invented world page is replaced by today's world home.
- **250e and 250f:** the 174b-style beats list is replaced by today's scene page.

**The panel, now the shipped one:**

| v2 | Now |
|---|---|
| ⌄ in the head | ⋯ (Conversations) |
| "World" or "Scene 1" above the composer | No such label |
| "Ask about your world…" | "Keep going…" in World Chat; "Ask Arke about this scene…" in a scene |
| "Arke" above each reply | No label; replies are bubbles |
| Your messages on grey | `--primary` in World Chat, `--foreground` in a scene |
| No Listen or Copy | Listen and Copy under every reply |
| GPT-5.4 and "Read replies" side by side | GPT-5.4, then Read replies as an icon alone |
| "Harness default" chip in Builder Chat | No chip; the scene's two prompts above the composer |
| Builder Chat on white | The scene dock's `--secondary` well, white bordered replies, 12 px |

**The receipt.** v2 drew a "✓ Designed 12 voices · $1.86" row under an "Arke" label, above the
card.

- **Now:** it is the client's own receipt line, inside the reply under its words: `.fy-chat__receipts`,
  "✓ a · b", 10.5 px, `--neutral-400`.
- **Today's World Chat shows no receipt line.** The coordinator passes `projectWorkspace` an
  empty map; only a production setup's source reads show.
- **So the receipt is new behaviour:** `measure_read`'s receipts would be the first a World Chat
  reply shows. The rules ("The tool", "Implementation boundary") now say so.

**Cards.**

- **Where they sit:** after a reply's Listen and Copy, 8 below, where a production plan or a
  run's report sits today.
- **How wide:** they fill the message column, 374 in World Chat and 347 in a scene's Builder Chat
  (334 and 307 at the 360 minimum). v2 said 363 and 323.

**Content changes the real screens forced:**

- **Every reply has words.** The reply that was only a card now says "Twelve voices, two a
  character. Play each before you choose." Arke's post after a table read says "Voice lines
  finished: 9 lines read, 3 to check."
- **Lines are numbered by shot.** The scene page has no beat numbers; it numbers shots.
  - 250e's items: 4, 7, 9 become 2, 3, 4 (Elsie in shot 2, Lin Wei in shot 3, the narrator in
    shot 4).
  - 250f's card: "beat 6" becomes "shot 2".
  - The rules that named beats by number now name shots.
- **250f's message.** "Check this take." had an invented context chip, "Beat 6 · Imani Okoro".
  It is now "Check Imani's line in shot 2." The transcript has no such chip.
- **"Voice lines · 08:31"** above Arke's post is dropped. The transcript has no such marker.
- **The one-read card.** The model's name moves from the card's head to the line's row: in the
  347 column the head wrapped.
- **The World Chat head** names the conversation ("The Red Quiet / Voices for the miners"), as
  the panel does.

**Unchanged:**

- the rules, the calls, and every number from the miners' and the table read's measures;
- what each card shows, and its controls.

**Assets:**

- **Added:** six context pictures, `t250-ctx-{world,scene1,scene2}-{light,dark}.jpg`, 1.2 MB in
  all.
- **No longer used:** the stills `t250-fc1-*.jpg` and `t250-fc2-*.jpg`.

## What could not be exact, and what was done instead

- **The pages are pictures, not HTML.**
  - The master holds no current frame of either page, and only a screenshot is exact.
  - `check-master` accepts it, because every card also holds the HTML panel.
  - A picture does not follow later changes to the page. Reshoot it if the world home or the
    scene page moves (`v3/work/`).
- **The pages hold sample data, not the live world.** The design is today's; the data is a
  stand-in. Its counts and cast are not The Red Quiet's:
  - Cast · 6 with the role "Miner";
  - an invented logline;
  - canon v41, no entries;
  - one production.
- **Three things on the world home are today's behaviour on this data.** They are not part of
  the turn:
  - "Continue First Contact · 0 of 63 shots covered · 63 gaps to close.": the home's door counts
    clips, `deriveCut`, so a visual novel whose pictures are all accepted reads 0 covered.
  - "Grow the canon" shows a blank picture: `world.tsx` names the fixture's `the-saltmarket`.
  - The fan's fifth card is cut at 960 wide.
- **The transcript is shown scrolled to its end.**
  - In 250a, 250b and 250e, the reply above the card is out of view.
  - The receipt line shows in 250c, 250d and 250f.
- **The composer is drawn at rest.** The app focuses it when the panel opens, which turns its
  border to `--ring`.
- **"GPT-5.4" is a sample.** It is the World Chat agent's model in Settings; another setup names
  another.
- **Two sizes are off the type scale.** The client's own 13.5 px (composer) and 10.5 px
  (receipt) are written as token arithmetic: `calc(var(--text-sm) + .5px)` and
  `calc(var(--text-2xs) - .5px)`.
- **The master renders text half a pixel off.** Frames sit at fractional offsets there (y ends in
  .56 px), so a 2x capture can move text one device pixel against a picture. At whole-pixel
  positions (`_frames.html`), every frame matches the app.

## The numbers, and where each comes from

Unchanged from v2.

### The twelve auditions (250a–d)

The audition files are in the session's `scratchpad/voices/*.m4a`. They are copies of the world's
`.cache/voice-previews/*.wav`; the world itself is not read.

The following come from that session's `first-contact/voices-work/measures.json`:

- duration;
- words a minute: Whisper's words over the span Whisper heard;
- median pitch, with its 10th and 90th percentiles: librosa pYIN, 60–400 Hz.

The pause at each full stop was measured again (`t-arke-hears/stops.py`):

- 10 ms RMS frames;
- quiet is 35 dB under the loudest frame, and never above −40 dBFS;
- the longest quiet between word midpoints, placed by Whisper's word times.

| Read | s | wpm (brief) | Hz (10–90 %) | Stops (s) |
|---|---|---|---|---|
| Imani A | 5.3 | 207 (150) | 148 (126–213) | home. 0.00 · Dev. 0.37 |
| Imani B ✓ | 5.1 | 213 (160) | 149 (95–238) | home. 0.64 · Dev. 0.00 |
| Dev A ✓ | 10.0 | 165 (150) | 104 (87–133) | 0.59 0.56 0.94 0.90 0.73 |
| Dev B | 8.4 | 196 (165) | 139 (61–178) | 0.55 0.66 0.63 fired. 0.22 0.78 |
| Lin Wei A | 10.0 | 166 (160) | 97 (84–127) | channel. 0.00 · 0.27 0.47 0.17 |
| Lin Wei B ✓ | 9.6 | 171 (145) | 107 (85–127) | 0.67 0.46 0.65 0.64 |
| Ana A ✓ | 8.0 | 196 (155) | 168 (151–222) | 0.38 0.75 |
| Ana B | 8.2 | 187 (165) | 165 (132–251) | 0.54 0.63 |
| Elsie A ✓ | 12.4 | 168 (160) | 210 (163–262) | 0.57 0.57 0.62 0.80 0.71 0.49 0.50 |
| Elsie B | 12.0 | 173 (160) | 180 (148–223) | 0.51 0.65 route. 0.15 0.72 0.79 0.77 0.59 |
| Tomas A ✓ | 11.2 | 176 (140) | 107 (84–144) | 0.70 0.52 1.71 on. 0.18 0.55 |
| Tomas B | 8.9 | 220 (150) | 94 (60–162) | 0.50 0.51 1.02 on. 0.00 landing. 0.00 |

- ✓ marks Arke's pick. Every pick agrees with the one the session made and assigned at 07:41.
- The frames assert the drawn run-ons against these stops: a run-on is drawn exactly where a stop
  is under 0.15 s.
- Close is asserted against the 8 % rule: 104 and 107 are Close; 104 and 139 are not.

### Scenes 1 and 2 (250e, 250f)

From a second session's `first-contact/narrate/checks.json` and `flags.json`, made the same
morning, which checked all 71 voiced lines of First Contact.

**Scene 1:** four shots, nine lines, 1:13 in all.

- Shot 3's run-on is real: 0.06 s of quiet after "shuttle.", against 0.38 s after "tender.". It is
  scene 1's line 7, and the one real flag in the scene.

**Scene 2:** five shots, eleven lines, 1:34 in all.

- Shot 2's third line is Imani's. It runs 2.8 s, at 133 words a minute and a median of 197 Hz,
  with 0.54 s after "Stop.", and every word heard ("Stop! They are not shooting!").
- Imani B's audition is 213 a minute at 149 Hz, with a middle 80 % of 95–238 Hz. So 197 Hz is in
  her range: data, not Wrong voice.

**These are samples:**

- scene 1's shot 2, Wrong voice at 158 Hz (the real read is 213 Hz and clean);
- scene 1's shot 4, the missing "of fire" (the real read is clean);
- 250f's loudness.

The Redo prices are estimates for one Gemini line.

## Calls for the owner

Unchanged from v2:

1. **The UI.** Decided: cards in the chat, no other UI.
2. **When a read is measured.** Drawn: when it lands, by the app; Arke reads the kept measure. The
   alternative is to measure only when asked.
3. **Two voices by default.** Drawn, at twice the price: ~$0.31 a character, $1.86 for six.
4. **Use after a play; no Use all.** Drawn.
5. **The after-table-read card replaces flags on the beats.** Drawn. A flag on the line itself can
   come later if the card proves easy to miss.
6. **Open: pace against the brief.**
   - All twelve reads came out faster than their briefs, five by more than a fifth.
   - So Fast may only be saying that Gemini reads fast.
   - The alternative compares the two candidates with each other.
   - Drawn against the brief.
7. **Open: Imani and the narrator.**
   - They sit at 149 and 148 Hz, so Wrong voice cannot tell her lines from the narration.
   - A first-person narration may want that.
   - Redesign one, or keep?
8. **Open: Arke's pick needs a model call.**
   - The one-sentence reason needs a model call over the two measures, one a character.
   - A pick by rule costs nothing: fewest run-ons and flags, then the pitch order the briefs ask
     for. But it cannot write the sentence.
   - Drawn with the model call.
9. **The evidence card.** Drawn from the tool's receipt, never from Arke's text.

New with this correction:

10. **Receipts in World Chat.** World Chat shows no receipt line today. Drawn: `measure_read`'s
    receipts turn it on for that tool alone. Turning it on for every tool would change every World
    Chat reply.

Not part of this turn, but seen while shooting today's world home: the home's "Continue" door
reports a visual novel as 0 shots covered. Worth an issue.

## The build, smaller

- **Coordinator, `src/audio/`:** a measure module beside QC and transcript comparison.
  - It runs when a read lands and is kept by the audio's hash and the script's.
  - It reuses heard-match, speech-wav's pause finder and loudness, and Voxa's word times.
  - It adds a pitch tracker.
- **The tool, `measure_read`, in the five places a read tool lives:**
  - `harness/world-query.ts` (`TOOLS` and `call()`);
  - `world-chat/retrieval.ts` (`TOOL_BY_NAME` and `dispatch()`);
  - `world-chat/lease.ts` (`LEASED_OPERATIONS`);
  - contracts' `CheckToolSchema`;
  - `world-chat/project.ts` (`WORKING_LABELS`).

  Two tests pin the tool counts and must be updated: `harness/world-query.test.ts` and
  `world-chat/retrieval.test.ts`.
- **Its receipts:** projected onto the reply that used them. Today the coordinator passes
  `projectWorkspace` an empty map, so a narrow fold is needed, as `sourceReads` has.
- **Design two from chat:**
  - Arke drafts the briefs and picks the lines.
  - The priced card's Design is the confirmation that the human-only `design-voice` already
    needs.
  - Use goes through the sheet's existing voice assignment.
- **After a table read:**
  - a post to the scene's conversation when Voice lines finishes;
  - Keep is recorded on the line's measure;
  - Redo is `voice-line`, carrying 181's pause for a run-on.
- **Client:** five cards in the conversation, after a reply's Listen and Copy:
  - two voices a character;
  - the evidence;
  - not measured;
  - the table read's check;
  - one read.
- **Not touched:** the Voice page, the cast, a scene's beats, Voice lines, the beat inspector,
  takes, the Chat panel.

## Rests on

- **225:** World Chat and Builder Chat, rule 7 (docks show the same conversation) and rule 8 (a
  card never opens Chat). The panel is drawn as it ships, not as 225 drew it.
- **143:** the scene dock has no model chip.
- **183:** Listen under every reply.
- **132:** the Voice page, unchanged.
- **174 and 246:** a visual novel's scene page, unchanged.
- **181:** the pause marker.
- **SPEC-049 R-14:** Design voice.
- **SPEC-041 R-87 and R-95:** leased media reads.
- **SPEC-047 R-60:** `PAUSE_SEC`.
- **SPEC-050 and SPEC-051:** chat reach.
- **The character-audio foundation note:** QC and transcript comparison.

## To regenerate

    node design-system/arke-hears-250.mjs
    node design-system/check-master.mjs --record
    node design-system/build-review.mjs
    node design-system/check-master.mjs
    node design-system/build-review.mjs --check

The generator replaces any earlier `t250` section whole and re-registers its frames, so it applies
on a branch that holds the first or second drawing. This drawing uses:

- `assets/t250-ctx-*.jpg` (six, new);
- the six portraits `assets/t250-{imani-okoro,dev-malik,lin-wei,ana-lucia-reyes,elsie-ward,tomas-vale}.jpg`.

The four steps passed against a copy of main's master (50b479f19):

- 244 turns, legacy raw sizes 12505/12513, anchors resolve;
- 563 screens resolve to frames that carry their controls.
