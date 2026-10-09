import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {Script} from 'node:vm';
import {localEntries,fingerprint} from '../src/sync-state.js';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('every classic inline app script parses, not just Vite modules',async()=>{
  for(const file of ['index.html','mobile.html']){
    const html=await readFile(new URL('../'+file,import.meta.url),'utf8');
    for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
      if(!/type=["']module["']/.test(match[1]) && !/\bsrc=/.test(match[1])) new Script(match[2],{filename:file});
    }
  }
});
test('the existing app renders and accepts cloud library updates without losing its UI state',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const state={docs:[{id:'test',title:'Synthetic book',author:'Test',category:'Test',status:'reading',color:'new',pages:2,progress:5,time:'0 h'}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));await tick();
  assert.match(w.document.querySelector('#books').textContent,/Synthetic book/);
  state.docs[0].title='Cloud update';w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.dispatchEvent(new w.Event('scribe-cloud-updated'));
  assert.match(w.document.querySelector('#books').textContent,/Cloud update/);
  assert.equal(w.document.querySelector('#docCount').textContent,'1');
  dom.window.close();
});
test('a same-origin private server exposes the independent upload channel without replacing cloud mode',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://reader.example.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;
  w.fetch=async(url)=>url==='/api/health'
    ?{ok:true,json:async()=>({status:'ok',service:'scribe-local'})}
    :new Promise(()=>{});
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));await tick();await tick();
  assert.match(w.document.querySelector('[data-channel="local"]').textContent,/独立服务器/);
  assert.equal(w.document.querySelector('[data-channel="local"]').classList.contains('active'),true);
  assert.match(w.document.querySelector('#phoneHint').textContent,/不同网络/);
  w.document.querySelector('[data-channel="cloud"]').click();
  assert.equal(w.document.querySelector('[data-channel="cloud"]').classList.contains('active'),true);
  dom.window.close();
});
test('library sync preserves edits made during a request and backs up stale-device conflicts',async()=>{
  const dom=new JSDOM('<div id="settings"><div class="settings-grid"></div></div><div class="topbar"></div>',{url:'https://scribe.test',runScripts:'outside-only'});
  const w=dom.window;w.structuredClone=structuredClone;w.setTimeout=()=>0;w.setInterval=()=>0;
  const initial={docs:[{id:'d',progress:10}],cards:[],deletedDocs:[],settings:{}};
  const metadata=Object.fromEntries([...localEntries(initial)].map(([id,entry])=>[id,{kind:entry.kind,id:entry.id,revision:1,fingerprint:fingerprint(entry)}]));
  w.localStorage.setItem('scribe-library-key','a'.repeat(64));
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(initial));w.localStorage.setItem('scribe-sync-meta-v1',JSON.stringify(metadata));
  let reply;const requests=[];
  const cloud={callFunction:async(name,body)=>{assert.equal(name,'scribe-library');assert.equal(body.action,'sync');requests.push(body);return new Promise(resolve=>{reply=resolve;});}};
  const pure=(await readFile(new URL('../src/sync-state.js',import.meta.url),'utf8')).replaceAll('export function','function');
  const library=(await readFile(new URL('../src/cloud-library.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'').replace('export function','function');
  w.eval(pure+'\n'+library+'\nwindow.installLibrary=installLibrary;');w.installLibrary(cloud);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));await tick();
  const response=(progress,revision,conflicts=[])=>({entries:[{kind:'doc',entry_id:'d',value:{id:'d',progress},revision,deleted:false},{kind:'preferences',entry_id:'settings',value:{settings:{}},revision:1,deleted:false}],documents:[],conflicts});
  const edit=progress=>w.localStorage.setItem('scribe-local-v1',JSON.stringify({...JSON.parse(w.localStorage.getItem('scribe-local-v1')),docs:[{id:'d',progress}]}));
  edit(20);reply(response(10,1));await tick();
  assert.equal(JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs[0].progress,20);
  let syncing=cloud.library.sync();await tick();assert.equal(requests.at(-1).changes[0].value.progress,20);reply(response(20,2));await syncing;
  syncing=cloud.library.sync();await tick();reply(response(40,3));await syncing;
  assert.equal(JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs[0].progress,40);
  edit(30);syncing=cloud.library.sync();await tick();edit(35);reply(response(45,4,[{kind:'doc',id:'d'}]));await syncing;
  assert.equal(JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs[0].progress,45);
  assert.equal(JSON.parse(w.localStorage.getItem('scribe-sync-conflicts'))[0].value.progress,35);
  assert.equal(Object.keys(JSON.parse(w.localStorage.getItem('scribe-sync-pending'))).length,0);
  dom.window.close();
});

