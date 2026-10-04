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
