const F=require('./_pptx-fixtures');const P=require('../src/features/pptx');
let seed=12345;const noise=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed>>8;};
const media={};for(let i=0;i<100;i++)media[`p${i}.png`]=F.png(200,150,(x,y)=>[noise()%256,(x*3+i)%256,(y*5+noise()%40)%256]);
let n=0;const slides=Array.from({length:60},(_,s)=>{const c=s<40?2:3;let shapes='';const rels=[];for(let k=0;k<c;k++){rels.push(F.imageRel(`r${k}`,`p${n%100}.png`));shapes+=F.pic({id:10+k,rid:`r${k}`,box:{x:40+k*300,y:120,w:280,h:210}});n++;}return{shapes,rels};});
const buf=F.deck({slides,media});
(async()=>{
 // gap probe
 let last=Date.now(),max=0,go=true;const turn=()=>{const now=Date.now();if(now-last>max)max=now-last;last=now;if(go)setImmediate(turn);};setImmediate(turn);
 const t=Date.now();const deck=await P.parsePptx(buf);console.log('parse total',Date.now()-t,'max gap',max);
 max=0;let t1=Date.now();const j=JSON.stringify(deck);console.log('stringify',Date.now()-t1,'bytes',j.length);
 t1=Date.now();const code=`window.lumenSlides && window.lumenSlides(${j})`;console.log('template',Date.now()-t1);
 await new Promise(r=>setTimeout(r,50));console.log('max gap after',max);go=false;
})();
