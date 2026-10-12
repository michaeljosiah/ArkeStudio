// Independent procedural study. No pixels or motion tracks are sampled from the reference.
import {physicsPositionsAt} from './air-particles-220.physics.mjs';
export const preset=Object.freeze({name:'Air Particles · Drift',version:'study-4',seed:81273,amount:1,size:1,speed:1,depth:1,softness:.55,texture:.75,turbulence:1,boundary:'bounce',interactions:true});
export const BASE_POPULATION=660;
const clamp=(x,a=0,b=1)=>Math.min(b,Math.max(a,x));
const smooth=x=>{x=clamp(x);return x*x*(3-2*x)};
function hash(x){x=Math.imul(x^(x>>>16),0x7feb352d)>>>0;x=Math.imul(x^(x>>>15),0x846ca68b)>>>0;return ((x^(x>>>16))>>>0)/4294967296}
function random(i,c,seed=preset.seed){return hash((seed^Math.imul(i+1,0x9e3779b1)^Math.imul(c+1,0x85ebca6b))>>>0)}
function noise(x,y,seed){const ix=Math.floor(x),iy=Math.floor(y),tx=smooth(x-ix),ty=smooth(y-iy);const at=(a,b)=>hash(seed^Math.imul(a,1597334677)^Math.imul(b,3812015801));const a=at(ix,iy)*(1-tx)+at(ix+1,iy)*tx,b=at(ix,iy+1)*(1-tx)+at(ix+1,iy+1)*tx;return a*(1-ty)+b*ty}
// Mottling travels with each particle. It never rerolls between frames or covers the background.
const TEX=64;
const textures=Array.from({length:32},(_,n)=>{const out=new Float32Array(TEX*TEX),seed=(preset.seed+Math.imul(n+1,93097))>>>0;for(let y=0;y<TEX;y++)for(let x=0;x<TEX;x++)out[y*TEX+x]=.52*noise(x/16,y/16,seed)+.32*noise(x/5,y/5,seed+81)+.16*noise(x/1.7,y/1.7,seed+197);return out});
function textureAt(index,x,y){const u=clamp(x,0,TEX-1.001),v=clamp(y,0,TEX-1.001),ix=Math.floor(u),iy=Math.floor(v),tx=u-ix,ty=v-iy,a=textures[index],p=iy*TEX+ix;return (a[p]*(1-tx)+a[p+1]*tx)*(1-ty)+(a[p+TEX]*(1-tx)+a[p+TEX+1]*tx)*ty}
const makePopulation=seed=>Array.from({length:Math.ceil(BASE_POPULATION*1.6)},(_,i)=>{const r=c=>random(i,c,seed),z=r(0);return {i,z,x:r(1),y:r(2),r:r(3),a:r(4),phase:r(5)*Math.PI*2,vx:(r(6)-.5)*16,vy:-8-r(7)*18,f:.45+r(8)*.5,aspect:.74+r(9)*.48,angle:r(10)*6.283,focus:r(11),life:r(12),rim:r(13),tex:Math.floor(r(14)*textures.length)}});
const populations=new Map();
export function particlesAt(seconds,settings={}){
 const p={...preset,...settings},t=seconds*p.speed;
 let population=populations.get(p.seed);if(!population){population=makePopulation(p.seed);populations.set(p.seed,population)}
 const positions=physicsPositionsAt(t,population,p);
 return population.slice(0,Math.round(BASE_POPULATION*p.amount)).map(v=>{
  const layer=v.z<.28?0:v.z<.82?1:2;
  const baseR=layer===0?.6+v.r*1.25:layer===1?2.4+v.r*4.2:4+v.r*4.5;
  const focusShift=Math.sin(t*.17+v.phase)*.17*p.depth;
  const radius=baseR*p.size*(1+focusShift);
  const x=positions[v.i*2],y=positions[v.i*2+1];
  const breathing=.72+.28*Math.sin(t*.22+v.life*6.283)**2;
  const brightness=(layer===0?.01+v.a*.050:layer===1?.030+v.a*.22:.045+v.a*.255)*breathing*1.04;
  const soft=clamp(.09+p.softness*.65+v.focus*.22+(layer===2?.08:0)+focusShift*.35,.12,.95);
  return {...v,layer,x,y,radius,brightness,soft,texture:p.texture};
 });
}
export function renderParticles(seconds,width=960,height=540,settings={}){
 const out=new Uint8ClampedArray(width*height*4);for(let i=3;i<out.length;i+=4)out[i]=255;
 const sx=width/960,sy=height/540;
 for(const p of particlesAt(seconds,settings)){
  const rx=Math.max(.65,p.radius*sx),ry=Math.max(.65,p.radius*sy*p.aspect),cx=p.x*sx,cy=p.y*sy;
  const energy=Math.min(1,p.radius*sx/.65)**2,extent=1.65;
  const x0=Math.max(0,Math.floor(cx-rx*extent)),x1=Math.min(width-1,Math.ceil(cx+rx*extent));
  const y0=Math.max(0,Math.floor(cy-ry*extent)),y1=Math.min(height-1,Math.ceil(cy+ry*extent));
  const cs=Math.cos(p.angle),sn=Math.sin(p.angle);
  for(let y=y0;y<=y1;y++)for(let x=x0;x<=x1;x++){
   const dx=(x+.5-cx)/rx,dy=(y+.5-cy)/ry,a=Math.atan2(dy,dx);
   const edge=1+(.025+p.texture*.035)*Math.sin(a*3+p.angle)+p.texture*.018*Math.cos(a*5+p.phase);
   const d=Math.sqrt(dx*dx+dy*dy)/edge;if(d>=extent)continue;
   const coverage=1-smooth((d-(1-p.soft))/p.soft);
   const halo=.065*(1-smooth(d/extent))**2;
   const tx=(dx*cs-dy*sn)*22+32,ty=(dx*sn+dy*cs)*22+32;
   const grain=1+p.texture*1.9*(textureAt(p.tex,tx,ty)-.5)*(1-.35*p.soft);
   const mottled=clamp(grain,.30,1.65);
   // A minority of defocused discs have a faint irregular rim, as in lens bokeh.
   const ring=p.rim>.8?p.texture*.10*Math.max(0,1-Math.abs(d-.70)/.20):0;
   const core=coverage*mottled*(1-p.texture*.12)+ring;
   const b=255*p.brightness*(core+halo)*energy;
   const at=(y*width+x)*4,v=Math.min(255,out[at]+b);out[at]=out[at+1]=out[at+2]=v;
  }
 }
 return out;
}

