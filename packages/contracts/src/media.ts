import { z } from "zod";
import { IsoDateTimeSchema } from "./ids.js";

/**
 * What a file actually is, measured rather than assumed (#253).
 *
 * A track whose length is unknown cannot be a clock, and a take whose length is unknown cannot be
 * checked against the window it was cut for — so both the spine and the cut refuse to guess here.
 * Nothing in this shape is declared by a user or inferred from a filename: it is ffprobe's answer,
 * parsed at a strict boundary, or it is absent.
 */
export const MediaInfoSchema = z
  .object({
    durationSec: z.number().positive(),
    hasAudio: z.boolean(),
    /**
     * Whether a picture stream was found, cover art aside. Optional because it was not always
     * recorded: absent means unknown, and a filing decision is made only on a measured `false`,
     * the same distinction `hasAudio` needs between silence and a probe that could not say.
     */
    hasVideo: z.boolean().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    frameRate: z.number().finite().positive().optional(),
    audioChannels: z.number().int().positive().optional(),
    audioSampleRateHz: z.number().int().positive().optional(),
  })
  .strict();
export type MediaInfo = z.infer<typeof MediaInfoSchema>;

/**
 * A probe result for one take's media, stored beside the take and never inside it.
 *
 * `take.json` is immutable — it is the record of what was dispatched and what came back, and a
 * measurement taken afterwards is neither. Writing the duration into it would also make a failed
 * probe indistinguishable from a take that was never probed, and turn a retry into a rewrite of
 * paid history. So this lands at
 * `productions/<productionId>/takes/<sourceTakeId>/media-info.json` instead, and a take with no
 * record is simply one nobody has measured yet.
 *
 * `sourceHash` is the full hash of the bytes that were measured, so a record that outlived its
 * media — or was copied beside different media — is detectable rather than quietly believed.
 */
export const TakeMediaInfoRecordSchema = z
  .object({
    sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    mediaInfo: MediaInfoSchema,
    probedAt: IsoDateTimeSchema,
  })
  .strict();
export type TakeMediaInfoRecord = z.infer<typeof TakeMediaInfoRecordSchema>;

/**
 * The name a downloaded media file lands under (issue 478).
 *
 * Shared rather than written twice: the browser build puts this on an anchor's `download` and
 * the desktop host puts it in the save dialog's default path, and a filename that two halves
 * sanitise differently is a filename nobody can predict. Nothing here decides *where* a file
 * goes — only what it is called once the person has chosen.
 *
 * The extension always comes from the source path, never from the offered name: a JPEG asked to
 * be called "Maren Kest main photo" is `Maren Kest main photo.jpg`, not `.png` and not extensionless.
 */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** The `.ext` of a world-relative media path, lowercased, or "" when it has none. */
export function mediaExtension(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  // A leading dot is a hidden file, not an extension — ".gitignore" has no type to preserve.
  if (dot <= 0) return "";
  const ext = base.slice(dot).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : "";
}

/**
 * A save name for the file at `path`, preferring `offered` as the stem when one is given.
 *
 * Path separators, the characters Windows refuses, and control bytes are stripped rather than
 * escaped — a name that survives here is a name every platform will actually take. Reserved
 * device names are prefixed, not rejected, so a character called "Aux" still downloads.
 */
export function downloadFileName(path: string, offered?: string | null): string {
  const ext = mediaExtension(path);
  const sourceStem = (() => {
    const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
    return ext ? base.slice(0, base.length - ext.length) : base;
  })();
  // An offered name that already carries the extension is a filename, not a stem — "cover.png"
  // must not land as "cover.png.png". Only the file's own extension is taken off, so a character
  // called "Ana.Webp" keeps her name.
  const trimmed = (offered ?? "").trim();
  const offeredStem =
    ext !== "" && trimmed.toLowerCase().endsWith(ext) ? trimmed.slice(0, trimmed.length - ext.length) : trimmed;
  // Anything that could reach out of the folder the person picked, plus the bytes no filesystem
  // stores: taken out, so what is left is only ever a name.
  const printable = (value: string): string =>
    // By code point rather than by a character class: the same answer, without writing a regex
    // that is itself full of control characters.
    Array.from(value)
      .filter((ch) => ch >= " " && ch.charCodeAt(0) !== 127)
      .join("");
  const clean = (value: string): string =>
    printable(
      // A line break is a gap between words before it is a control byte, so it becomes one
      // rather than closing up: two lines are two words, not one run-on.
      value.replace(/[\t\n\r]/g, " "),
    )
      .replace(/[\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .trim();
  // Three chances, narrowing: what the screen offered, what the file is called, and a word. An
  // offer that sanitises away to nothing is no reason to lose the name the file already had.
  let stem = clean(offeredStem) || clean(sourceStem) || "image";
  if (WINDOWS_RESERVED.test(stem)) stem = `_${stem}`;
  // Long enough for any name a person would recognise, short enough that the whole path still
  // fits under the limits Windows enforces once a chosen folder is in front of it.
  if (stem.length > 120) stem = stem.slice(0, 120).trimEnd();
  return `${stem}${ext}`;
}
