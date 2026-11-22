# Continuity across cuts

How a director and a script supervisor keep a scene's shots playing as one scene. Read this before you
plan, review or change a shot beside one that has a take, and before you review a cut.

## 1 · A cut is matched or deliberate

A **matched** cut continues the action: the same moment, carried on from another angle. A
**deliberate** cut jumps on purpose: in time, in place, or to a reset of the action. Within a scene, a
cut is matched unless the shot coming in says it jumps on purpose. Hold matched cuts to everything
below. Leave deliberate ones alone.

## 2 · What has to match

Check each of these in the last frames of the shot going out and the first frames of the shot coming in:

- **Where each person is**, and **where in their action**: half up, sitting back, leaning in, mid-step.
- **Where each person looks**: left or right, and how high.
- **What each hand holds**, and which hand.
- **The props**: which ones, where they stand, how full, how many. A glass is the same glass, the same size.
- **Clothes and hair**: a collar open in one shot is open in the next.
- **The room behind them**: a camera looking the same way sees the same background. A wall behind someone
  in the wide shot is a wall behind them in their close shot.
- **The light**: where it comes from, and how bright.
- **The direction of movement**: someone who leaves frame right comes in frame left.

## 3 · The line and the angle

- **The line.** Between two people there is a line. Every camera stays on one side of it, so each person
  keeps their side of the frame. Crossing it swaps their sides and turns the room over.
- **The angle.** Two shots in a row of the same person change the camera's angle by about 30 degrees or
  more, and the size by a clear step: wide to medium, medium to close. Less than that reads as a jump.

## 4 · Plan for the cut

- **Cut on a movement.** The best cut falls in the middle of a movement: a head coming up, a glass going
  down. The eye follows the movement and does not see the cut.
- **Overlap the action.** Start each shot's action a beat before the point where the shot before it will be
  cut. Then the cut can be placed where both shots agree. A shot that starts exactly where the last one
  stops leaves nowhere to cut.
- **End while it is still moving.** A generated clip slows as it ends. End each shot with its movement still
  going, so the slowing is trimmed away rather than cut into.
- **Carry the state forward.** When a take is accepted, write its end into the next shot: who is where and
  how, where each person looks, what each hand holds, what is on the table and where.

## 5 · Look at the cuts in the pictures

Words that match prove nothing about the pictures. When shots have takes, look at them:

- **Look again each time.** What you saw or said in an earlier turn is not evidence now: takes, frames and the
  cut change, and an earlier reading may have been wrong. Never repeat an earlier finding without looking.
- **Before you write the next shot, look at the end of the take before it.** Write the new shot's opening
  from what you see there, not from what the last shot's words say it ends on.
- **Answer from the pictures what they can show**: which hand holds the glass, which wrist the bangles are
  on, what is on the table. Never ask the person what a take already shows.
- **A contact sheet shows no cut.** `cut_contact_sheet` takes one frame from the middle of each shot. Use it
  to find where the shots are, then look at the cuts themselves.

- **When the scene has been exported**, call `list_exports` for the latest export of the production, then
  `cut_contact_sheet` on it for each shot's start and end. Then call `sample_video` on the export at each
  cut, from 0.2 s before the cut to 0.2 s after it, with a count of 2: the last frame before the cut and the
  first after it.
- **When the takes are not cut yet**, call `sample_video` on the accepted take of each shot: the last
  0.2 s of one and the first 0.2 s of the next, a count of 1 each.
- **Spend frames where they decide something.** A turn can see about 24 frames in all. Look closer (a
  count of 4, or a region round a face or a hand) only at a cut in doubt. Look at no more than ten cuts in
  one turn, and say which cuts are left for the next.
- Say which frames you looked at, and their times.

How to judge:

- **Two still frames cannot show movement.** A pose, a hand, a prop or a room that differs across a matched
  cut is a mismatch. Never explain it away as movement nobody saw.
- Say what the frames cannot show: the movement between them, and lip sync, need the clip itself.
- **A measurement that finds no motion is not a still.** `review_export` and `clip_quality` give no motion
  figures for a shot that changes too little between frames to measure, and slow movement in a dark room can
  read that way. Never say a shot does not move from that alone: look at its first and last frames.
- Name each cut by its two shots ("shot 4 to shot 5") and say, for each, matched and holds, matched and
  does not hold, or deliberate.

## 6 · Fix it or change the camera, cheapest first

When a matched cut does not hold, choose the cheapest fix that keeps the moment, and offer it on a card:

1. **Move the cut.** Trim one side in the Cut so the cut falls where both shots agree. It costs nothing, but
   needs the overlap.
2. **Cut inside a movement.** Put the cut in the middle of a gesture, so the change reads as motion.
3. **Redraw the opening.** Rewrite the next shot's first frame from the end of the shot before it: the same
   pose, the same hands, the same props, seen from the next shot's own camera. Then its frame and clip are
   made again. Say what that costs.
4. **Change the camera.**
   - Put a reaction or an insert between the two shots: two seconds at most, and only where the story has a
     reason to look there. An insert with no reason shows that something is being hidden.
   - Or move the next shot's camera to a clearly different position and size, so it reads as a new moment.
     Never move it across the line.
5. **Make it deliberate.** Say in the shot that the cut jumps in time or resets the action.

A fix that changes a shot already made means making it again: say so, and never rewrite a shot that has
been paid for without asking.

## 7 · What a fix must never give up

When a fix costs something, give up the last item in this list first and the first item last:

1. the feeling of the moment
2. the story
3. the rhythm
4. where the eye is
5. left and right on the screen
6. the exact geometry of the room

A cut that keeps the laugh and moves a glass is better than one that keeps the glass and loses the laugh.
