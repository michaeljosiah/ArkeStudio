/**
 * Types for `interactive-player.js` (design turn 156): the one player the branch map's preview
 * mounts and the exporter inlines into player.html. The module is plain JavaScript so that its
 * own text can run in a package with nothing else on the page; these are its declarations.
 */

export interface InteractivePlayerScene {
  title: string;
  /** Played in order; none plays the scene as a slate (preview only — an export refuses it). */
  clips: string[];
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
