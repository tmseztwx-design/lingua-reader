import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM,VirtualConsole} from 'jsdom';
import {localEntries,applyEntries} from '../src/sync-state.js';
import {mergeBackup,readBackupPayload} from '../src/restore-backup.js';

const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const reviewCode=(await Promise.all(['review-scheduler.js','review-ui.js'].map(name=>readFile(new URL('../src/'+name,import.meta.url),'utf8')))).map(code=>code.replace(/^import[^\n]*\n/gm,'').replace(/^export\s+/gm,'')).join('\n');
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
function book(id,title,text){return {id,title,author:'Test',category:'Test',status:'reading',color:'new',pages:1,progress:0,lastPage:0,sourcePages:[{id:id+'-page',order:1,name:'page.png',type:'image/png',url:'https://example.test/page.png',text,paragraphs:[{text,translation:'测试译文。'}]}]};}
function workspace(docs,cards=[]){return {docs,cards,deletedDocs:[],activeDocId:docs[0]?.id,minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',settings:{auto:true,timer:false,glossary:''}};}
async function boot(state,cloud){
  const errors=[],virtualConsole=new VirtualConsole();
  virtualConsole.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only',virtualConsole}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  const timeout=w.setTimeout.bind(w);w.setTimeout=(fn,ms,...args)=>ms===0?timeout(fn,0,...args):0;w.setInterval=()=>0;
  w.fetch=()=>new Promise(()=>{});w.alert=message=>{throw new Error(message);};
  if(cloud){w.__scribeCloud={library:{call:async()=>({sessions:[]}),sync:async()=>{}},...cloud};w.localStorage.setItem('scribe-library-key','a'.repeat(64));}
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  w.eval(reviewCode+'\ninstallReview();');
  await tick();await tick();
  const read=()=>JSON.parse(w.localStorage.getItem('scribe-local-v1'));
  const open=async id=>{w.document.querySelector('.nav [data-view="library"]').click();w.document.querySelector('[data-document-id="'+id+'"] .open').click();await tick();};
  const word=term=>Array.from(w.document.querySelectorAll('#paper .word')).find(item=>item.textContent.toLowerCase()===term.toLowerCase());
  const nav=view=>w.document.querySelector('.nav [data-view="'+view+'"]').click();
  return {dom,w,read,open,word,nav,errors};
}

test('same word is independent per book, while knowledge and review aggregate all books',async t=>{
  const docs=[book('a','Education','Knowledge supports learning in classrooms.'),book('b','Culture','Knowledge connects generations and cultural experience.')];
  const {dom,w,read,open,word,nav}=await boot(workspace(docs));t.after(()=>dom.window.close());
  word('knowledge').click();word('knowledge').click();
  assert.equal(read().cards.length,1,'same-book duplicate clicks stay idempotent');
  const a=read().cards[0];assert.equal(a.documentId,'a');assert.equal(a.sourcePageId,'a-page');assert.equal(a.pageNumber,1);assert.equal(a.paragraphIndex,1);
  assert.match(w.document.querySelector('#captureBookScope').textContent,/Education/);
  await open('b');
  assert.equal(w.document.querySelectorAll('#captureTabPanel .capture-card').length,0);
  assert.equal(word('knowledge').classList.contains('captured'),false,'book A highlight does not leak into B');
  word('knowledge').click();
  const b=read().cards.find(card=>card.documentId==='b');assert.ok(b);assert.notEqual(a.id,b.id);
  assert.equal(read().cards.length,2);assert.equal(w.document.querySelectorAll('#captureTabPanel .capture-card').length,1);
  nav('knowledge');
  assert.equal(w.document.querySelectorAll('#klist .kitem').length,2);assert.equal(w.document.querySelector('#allCards').textContent,'2');
  assert.match(w.document.querySelector('#klist').textContent,/Education/);assert.match(w.document.querySelector('#klist').textContent,/Culture/);
  nav('review');w.document.querySelector('[data-review-action="start"]').click();assert.equal(w.document.querySelector('#reviewProgress').textContent,'已完成 0 / 2 张');
  assert.match(w.document.querySelector('#reviewSource').textContent,/Education/);
  w.document.querySelector('#reveal').click();w.document.querySelector('[data-q="good"]').click();
  assert.match(w.document.querySelector('#reviewSource').textContent,/Culture/,'the other book also enters the review queue');
  assert.equal(read().cards.find(card=>card.id===a.id).due,false);assert.equal(read().cards.find(card=>card.id===b.id).due,true,'review schedules remain independent');
  await open('a');assert.equal(w.document.querySelector('#captureTabPanel .capture-card').dataset.cardId,a.id);
  w.document.querySelector('[data-remove-card]').click();
  assert.deepEqual(read().cards.map(card=>card.id),[b.id],'deleting from A preserves B');
  await open('b');assert.equal(word('knowledge').classList.contains('captured'),true);
});

test('same-title books open by stable ID; renames preserve ownership and source jumps',async t=>{
  const first=book('a','Same title','Knowledge supports the first reading book.');
  first.sourcePages.push({...first.sourcePages[0],id:'a-page-two',order:2,text:'Agency appears on the second page.',paragraphs:[{text:'Agency appears on the second page.',translation:'第二页。'}]});first.pages=2;first.lastPage=1;
  const {dom,w,read,open,word,nav}=await boot(workspace([first,book('b','Same title','Scaffolding supports the other reading book.')]));t.after(()=>dom.window.close());
  word('agency').click();const card=read().cards[0];assert.equal(card.pageNumber,2);
  await open('b');assert.equal(read().activeDocId,'b');assert.match(w.document.querySelector('#paper .para').textContent,/other reading book/);
  const renamed=read();renamed.docs[0].title='Renamed book';renamed.docs[0].lastPage=0;w.localStorage.setItem('scribe-local-v1',JSON.stringify(renamed));w.dispatchEvent(new w.Event('scribe-cloud-updated'));
  nav('knowledge');assert.match(w.document.querySelector('#klist .source').textContent,/Renamed book/);
  w.document.querySelector('#klist .jump').click();await tick();
  assert.equal(read().activeDocId,'a');assert.equal(read().docs[0].lastPage,1);
  assert.match(w.document.querySelector('#paper .para').textContent,/second page/);
  assert.equal(w.document.querySelector('#captureTabPanel .capture-card').dataset.cardId,card.id);
});

test('phrase and sentence collection uses the same book boundary',async t=>{
  const text='Knowledge supports learning in classrooms.';
  const {dom,w,read,open}=await boot(workspace([book('a','One',text),book('b','Two',text)]));t.after(()=>dom.window.close());
  w.__scribeCaptureCard('phrase','supports learning','支持学习',text);w.__scribeCaptureCard('sentence',text,'知识支持课堂学习。',text);
  await open('b');
  w.__scribeCaptureCard('phrase','supports learning','支持学习',text);w.__scribeCaptureCard('sentence',text,'知识支持课堂学习。',text);
  assert.equal(read().cards.length,4);
  for(const id of ['a','b'])assert.deepEqual(read().cards.filter(card=>card.documentId===id).map(card=>card.type),['phrase','sentence']);
  assert.equal(w.document.querySelectorAll('#captureTabPanel .capture-card').length,1);
  w.document.querySelector('[data-reader-tab="phrase"]').click();assert.equal(w.document.querySelectorAll('#captureTabPanel .capture-card').length,1);
});

test('legacy migration uses unique context and never guesses ambiguous or hardcoded demo provenance',async t=>{
  const shared='Knowledge is shared across both reading books.';
  const a=book('a','Original A','Knowledge uniquely supports this first reading book. '+shared),b=book('b','Original B',shared);
  const cards=[
    {id:'old-a',type:'word',term:'knowledge',context:'Knowledge uniquely supports this first reading book.',source:'The Sociology of Education · Chapter 3',note:'Keep my note',due:false,nextReview:21},
    {id:'ambiguous',type:'word',term:'knowledge',context:shared,source:'The Sociology of Education · Chapter 3',due:true},
    {id:'unknown',type:'word',term:'agency',context:'Unavailable original context',source:'The Sociology of Education · Chapter 3',due:true}
  ];
  const {dom,w,read,nav,open}=await boot(workspace([a,b],cards));t.after(()=>dom.window.close());
  assert.equal(read().cards[0].documentId,'a');assert.equal(read().cards[0].note,'Keep my note');assert.equal(read().cards[0].nextReview,21);assert.equal(read().cards[0].due,false);
  assert.equal(read().cards[1].documentId,undefined);assert.equal(read().cards[2].documentId,undefined);
  assert.equal(w.document.querySelectorAll('#captureTabPanel .capture-card').length,1);
  nav('knowledge');assert.equal(w.document.querySelectorAll('#klist .kitem').length,3);
  const select=w.document.querySelector('[data-assign-book="ambiguous"]');select.value='b';select.dispatchEvent(new w.Event('change'));
  assert.equal(read().cards.find(card=>card.id==='ambiguous').documentId,'b');
  await open('b');assert.equal(w.document.querySelector('#captureTabPanel .capture-card').dataset.cardId,'ambiguous');
});

test('in-flight definitions update only the originating card after switching books',async t=>{
  const replies=[];const cloud={callFunction:async(name,body)=>name==='scribe-study'?new Promise(resolve=>replies.push({body,resolve})):new Promise(()=>{})};
  const {dom,read,open,word,w}=await boot(workspace([book('a','One','Zephyrlike describes this first reading book.'),book('b','Two','Zephyrlike describes this second reading book.')]),cloud);t.after(()=>dom.window.close());
  word('zephyrlike').click();await open('b');word('zephyrlike').click();
  assert.equal(replies.length,2);
  replies[0].resolve({words:[{phonetic:'/first/',meaning:'第一本释义'}]});await tick();
  assert.equal(read().cards.find(card=>card.documentId==='a').translation,'第一本释义');assert.equal(read().cards.find(card=>card.documentId==='b').translation,'');
  assert.doesNotMatch(w.document.querySelector('#captureTabPanel').textContent,/第一本释义/);
  replies[1].resolve({words:[{phonetic:'/second/',meaning:'第二本释义'}]});await tick();
  assert.match(w.document.querySelector('#captureTabPanel').textContent,/第二本释义/);
  assert.equal(Object.keys(JSON.parse(w.localStorage.getItem('scribe-word-cache-v1'))).length,2);
});

test('cloud sync and backup restore preserve independent cards and their notes, review state and provenance',()=>{
  const docs=[book('a','One','A paragraph.'),book('b','Two','Another paragraph.')];
  const cards=['a','b'].map(id=>({id:id+'-word',type:'word',term:'knowledge',documentId:id,documentTitle:id,sourcePageId:id+'-page',pageNumber:1,paragraphIndex:1,note:id+' note',due:id==='a',nextReview:7}));
  const original=workspace(docs,cards),empty=workspace([]);
  const rows=[...localEntries(original).values()].map(entry=>({kind:entry.kind,entry_id:entry.id,value:entry.value,deleted:false}));
  assert.deepEqual(applyEntries(empty,rows).cards,cards);
  assert.deepEqual(mergeBackup(empty,readBackupPayload(JSON.parse(JSON.stringify(original)))).state.cards,cards);
});

test('legacy definition backfills in different books do not block each other',async t=>{
  const replies=[],cloud={callFunction:async(name,body)=>name==='scribe-study'?new Promise(resolve=>replies.push({body,resolve})):new Promise(()=>{})};
  const docs=[book('a','One','Zephyrlike describes the first reading book.'),book('b','Two','Zephyrlike describes the second reading book.')];
  const cards=docs.map(doc=>({id:doc.id+'-old',documentId:doc.id,type:'word',term:'Zephyrlike',context:doc.sourcePages[0].text,due:true}));
  const {dom,w,open}=await boot(workspace(docs,cards),cloud);t.after(()=>dom.window.close());
  assert.equal(replies.length,1);await open('b');assert.equal(replies.length,2);
  replies[1].resolve({words:[{phonetic:'/second/',meaning:'第二本旧卡释义'}]});await tick();
  assert.match(w.document.querySelector('#captureTabPanel').textContent,/第二本旧卡释义/);
  replies[0].resolve({words:[{phonetic:'/first/',meaning:'第一本旧卡释义'}]});await tick();
  assert.doesNotMatch(w.document.querySelector('#captureTabPanel').textContent,/第一本旧卡释义/);
});

test('a book without OCR text never displays another book\'s selectable sample article',async t=>{
  const empty={id:'empty',title:'Waiting for recognition',sourcePages:[],status:'reading',color:'new',progress:0};
  const {dom,w,open}=await boot(workspace([book('a','One','Knowledge belongs to the first reading book.'),empty]));t.after(()=>dom.window.close());
  await open('empty');
  assert.match(w.document.querySelector('#paper').textContent,/Waiting for recognition/);
  assert.equal(w.document.querySelectorAll('#paper .word').length,0);
  assert.match(w.document.querySelector('#captureBookScope').textContent,/Waiting for recognition/);
});

test('drag selection and category confirmation create a card for the open book',async t=>{
  const text='Knowledge supports learning in classrooms.';
  const {dom,w,read,open}=await boot(workspace([book('a','One',text),book('b','Two',text)]));t.after(()=>dom.window.close());
  await open('b');
  w.Range.prototype.getBoundingClientRect=()=>({left:100,top:200,width:300,height:20});
  const range=w.document.createRange();range.selectNodeContents(w.document.querySelector('#paper .para'));
  w.getSelection().removeAllRanges();w.getSelection().addRange(range);
  w.document.dispatchEvent(new w.MouseEvent('mouseup',{bubbles:true}));await tick();
  const confirm=w.document.querySelector('.reader-classify-menu [data-kind="sentence"]');assert.ok(confirm);
  confirm.click();await tick();
  const card=read().cards[0];assert.equal(card.documentId,'b');assert.equal(card.type,'sentence');assert.equal(card.term,text);
  await open('a');assert.equal(w.document.querySelectorAll('#captureTabPanel .capture-card').length,0);
});

test('unassigned legacy cards stay out of a reader with no active book, but remain in global study',async t=>{
  const state=workspace([],[{id:'unassigned',type:'word',term:'knowledge',context:'Unavailable context',due:true},{id:'guide',type:'word',term:'',due:false}]);
  const {dom,w,nav}=await boot(state);t.after(()=>dom.window.close());
  assert.equal(w.document.querySelectorAll('#captureTabPanel .capture-card').length,0);
  nav('knowledge');assert.equal(w.document.querySelector('#allCards').textContent,'1');
  assert.equal(w.document.querySelectorAll('#klist .kitem').length,1);
  nav('review');w.document.querySelector('[data-review-action="start"]').click();assert.equal(w.document.querySelector('#reviewTerm').textContent,'knowledge');
});

test('trashing or permanently removing a book does not reassign or discard its study cards',async t=>{
  const a=book('a','Removed book','Knowledge belongs to the removed reading book.'),b=book('b','Remaining book','Knowledge belongs to the remaining reading book.');
  const card={id:'a-word',type:'word',term:'knowledge',documentId:'a',documentTitle:'Removed book',translation:'知识',due:true};
  const state=workspace([b],[card]);state.deletedDocs=[{...a,deletedAt:new Date().toISOString()}];
  const {dom,w,read,nav}=await boot(state);t.after(()=>dom.window.close());
  assert.equal(w.document.querySelectorAll('#captureTabPanel .capture-card').length,0);
  nav('knowledge');assert.match(w.document.querySelector('#klist .source').textContent,/Removed book（回收站）/);
  const fresh=read();fresh.deletedDocs=[];w.localStorage.setItem('scribe-local-v1',JSON.stringify(fresh));w.dispatchEvent(new w.Event('scribe-cloud-updated'));
  assert.equal(read().cards[0].documentId,'a');assert.match(w.document.querySelector('#klist .source').textContent,/Removed book/);
  nav('review');w.document.querySelector('[data-review-action="start"]').click();assert.match(w.document.querySelector('#reviewSource').textContent,/Removed book/);
});
