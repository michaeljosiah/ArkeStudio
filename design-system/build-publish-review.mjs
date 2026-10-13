// A focused review of turn 224, generated from the master rather than a second drawing.
// Run: node design-system/build-publish-review.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const master = readFileSync(join(dir, 'Arke Studio.dc.html'), 'utf8');
const start = master.indexOf('<section class="dv-turn" id="t224">');
if (start < 0) throw new Error('Missing turn 224');
const end = master.indexOf('<section class="dv-turn"', start + 1);
const turn = master.slice(start, end < 0 ? master.indexOf('</x-dc>', start) : end);
const style = master.match(/<helmet>[\s\S]*?<style>([\s\S]*?)<\/style>/)?.[1];
if (!style) throw new Error('Missing master styles');
const styleAt = style.indexOf('/* Turn 224:');
if (styleAt < 0) throw new Error('Missing turn 224 styles');
const styles = style.slice(0, style.indexOf('/* Turn 138')) + style.slice(styleAt);
const captions = [...turn.matchAll(/<div class="dv-olabel"><a class="dv-oid" href="#(224[a-z])">[^<]+<\/a>([^<]+)<\/div>/g)];
if (captions.length !== 21) throw new Error(`Expected 21 frames, found ${captions.length}`);
const tokens = '_ds/specone-design-system-b87656f3-7e74-4657-8cc8-d1409352969e/tokens';
const output = `<!doctype html>
<html lang="en" data-theme="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Arke · Publish a private story · Turn 224</title>
${['fonts','colors','typography','spacing','effects'].map(name=>`<link rel="stylesheet" href="${tokens}/${name}.css">`).join('\n')}
<style>${styles}
body{margin:0;font:var(--type-body);background:var(--dv-canvas);color:var(--dv-ink)}
.review-nav{box-sizing:border-box;position:fixed;left:0;top:0;bottom:0;width:218px;overflow:auto;background:var(--background);border-right:1px solid var(--border);padding:26px 18px;z-index:10}
.review-nav h1{font:var(--type-h3);margin:0 0 8px}.review-nav p{font:var(--type-label);color:var(--muted-foreground);line-height:1.5}.review-nav a{display:block;text-decoration:none;font:var(--type-label);line-height:1.5;padding:9px 0;color:var(--muted-foreground)}.review-nav a:hover{color:var(--foreground)}.review-nav a:focus-visible{outline:2px solid var(--foreground)}
.review-content{margin-left:218px}.review-banner{padding:22px 28px;background:var(--background);border-bottom:1px solid var(--border);font:var(--type-ui);display:flex;justify-content:space-between;gap:18px}.review-banner span{color:var(--muted-foreground)}
.dv-turn{padding:28px}.dv-opts{display:flex;flex-direction:column;gap:44px;align-items:flex-start}.dv-opt{max-width:100%;scroll-margin-top:20px}.dv-card{max-width:none;zoom:var(--review-scale,1)}.dv-next{max-width:1040px}.dv-thd{flex-wrap:wrap}.dv-rule{max-width:1120px}.dv-opt:target .dv-oid{background:var(--dv-accent);color:white}.review-content{min-width:0;overflow-x:hidden}.dv-olabel{max-width:100%;flex-wrap:wrap}
@media(max-width:760px){.review-nav{position:relative;width:auto;border-right:0;border-bottom:1px solid var(--border);padding:16px 20px}.review-nav nav{display:none}.review-content{margin-left:0}.review-banner{padding:16px 20px}.dv-turn{padding:20px}.review-content{overflow-x:auto}}
</style></head><body>
<aside class="review-nav"><h1>Publish a private story</h1><p>Turn 224 · Revision 2<br>13 October 2026<br>Proposed for review</p><nav>${captions.map(([,id,text])=>`<a href="#${id}">${id} · ${text}</a>`).join('\n')}<a href="#rules">Design rules</a></nav></aside>
<div class="review-content"><header class="review-banner"><b>Arke Studio · Design review</b><span>Static UI states · buttons link between frames · no files are created or sent</span></header>${turn.replace('<p class="dv-rule">','<span id="rules"></span><p class="dv-rule">')}</div>
<script>
function fitFrames(){const room=document.querySelector('.dv-opts').clientWidth;document.querySelectorAll('.dv-card').forEach(card=>{card.style.setProperty('--review-scale',Math.min(1,room/parseFloat(card.style.width)))});}
fitFrames();new ResizeObserver(fitFrames).observe(document.querySelector('.review-content'));
window.addEventListener('load',()=>{fitFrames();if(location.hash)document.getElementById(location.hash.slice(1))?.scrollIntoView({block:'start',inline:'nearest'});});
</script></body></html>
`;
const destination = join(dir, 'publish-private-review.html');
if (process.argv.includes('--check')) {
  if (readFileSync(destination, 'utf8') !== output) throw new Error('publish-private-review.html is stale');
  console.log('Publish review: 21 frames, generated page is current');
} else {
  writeFileSync(destination, output);
  console.log('Wrote publish-private-review.html from turn 224');
}
