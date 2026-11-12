import type { StoryProgram } from "./story-state.js";
import type { StoryPredicate, StoryEffect } from "./story-state-schema.js";
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

/** One beat: a picture and a line, moving on by itself once heard (turn 246). */
export interface InteractivePlayerBeat {
  shotId?: string;
  pictureShotId?: string;
  blockId?: string;
  picture?: string;
  /** The line; none is the picture alone. */
  text?: string;
  /** Who says it, as shown on the tab; none is narration, unless `dialogue` says otherwise. */
  speaker?: string;
  /** A line of dialogue still waiting for its speaker: shown as dialogue, never as narration. */
  dialogue?: boolean;
  /** Its voice; none reads as text. */
  audio?: string;
  /**
   * "voice" (the default): after the line — 1.2 s after its voice, or its reading time unvoiced;
   * "hold": after `holdSec`. "tap" is read from older packages and plays as "voice" (turn 246).
   */
  advance?: "voice" | "tap" | "hold";
  holdSec?: number;
  motion?: "push" | "drift" | "none";
  /** Keeps the beat before's picture, still moving: a shot's next line, or a same-picture beat. */
  keep?: boolean;
}

/** A window into a file: from `from` seconds (default 0) to `to` (default the file's end). */
export interface InteractivePlayerClip {
  src: string;
  from?: number;
  to?: number;
}

export interface InteractivePlayerChoice {
  unavailable?: { label?: string; reason:string };
  when?: StoryPredicate;
  effects?: StoryEffect[];
  id: string;
  from: string;
  label: string;
  to: string;
}

export interface InteractivePlayerAuthor {
  /** Choices nobody has walked in preview; their cards say so, and the strip counts them. */
  unwalked: readonly string[];
  /**
   * A choice pressed, or a lone way played through (turn 246), with the scenes walked to reach it —
   * the evidence route (brief §4).
   */
  onChoice?: (choice: InteractivePlayerChoice, walked: string[], story?: { identity: string; prefix: string[]; before: string; after: string; provenance: "human" | "automated" }) => void;
  onBranchMap?: () => void;
  onClose?: () => void;
  /** Pick another reachable prefix into the current scene; never an authored state override. */
  onTestRoute?: (sceneId:string) => void;
}

export interface InteractivePlayerOptions {
  story?: StoryProgram;
  /** Resume a named stateful playthrough; Start again creates a separate run. */
  playthroughId?: string;
  prefix?: string[];
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
  /** Where in `from` to begin: a beat scene's beat index, a clip scene's seconds. */
  at?: number;
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
