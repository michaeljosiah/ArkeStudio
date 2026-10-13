// Navigation simulation for the approval artifact only. No network, app bridge or persistence.
const frames=[...document.querySelectorAll('.review-frame')];
const picker=document.querySelector('#step');
const phones=new Set(['209m','209n','209o','209ac']);
let current='209a', prior=[], chosen='Storm coat', preview=chosen, phoneMode=false;
let looksReturn='209p', collectionReturn='209d', chapterReturn='209p';
let scope='chapter', format='video', blocked=false;
function show(id,remember=true,inheritPhone=false){
  const frame=frames.find(f=>f.dataset.id===id);if(!frame)return;
  if(remember&&current!==id)prior.push(current);
  current=id;phoneMode=inheritPhone?phoneMode:phones.has(id);
  frame.querySelector('.v209').classList.toggle('phone',phoneMode);
  frames.forEach(f=>f.hidden=f!==frame);picker.value=id;
  document.querySelector('#state').textContent=frame.dataset.note;
  document.querySelector('#prototype-title').focus({preventScroll:true});
  document.querySelectorAll('[data-preview-look]').forEach(e=>e.textContent=preview);
  if(['209j','209k','209o'].includes(id)){scope='chapter';format='video';blocked=id==='209k';}
  if(id==='209w'){scope='book';format='video';blocked=false;}
  if(id==='209x'){
    format='player';
    const body=frame.querySelector('.sheetbody');
    body.querySelector(':scope>.stack>strong').textContent=scope==='book'?'The Undersong · 5 complete chapters':'Chapter 6 · The harbour';
    body.querySelector('.fact span:last-child').textContent=scope==='book'?'5 chapters · Chapter 4 omitted':'1 chapter · 18 blocks · 7 pictures';
    body.querySelector('.hint').textContent=scope==='book'?'A browser player with the 5 complete chapters. Chapter 4 is not fully read and will be omitted.':'A player with this chapter’s reading and pictures, ready to open in a browser.';
    body.querySelector('.scope').querySelectorAll('button').forEach((b,i)=>b.classList.toggle('on',scope==='book'?i===1:i===0));
  }
  if(id==='209aa'){
    frame.querySelector('.sheethead .small').textContent=scope==='book'?'The Undersong · 5 complete chapters':'Chapter 6 · The harbour';
    frame.querySelector('h3').textContent=format==='player'?'Exporting player':scope==='book'?'Rendering 5 videos':'Rendering video';
  }
  fitPreview();
}
function navigate(button){
  let id=button.dataset.go;if(!id)return;
  const from=current;
  if(['209p','209h','209z','209ac','209q'].includes(from))chapterReturn=from;
  if(from==='209m')chapterReturn='209ac';
  if(id==='209d'&&['209c','209t'].includes(from))looksReturn=from==='209t'?'209t':chapterReturn;
  if(id==='209n')looksReturn='209ac';
  if(id==='209e'){preview=chosen;collectionReturn=from;}
  if(from==='209e'&&id==='209d')id=button.hasAttribute('data-use-look')?(phoneMode?'209n':'209d'):collectionReturn;
  if(['209d','209n'].includes(from)&&['209p','209ac'].includes(id))id=phoneMode&&looksReturn==='209p'?'209ac':looksReturn;
  if(from==='209x'&&button.textContent.trim()==='Whole book'){scope='book';id='209x';}
  if(from==='209x'&&button.textContent.trim()==='This chapter'){scope='chapter';id='209x';}
  if(from==='209x'&&button.textContent.trim()==='Video')id=scope==='book'?'209w':'209j';
  if(from==='209w'&&id==='209x')scope='book';
  if(id==='209x'&&blocked){document.querySelector('#state').textContent='This chapter still needs 6 takes. Both export formats use the same readiness check.';return;}
  if(id==='209p'&&!['209d','209n','209e'].includes(from))id=chapterReturn;
  if(phoneMode&&id==='209p')id='209ac';
  show(id,true,phoneMode);
}
document.addEventListener('click',e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.look){preview=b.dataset.look;b.closest('.collection').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));document.querySelectorAll('[data-preview-look]').forEach(x=>x.textContent=preview);return;}
  if(b.hasAttribute('data-use-look')){chosen=preview;document.querySelectorAll('.lookrow').forEach(row=>{if(row.querySelector('strong')?.textContent==='Maren'){const label=row.querySelector('.lookchoice>span:nth-child(2)');if(label){label.replaceChildren(document.createTextNode(chosen));const caption=document.createElement('span');caption.className='small';caption.textContent='Chosen for this chapter';label.append(caption);}}});}
  if(b.dataset.go)navigate(b);
  else if(b.id==='previous'){const id=prior.pop();if(id)show(id,false);}
  else if(b.id==='restart'){location.reload();}
  else if(b.id==='gallery'){const all=b.getAttribute('aria-pressed')!=='true';b.setAttribute('aria-pressed',String(all));frames.forEach(f=>f.hidden=all?false:f.dataset.id!==current);}
  else if(b.closest('.v209'))document.querySelector('#state').textContent='This control belongs to the existing detailed design. This prototype demonstrates navigation and scope; it does not generate, play, save or export media.';
});
picker.addEventListener('change',()=>{chapterReturn='209p';looksReturn='209p';collectionReturn='209d';scope='chapter';format='video';blocked=false;show(picker.value);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){const frame=frames.find(f=>f.dataset.id===current);const close=frame.querySelector('.sheethead [data-go]');if(close)navigate(close);else if(current==='209c')show('209p');else if(current==='209m')show('209ac');}});
show('209a',false);
function fitPreview(){for(const frame of frames){const page=frame.querySelector('.v209');page.style.zoom=String(Math.min(1,(innerWidth-64)/(page.classList.contains('phone')?390:1320)));}}
addEventListener('resize',fitPreview);fitPreview();
