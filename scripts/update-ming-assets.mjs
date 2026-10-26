// Explicit maintainer operation: fetch publisher metadata and replace the immutable lock.
// Edit the pins/versions in ming-assets.json deliberately, run this, then review every diff
// and repeat native qualification. Never run as setup, inference or ordinary build work.
import {readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const lockPath = new URL('../packages/coordinator/src/local-ai/ming-assets.json', import.meta.url);
const previous = JSON.parse(await readFile(lockPath, 'utf8'));
const revision=previous.sourceRevision;
async function json(url){const r=await fetch(url);if(!r.ok)throw Error(`${r.status} ${url}`);return r.json();}
async function asset(url,file){const r=await fetch(url);if(!r.ok)throw Error(`${r.status} ${url}`);const b=Buffer.from(await r.arrayBuffer());return {url,file,bytes:b.length,sha256:createHash('sha256').update(b).digest('hex')};}
const source=await asset(`https://codeload.github.com/inclusionAI/Ming-3.0-tts/zip/${revision}`,'source.zip');
const variants={};
for(const [variant,prior] of Object.entries(previous.variants)){
 const repo = prior.repo.replace('inclusionAI/', ''), ref = prior.revision;
 const packages=prior.wheels;
 const wheels=[];
 for(const {name,version} of packages){
  const meta=await json(`https://pypi.org/pypi/${name}/${version}/json`);
  const choices=meta.urls.filter(x=>x.packagetype==='bdist_wheel'&&!x.yanked);
  const wheel=choices.find(x=>/(?:cp313-(?:cp313|none)|cp3(?:5|6|7|8|9|10|11|12|13)-abi3)-win_amd64\.whl$/.test(x.filename))??choices.find(x=>/(?:py3|py2\.py3)-none-win_amd64\.whl$/.test(x.filename))??choices.find(x=>/(?:py3|py2\.py3)-none-any\.whl$/.test(x.filename));
  if(!wheel)throw Error(`No Python 3.13 Windows wheel: ${name} ${version}`);
  wheels.push({name,version,url:wheel.url,file:wheel.filename,bytes:wheel.size,sha256:wheel.digests.sha256});
 }
 const model=await json(`https://huggingface.co/api/models/inclusionAI/${repo}/revision/${ref}?blobs=true`);
 const models=[];
 for(const row of model.siblings.filter(x=>/\.(?:json|txt|onnx|safetensors)$/.test(x.rfilename)&&!x.rfilename.includes('/'))){
  const url=`https://huggingface.co/inclusionAI/${repo}/resolve/${ref}/${row.rfilename}`;
  models.push(row.lfs?{url,file:row.rfilename,bytes:row.lfs.size,sha256:row.lfs.sha256}:await asset(url,row.rfilename));
 }
 variants[variant]={revision:ref,repo:`inclusionAI/${repo}`,wheels,models};
}
const sdk=await asset(previous.sdk.url,previous.sdk.file);
const lock={schemaVersion:1,sourceRevision:revision,source,sdk,variants};
await writeFile(lockPath,JSON.stringify(lock,null,2)+'\n');
console.log(JSON.stringify(Object.fromEntries(Object.entries(variants).map(([k,v])=>[k,{wheels:v.wheels.length,models:v.models.length,modelBytes:v.models.reduce((n,x)=>n+x.bytes,0)}]))));

