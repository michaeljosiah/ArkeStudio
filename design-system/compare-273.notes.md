# Turn 273 — Compare an upscale with its source

Drawn for the owner's approval, issue 2402. The sample is the world's drowned-quarter key art
standing in for a video still; the source is the same frame at 45%, the 864→1920 step. The wall
draws the shipped `.fy-bench__wall` at token sizes (bar, brief line, media, transport, chips,
actions). The composer on its left and the take strip on its right are unchanged and left out.

An upscale costs real GPU time (about 14 minutes for a 7 s clip on the reference card), and today
the only way to judge one is to flip between two takes and remember the first. A line over one
frame answers "was that worth it?" at once.

- **Where it lives.** A `Compare` tab in the wall bar, beside the crop tab, on a selected upscale
  whose source still has media. It toggles like the crop tab. Selecting another take leaves it.
  A deleted source removes the tab; the brief line's `from Take 19` already says which take it was.
- **Fit and Pixels** sit at the bar's end only while comparing. Fit is the default. Pixels is the
  result's native width, because an upscale's value only shows there; the pointer pans. On a
  phone Pixels is left out of this first version: panning by hover needs a mouse.
- **The handle is a real slider**, keyboard and screen reader included. A touch starts a drag only
  on the 28px grip, so a finger can still scroll the page over the picture.
- **The result keeps the clock.** The Bench player's transport drives the result; the source
  follows by speeding up or slowing down slightly, and seeks only when it has drifted 0.3 s. Seeking
  on every time update stutters. The resting play disc is dropped here: it would sit under the grip,
  and a click on the picture moves the line instead of playing.
- **Labels are data**: take number and size on each side, no caption.
- **A source that will not load** leaves the result playing alone, with one clause by the tab.

Taken from openfield (MIT): the `clip-path: inset()` wipe, Fit / Pixels, cover on both layers and
the playback-rate clock. Changed: a real slider, touch only from the grip, and the Bench player
as the clock rather than an autoplaying element per side.

Out of scope for this turn: any two takes of a shot, look edits, tall recomposes and picture marks,
difference or onion-skin modes, and audio.
