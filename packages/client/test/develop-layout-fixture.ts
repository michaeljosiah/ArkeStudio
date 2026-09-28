import { type ClientState, type StagedProposal } from "@arke-studio/contracts";
import { CHAT_ID, chatArtifactsFixture } from "./chat-artifacts-fixture.js";
export { CHAT_ID };

export function developLayoutFixture(mode = "normal"): ClientState {
  const state = chatArtifactsFixture(), world = state.world!, film = world.productions[0]!;
  state.app.harnessInfo = { generation: "codex", source: "path", version: "test", beta: false };
  state.app.harnessModelStatus = { status: "ready" };
  state.app.harnessModels = [{id:"story-author",provider:"openai",displayName:"Story author"}];
  world.conversations = [{ ...world.conversations[0]!, entryContext: { kind: "production", productionId: "saltlight" } }];
  const messages = ["It should end with Maren choosing the harbour over the song. Not a victory.", "Then the middle has to cost her something the song was giving her, or the choice is free. Scene 4 is where she still has both, so that is the last place the price can be set.", "Her hearing. She loses the bells first.", "That gives the film a spine I can state in one line, and it changes the third act rather than the scenes you have already locked."];
  state.worldChat!.messages.forEach((message, i) => { message.text = messages[i]!; message.receipts = i === 1 ? ["read 7 accepted scenes", "nothing written"] : i === 3 ? ["read Maren Kest v4", "searched 41 canon entries"] : []; });
  state.worldChat!.points = [
    { ...state.worldChat!.points[0]!, subject: "The ending", subjectKind: "story", text: "Maren chooses the harbour over the song. Not a victory." },
    { ...state.worldChat!.points[1]!, subject: "The price", subjectKind: "spine", text: messages[2]! },
    { ...state.worldChat!.points[2]!, subject: "Scene 4", subjectKind: "note", text: "The last place she holds both; the price is set here." },
    { ...state.worldChat!.points[3]!, subject: "Still open", text: "What the song was giving her." },
  ];
  film.story = { version: 4, logline: "One night on the Vigil, the verse rises early — and the bill goes to the man standing next to her.", spine: "A watch, a correction, a rupture.", acts: [{title: "The watch"}, {title: "The price"}, {title: "Slack water"}] };
  film.narrative = { version: 3, question: "Will she ever ask why putting the water back has never cost her much?", direction: "A watch, a correction, a rupture — told at the pace of the water.", ending: "Cut before she can follow the Chorister’s look. We do not subtitle the song.", arcNotes: "Maren hears the price before she chooses it." };
  const book = structuredClone(film);
  book.meta = { ...book.meta, id: "ledger", format: "story", medium: "story", kind: "novel", title: "The Ledger of Nights" };
  book.scenes = []; book.takes = []; book.sceneFiles = {}; book.selections = {}; book.narrative = null;
  book.story = { version: 6, targetLength: "novella", logline: "The harbour’s luck was never free. A tide-caller finds the invoice, and her own name is not on it.", spine: "Maren goes looking for a forger in the Vigil’s ledger and finds an accounts department. Every tide her town has argued with for two centuries was paid for in fractions of hearing, drawn automatically from whoever stood close enough to lend it — no signature, no consent, nothing anyone chose. The book is not the mystery. The book is the receipt.", acts: [
    {title: "First night · 1820", summary: "A watchkeeper strikes through a predicted tide and writes what the water actually did, then a second correction: called it back. paid."},
    {title: "Second night · 1901", summary: "The same hand, eighty-one years on, with both columns filled in one sitting. She stops looking for a forger."},
    {title: "Third night · 1974", summary: "Ines Half-Hitch audits the ledger and finds it accurate, which is the finding."},
    {title: "Fourth night · not yet", summary: "An entry three weeks ahead in a hand she now recognises as her own."},
  ] };
  book.treatment = ""; book.proseStyle = mode === "style" ? { version: 2, pov: "close third", tense: "past", voice: "Weather and stone before feeling.", samples: ["Six, and the tide not yet called."] } : null;
  book.chapters = book.story.acts!.map((act, i) => ({ id: `chapter-${i+1}`, file: `chapter-${i+1}`, order: i+1, title: ["Neap", "The same ink", "Nothing wrong with it", "Her own hand"][i]!, status: "planned", version: 1, words: 564 }));
  world.productions = [film, book];
  if (mode === "staged" || mode === "blocked") {
    const path = "productions/saltlight/story.json";
    const staged: StagedProposal = {
      proposal: {id: "pr_01J8H0000000000000000000P1", kind: "sheet-edit", summary: "From this conversation · 3 fields", targets: [{path,baseVersion:4,baseHash:"sha256:9f2c66a1b0e4d8c2"}],baseCanonRevision:42,reservedCanonIds:[],source:"world-chat:"+CHAT_ID,created:"2026-07-30T18:00:00Z",draftRevision:1,
        worldChatOrigins:[{ requestId:"develop",conversationId:CHAT_ID,candidateId:state.worldChat!.points[0]!.id,candidateRevision:1,targetPaths:[path],fields:["logline"] }],
        ...(mode === "blocked" ? { conflicts: [{path,field:"logline",base:"Old",mine:"New",theirs:"Changed elsewhere"}] } : {}),
      },
      ripple:{computedAt:"2026-07-30T18:00:01Z",governing:false,items:[]},
      review:{targets:[{path,label:"Story",kind:"story",action:"amend",fields:[
        {field:"Logline",before:film.story.logline!,proposed:"One night on the Vigil, the verse rises early, and the price is her hearing."},
        {field:"Act III · Slack water",before:null,proposed:"She chooses the harbour over the song. The bells go first. Not a victory."},
        {field:"Scene 4 · note",before:null,proposed:"The last place she holds both."},
      ]}]},
    };
    world.proposals = [staged];
  }
  if (mode === "empty-thread") { world.conversations = []; state.worldChat = null; }
  return state;
}
