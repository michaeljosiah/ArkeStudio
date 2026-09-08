import type { ResolvedShotStaging } from "../../src/staging.js";

// Geometry is authored after the measurable constraints in docs/development/stage-evaluation.md.
const hold = (duration:number, p:[number,number,number], l:[number,number,number]) => [{t:0,p,l},{t:duration,p,l}];
export const stageFixtures: Array<{name:string;duration:number;stage:ResolvedShotStaging}> = [
  {name:"dialogue",duration:6,stage:{version:1,cast:[{sheetId:"speaker-one",x:-.7,z:0},{sheetId:"speaker-two",x:.7,z:0}],sets:[],keys:hold(6,[0,1.5,4.5],[0,1.1,0])}},
  {name:"over-shoulder",duration:6,stage:{version:1,cast:[{sheetId:"speaker-one",x:-.8,z:1.4,facing:180},{sheetId:"speaker-two",x:.3,z:0}],sets:[],keys:hold(6,[-.25,1.7,3],[.3,1.35,0])}},
  {name:"doorway",duration:6,stage:{version:1,cast:[{sheetId:"actor",x:0,z:-2}],sets:[{name:"Left wall",x:-1.5,z:0,w:1.6,h:3,d:.2,solid:true},{name:"Right wall",x:1.5,z:0,w:1.6,h:3,d:.2,solid:true},{name:"Lintel",x:0,y:2.4,z:0,w:1.4,h:.6,d:.2,solid:true}],keys:hold(6,[0,1.6,6],[0,1.1,0]),performances:[{sheetId:"actor",keys:[{t:0,x:0,z:-2},{t:1,x:0,z:-2},{t:5,x:0,z:2},{t:6,x:0,z:2}]}]}},
  {name:"seated",duration:6,stage:{version:1,cast:[{sheetId:"actor",x:0,z:0,pose:"sit"}],sets:[{name:"Seat",group:"chair",x:0,y:.3,z:0,w:.6,h:.1,d:.6,solid:true},{name:"Chair back",group:"chair",x:0,y:.3,z:-.3,w:.6,h:.7,d:.1,solid:true},{name:"Table top",x:0,y:.65,z:1,w:1.6,h:.1,d:.7,solid:true}],keys:hold(6,[2,1.7,4],[0,1,0])}},
  {name:"delayed-action",duration:6,stage:{version:1,cast:[{sheetId:"actor",x:-1,z:0}],sets:[],keys:hold(6,[0,1.5,5],[0,1.1,0]),performances:[{sheetId:"actor",keys:[{t:0,x:-1,z:0},{t:1,x:-1,z:0},{t:3,x:1,z:0,facing:90},{t:4,x:1,z:0,facing:180},{t:5,x:1,z:0,facing:180,pose:"sit"},{t:6,x:1,z:0,facing:180,pose:"sit"}]}]}},
  {name:"independent-motion",duration:6,stage:{version:1,cast:[{sheetId:"actor",x:-2,z:0}],sets:[],keys:[{t:0,p:[0,2,6],l:[0,1.2,0],track:"actor"},{t:1.5,p:[-4,2,0],l:[0,1.2,0],track:"actor"},{t:3,p:[0,2,-6],l:[0,1.2,0],track:"actor"},{t:4.5,p:[4,2,0],l:[0,1.2,0],track:"actor"},{t:6,p:[0,2,6],l:[0,1.2,0],track:"actor"}],performances:[{sheetId:"actor",keys:[{t:0,x:-2,z:0},{t:6,x:2,z:0}]}]}},
  {name:"valley-chase",duration:8,stage:{version:1,cast:[{sheetId:"driver-one",parent:"lead-car",x:-.4,y:.45,z:.45,pose:"sit"}],sets:[
    {name:"Car body",group:"lead-car",x:0,y:.3,z:0,w:1.8,h:.5,d:4,solid:true},
    {name:"Roof",group:"lead-car",x:0,y:1.98,z:0,w:1.7,h:.12,d:1.6,solid:true},
    ...[-.82,.82].flatMap(x=>[-.7,.7].map(z=>({name:"Window pillar",group:"lead-car",x,y:.8,z,w:.09,h:1.18,d:.09,solid:true}))),
    ...[-.9,.9].flatMap(x=>[-1.2,1.2].map(z=>({name:"Wheel",group:"lead-car",shape:"cylinder" as const,x,y:.05,z,w:.65,h:.2,d:.65,rotation:[0,0,90] as [number,number,number],solid:true}))),
    {name:"Road",x:2,y:-.1,z:25,w:9,h:.1,d:70,solid:true},
    ...[-1,1].map(side=>({name:side<0?"West valley":"East valley",shape:"mesh" as const,x:side*15,y:0,z:25,w:20,h:12,d:70,solid:true,vertices:[[-.5,-.5,-.5],[.5,-.5,-.5],[side*.35,.5,-.3],[-.5,-.5,.5],[.5,-.5,.5],[side*.35,.5,.5]] as [number,number,number][],triangles:[0,2,1,0,3,2,3,5,2,1,2,4,4,2,5,3,4,5]})),
    ],objectMotions:[{group:"lead-car",keys:[{t:0,p:[0,0,0]},{t:4,p:[3,0,25],rotation:[0,10,0]},{t:8,p:[5,0,50],rotation:[0,0,0]}]}],keys:[
      {t:0,p:[5,2.4,-4],l:[0,1.1,0],anchor:"lead-car",anchorSpace:"local",track:"driver-one"},
      {t:2,p:[5,2.4,2],l:[0,1.1,0],anchor:"lead-car",anchorSpace:"local",track:"driver-one"},
      {t:4,p:[0,2,5],l:[0,1.1,0],anchor:"lead-car",anchorSpace:"local",track:"driver-one"},
      {t:6,p:[-.4,1.72,2.4],l:[0,1.28,0],anchor:"lead-car",anchorSpace:"local",track:"driver-one",easeIn:.6,focalMm:35},
      {t:8,p:[-.4,1.72,2.4],l:[0,1.28,0],anchor:"lead-car",anchorSpace:"local",track:"driver-one",focalMm:35},
    ]}},
];
