import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject } from "@arke-studio/confined-tools";
import type { ChatTool } from "./ollama.js";

/**
 * An agent's own working memory, for Arke's harness (issue 1289 follow-up).
 *
 * Hosted harnesses bring their own: OpenCode's todo list, Claude Code's checklist and its
 * compaction. Arke's harness promised "keep your own scratch checklist" in every writing agent's
 * instructions and had no tool for it. Two things, kept apart on purpose:
 *
 * - The checklist is this session's: what the agent means to do for the ask in front of it.
 *   It goes with the session.
 * - Notes are the agent's across sessions, one file an agent a world, in a folder the app owns.
 * - The author's page is shared: what any agent learns about the person as a writer — their
 *   voice, what they like and dislike, how they like to work — is worth knowing in every world
 *   and to every agent, so it is one page beside the worlds' notes.
 *   They are read into the instructions when a session opens — the pattern Anthropic's memory
 *   tool uses: check memory first, expect the window to be reset at any time, write down what
 *   must survive it. They are working knowledge — what the author prefers, threads it is
 *   following, what it tried — never canon. The world's files decide what is true; a note that
 *   disagrees with them is the note that is wrong, and the instructions say so.
 */

/** Long enough for a page of working knowledge; short enough to read into every session. */
export const NOTES_LIMIT = 6_000;
/** The author's page is read into every session of every agent, so it is shorter. */
export const AUTHOR_NOTES_LIMIT = 4_000;

export const MEMORY_TOOLS: readonly ChatTool[] = [
  {
    type: "function",
    function: {
      name: "checklist",
      description: "Your checklist for this ask. Send the whole list each time; it replaces the last.",
      parameters: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { text: { type: "string" }, done: { type: "boolean" } },
              required: ["text"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "notes",
      description: `Notes kept between sessions. Not canon. about "world": your notes for this world (at most ${NOTES_LIMIT} characters). about "author": the page every agent shares about the author as a writer (at most ${AUTHOR_NOTES_LIMIT}). read returns a page; write replaces it.`,
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["read", "write"] },
          about: { type: "string", enum: ["world", "author"] },
          content: { type: "string" },
        },
        required: ["action"],
      },
    },
  },
];

export const MEMORY_TOOL_NAMES: ReadonlySet<string> = new Set(MEMORY_TOOLS.map((tool) => tool.function.name));

/** Where one agent's notes live, or null with no folder to keep them in. */
export function notesPath(memoryDir: string | undefined, agent: string): string | null {
  if (!memoryDir || !/^[a-z][a-z0-9-]*$/.test(agent)) return null;
  return join(memoryDir, `${agent}.md`);
}

export async function readNotes(path: string | null, limit = NOTES_LIMIT): Promise<string> {
  if (path === null) return "";
  try { return (await readFile(path, "utf8")).slice(0, limit); } catch { return ""; }
}

/** Where the author's page lives, or null when the host keeps none. */
export function authorPath(file: string | undefined): string | null {
  return file && file.endsWith(".md") ? file : null;
}

/**
 * The section an agent's instructions gain: how to use its memory, and what it wrote last time.
 * Written as instructions, not as evidence, so notes never read as the world's word.
 */
export function memoryInstructions(pages: { world: string | null; author: string | null }): string {
  const lines = [
    "## Your working memory",
    "Use checklist to plan and track this ask when it takes more than a step or two.",
  ];
  if (pages.world !== null || pages.author !== null) {
    lines.push("Use notes to keep what will matter next time. Write a whole page each time; keep it short and current. Notes are not canon: the world's files decide what is true, and a note that disagrees with them is wrong — correct it.");
  }
  if (pages.author !== null) {
    lines.push(
      "When the author tells you how they write or what they want in every story — their voice, what they like and dislike, how they like to work — call notes with action \"write\" and about \"author\" before you answer, keeping what the page already says. That is how it is remembered. It is not a change to the world: do not propose it as canon or as a candidate. Every agent reads this page, in every world.",
      pages.author.trim() === "" ? "The author page is empty so far." : `The author page:\n<author>\n${pages.author.trim()}\n</author>`,
    );
  }
  if (pages.world !== null) {
    lines.push(
      "Keep your own working notes for this world (about \"world\"): threads you are following, open questions, what you tried and how it went.",
      pages.world.trim() === "" ? "You have no notes for this world yet." : `Your notes for this world:\n<notes>\n${pages.world.trim()}\n</notes>`,
    );
  }
  return lines.join("\n");
}

/** One memory call, answered in words the model reads. Never throws for the model's mistakes. */
export async function runMemoryTool(
  name: string,
  args: JsonObject,
  state: { checklist: Array<{ text: string; done: boolean }>; notesPath: string | null; authorPath: string | null },
): Promise<string> {
  if (name === "checklist") {
    const items = Array.isArray(args.items) ? args.items : [];
    state.checklist = items.flatMap((raw) => {
      const item = raw as { text?: unknown; done?: unknown } | null;
      return item && typeof item.text === "string" && item.text.trim() !== "" ? [{ text: item.text.trim().slice(0, 300), done: item.done === true }] : [];
    }).slice(0, 30);
    return state.checklist.length === 0 ? "Checklist cleared." : state.checklist.map((item) => `${item.done ? "[x]" : "[ ]"} ${item.text}`).join("\n");
  }
  const author = args.about === "author";
  const path = author ? state.authorPath : state.notesPath;
  const limit = author ? AUTHOR_NOTES_LIMIT : NOTES_LIMIT;
  if (path === null) return author ? "No author page is kept in this session." : "World notes are not kept in this session: no world is open.";
  if (args.action === "read") {
    const notes = await readNotes(path, limit);
    return notes.trim() === "" ? (author ? "The author page is empty so far." : "You have no notes for this world yet.") : notes;
  }
  if (args.action === "write") {
    if (typeof args.content !== "string") return "Nothing written: write needs content, the whole page.";
    if (args.content.length > limit) return `Nothing written: ${author ? "the author page is" : "notes are"} at most ${limit} characters, and this is ${args.content.length}. Shorten it and write again.`;
    await writeNotes(path, args.content);
    return `${author ? "Author page" : "Notes"} saved (${args.content.length} characters).`;
  }
  return "Unknown action: use read or write.";
}

/** Whole or not at all: a note cut short by a crash would be read as the agent's word next time. */
async function writeNotes(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const staged = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(staged, content, "utf8");
  await rename(staged, path);
}
