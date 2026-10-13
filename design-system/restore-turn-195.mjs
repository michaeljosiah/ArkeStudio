// Recover the recorded drawing, not a reconstruction. All other turns are preserved verbatim.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const here=path.dirname(fileURLToPath(import.meta.url)),root=path.dirname(here);
const source='d5c1a0ac',restoration='4fffedac2dcbad461fcc60608f511c6e7d264a28';
const git=(ref,file)=>execFileSync('git',['show',`${ref}:${file}`],{cwd:root,encoding:'utf8',maxBuffer:30e6});
const normalized=s=>s.replaceAll('\r\n','\n').trim();
const hash=s=>createHash('sha256').update(normalized(s)).digest('hex');
const sections=s=>new Map([...s.matchAll(/<section class="dv-turn" id="(t\d+)"/g)].map((m,i,all)=>[m[1],s.slice(m.index,all[i+1]?.index??s.lastIndexOf('</body>'))]));
const original=git(source,'design-system/Arke Studio.dc.html'),restored=git(restoration,'design-system/Arke Studio.dc.html');
const turn=sections(original).get('t195'),restoredTurn=sections(restored).get('t195');
if(!turn||hash(turn)!==hash(restoredTurn))throw Error('Original and restoration PR turn 195 differ');
const css=s=>s.split(/\r?\n/).filter(l=>l==='/* t195 */'||l.startsWith('.v195')).join('\n');
if(!css(original)||hash(css(original))!==hash(css(restored)))throw Error('Original and restoration PR styles differ');
const file=path.join(here,'Arke Studio.dc.html');let current=fs.readFileSync(file,'utf8');const before=sections(current);
if(!before.has('t195')){
 const anchor=current.indexOf('<section class="dv-turn" id="t194"');if(anchor<0)throw Error('Turn 194 anchor absent');
 current=current.slice(0,anchor)+turn+current.slice(anchor);
 const styleAnchor='/* Turn 127: settings narrator catalogue. Scoped to these proposed drawings. */';
 const styleAt=current.indexOf(styleAnchor)+styleAnchor.length;if(styleAt<styleAnchor.length)throw Error('Original style anchor missing');
 current=current.slice(0,styleAt)+'\n'+css(original)+current.slice(styleAt);
}
if(hash(sections(current).get('t195'))!==hash(turn))throw Error('Restored section differs');
for(const [id,s] of before)if(normalized(sections(current).get(id))!==normalized(s))throw Error(`Other turn changed: ${id}`);
fs.writeFileSync(file,current);
const ledgerFile=path.join(here,'turns.json'),ledger=JSON.parse(fs.readFileSync(ledgerFile,'utf8'));if(ledger.pending)delete ledger.pending.t195;fs.writeFileSync(ledgerFile,JSON.stringify(ledger,null,2)+'\n');
const buildFile=path.join(here,'build-review.mjs');let build=fs.readFileSync(buildFile,'utf8');
const oldBuild=git(restoration,'design-system/build-review.mjs');
for(const frame of ['195b','195e','195g'])if(!build.includes(`frame: "${frame}"`)){
 const start=oldBuild.lastIndexOf('  { group:',oldBuild.indexOf(`frame: "${frame}"`)),end=oldBuild.indexOf('] },',start)+4;
 if(start<0||end<4)throw Error('Missing restored review entry');
 build=build.replace('const SCREENS = [','const SCREENS = [\n'+oldBuild.slice(start,end));
}
fs.writeFileSync(buildFile,build);
const proof={source,restoration,sectionSha256:hash(turn),stylesSha256:hash(css(original)),frames:[...turn.matchAll(/class="dv-opt" id="(195[a-g])"/g)].map(m=>m[1]),rules:(turn.match(/class="dv-rule"/g)||[]).length,preservedTurns:before.size};
fs.mkdirSync(path.join(root,'.dev/global-chat-design'),{recursive:true});fs.writeFileSync(path.join(root,'.dev/global-chat-design/restoration-proof.json'),JSON.stringify(proof,null,2));
console.log(JSON.stringify(proof));
