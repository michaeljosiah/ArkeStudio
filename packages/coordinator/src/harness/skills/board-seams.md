# Boards and their seams

How to group a scene's shots into the clips a video route makes. Read this before you set a scene's
board target, split or merge its boards, or plan its video.

## 1 · What a board is

- **A board is a run of consecutive shots made as one clip**, and as one sheet of pictures for their
  frames. Its shots share one rendering, so faces, light and grade hold across them. Shots made one by
  one drift.
- **Only consecutive shots.** A board is one continuous clip cut at its shots' boundaries. Shots far apart
  in the scene, such as all of one person's close shots, cannot share a board.
- **Read the boards before you change them.** `get_scene_boards` gives `packed`: each board's shots,
  its seconds, and `startsBecause`. It also gives the route's `capSec` and the scene's `targetSec`.

## 2 · Set a length

- **A route's cap is not its best length.** A route that takes 15 seconds often holds a face and an action
  better over 10. Without a target, every board is filled to the cap.
- **Set the target with `set-board-target`** (`targetSec` in seconds; `null` clears it). Start at 10 for a
  route capped at 12 or more. Leave it unset when the cap is already 10 or less.
- **The target is a goal, not a refusal.** A shot longer than the target stands as a board of its own. A
  target at or over the cap changes nothing.

## 3 · Put each seam where the action turns

The packer fills boards up to the length and knows nothing about the story. Read the boards it made, then
move any seam that falls in the wrong place.

- **Cut where a beat has landed**: a line said and answered, a reaction given, someone entering or leaving,
  a move finished, a change in what someone wants.
- **Never split a line from its answer** when both fit in one board, and never start a board partway through a
  movement that the board before it began.
- **Each board opens on a known state.** Its first shot says where everyone is, what they hold and what they
  are doing, so the clip does not have to invent it.
- **Move a seam with `move-board-boundary`**, add one with `set-board-override` `split`, and remove an
  automatic one with `merge`. A seam that starts for `clip limit`, `target length` or `panel limit` cannot
  be merged away. To move it, split earlier, or change the target.

## 4 · Seams you cannot remove

- A seam that starts for `cast changes` or `time of day changes` is a real change. Merge across it only
  when the shots truly continue, and the board will carry a warning that says so.
- A shot that sings the production's song is a clip of its own.
- A shot made from references rather than a start frame opens its own clip.

## 5 · Check before you finish

- **Read `get_scene_boards` again** after any change, and check each board in turn. Its seconds are at or
  under the target. It starts on a turn in the action. Read its notes.
- **Avoid a board of one shot.** It gives no consistency across shots. Keep one only for a shot longer than
  the target, or one that has to stand alone.
- **Say what changed**: how many boards before and after, and the seconds of each. Each board is one paid
  clip. Fewer boards cost less, but a bad shot means remaking its whole board.
