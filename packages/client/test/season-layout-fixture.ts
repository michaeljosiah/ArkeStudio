import { ProductionSetupStateSchema, type ClientState, type Scene, type Routing } from "@arke-studio/contracts";
import { developLayoutFixture, CHAT_ID } from "./develop-layout-fixture.js";
export { CHAT_ID };

export function seasonLayoutFixture(mode = "season"): ClientState {
  const state = developLayoutFixture(mode === "staged" ? "staged" : "normal"), world = state.world!, film = world.productions[0]!;
  const at = "2026-09-28T14:00:00Z";
  const makeScene = (id:string,number:number,title:string,seconds=45):Scene => ({id,number,slug:id.replace(/^sc_/,""),title,status:"draft",version:1,
    inherits:{location:"drowned-quarter",timeOfDay:"night"},shots:[{id:"sh_"+id.slice(3),number:1,title,description:"The harbour at night.",durationSec:seconds}]});
  const episodes = ["The bell that answers","What the ledger skips","Her mother’s hour"].map((title,i)=>({id:`ep_night-${i+1}`,version:4,order:i+1,title,
    promise:{opens:"The answering bell keeps an hour only her mother ever rang.",turn:"Ringing it tells whoever rebuilt the street where she is.",closes:"She rings it anyway."},
    scenes:[`sc_night-${i+1}-1`,`sc_night-${i+1}-2`,`sc_night-${i+1}-3`]}));
  const scenes=episodes.flatMap((episode,i)=>episode.scenes.map((id,j)=>makeScene(id,i*3+j+1,["The hour found","The warning","The argument she loses"][j]!)));
  const season={...structuredClone(film),meta:{...film.meta,id:"bell-watch",title:"Bell Watch",kind:"microdrama" as const,medium:"video" as const,aspect:"9:16"},
    season:{version:3,question:"Whether she stops looking for her mother and starts looking for who is answering.",ending:"She rings to be found rather than to be answered.",defaults:{episodeCount:7,episodeSecondsMin:45,episodeSecondsMax:75}},
    episodes,episodeFiles:Object.fromEntries(episodes.map(e=>[e.id,e.id.slice(3)])),scenes,sceneFiles:Object.fromEntries(scenes.map(s=>[s.id,s.slug])),takes:[],selections:{},story:null,narrative:null};
  season.selections=Object.fromEntries(scenes.map((scene,i)=>[scene.shots[0]!.id,{trimInSec:0,startFrameArtifactId:world.artifacts[i%2?4:3]!.id}]));
  const ids=["quarter","causeway","towers","vigil","bells","pier","undertow","wake"];
  const branchScenes=ids.map((id,i)=>makeScene("sc_"+id,i+1,["The drowned quarter","The causeway","The bell towers","The Vigil","Beneath the bells","The pier at dusk","The undertow","The wake"][i]!,[72,58,90,125,70,70,10,10][i]));
  const routing:Routing={version:12,start:"sc_quarter",choices:[
    {id:"ch_follow",from:"sc_quarter",to:"sc_causeway",label:"Follow the lantern"},
    {id:"ch_stay",from:"sc_quarter",to:"sc_towers",label:"Stay with the boat"},
    {id:"ch_cross",from:"sc_causeway",to:"sc_towers",label:"Cross before the tide"},
    {id:"ch_wait",from:"sc_causeway",to:"sc_vigil",label:"Wait for low water"},
    {id:"ch_ring",from:"sc_towers",to:"sc_bells",label:"Ring the bell"},
    {id:"ch_sleep",from:"sc_towers",to:"sc_pier",label:"Let it sleep"},
    {id:"ch_climb",from:"sc_vigil",to:"sc_pier",label:"Climb to the lamp"},
  ],endings:[{sceneId:"sc_bells",title:"The bell answers"},{sceneId:"sc_pier",title:"The harbour, level"}],excluded:[],groups:[]};
  const branch={...structuredClone(film),meta:{...film.meta,id:"low-water",title:"Low Water",kind:"interactive" as const,medium:"video" as const},scenes:branchScenes,
    sceneFiles:Object.fromEntries(branchScenes.map(s=>[s.id,s.slug])),routing,takes:[],selections:Object.fromEntries(branchScenes.map((scene,i)=>[scene.shots[0]!.id,{trimInSec:0,startFrameArtifactId:world.artifacts[i%2?4:3]!.id}]))};
  world.productions=[season,branch];world.series=[{id:"bell-watch-series",title:"Bell Watch",version:1,engine:"Every season, someone the harbour gave up on answers back.",seasons:["bell-watch"],created:at,updated:at}];
  world.conversations=[{...world.conversations[0]!,entryContext:{kind:"production",productionId:mode==='branch'?"low-water":"bell-watch"}}];
  state.worldChat!.messages=state.worldChat!.messages.slice(0,2);
  state.worldChat!.messages[0]!.text="What changes at the end of the season?";
  state.worldChat!.messages[1]!.text="Episode 4 has no hook. Here is one, and it moves the ending a week earlier.";
  if(mode==='staged'){state.worldChat!.messages=state.worldChat!.messages.filter(m=>m.role==='studio');state.worldChat!.messages[0]!.receipts=[];}
  if(mode==='staged')for(const staged of world.proposals){const path='productions/bell-watch/season.json';staged.proposal.targets[0]!.path=path;staged.proposal.summary='Staged · 3 changes';staged.review!.targets[0]!.path=path;staged.review!.targets[0]!.fields=[{field:'ending',before:'She waits.',proposed:'she rings to be found'},{field:'episode 04',before:null,proposed:'hook, cliff'},{field:'episode 05',before:null,proposed:'title'}];staged.proposal.worldChatOrigins![0]!.targetPaths=[path];}
  if(mode==='episode'){world.conversations[0]!.entryContext={kind:"episode",productionId:"bell-watch",episodeId:"ep_night-3"};}
  if(mode==='setup'){
    world.conversations[0]!.entryContext={kind:"production-setup",setupId:CHAT_ID};
    state.worldChat!.productionSetup=ProductionSetupStateSchema.parse({status:"draft",review:null,draft:{schemaVersion:1,setupId:CHAT_ID,worldId:world.meta.worldId,revision:3,title:"Low Water",kind:"film",aspect:"16:9",frameRate:24,
      logline:"A drowned quarter at low water.",narrative:{direction:"Follow the lantern."},arcs:[],references:[],openQuestions:["Two endings or more?"],episodes:[],scenes:[{key:"quarter",title:"The drowned quarter",synopsis:"The first choice is the lantern."}]}});
    state.worldChat!.messages=["A watch-format production in The Undersong. Where does it start: a place, a person, or a question?","The drowned quarter at low water. The viewer chooses whether to follow the lantern.","Then the first scene is the quarter and the first choice is the lantern. Two endings or more?"].map((text,i)=>({id:`msg_01J8F3K2QW9VZX4N7M0RTYB6H${i}`,role:i===1?"user":"studio",text,createdAt:at,receipts:i===2?["read The Undersong","6 places"]:[],refusals:[]}));
  }
  return state;
}
