# Turn 286 · Arke directs: the brief, skills and checks

Written 22 November 2026, for the owner's approval. A decision turn with no frames. Nothing here is built
beyond what the last section names. It answers issues 3273 (Arke does not direct a film) and 3278 (a
scene's drafted shots play as separate clips), and follows ArkeStudio PR 3279, which put the director's
craft in every video thread.

## Why this is a turn

On the Na Love or Juju film, the first ten shots of Gold on Gold were drafted, voiced and cut in Arke.
Two kinds of failure kept coming back:

- **Arke did not direct unless asked.** It planned a dialogue scene with two or three speakers' lines
  to a shot, no listener's face, no insert, and the camera worded afresh every time. Asked in so many
  words, it could direct; nothing told it to. PR 3279 fixed the telling.
- **The words were right and the pictures were not.** Shot 5's text says Ade's head is "just coming up
  from where he folded forward". Shot 4 ends with him folded over the table, face down, a hand on the
  seat. Shot 5 opens with him upright, head up, a hand on his chest. The rule was kept in the shot's
  words. The frame was drawn from the room's view alone, before shot 4's clip existed, so nothing
  carried his pose across the cut. No sentence in a brief fixes that. Only a picture that rides, and a
  check that compares the two frames, do.

The rest of the film's misses sit in one of those two kinds: the same two-shot at three widths, the
glasses changing on the table, a woman who walked in coming out a stranger, a man drawn as a bodybuilder
because his build was put in words, a 20 MB picture request that came back as "Arke lost track", the
room's sound jumping by up to 41 dB at a cut.

So the question is not how to word the rules better, but where each kind of rule lives.

## The three layers

| Layer | Holds | Reaches Arke | Fails when |
|---|---|---|---|
| The brief | the role and the rules that apply whether or not anyone asks | always, in every thread of a video production and in scene drafting | it grows too long to be read, or holds detail only one task needs |
| Skills | the craft for one task, or the habits of one route, with examples | when the task begins, by Arke's own read | Arke does not see that the task needs it |
| Checks | anything that can be measured | the app runs them and raises what it finds; Arke can call them too | nothing: a check does not forget |

The rule for placing anything: **if it can be measured, it is a check. If it applies every time, it is in
the brief. Everything else is a skill.**

### 1 · The brief

Today's `FILM_DIRECTION_CRAFT` (PR 3279) is this layer, at about 2,000 characters. It stays under the
tested limit of 2,600. The brief gains one line per skill, naming the skill and when to read it ("before
planning a dialogue scene's shots, read covering-a-conversation"). That line is the trigger. A skill
nobody is told about is never read: issue 3273 was exactly that, Arke not seeing that the task needed a
director.

### 2 · Skills

A skill is a shipped, versioned Markdown document, as SPEC-019 already defines one. This turn adds two
kinds.

**Craft skills**, keyed by task rather than by model:

- Covering a conversation: the coverage, how to cut on the line, the listener's face, inserts, holding
  each side.
- Continuity across cuts: the state at each boundary, props, matched action, when to open on the last
  frame and when to draw the same moment from a new angle.
- Voice-first clips: making the line before the clip, leaving room for it, timing it in the cut.
- The post pass: one room sound under a scene, still heads, levels at cuts, what colour difference is
  and is not a reason to redo a shot.

**Route skills**, keyed by the route's model id. Local H3 Reference and Pika H3 Flex both declare the
`minimax-h3` family, so a family-wide rule would teach one of them the wrong habit. They use the
model-specific override `skillFor` already has. What the film measured on local H3 Reference becomes its
first route skill:

- The line begins 1.3 to 1.9 s into the clip, not where the read's lead ends. A shot's length leaves
  room for it, and the cut trims the head.
- The clip adds laughs and speech the line does not have. The voice take is the shot's sound.
- A person who enters after the first frame comes out a stranger on the first-frame route. That shot
  is made from references.
- A moving figure is not held out of focus.
- Words about a person's build are exaggerated. A shot says what a person does; their pictures carry
  the body.

Each point carries the production and date it was measured on, so a later model can retire it.

**Delivery.** A skill is read through an Arke read (`read_skill`), not pasted into every turn. The
harness's own skill systems stay off: the three engines are confined on purpose, and Arke's skills must
read the same on each. The version of each skill read is recorded on the cards it shaped, as SPEC-019
R-19 records the version a draft was made under.

**Reference material** is short, labelled, and made from the shipped sample worlds or written in words.
It is never a user's pictures: the repository is public, and the Juju film is the owner's.

### 3 · Checks

Run by the coordinator, the same every time, raised as findings without anyone asking, and callable by
Arke. Some exist today as Arke's measurements (`sample_video`, sync, clip quality, the cut's contact
sheet, the review of an export). The new ones:

| Check | Reads | Raises |
|---|---|---|
| The cut pair | the last frames of a shot beside the first frames of the next, on a matched cut | pose, where each person looks, what each hand holds, props, each person's side of the frame |
| Sound at a cut | the room's level either side of each cut | a jump in dB |
| Still heads | each clip's first second | how long it holds still before anything moves |
| Where the line sits | the clip's sound against its voice take | the line's start and end in the clip |
| Colour across a cut | brightness and colour either side | the difference, as advice only: a colour difference is not a reason to redo a shot |
| A frame against the sheet | a start frame beside each person's sheet | a face or build that is not theirs (issue 3276) |
| Before a request goes | the request's pictures and size against the route's limits | too many pictures, or too large to send (issue 3277), before any spend |

The cut pair is the one that would have caught shot 4 to 5. It reads frames, so it answers what the
frames show. Motion between them, and lip sync, need other evidence, and it says so.

## Four decisions that make the checks work

**Look, then write.** When a take is accepted on a matched cut, Arke reads the end of that take before
the next shot's frame is drawn. It says what action is still going and which way each person faces.
Then it confirms the next shot, or offers a new opening on a card with a fresh quote. It never rewrites
a shot that has already been paid for without asking. In a scene plan that waits for review, this
happens at the Continue pause the plan already has.

**A cut is matched or deliberate.** Each shot records whether the cut into it continues the action or
jumps on purpose: in time, in place, or to a reverse that resets the action. The cut pair and the sound
check run only on matched cuts. Within a scene, a cut is matched unless the shot says otherwise.

**The same moment from a new angle.** A shot on a matched cut from a different camera position draws its
first frame with the last frame of the shot before it riding as a picture for the pose and the state,
beside the place's view for the angle. Neither option today does this. Opening on the previous shot
keeps the old framing. Continuing it extends the old footage.

**A set-up carries its frame and its props.** A named camera position (turn 285's positions) holds its
accepted frame and the props in it. Every shot from that position starts from them, so the two-shot
keeps one width and the glasses stay where they were.

## What the DreamVerse review added

An engineering review of Hao AI Lab's DreamVerse, given by the owner on 22 November 2026, compared it
with Arke at commit 1de466d (before PR 3279). Four points shaped this turn:

- Its directing skill looks at the last stills of the shot before and describes the unfinished action
  before it writes the next shot. That is "look, then write".
- It separates continuity from intentional cuts. That is "matched or deliberate".
- It locks the references a sequence keeps returning to. That is "a set-up carries its frame and props".
- Prose guides the creative choice; code decides whether a request may go. That is layer 3, and the
  check before a request goes.

It also recommended a view of which takes in the cut used a reference that changed, a note to Arke of
what changed since it last looked, and a benchmark of a faster local engine. Each is useful and each
waits for its own measurement. Its advice against a whole-project history replay and a plugin system is
taken.

## Order

1. Look, then write; matched or deliberate; the same moment from a new angle. Together these are the fix
   for shot 4 to 5.
2. Route skills for local H3 Reference and Pika H3 Flex.
3. The check before a request goes.
4. The other checks.
5. The craft skills, moved out of the brief, which then keeps only the role, the rules that always
   apply and the list of skills.

## Not drawn

Four screens change, and none is drawn here: the cut pair on a card, the cut's kind on a shot, the new
angle as a choice for a shot's frame, and a position's frame and props. They are drawn from the app's own
screens in a following turn, as turn 285 was, before any of them is built.

## Built today, and reused

- `FILM_DIRECTION_CRAFT`, in every video thread and in scene drafting (PR 3279; SPEC-051 R-45).
- SPEC-019 skills: shipped Markdown, selected by purpose and model family, with a model-specific
  override, versioned and recorded on the drafts they shaped.
- Arke's measurements: `sample_video`, sync, clip quality, the cut's contact sheet, the review of an
  export.
- The scene plan's boundary frame and its Continue pause.
- A shot's `continuity.openOnPrevious`, `continuesPrevious` and `clipsFrom`.

Not built: `read_skill` and the craft skills, the route skills, the new checks, a cut's kind, the same
moment from a new angle, and a position's frame and props. SPEC-019 (skills), SPEC-051 (checks and
cards) and SPEC-036 (the shot's fields) are amended in the private set when each slice is built.
