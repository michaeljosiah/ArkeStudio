/** Only inventoried publication filenames reach a native picker; suffix guesses hide errors. */
export function storyPublicationFileFilter(file: string): { name: string; extensions: string[] } | null {
  switch (file) {
    case "story.epub": return { name: "EPUB book", extensions: ["epub"] };
    case "story.m4b": return { name: "M4B audiobook", extensions: ["m4b"] };
    case "story.pdf": return { name: "PDF book", extensions: ["pdf"] };
    default: return null;
  }
}