test('imported documents render one fold flag per paragraph and keep every paragraph translation',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const state={docs:[{id:'cloud-1',title:'Imported paper',cloudSessionId:'session',status:'reading',color:'new',pages:1,progress:0,lastPage:0,sourcePages:[{id:'cloud-file',order:1,name:'page-1.png',type:'image/png',url:'https://example.test/page-1.png',text:'First paragraph text.\n\nSecond paragraph text.',paragraphs:[{text:'First paragraph text.',translation:'第一段中文译文。'},{text:'Second paragraph text.',translation:'第二段中文译文。'}],sourceFileId:'11111111-1111-1111-1111-111111111111',pageIndex:0,cloud:true}]}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-1',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();
  const paper=w.document.querySelector('#paper');
  assert.equal(paper.querySelectorAll('.src-para').length,2,'one block per paragraph');
  const flags=paper.querySelectorAll('[data-src-trans]');
  assert.equal(flags.length,2,'every paragraph carries its own fold flag');
  assert.equal(paper.querySelectorAll('.src-trans').length,2);
  assert.match(paper.textContent,/第一段中文译文。/);
  assert.ok(paper.querySelectorAll('.para .word.capture-word').length>0,'paragraph words stay clickable');
  const first=w.document.getElementById(flags[0].dataset.srcTrans),second=w.document.getElementById(flags[1].dataset.srcTrans);
  assert.equal(first.classList.contains('show'),false,'translations start folded');
  flags[0].click();
  assert.equal(first.classList.contains('show'),true);
  assert.equal(second.classList.contains('show'),false,'folding one paragraph leaves the others alone');
  assert.match(flags[0].textContent,/收起译文/);
  w.document.querySelector('[data-mode="bi"]').click();
  assert.equal(paper.classList.contains('mode-bi'),true);
  assert.equal(flags.length,2,'reading modes keep the per-paragraph flags in place');
  dom.window.close();
});

test('a page without generated translations is folded but asks the library to backfill it',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const requests=[];
  w.__scribeCloud={callFunction:async(name,body)=>{requests.push([name,body]);return {paragraphs:[{text:'Legacy paragraph.',translation:'旧文献译文。'}]};},library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const state={docs:[{id:'cloud-2',title:'Legacy paper',status:'reading',color:'new',pages:1,progress:0,lastPage:0,sourcePages:[{id:'cloud-legacy',order:1,name:'page-1.png',type:'image/png',url:'https://example.test/page-1.png',text:'Legacy paragraph.',sourceFileId:'22222222-2222-2222-2222-222222222222',pageIndex:0,cloud:true}]}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-2',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','a'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)),[['scribe-study',{action:'translate',fileId:'22222222-2222-2222-2222-222222222222',libraryKey:'a'.repeat(64)}]]);
  const paper=w.document.querySelector('#paper');
  assert.equal(paper.querySelectorAll('[data-src-trans]').length,1,'backfilled paragraphs gain their fold flag');
  assert.match(paper.textContent,/旧文献译文。/);
  dom.window.close();
});

