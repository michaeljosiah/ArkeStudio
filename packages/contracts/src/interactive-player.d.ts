/**
 * Types for `interactive-player.js` (design turn 156): the one player the branch map's preview
 * mounts and the exporter inlines into player.html. The module is plain JavaScript so that its
 * own text can run in a package with nothing else on the page; these are its declarations.
 */

export interface InteractivePlayerScene {
  title: string;
  /** Played in order; none plays the scene as a slate (preview only — an export refuses it). */
  clips?: Array<string | InteractivePlayerClip>;
  /** A visual novel's scene (turn 174): read beat by beat instead of played; wins over `clips`. */
  beats?: InteractivePlayerBeat[];
}

/** One beat: a picture and a line, read at the viewer's pace. */
export interface InteractivePlayerBeat {
  picture?: string;
  /** The line; none is the picture alone. */
  text?: string;
  /** Who says it, as shown on the tab; none is narration. */
  speaker?: string;
  /** Its voice; none reads as text. */
  audio?: string;
  /** "voice": on after the voice; "tap": when the reader moves on (the default); "hold": after `holdSec`. */
  advance?: "voice" | "tap" | "hold";
  holdSec?: number;
  motion?: "push" | "drift" | "none";
}

/** A window into a file: from `from` seconds (default 0) to `to` (default the file's end). */
export interface InteractivePlayerClip {
  src: string;
  from?: number;
  to?: number;
}

export interface InteractivePlayerChoice {
  id: string;
  from: string;
  label: string;
  to: string;
}

export interface InteractivePlayerAuthor {
  /** Choices nobody has walked in preview; their cards say so. */
  unwalked: readonly string[];
  /** A choice pressed, with the scenes walked to reach it — the evidence route (brief §4). */
  onChoice?: (choice: InteractivePlayerChoice, walked: string[]) => void;
  onBranchMap?: () => void;
  onClose?: () => void;
}

export interface InteractivePlayerOptions {
  /** The production's title: the poster's heading and the eyebrow over each scene. */
  title: string;
  /** Above the poster's title: the world. */
  eyebrow?: string;
  start: string;
  scenes: Record<string, InteractivePlayerScene>;
  choices: readonly InteractivePlayerChoice[];
  endings: ReadonlyArray<{ sceneId: string; title: string }>;
  /** Where the viewer's place is kept on this device; none keeps nothing. */
  storageKey?: string | null;
  /** Preview from here: the route starts at this scene instead of the start. */
  from?: string;
  /** Skip the poster and play at once. */
  autoplay?: boolean;
  /** Present in the app's preview only: the author's strip and the walk evidence. */
  author?: InteractivePlayerAuthor;
}

export interface InteractivePlayerHandle {
  setUnwalked(ids: readonly string[]): void;
  destroy(): void;
}

/** `root` is the element the player fills — an HTMLElement; typed loosely because contracts carries no DOM library. */
export function mountInteractivePlayer(root: object, options: InteractivePlayerOptions): InteractivePlayerHandle;
