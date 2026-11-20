import { BibleEditError, GENERIC_ERROR_COPY, SceneOperationRefused } from "@arke-studio/contracts";
import { EditorRequestRefused } from "../productions/editor-requests.js";
import { MusicRefusal } from "../productions/music.js";
import { SceneDeleteRefused } from "../productions/ops.js";
import { SceneCommandRefused, SceneVersionMoved } from "../productions/scene-commands.js";
import { SceneEditRefused } from "../productions/scene-edits.js";
import { SceneFlowRefused } from "../productions/scene-record.js";
import { AudioSpineCommandRefused } from "../productions/spine.js";
import { TimelineCommandRefused } from "../productions/timeline.js";
import { BibleStaleError } from "../world/bible.js";
import { CommitStaleError } from "../world/commit.js";
import { WorldStateStaleError } from "../world/store.js";
import { describeCoordinatorError } from "./user-message.js";

/** More blockers than this are counted, not listed: the card is read, not scrolled. */
const LISTED_REASONS = 6;

/**
 * Is this something an authority refused on purpose, in words for whoever asked?
 *
 * Each class here is thrown deliberately by an authority an approved card can reach, with a
 * sentence about the change that was asked for: what stands in the way, or what moved. A plain
 * `Error` is not on the list even where its message happens to be a sentence, because nothing
 * tells it apart from a file that would not read or a bug, whose words are for a log.
 *
 * Matched by class, as `worldOpenFailureKind` is: the desktop ships through a bundler, and a
 * class name that survives it today is not something anybody has promised.
 */
function isRefusal(err: unknown): err is Error {
  return err instanceof SceneCommandRefused || err instanceof SceneOperationRefused || err instanceof SceneDeleteRefused ||
    err instanceof SceneVersionMoved || err instanceof SceneFlowRefused || err instanceof SceneEditRefused ||
    err instanceof AudioSpineCommandRefused || err instanceof TimelineCommandRefused || err instanceof EditorRequestRefused ||
    err instanceof MusicRefusal || err instanceof BibleEditError || err instanceof BibleStaleError ||
    err instanceof WorldStateStaleError || err instanceof CommitStaleError;
}

/**
 * One reason as a sentence of its own. The authorities write them as clauses, "shot 1 is anchored
 * to the track — move or clear the anchor first", to be joined by whoever shows them. A reason
 * that opens on an id or a quoted name keeps its first letter: `sh_01…` capitalised is another id.
 */
function sentence(reason: string): string {
  const text = reason.trim().replace(/^[a-z]+(?=\s)/, (word) => word.charAt(0).toUpperCase() + word.slice(1));
  return text === "" || /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * An authority's own refusal, as the words a failed card shows (issue 3135), or null when the
 * error is not one.
 *
 * A card that removed a scene's four shots failed with "The authority failed while executing the
 * approved action." The authority had refused in a sentence a person could act on, and the catch
 * that turned its throw into a failed card kept none of it. Arke, asked why, could not see the
 * reason either, guessed a wrong one and prepared the same deletion again.
 *
 * `describeCoordinatorError` still judges the words: a refusal that quotes a path off the disk
 * is answered null, so its caller says the generic line and logs the cause instead. Several
 * blockers read as that many sentences, each one a thing the person can clear.
 */
export function describeRefusal(err: unknown): string | null {
  if (!isRefusal(err)) return null;
  const plain = describeCoordinatorError(err);
  if (plain === GENERIC_ERROR_COPY) return null;
  const listed = "reasons" in err && Array.isArray(err.reasons)
    ? err.reasons.filter((reason): reason is string => typeof reason === "string" && reason.trim() !== "")
    : [];
  const reasons = listed.length > 0 ? listed : [plain];
  const more = reasons.length - LISTED_REASONS;
  return [...reasons.slice(0, LISTED_REASONS).map(sentence), ...(more > 0 ? [`And ${more} more.`] : [])].join(" ");
}