test('clicking an imported word collects a card with phonetic and contextual meaning',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const requests=[];
  w.__scribeCloud={callFunction:async(name,body)=>{requests.push([name,body]);return {words:[{word:'accumulate',phonetic:'/əˈkjuːmjəleɪt/',meaning:'积累；逐渐聚集'}]};},library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const paragraph='Students inherit the culture of their classroom; they also accumulate symbolic capital.';
  const state={docs:[{id:'cloud-3',title:'Imported paper',status:'reading',color:'new',pages:1,progress:0,lastPage:0,sourcePages:[{id:'cloud-word',order:1,name:'page-1.png',type:'image/png',url:'https://example.test/page-1.png',text:paragraph,paragraphs:[{text:paragraph,translation:'学生继承课堂文化，同时也积累符号资本。'}],sourceFileId:'33333333-3333-3333-3333-333333333333',pageIndex:0,cloud:true}]}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-3',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','b'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();
  const word=term=>[...w.document.querySelectorAll('#paper .word')].find(item=>item.textContent===term);
  const click=element=>element.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.ok(word('inherit')&&word('accumulate'),'the imported paragraph exposes clickable words');
  // 词典里已有的词直接命中，不消耗额度。
  click(word('inherit'));await tick();await tick();
  assert.equal(requests.length,0,'a word already in the local dictionary is not sent to the cloud');
  const collected=()=>JSON.parse(w.localStorage.getItem('scribe-local-v1')).cards;
  assert.equal(collected()[0].phonetic,'/ɪnˈherɪt/');
  assert.equal(collected()[0].translation,'继承');
  // 词典里没有的词才向云端查询，并写回音标与当前语境释义。
  click(word('accumulate'));await tick();await tick();
  assert.equal(requests.length,1,'the dictionary is queried once for the unknown word');
  assert.equal(requests[0][0],'scribe-study');
  assert.equal(requests[0][1].action,'define');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0][1].words)),[{word:'accumulate',sentence:'Students inherit the culture of their classroom; they also accumulate symbolic capital.'}]);
  const card=collected().find(item=>item.term==='accumulate');
  assert.equal(card.phonetic,'/əˈkjuːmjəleɪt/');
  assert.equal(card.meaning,'积累；逐渐聚集','the card must not fall back to a placeholder meaning');
  const panel=w.document.querySelector('#captureTabPanel').textContent;
  assert.match(panel,/\/əˈkjuːmjəleɪt\//);
  assert.match(panel,/积累；逐渐聚集/);
  dom.window.close();
});

test('desktop upload submits the whole confirmed queue to cloud in user-selected order',async()=>{
  const dom=new JSDOM('<div id="upload"><div class="notice"></div><div id="drop"><input id="fileInput"><span class="tiny muted"></span></div><div id="fileRow"><span id="fileName"></span><span id="fileMeta"></span></div><button id="process"></button></div><div id="steps"></div>',{url:'https://scribe.test',runScripts:'outside-only'});
  const w=dom.window;w.TextEncoder=TextEncoder;w.fetch=()=>{throw new Error('Must not call local server')};
  const uploaded=[],calls=[];
  w.__scribeCloud={callFunction:async(name,body)=>{calls.push(body);return{};},library:{createSession:async()=>({token:'batch',sessionId:'session'}),upload:async(token,file,order)=>uploaded.push([file.name,order]),sync:async()=>{},awaitBatch:async()=>{throw new Error('Synthetic offline pause after durable submission');}}};
  w.eval(await readFile(new URL('../public/import-queue.js',import.meta.url),'utf8'));w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  const input=w.document.querySelector('#fileInput');Object.defineProperty(input,'files',{value:['a','b','c'].map(name=>new w.File(['page'],name+'.txt',{type:'text/plain'}))});input.dispatchEvent(new w.Event('change',{bubbles:true}));
  w.document.querySelector('[aria-label="下移"]').click();w.document.querySelector('#process').click();await tick();
  assert.deepEqual(uploaded,[['b.txt',0],['a.txt',1],['c.txt',2]]);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{action:'complete',token:'batch'}]);
  assert.equal(w.document.querySelector('#fileInput').disabled,true);
  assert.match(w.document.querySelector('#computerQueueHint').textContent,/Synthetic offline/);
  dom.window.close();
});
