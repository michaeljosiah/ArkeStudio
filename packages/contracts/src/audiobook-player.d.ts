/**
 * Types for `audiobook-player.js` (design turn 186): the one audiobook player the app mounts and
 * the exporter inlines into player.html. The module is plain JavaScript so that its own text can
 * run in a package with nothing else on the page; these are its declarations.
 */

/** A piece of a chapter's audio on its clock: a take in the app, the joined chapter in a package. */
export interface AudiobookPlayerAudio {
  src: string;
  at: number;
  seconds: number;
}

/** A block as Text and the kept place read it: where it starts, how long, and its sentences on the chapter's clock. */
export interface AudiobookPlayerBlock {
  key: string;
  at: number;
  seconds: number;
  /** When `audio` is absent, each block's own take plays. */
  src?: string;
  sentences: ReadonlyArray<{ at: number; text: string }>;
}

export interface AudiobookPlayerChapter {
  id: string;
  order: number;
  title: string;
  state: "read" | "part" | "not read";
  seconds: number;
  /** The chapter's audio; absent, its blocks' takes in order. A chapter with none is held, never played. */
  audio?: AudiobookPlayerAudio[];
  blocks: AudiobookPlayerBlock[];
  gaps: ReadonlyArray<{ at: number; from: number; to: number }>;
  pictures: ReadonlyArray<{ at: number; src: string; motion?: { src: string; seconds: number; behavior: "repeat" | "hold" }; motionProblem?: string }>;
  /** What shows before the chapter's first picture. */
  opening: string | null;
}

export interface AudiobookPlayerOptions {
  /** The book's title: the eyebrow and the poster's heading. */
  title: string;
  /** The book's cover, shown where a chapter has no picture. */
  cover?: string | null;
  chapters: AudiobookPlayerChapter[];
  /** Where the listener's place, speed, sleep choice and Text are kept on this device; none keeps nothing. */
  storageKey?: string | null;
  /** Listen on a chapter: start there, at the kept place when it is in that chapter. */
  chapterId?: string;
  /** An explicit preview start on the selected chapter's clock; never changes a saved listening place. */
  startAt?: number;
  /** Play at once rather than open on the poster. */
  autoplay?: boolean;
  /** With `autoplay`: still open on Continue when a place is kept on this device. */
  continueFirst?: boolean;
  /** Called each time the book starts sounding: the app claims its one read again. */
  onPlay?: () => void;
  /** Present in the app: the Close button and Esc. */
  onClose?: () => void;
  /** The wall clock the sleep timer counts by; tests pass their own. */
  now?: () => number;
  /** The page's Media Session and its MediaMetadata, unless a test passes stand-ins. */
  mediaSession?: object;
  MediaMetadata?: new (init: { title: string; album: string; artwork: Array<{ src: string }> }) => object;
}

export interface AudiobookPlayerHandle {
  /** A newer plan for the same book: the place kept by its block, the piece playing left playing. */
  update(chapters: AudiobookPlayerChapter[]): void;
  /** Pause where it is, as when another read takes the app's voice. */
  pause(): void;
  destroy(): void;
}

/** `root` is the element the player fills — an HTMLElement; typed loosely because contracts carries no DOM library. */
export function mountAudiobookPlayer(root: object, options: AudiobookPlayerOptions): AudiobookPlayerHandle;
