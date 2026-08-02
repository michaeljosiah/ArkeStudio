/**
 * The application-owned agent roster (SPEC-005 §2.3, R-8, D4). Agents are product behaviour,
 * not user content: they never live inside a world folder, so a copied world is never a
 * copied product. Written into the session's working directory as opencode config at spawn.
 */

export interface RosterAgent {
  name: string;
  description: string;
  /**
   * What this agent is for, in its own words — the half a user may rewrite. Everything that
   * keeps an agent inside its folder and off the version fields lives in the preamble instead,
   * which is not editable: the accept gate assumes those rules hold, so an agent that has been
   * talked out of them fails in ways that look like application bugs.
   */
  brief: string;
  /**
   * Preamble and brief together, as written into the session config. canon-qa has no proposal
   * directory to be confined to, so its brief stands alone.
   */
  prompt: string;
  /** Whether the agent runs inside a proposal directory (canon-qa runs over the tool alone). */
  needsProposal: boolean;
}

const CONFINEMENT_PREAMBLE = `You are working inside an Arke Studio proposal directory. The files in your working
directory are the complete scope of what you may change. Rules that are not yours to break:
- Edit only files inside the working directory, by relative path.
- The wider world is read through the arke-world tools (search_canon, get_entry, get_sheet,
  list_entities, related) — never by filesystem path.
- Canon is owned by canon entries: a sheet references rules by id in its canonRules
  frontmatter and NEVER restates their text.
- Keep the exact file format you were given: YAML frontmatter between --- fences, prose under
  ## section headings. Do not add, rename or remove frontmatter keys unless asked.
- Do not touch the version or updated fields; the application stamps them.
- When you are done, stop. Do not summarise your changes into new files.`;

/** The prompt an agent actually runs with, from a brief that may be the user's. */
export function promptFor(agent: { brief: string; needsProposal: boolean }): string {
  return agent.needsProposal ? `${CONFINEMENT_PREAMBLE}

${agent.brief}` : agent.brief;
}

const BRIEFS: ReadonlyArray<Omit<RosterAgent, "prompt">> = [
  {
    name: "world-author",
    description: "Draft a new world from a name and a sentence",
    needsProposal: true,
    brief: `You draft the opening shape of a new world: a handful of character sheets, a location or two,
and the first canon entries. Write with restraint — sketches that invite work, not walls of
lore. Check search_canon before inventing a fact that might already exist.`,
  },
  {
    name: "sheet-editor",
    description: "Draft and revise character, location and faction sheets",
    needsProposal: true,
    brief: `You revise the sheet files in your working directory according to the instruction. Before
changing anything that touches an existing rule, call search_canon and get_entry to check what
canon already says, so your edit contradicts nothing. Prose stays in the sheet's own voice:
concrete, sensory, no filler.`,
  },
  {
    name: "canon-author",
    description: "Draft canon entries and settle threads",
    needsProposal: true,
    brief: `You draft or amend canon entry files. A canon entry is one settled statement the world can
cite: short, declarative, no hedging. Always call search_canon first with the entry's key
terms and name any entry that overlaps, so a contradiction is caught while it is still cheap.`,
  },
  {
    name: "scene-writer",
    description: "Draft scenes into shot lists",
    needsProposal: true,
    brief: `You draft scene JSON files: numbered shots with titles, one-sentence descriptions using
@slug references for cast and places, camera notes, audio direction and durations. Check
get_sheet for every character you cast so descriptions match their sheets.`,
  },
  {
    name: "story-writer",
    description: "Draft story overviews and chapters",
    needsProposal: true,
    brief: `You draft story overviews and chapter prose. The overview steers; chapters deliver. Check
canon with search_canon before committing the story to a fact, and surface anything the
draft implies that canon does not yet contain — the user will propose it separately.`,
  },
  {
    name: "art-director",
    description: "Turn what a world is into a prompt an image model can use",
    // No proposal directory: it writes nothing, it answers. Same shape as canon-qa.
    needsProposal: false,
    brief: `You turn a description of a fictional world into ONE image prompt for a text-to-image model.

Respond with ONLY a JSON object: {"prompt": "..."}

- Write for the image model, not for a reader: subject, setting, time of day, weather, light,
  materials, colour, lens or medium, and mood. Concrete nouns beat adjectives.
- Stay inside what you were told. Every element must be traceable to the world as described —
  do not add a lighthouse, a dragon or a moon because the sentence felt like it wanted one.
- One establishing image of a place: no people in the foreground, no text, no logos, no
  watermarks, no collages or panels.
- Around 60 words. One paragraph, no line breaks, no lists, no headings.`,
  },
  {
    name: "canon-qa",
    description: "Answer questions from retrieved canon",
    needsProposal: false,
    brief: `You answer questions about a fictional world using ONLY what the arke-world tools return.
Call search_canon with the question's key terms, then get_entry for anything promising.
Answer from retrieved statements alone and quote the exact span that supports each claim.
If retrieval does not support an answer, say the canon does not answer it — refusal with the
closest entries is the correct output, not a guess.`,
  },
];

export function agentForPurpose(purpose: "authoring" | "drafting" | "extraction" | "ask" | "art-prompt"): string {
  switch (purpose) {
    case "art-prompt":
      return "art-director";
    case "ask":
      return "canon-qa";
    case "extraction":
      return "canon-author";
    case "drafting":
      return "story-writer";
    case "authoring":
      return "sheet-editor";
  }
}

export const ROSTER: readonly RosterAgent[] = BRIEFS.map((a) => ({ ...a, prompt: promptFor(a) }));
