import { LISTENING_FORMAT, LISTENING_VERSION, sentencesOf, type ListeningBlock, type ListeningChapter, type ListeningDocument, type ListeningDocumentChapter, type ListeningDocumentPhrase } from "@arke-studio/contracts";

/**
 * The listening plan as Arke Player's listening document (SPEC-058 R-10, R-11): the plan the
 * Studio's Listen plays, less the workshop — no block keys, takes, artifacts, hashes, sources,
 * gaps or notes. Times become whole milliseconds on each chapter's own clock.
 */

const ms = (seconds: number) => Math.round(seconds * 1000);
const SENTENCE_END = /[.!?…]["'”’)\]]*$/;

/**
 * Text's phrases from the blocks' sentences (R-11). A block read alone is one long entry; its
 * sentences take their share of it by length, as a grouped take's do (`blockSentences`). Where a
 * block has validated acoustic words they are the clock instead, grouped at sentence ends as the
 * shared player groups them, and each phrase carries its words (SPEC-047 R-70).
 */
export function phrasesOf(blocks: readonly ListeningBlock[], duration: number): ListeningDocumentPhrase[] {
  const phrases: ListeningDocumentPhrase[] = [];
  let last = 0;
  const add = (at: number, end: number, text: string, words?: ListeningDocumentPhrase["words"]) => {
    const from = Math.max(at, last);
    const until = Math.min(end, duration);
    if (until <= from || text.trim() === "") return;
    const inside = words?.filter((word) => word.at >= from && word.end <= until && word.at < word.end);
    phrases.push({ at: from, end: until, text, ...(inside !== undefined && inside.length > 0 ? { words: inside } : {}) });
    last = until;
  };
  for (const block of blocks) {
    const blockEnd = block.at + block.seconds;
    if (block.words !== undefined && block.words.length > 0) {
      let held: Array<{ at: number; end: number; text: string }> = [];
      let heard = 0;
      const flush = () => {
        if (held.length > 0) add(held[0]!.at, held[held.length - 1]!.end, held.map((word) => word.text).join(" "), held.map((word) => ({ ...word, text: word.text.slice(0, MAX_WORD) })));
        held = [];
      };
      for (const word of block.words) {
        // Words follow one another (R-13): one that starts inside the last starts as it ends.
        const at = Math.max(ms(word.startSec), heard);
        const end = ms(word.endSec);
        if (end <= at) continue;
        // A phrase holds at most its limit, so a long run without a sentence end is cut between words.
        if (held.length > 0 && [...held.map((w) => w.text), word.text].join(" ").length > MAX_PHRASE) flush();
        held.push({ at, end, text: word.text });
        heard = end;
        if (SENTENCE_END.test(word.text)) flush();
      }
      flush();
      continue;
    }
    block.sentences.forEach((sentence, index) => {
      const start = Math.max(block.at, sentence.at);
      const end = Math.min(blockEnd, block.sentences[index + 1]?.at ?? blockEnd);
      // Each sentence by its length, and a sentence longer than a phrase may be in pieces that
      // follow one another, never cut short: Text keeps every word the narration says.
      const parts = sentencesOf(sentence.text).flatMap(bounded);
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      let at = start;
      for (const part of parts) {
        const until = at + ((end - start) * part.length) / total;
        add(ms(at), ms(until), part);
        at = until;
      }
    });
  }
  return phrases;
}

const MAX_PHRASE = 2000;
const MAX_WORD = 200;

/** A text in pieces of at most a phrase's length, cut between words, a word longer than that by characters. */
function bounded(text: string): string[] {
  if (text.length <= MAX_PHRASE) return [text];
  const words = text.split(" ").flatMap((word) => (word.length <= MAX_PHRASE ? [word] : Array.from({ length: Math.ceil(word.length / MAX_PHRASE) }, (_, i) => word.slice(i * MAX_PHRASE, (i + 1) * MAX_PHRASE))));
  const pieces: string[] = [];
  let piece = "";
  for (const word of words) {
    if (piece !== "" && piece.length + 1 + word.length > MAX_PHRASE) {
      pieces.push(piece);
      piece = word;
    } else piece = piece === "" ? word : `${piece} ${word}`;
  }
  if (piece !== "") pieces.push(piece);
  return pieces;
}

/** One chapter read whole, its files named by the package's asset ids. */
export function documentChapter(
  chapter: ListeningChapter,
  ids: { audio: string; picture: (file: string) => string; motion: (file: string) => string | undefined; book?: string },
): ListeningDocumentChapter {
  const duration = ms(chapter.seconds);
  const pictures = chapter.pictures
    .filter((picture) => ms(picture.at) < duration)
    .map((picture, index, all) => {
      // A hold only where the picture leaves before the next one comes (R-14); otherwise it shows
      // until the next picture or the chapter's end on its own.
      const at = ms(picture.at);
      const until = Math.min(ms(picture.at + picture.seconds), duration);
      const natural = all[index + 1] !== undefined ? ms(all[index + 1]!.at) : duration;
      const video = picture.motion !== undefined ? ids.motion(picture.motion.file) : undefined;
      return {
        at,
        ...(until < natural && until > at ? { hold: until - at } : {}),
        picture: ids.picture(picture.file),
        // The same moment made Tall (SPEC-058 R-37): a phone in portrait shows it over the whole screen.
        ...(picture.tall !== undefined ? { tall: ids.picture(picture.tall) } : {}),
        ...(picture.focus !== undefined ? { focus: picture.focus } : {}),
        ...(video !== undefined && picture.motion !== undefined ? { motion: { video, behavior: picture.motion.behavior } } : {}),
      };
    });
  return {
    id: chapter.chapterId,
    order: chapter.order,
    title: chapter.title.trim() === "" ? `Chapter ${chapter.order}` : chapter.title.slice(0, 200),
    duration,
    audio: ids.audio,
    ...(ids.book !== undefined ? { book: ids.book } : {}),
    ...(chapter.opening !== null ? { opening: ids.picture(chapter.opening) } : {}),
    pictures,
    phrases: phrasesOf(chapter.blocks, duration),
  };
}

export function listeningDocument(title: string, cover: string | undefined, chapters: ListeningDocumentChapter[]): ListeningDocument {
  return { format: LISTENING_FORMAT, version: LISTENING_VERSION, timescale: 1000, title: title.trim() === "" ? "Audiobook" : title.slice(0, 200), ...(cover !== undefined ? { cover } : {}), chapters };
}
