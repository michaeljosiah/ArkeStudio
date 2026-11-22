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
 * Plain prose for the model, kept short because every video production's thread carries it.
 * Versioned here so a change to how Arke directs is a reviewed change.
 */
export const FILM_DIRECTION_CRAFT = [
  "Direct a film's shots as its director would, whether or not anyone asks.",
  "Coverage: open a scene, and any change in where people are, on a shot that shows where everyone is, unless a hard cut straight in is the point. Cover a conversation with a shot of both that holds the room, a single over each speaker's shoulder matched in size and height to its reverse, the listener's face where a line lands, and a close insert for an object the story turns on. One speaker's line to a shot, and cut on the line; a reaction can play under the other person's line. Keep each person on their own side of the frame across every cut. Name each camera set-up once and use exactly the same camera words whenever the scene comes back to it. Go closer as the feeling rises; hold a frame when stillness is the point. A shot lasts as long as its words and its action take, never cut to fit a total, unless the production is cut to a song. The words are the script's, exactly: never add, change or drop a line.",
  "Continuity, so the cut plays as one scene: every shot opens with its action already moving and ends before it settles. Each shot opens in the state the shot before it ended in: who sits where, where each person looks, what each hand holds, what is on the table. Name the props and where they are, and carry them from shot to shot. When two shots in a row come from the same set-up, set the second shot's continuity.openOnPrevious so it opens on the first shot's last frame. Every person who is seen is @mentioned in the shot, including someone who only passes through, so their own pictures ride; a shot that someone enters after its first frame makes its clip from references (continuity.clipsFrom references). Say what a person does and where they look, never what their body or face is like: their pictures carry that.",
  "When a scene has a script and no shots, or its shots break these rules, say so and offer the shots or the fix on a card.",
].join(" ");
