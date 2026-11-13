import { lstat, opendir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate as yieldWork } from "node:timers/promises";
import { toExtendedLength } from "../world/paths.js";

/**
 * The census (SPEC-066 R-38), as plainly as it can be done: every record a world or the app keeps
 * is read as text, and every id or file name in it is protected. A record names an artifact, a
 * Bench take or a session by an id no other thing has (`ar_`, `tk_`, `sess_` and a ULID), and a
 * file by its name, so finding the name finds the record, whatever its shape: a chapter's takes at
 * any key, a timeline's undo stack, a conversation, a queued job, a version in `.history`. A
 * name that is also part of another name is kept too; that errs only towards keeping.
 *
 * Only `changes.jsonl` is read apart: a name found there alone is history, not a holder (R-39).
 * A record that cannot be read stops every class that asks the census (R-8).
 */
export interface Census {
  /** Where each id was found: `sess:<id>` for a Bench session's own files, `side:<id>` for an artifact's own sidecar, `changes` for the change log, `rec` for any other record. */
  named: Map<string, Set<string>>;
  /** File names (of `watch`) found in any record but their own sidecar. */
  files: Map<string, Set<string>>;
  /** The record that could not be read, when one could not. */
  unreadable: string | null;
}

const ID = /\b(?:ar|tk|sess)_[0-9A-HJKMNP-TV-Z]{26}\b/g;
const SPLIT = /[\s"'`,;:()[\]{}<>|\\/=]+/;
const TEXT = /\.(?:json|jsonl|md|txt|ya?ml|csv|html?)$/i;
/** Folders of media, derived files and Clean up's own hold: no record lives there. */
const SKIP_TOP = new Set([".cache", ".held", ".index", "exports"]);
const MAX_RECORD = 64 * 1024 * 1024;

export async function takeCensus(worldDir: string, appRoot: string | null, watch: ReadonlySet<string>, signal: AbortSignal): Promise<Census> {
  const census: Census = { named: new Map(), files: new Map(), unreadable: null };
  // Names a tokeniser would split are looked for whole.
  const awkward = [...watch].filter(name => SPLIT.test(name));
  let since = performance.now();
  const note = (map: Map<string, Set<string>>, key: string, tag: string) => { let set = map.get(key); if (!set) map.set(key, set = new Set()); set.add(tag); };
  const read = async (path: string, label: string, tag: string, own?: string) => {
    let text: string;
    try { text = await readFile(toExtendedLength(path), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") census.unreadable ??= label; return; }
    for (const match of text.matchAll(ID)) if (match[0] !== own) note(census.named, match[0], tag);
    for (const token of text.split(SPLIT)) if (watch.has(token)) note(census.files, token, tag);
    for (const name of awkward) if (text.includes(name)) note(census.files, name, tag);
    if (performance.now() - since > 50) { await yieldWork(); signal.throwIfAborted(); since = performance.now(); }
  };
  const walk = async (dir: string, rel: string, tagFor: (rel: string) => string): Promise<void> => {
    let handle;
    try { handle = await opendir(toExtendedLength(dir), { bufferSize: 64 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") census.unreadable ??= rel || "the world folder"; return; }
    for await (const entry of handle) {
      signal.throwIfAborted();
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (!rel && SKIP_TOP.has(entry.name)) continue;
      if (entry.isDirectory()) {
        // A Bench take's media folder holds pictures and video, never a record.
        if (/^\.sessions\/[^/]+\/media$/.test(child)) continue;
        await walk(join(dir, entry.name), child, tagFor);
      } else if (entry.isFile() && TEXT.test(entry.name)) {
        if (child === "changes.jsonl") { await read(join(dir, entry.name), child, "changes"); continue; }
        // Clean up's own ledger names what it held: history of clean-up, never a holder.
        if (child === "cleanup.jsonl") continue;
        if (/^artifacts\/[^/]+\.json$/.test(child)) {
          // A sidecar names its own id and file: those are not a holder of themselves.
          const raw = await readFile(toExtendedLength(join(dir, entry.name)), "utf8").catch(() => null);
          const own = raw === null ? undefined : (() => { try { return (JSON.parse(raw) as { id?: string }).id; } catch { return undefined; } })();
          const tag = own ? `side:${own}` : "rec";
          await read(join(dir, entry.name), child, tag, own);
          continue;
        }
        const size = await lstat(toExtendedLength(join(dir, entry.name))).then(info => info.size, () => 0);
        if (size > MAX_RECORD) { census.unreadable ??= child; continue; }
        await read(join(dir, entry.name), child, tagFor(child));
      }
    }
  };
  await walk(worldDir, "", rel => { const session = /^\.sessions\/([^/]+)\//.exec(rel); return session ? `sess:${session[1]}` : "rec"; });
  // The app keeps the job queue and its operations beside the worlds: a queued job names its inputs there.
  if (appRoot) for (const folder of ["queue", "operations"]) await walk(join(appRoot, folder), folder, () => "rec");
  return census;
}

/** Named by a holder other than the ones given (its own sidecar, its own session, the change log). */
export const namedElsewhere = (tags: ReadonlySet<string> | undefined, ...own: string[]) => !!tags && [...tags].some(tag => tag !== "changes" && !own.includes(tag));
