// Fixed-step, layered 2D motion study; not a volumetric fluid/scene collision solver.
const HZ=120,DT=1/HZ,WIDTH=960,HEIGHT=540,CELL=32;
const caches=new Map();
const layer=z=>z<.28?0:z<.82?1:2;
function makeSimulation(population,settings){
 const count=Math.round(660*settings.amount),rows=population.slice(0,count),n=rows.length;
 const x=new Float64Array(n),y=new Float64Array(n),vx=new Float64Array(n),vy=new Float64Array(n),radius=new Float64Array(n),band=new Uint8Array(n);
 const boundaryUntilX=new Float64Array(n),boundaryUntilY=new Float64Array(n);
 const headingOffset=new Float64Array(n);
 const collisions={particle:0,boundary:0},samples=[];
 const airflow=settings.turbulence??1,bounce=settings.boundary!=='open',interact=settings.interactions!==false;
 const heading=(i,time)=>rows[i].phase+headingOffset[i]+airflow*(time*(rows[i].vx>=0?1:-1)*(.25+rows[i].life*.55)+.5*Math.sin(time*(.24+rows[i].f*.31)+rows[i].life*6.283));
 const flow=(i,time)=>{
  const p=rows[i],d=1+(band[i]-1)*.20*settings.depth;
  // A stream function produces divergence-free shared flow: no persistent sinks.
  // Independent smooth phase changes prevent a whole region travelling as one clump.
  const ax=Math.PI*x[i]/WIDTH,ay=Math.PI*y[i]/HEIGHT;
  const a=12*Math.sin(time*.31),b=8*Math.cos(time*.43);
  const sharedX=a*Math.sin(ax)*Math.cos(ay)+b*Math.sin(2*ax)*Math.cos(2*ay);
  const sharedY=-(HEIGHT/WIDTH)*(a*Math.cos(ax)*Math.sin(ay)+b*Math.cos(2*ax)*Math.sin(2*ay));
  const angle=heading(i,time);
  let fx=d*(19*Math.cos(angle)+airflow*sharedX),fy=d*(19*Math.sin(angle)+airflow*sharedY);
  // A brief inward flow after contact lets the particle leave the surface instead of chattering.
  if(time<boundaryUntilX[i])fx=Math.sign(WIDTH/2-x[i])*Math.abs(fx);
  if(time<boundaryUntilY[i])fy=Math.sign(HEIGHT/2-y[i])*Math.abs(fy);
  return [fx,fy];
 };
 for(let i=0;i<n;i++){
  const p=rows[i],l=layer(p.z);band[i]=l;
  const r=l===0?.6+p.r*1.25:l===1?2.4+p.r*4.2:4+p.r*4.5;
  // The blurred halo is visual; contact radius is smaller than the visible disc.
  radius[i]=Math.max(.7,r*settings.size*.62);
  // Progressive stratification, with independent jitter, spreads the initial population.
  // Coprime cell traversal keeps partial populations spread over the whole picture too.
  const cell=(i*197)%660,col=cell%33,row=Math.floor(cell/33);
  x[i]=radius[i]+((col+p.x)/33)*(WIDTH-radius[i]*2);y[i]=radius[i]+((row+p.y)/20)*(HEIGHT-radius[i]*2);
  [vx[i],vy[i]]=flow(i,0);
 }
 let stepNumber=0;
 function step(){
  const time=stepNumber*DT;
  for(let i=0;i<n;i++){
   const target=flow(i,time);vx[i]+=(target[0]-vx[i])*1.65*DT;vy[i]+=(target[1]-vy[i])*1.65*DT;
   x[i]+=vx[i]*DT;y[i]+=vy[i]*DT;
  }
  if(interact){
   const buckets=new Map();
   for(let i=0;i<n;i++){const cx=Math.floor(x[i]/CELL),cy=Math.floor(y[i]/CELL),key=(band[i]*64+cy)*64+cx;let list=buckets.get(key);if(!list)buckets.set(key,list=[]);list.push(i)}
   for(let i=0;i<n;i++){
    const cx=Math.floor(x[i]/CELL),cy=Math.floor(y[i]/CELL);
    for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
     const list=buckets.get((band[i]*64+cy+oy)*64+cx+ox);if(!list)continue;
     for(const j of list){if(j<=i||Math.abs(rows[i].z-rows[j].z)>.16)continue;
      let dx=x[j]-x[i],dy=y[j]-y[i];const limit=radius[i]+radius[j],distance=Math.hypot(dx,dy);if(distance>=limit)continue;
      if(distance<.00001){dx=1;dy=0}else{dx/=distance;dy/=distance}
      const wi=1/(radius[i]*radius[i]),wj=1/(radius[j]*radius[j]),sum=wi+wj;
      const overlap=(limit-distance)*.70;
      x[i]-=dx*overlap*wi/sum;y[i]-=dy*overlap*wi/sum;x[j]+=dx*overlap*wj/sum;y[j]+=dy*overlap*wj/sum;
      const closing=(vx[j]-vx[i])*dx+(vy[j]-vy[i])*dy;
      if(closing<-.05){const impulse=-1.50*closing/sum;vx[i]-=impulse*wi*dx;vy[i]-=impulse*wi*dy;vx[j]+=impulse*wj*dx;vy[j]+=impulse*wj*dy;collisions.particle++}
     }
    }
   }
  }
  for(let i=0;i<n;i++){
   const r=radius[i];
   if(bounce){
    if(x[i]<r){x[i]=r;if(vx[i]<0){vx[i]*=-.68;headingOffset[i]+=Math.PI-2*heading(i,time);boundaryUntilX[i]=time+.65;collisions.boundary++}}
    if(x[i]>WIDTH-r){x[i]=WIDTH-r;if(vx[i]>0){vx[i]*=-.68;headingOffset[i]+=Math.PI-2*heading(i,time);boundaryUntilX[i]=time+.65;collisions.boundary++}}
    if(y[i]<r){y[i]=r;if(vy[i]<0){vy[i]*=-.68;headingOffset[i]-=2*heading(i,time);boundaryUntilY[i]=time+.65;collisions.boundary++}}
    if(y[i]>HEIGHT-r){y[i]=HEIGHT-r;if(vy[i]>0){vy[i]*=-.68;headingOffset[i]-=2*heading(i,time);boundaryUntilY[i]=time+.65;collisions.boundary++}}
   }else{
    if(x[i]<-35)x[i]+=WIDTH+70;if(x[i]>WIDTH+35)x[i]-=WIDTH+70;
    if(y[i]<-35)y[i]+=HEIGHT+70;if(y[i]>HEIGHT+35)y[i]-=HEIGHT+70;
   }
   const speed=Math.hypot(vx[i],vy[i]);if(speed>90){vx[i]*=90/speed;vy[i]*=90/speed}
  }
  stepNumber++;
 }
 const capture=()=>{const data=new Float32Array(n*2);for(let i=0;i<n;i++){data[i*2]=x[i];data[i*2+1]=y[i]}samples.push(data)};
 // Start in established motion; fixed pre-roll is shared by every seek.
 for(let i=0;i<180;i++)step();capture();
 return {samples,collisions,extend(index){while(samples.length<=index){for(let i=0;i<5;i++)step();capture()}}};
}
export function physicsPositionsAt(seconds,population,settings){
 const key=JSON.stringify([settings.seed,settings.amount,settings.size,settings.depth,settings.turbulence??1,settings.boundary??'bounce',settings.interactions!==false]);
 let simulation=caches.get(key);
 if(!simulation){simulation=makeSimulation(population,settings);caches.set(key,simulation);if(caches.size>6)caches.delete(caches.keys().next().value)}
 const sample=Math.max(0,seconds*24),index=Math.floor(sample),fraction=sample-index;
 simulation.extend(index+(fraction>1e-9?1:0));
 if(fraction<1e-9)return simulation.samples[index];
 const a=simulation.samples[index],b=simulation.samples[index+1],out=new Float32Array(a.length);
 for(let i=0;i<a.length;i++)out[i]=Math.abs(b[i]-a[i])>200?a[i]:a[i]+(b[i]-a[i])*fraction;
 return out;
}
export function physicsStudyStats(){return [...caches.values()].map(v=>({samples:v.samples.length,contacts:{...v.collisions}}))}
