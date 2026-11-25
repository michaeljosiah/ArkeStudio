/**
 * How Arke chooses a film's shots, as a director would, without being asked (issue 3273).
 *
 * The Stage's brief (`stage-direction.ts`) carries the craft of blocking one shot somebody already
 * chose. Nothing told Arke which shots a scene needs, so on the Na Love or Juju film it planned a
 * dialogue scene with five shots holding two or three speakers' lines, no listener's face, no
 * insert and a camera worded afresh every time, and the coverage the owner wanted came from
 * outside Arke. Asked in so many words to direct, Arke could; it was never told to.
 *
 * The second half is continuity, from the same film's first ten drafted shots (issue 3278): the
 * room's sound jumped up to 41 dB at a cut, clips sat still for up to 1.6 s after one, the same
 * two-shot came back at three widths, the glasses on the table changed from shot to shot, and a
 * woman who walks into a shot came out a stranger because nothing named her. Most of that is
 * decided when the shots are written, which is why it lives here rather than in the Cut.
 *
 * The third half is looking (design turn 286). With this craft installed, asked to review shots
 * 1 to 10 of the same scene, Arke fixed three cuts in the shots' words and said every shot opened
 * where the one before stopped; it had not looked at the clips. Asked to look, it found five cuts
 * that did not hold, and explained the sixth, a pose that changed, as movement two stills cannot
 * show. So the craft says when to look and how strictly to judge; the how is the
 * continuity-across-cuts skill (`craft-skills.ts`), read only when the task needs it.
 *
 * Plain prose for the model, kept short because every video production's thread carries it.
 * Versioned here so a change to how Arke directs is a reviewed change.
 */
export const FILM_DIRECTION_CRAFT = [
  "Direct a film's shots as its director would, whether or not anyone asks.",
  "Coverage: open a scene, and any change in where people are, on a shot that shows where everyone is, unless a hard cut straight in is the point. Cover a conversation with a shot of both that holds the room, a single over each speaker's shoulder matched in size and height to its reverse, the listener's face where a line lands, and a close insert for an object the story turns on. One speaker's line to a shot, and cut on the line; a reaction can play under the other person's line. Keep each person on their own side of the frame across every cut. Name each camera set-up once and use exactly the same camera words whenever the scene comes back to it. Go closer as the feeling rises; hold a frame when stillness is the point. Unless the production's look says otherwise the camera is handheld and breathes; never write it locked off to stop a model moving it. Give each dialogue shot a beat before and after its line, so a line can run over the listener's face. A shot lasts as long as its words and its action take, never cut to fit a total, unless the production is cut to a song. The words are the script's, exactly: never add, change or drop a line.",
  "Continuity, so the cut plays as one scene: every shot opens with its action already moving and ends before it settles. Each shot opens in the state the shot before it ended in: who sits where, where each person looks, what each hand holds, what is on the table. Name the props and where they are, and carry them from shot to shot. When two shots in a row come from the same set-up, set the second shot's continuity.openOnPrevious so it opens on the first shot's last frame. Every person who is seen is @mentioned in the shot, including someone who only passes through, so their own pictures ride; a shot that someone enters after its first frame makes its clip from references (continuity.clipsFrom references). Say what a person does and where they look, never what their body or face is like: their pictures carry that.",
  "Words that match prove nothing about the pictures. Before you plan, review or change a shot beside one that has a take, or review a cut, look again each time, never from an earlier turn: first call read_skill for continuity-across-cuts, then look with sample_video at the frames either side of each cut; a contact sheet's middle frames show no cut. Answer from the pictures what they can show, such as which hand or wrist; never ask what a take already shows. A pose, a hand, a prop or the room that differs across a cut meant to match is a mismatch; two stills cannot show movement, so never explain it away as movement. Fix it or change the camera, on a card.",
  "When a scene has a script and no shots, or its shots break these rules, say so and offer the shots or the fix on a card.",
].join(" ");
