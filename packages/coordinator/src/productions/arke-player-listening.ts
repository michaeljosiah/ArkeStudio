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
      const flush = () => {
        if (held.length > 0) add(held[0]!.at, held[held.length - 1]!.end, held.map((word) => word.text).join(" "), held);
        held = [];
      };
      for (const word of block.words) {
        held.push({ at: ms(word.startSec), end: ms(word.endSec), text: word.text.slice(0, 200) });
        if (SENTENCE_END.test(word.text)) flush();
      }
      flush();
      continue;
    }
    block.sentences.forEach((sentence, index) => {
      const start = Math.max(block.at, sentence.at);
      const end = Math.min(blockEnd, block.sentences[index + 1]?.at ?? blockEnd);
      const parts = sentencesOf(sentence.text);
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      let at = start;
      for (const part of parts) {
        const until = at + ((end - start) * part.length) / total;
        add(ms(at), ms(until), part.slice(0, 2000));
        at = until;
      }
    });
  }
  return phrases;
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
