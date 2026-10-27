import type { StoryPredicate, StoryFact, StoryEffect, StoryPresentation, StoryEnding } from "./story-state-schema.js";
export type StoryState = Record<string, boolean | string>;
export interface StoryProgram {
  start: string;
  facts?: StoryFact[];
  choices: ReadonlyArray<{ id: string; from: string; to: string; when?: StoryPredicate; effects?: StoryEffect[]; unavailable?: { label?:string; reason:string } }>;
  presentation?: StoryPresentation[];
  endings: ReadonlyArray<{ sceneId: string; title: string; variants?: StoryEnding[] }>;
}
export interface StoryPoint { sceneId: string; state: StoryState; origins: Record<string, string | null>; prefix: string[] }
export function storyDefaults(program: StoryProgram): StoryState;
export function storyPredicate(predicate: StoryPredicate | undefined, state: StoryState): boolean;
export function validateStoryProgram(program: StoryProgram): void;
export function storyReplay(program: StoryProgram, prefix?: readonly string[]): Omit<StoryPoint, "prefix">;
export function storyIdentity(value: unknown): string;
export function storyEnding(program: StoryProgram, sceneId: string, state: StoryState): { title: string; text?: string } | undefined;
export function storyVisibleBeats<T extends { shotId?: string; pictureShotId?: string; blockId?: string }>(program: StoryProgram, sceneId: string, beats: T[], state: StoryState): T[];
export function exploreStory(program: StoryProgram, limits?: { states?: number; transitions?: number; witnessEntries?: number }): {
  complete: boolean; limit?: "witness"; points: StoryPoint[]; transitions: Array<{from: number; to: number; choiceId: string}>; problems: Array<StoryPoint & {detail: string}>;
};

export function storyFactReferences(program: StoryProgram, id: string): Array<{kind: string; id: string; label: string}>;
