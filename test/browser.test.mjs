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

test('reordering reader pages writes the new order to the cloud and rolls back when it fails',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const alerts=[];w.alert=message=>alerts.push(String(message));
  const calls=[];
  w.__scribeCloud={callFunction:async(name,body)=>{calls.push([name,JSON.parse(JSON.stringify(body))]);return {ok:true,pages:3};},library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const fileIds=['aaaaaaaa-1111-2222-3333-444444444444','bbbbbbbb-1111-2222-3333-444444444444','cccccccc-1111-2222-3333-444444444444'];
  const page=(index,id)=>({id:'cloud-'+id,order:index+1,name:'page-'+(index+1)+'.png',type:'image/png',url:'https://example.test/'+index+'.png',text:'Paragraph '+(index+1)+'.',paragraphs:[{text:'Paragraph '+(index+1)+'.',translation:'第 '+(index+1)+' 段。'}],sourceFileId:id,pageIndex:index,cloud:true});
  const state={docs:[{id:'cloud-reorder',title:'Reorder me',cloudSessionId:'99999999-8888-7777-6666-555555555555',status:'reading',color:'new',pages:3,progress:0,lastPage:0,sourcePages:[page(0,fileIds[0]),page(1,fileIds[1]),page(2,fileIds[2])]}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-reorder',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','c'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();
  const localOrder=()=>JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs[0].sourcePages.slice().sort((a,b)=>(a.order||0)-(b.order||0)).map(item=>item.sourceFileId);
  assert.deepEqual(localOrder(),fileIds,'pages start in upload order');
  const move=()=>{const buttons=[...w.document.querySelectorAll('#paper [data-move-page]')];return buttons.find(button=>button.dataset.movePage==='0'&&button.dataset.delta==='1');};
  w.document.querySelector('#paper [data-source-reorder]').click();
  assert.ok(move(),'reorder mode exposes per-page move controls');
  move().click();
  await tick();await tick();
  const reorder=calls.find(([name,body])=>name==='scribe-mobile-upload'&&body.action==='reorder');
  assert.ok(reorder,'the new order must be sent to the cloud');
  assert.equal(reorder[1].sessionId,'99999999-8888-7777-6666-555555555555');
  assert.deepEqual(reorder[1].order,[fileIds[1],fileIds[0],fileIds[2]]);
  assert.deepEqual(localOrder(),[fileIds[1],fileIds[0],fileIds[2]],'local order applies immediately');
  // 服务端仍是旧版本时：必须回退本地顺序，并且提示里不出现内部函数名。
  w.__scribeCloud.callFunction=async()=>{throw new Error('不支持的操作。');};
  const moveBack=()=>[...w.document.querySelectorAll('#paper [data-move-page]')].find(button=>button.dataset.movePage==='1'&&button.dataset.delta==='-1');
  assert.ok(moveBack(),'reorder mode stays available after a successful move');
  moveBack().click();
  await tick();await tick();
  assert.deepEqual(localOrder(),[fileIds[1],fileIds[0],fileIds[2]],'a rejected reorder rolls the local order back');
  assert.equal(alerts.length,1,'the user is told the change was not saved');
  assert.doesNotMatch(alerts[0],/scribe-mobile-upload|scribe-study|Edge Function/,'内部函数名不应出现在用户提示里');
  dom.window.close();
});

const BETA_DOM='<div class="nav"></div><div class="topbar"><span id="crumb"></span></div><div id="upload"><div class="upload-grid"></div></div><div id="settings"><div class="settings-grid"></div></div>';
async function betaPage(w,cloud){
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;
  w.__scribeCloud=cloud;
  const pure=(await readFile(new URL('../src/sync-state.js',import.meta.url),'utf8')).replaceAll('export function','function');
  const library=(await readFile(new URL('../src/cloud-library.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'').replace('export function','function');
  const beta=(await readFile(new URL('../src/beta-access.js',import.meta.url),'utf8')).replace('export function','function');
  w.eval(pure+'\n'+library+'\n'+beta+'\nwindow.installLibrary=installLibrary;window.installBeta=installBeta;');
  w.installBeta(cloud);w.installLibrary(cloud);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await tick();await tick();await tick();
}

test('a device without a beta code cannot create a cloud library and is told how to enable it',async()=>{
  const dom=new JSDOM(BETA_DOM,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  const calls=[];
  await betaPage(w,{callFunction:async(name,body)=>{calls.push([name,body]);return{};}});
  assert.equal(calls.filter(([name,body])=>name==='scribe-library'&&body.action==='create').length,0,'no anonymous library may be created during the beta');
  const card=w.document.querySelector('#betaCard-upload');
  assert.ok(card,'the upload view carries the beta code card');
  assert.match(card.textContent,/未开启/);
  assert.match(w.document.querySelector('#cloudSyncState').textContent,/内测码未填写/);
  assert.ok(w.document.querySelector('#betaCard-settings'),'settings also offers the beta code card');
  dom.window.close();
});

test('redeeming a beta code stores a permanent session and the next visit syncs with it',async()=>{
  const dom=new JSDOM(BETA_DOM,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  const calls=[],libraryKey='a'.repeat(64);
  await betaPage(w,{callFunction:async(name,body)=>{calls.push([name,JSON.parse(JSON.stringify(body))]);return name==='scribe-beta'?{mask:'SCRIBE-****-4F2A',label:'内测用户 A',libraryKey,firstDevice:true}:{};}});
  const input=w.document.querySelector('#betaInput-upload');
  input.value='scribe abcd 4f2a';
  w.document.querySelector('#betaRedeem-upload').click();
  await tick();await tick();
  const redeem=calls.find(([name,body])=>name==='scribe-beta'&&body.action==='redeem');
  assert.ok(redeem,'the code is sent to the backend for verification');
  assert.equal(redeem[1].code,'scribe abcd 4f2a','the raw code is what the user typed; normalisation is server side');
  const session=JSON.parse(w.localStorage.getItem('scribe-beta-session'));
  assert.equal(session.libraryKey,libraryKey);
  assert.equal(session.mask,'SCRIBE-****-4F2A');
  assert.match(w.document.querySelector('#betaState-upload').textContent,/已开启/);
  assert.equal(w.document.querySelector('#betaRedeem-upload').hidden,true,'the code input is replaced by the logged-in state');
  dom.window.close();

  // 重新打开页面：会话仍在，云端同步直接使用内测码签发的钥匙，不再新建书库。
  const again=new JSDOM(BETA_DOM,{url:'https://scribe.test',runScripts:'outside-only'}),w2=again.window;
  const calls2=[];
  w2.localStorage.setItem('scribe-beta-session',JSON.stringify({mask:'SCRIBE-****-4F2A',libraryKey,redeemedAt:new Date().toISOString()}));
  await betaPage(w2,{callFunction:async(name,body)=>{calls2.push([name,JSON.parse(JSON.stringify(body))]);return{};}});
  assert.equal(calls2.filter(([name,body])=>name==='scribe-library'&&body.action==='create').length,0,'a logged-in device reuses its key');
  const sync=calls2.find(([name,body])=>name==='scribe-library'&&body.action==='sync');
  assert.equal(sync[1].libraryKey,libraryKey,'the beta key drives the library sync');
  assert.match(w2.document.querySelector('#betaState-upload').textContent,/已开启/);
  again.window.close();
});

test('an invalid beta code is refused without storing a session',async()=>{
  const dom=new JSDOM(BETA_DOM,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  await betaPage(w,{callFunction:async(name)=>{if(name==='scribe-beta')throw new Error('内测码无效或已输入错误，请核对后重试。');return{};}});
  w.document.querySelector('#betaInput-upload').value='SCRIBE-WRNG-0000';
  w.document.querySelector('#betaRedeem-upload').click();
  await tick();await tick();
  assert.equal(w.localStorage.getItem('scribe-beta-session'),null,'a rejected code must not log the device in');
  assert.match(w.document.querySelector('#betaMessage-upload').textContent,/内测码无效/);
  assert.match(w.document.querySelector('#betaState-upload').textContent,/未开启/);
  dom.window.close();
});

test('a pre-beta device that already holds a library key keeps syncing',async()=>{
  const dom=new JSDOM(BETA_DOM,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  const legacy='b'.repeat(64),calls=[];
  w.localStorage.setItem('scribe-library-key',legacy);
  await betaPage(w,{callFunction:async(name,body)=>{calls.push([name,JSON.parse(JSON.stringify(body))]);return{};}});
  const sync=calls.find(([name,body])=>name==='scribe-library'&&body.action==='sync');
  assert.ok(sync,'an existing device must not be locked out of its own data');
  assert.equal(sync[1].libraryKey,legacy);
  assert.match(w.document.querySelector('#betaCard-upload').textContent,/尚未绑定内测码/);
  dom.window.close();
});

test('the student app carries no admin console, only the beta code login',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.doesNotMatch(html,/id=["']betaAdmin["']/,'the admin view must not exist inside the student app');
  assert.doesNotMatch(html,/管理入口/,'no admin entry may be offered to students');
  assert.doesNotMatch(html,/beta-admin-row/,'admin list styles belong to the separate console page');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  await betaPage(w,{callFunction:async()=>({}),library:{call:async()=>({sessions:[]}),sync:async()=>{}}});
  assert.equal(w.document.querySelector('#betaAdmin'),null);
  assert.equal([...w.document.querySelectorAll('.nav button')].some(button=>button.dataset.betaAdmin),false,'no admin nav entry is injected');
  assert.match(w.document.querySelector('#betaCard-upload').textContent,/内测码/,'the tester code entry stays');
  dom.window.close();
});

test('the separate admin console stays locked until the server accepts the password',async()=>{
  const html=await readFile(new URL('../admin.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test/admin.html',runScripts:'outside-only'}),w=dom.window;
  w.confirm=()=>true;
  const copied=[];
  Object.defineProperty(w.navigator,'clipboard',{value:{writeText:async text=>copied.push(text)},configurable:true});
  const calls=[];
  const entry={id:'11111111-2222-3333-4444-555555555555',mask:'SCRIBE-****-4F2A',label:'内测用户 A',revoked:false,bound:true,documents:2,cards:203,devices:2,createdAt:new Date().toISOString(),redeemedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()};
  const cloud={callFunction:async(name,body)=>{
    calls.push([name,JSON.parse(JSON.stringify(body))]);
    assert.equal(name,'scribe-beta');
    if(body.action==='adminAuth'){if(body.password==='open-sesame')return{ok:true};throw new Error('管理口令不正确。');}
    if(body.action==='adminList')return{codes:[entry]};
    if(body.action==='adminCreate')return{codes:[{code:'SCRIBE-ZZZZ-9999',mask:'SCRIBE-****-9999'}]};
    if(body.action==='adminRevoke')return{ok:true,id:entry.id,revoked:true};
    return{ok:true};
  }};
  const source=(await readFile(new URL('../src/admin-console.js',import.meta.url),'utf8')).replace('export function','function');
  w.eval(source+'\nwindow.installAdminConsole=installAdminConsole;');
  w.installAdminConsole(cloud);
  assert.equal(w.document.querySelector('#gate').hidden,false,'the console starts locked');
  assert.equal(w.document.querySelector('#console').hidden,true);
  assert.equal(calls.length,0,'a locked console asks the server for nothing');
  w.document.querySelector('#password').value='wrong-password';
  w.document.querySelector('#gateButton').click();
  await tick();await tick();
  assert.match(w.document.querySelector('#gateMessage').textContent,/口令不正确/);
  assert.equal(w.document.querySelector('#console').hidden,true);
  assert.equal(calls.filter(([,body])=>body.action==='adminList').length,0,'a rejected password must not reach the list');
  w.document.querySelector('#password').value='open-sesame';
  w.document.querySelector('#gateButton').click();
  await tick();await tick();
  assert.equal(w.document.querySelector('#console').hidden,false,'a verified password opens the console');
  assert.equal(w.document.querySelector('#gate').hidden,true);
  const rowText=w.document.querySelector('#rows').textContent;
  assert.match(rowText,/SCRIBE-\*\*\*\*-4F2A/);
  assert.match(rowText,/203/,'card counts are visible to the owner');
  assert.equal(w.document.querySelector('#statDocuments').textContent,'2');
  assert.equal(w.document.querySelector('#statDevices').textContent,'2');
  // 生成：明文只在这一次显示，可复制。
  w.document.querySelector('#count').value='1';
  w.document.querySelector('#label').value='内测用户 B';
  w.document.querySelector('#create').click();
  await tick();await tick();
  const create=calls.find(([,body])=>body.action==='adminCreate');
  assert.equal(create[1].count,1);
  assert.equal(create[1].label,'内测用户 B');
  assert.equal(create[1].password,'open-sesame','every admin call re-verifies the password server side');
  const generated=w.document.querySelector('#generated');
  assert.equal(generated.hidden,false);
  assert.match(generated.textContent,/SCRIBE-ZZZZ-9999/);
  generated.querySelector('#copyCodes').click();
  await tick();
  assert.deepEqual(copied,['SCRIBE-ZZZZ-9999'],'the plaintext codes can be copied once');
  // 停用：调用服务端动作并刷新列表。
  w.document.querySelector('[data-toggle]').click();
  await tick();await tick();
  const revoked=calls.find(([,body])=>body.action==='adminRevoke');
  assert.equal(revoked[1].id,entry.id);
  assert.equal(revoked[1].password,'open-sesame');
  dom.window.close();
});

const seedDoc=(id,title)=>({id,title,author:'示例',category:'示例',status:'reading',progress:38,pages:342,time:'12.6 h',color:''});
function seedCard(id,term){return {id,type:'word',term,meaning:'示例释义',context:'示例语境',source:'The Sociology of Education · p.137',note:'',due:true};}
// 用真实页面骨架（空 body 会让主脚本在 #heat 等处报错），再注入状态与脚本。
async function freshPage(state,libraryKey){
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const alerts=[];w.alert=message=>alerts.push(String(message));w.confirm=()=>true;
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  if(libraryKey)w.localStorage.setItem('scribe-library-key',libraryKey);
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await tick();await tick();
  return {dom,w,alerts};
}

test('the start-over entry never removes a real workspace and keeps the cloud library link',async()=>{
  const libraryKey='d'.repeat(64);
  const state={docs:[seedDoc('s','示例一'),{id:'real-1',title:'我的文献',status:'reading',progress:12,pages:9,time:'3 h'}],
    cards:[seedCard('c1','agency'),{id:'real-card',type:'word',term:'inherit',meaning:'继承',phonetic:'/ɪnˈherɪt/',translation:'继承',context:'Students inherit the culture.',source:'我的文献',note:'',due:true}],
    deletedDocs:[],minutes:412,vocabTotal:0,reviewed:31,filter:'all',tab:'all',kind:'all',settings:{auto:true,timer:true,glossary:'agency = 能动性'}};
  const {dom,w,alerts}=await freshPage(state,libraryKey);
  const entry=w.document.querySelector('#startExperience');
  assert.ok(entry,'the entry button is injected');
  assert.equal(entry.hidden,true,'a workspace with real content must not offer the start-over button');
  entry.click();
  await tick();
  const saved=JSON.parse(w.localStorage.getItem('scribe-local-v1'));
  assert.deepEqual(saved.docs.map(doc=>doc.id),['real-1'],'the user document survives while the sample is removed');
  assert.deepEqual(saved.cards.map(card=>card.id),['real-card'],'the user card survives while the sample card is removed');
  assert.equal(saved.minutes,412,'study minutes are preserved');
  assert.equal(saved.reviewed,31);
  assert.equal(saved.settings.glossary,'agency = 能动性');
  assert.equal(w.localStorage.getItem('scribe-library-key'),libraryKey,'the cloud library key must never be dropped');
  assert.equal(w.localStorage.getItem('scribe-fresh-experience-v1'),null,'real users are not pushed into zero-data mode');
  assert.match(alerts.join(' '),/保留/);
  dom.window.close();
});

test('a workspace holding only built-in samples can still start from zero',async()=>{
  const libraryKey='e'.repeat(64);
  const state={docs:[seedDoc('s','示例一'),seedDoc('m','示例二'),seedDoc('c','示例三')],
    cards:['c1','c2','c3','c4','c5','c6'].map(id=>seedCard(id,'sample-'+id)),
    deletedDocs:[],minutes:47,vocabTotal:0,reviewed:0,filter:'all',tab:'all',kind:'all',settings:{auto:true,timer:true,glossary:''}};
  const {dom,w}=await freshPage(state,libraryKey);
  const entry=w.document.querySelector('#startExperience');
  assert.equal(entry.hidden,false,'a fresh visitor still sees the start-over button');
  entry.click();
  await tick();
  const saved=JSON.parse(w.localStorage.getItem('scribe-local-v1'));
  assert.equal(saved.docs.length,0);
  assert.deepEqual(saved.cards.map(card=>card.id),['guide']);
  assert.equal(w.localStorage.getItem('scribe-fresh-experience-v1'),'1');
  assert.equal(w.localStorage.getItem('scribe-library-key'),libraryKey,'even a fresh start keeps the cloud link');
  dom.window.close();
});

test('an imported document re-signs expired page links instead of showing missing pages',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const calls=[],fresh='https://example.test/fresh-signed.png';
  w.__scribeCloud={callFunction:async(name,body)=>{
    calls.push([name,JSON.parse(JSON.stringify(body))]);
    if(name==='scribe-mobile-upload'&&body.action==='pages')return {files:[{id:'file-1',url:fresh,order:0,name:'page-1.png'}]};
    return {};
  },library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const stale=Date.now()-3*60*60*1000;
  const state={docs:[{id:'cloud-stale',title:'过期链接文献',cloudSessionId:'77777777-8888-9999-aaaa-bbbbbbbbbbbb',status:'reading',color:'new',pages:1,progress:0,lastPage:0,sourcePages:[{id:'cloud-f1',order:1,name:'page-1.png',type:'image/png',url:'https://example.test/expired.png',urlAt:stale,text:'One page of text.',paragraphs:[{text:'One page of text.',translation:'一页正文。'}],sourceFileId:'file-1',pageIndex:0,cloud:true}]}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-stale',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','f'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();await tick();
  const refresh=calls.find(([name,body])=>name==='scribe-mobile-upload'&&body.action==='pages');
  assert.ok(refresh,'stale page links must be re-signed on open');
  assert.equal(refresh[1].sessionId,'77777777-8888-9999-aaaa-bbbbbbbbbbbb');
  assert.equal(refresh[1].libraryKey,'f'.repeat(64));
  const saved=JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs[0].sourcePages[0];
  assert.equal(saved.url,fresh,'the fresh link is written back to the local document');
  assert.ok(saved.urlAt&&Date.now()-saved.urlAt<60000,'the new link is stamped so it is refreshed again only after it ages');
  assert.equal(w.document.querySelector('#sourcePageImage').getAttribute('src'),fresh,'the reader renders the re-signed image');
  assert.match(w.document.querySelector('#paper').textContent,/一页正文。/,'text and translations survive a link refresh');
  dom.window.close();
});

test('a document with no usable page link asks the cloud once, and an image failure falls back gracefully',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const calls=[];
  w.__scribeCloud={callFunction:async(name,body)=>{calls.push([name,JSON.parse(JSON.stringify(body))]);return {files:[]};},library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const state={docs:[{id:'cloud-blank',title:'无链接文献',cloudSessionId:'66666666-7777-8888-9999-aaaaaaaaaaaa',status:'reading',color:'new',pages:1,progress:0,lastPage:0,sourcePages:[{id:'cloud-f9',order:1,name:'page-1.png',type:'image/png',url:'',text:'Body text only.',paragraphs:[{text:'Body text only.',translation:'只有正文。'}],sourceFileId:'file-9',pageIndex:0,cloud:true}]}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-blank',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','9'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();await tick();
  const refresh=calls.filter(([name,body])=>name==='scribe-mobile-upload'&&body.action==='pages');
  assert.equal(refresh.length,1,'a cloud document with no live link asks exactly once, not in a loop');
  assert.match(w.document.querySelector('#paper').textContent,/正在重新获取/);
  assert.match(w.document.querySelector('#paper').textContent,/只有正文。|正文/,'the recognised text stays readable while links are being re-signed');
  dom.window.close();
});

test('page turning keeps working on a multi-batch cloud document with aged links',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const aged=Date.now()-3*60*60*1000, refreshed=[];
  w.__scribeCloud={callFunction:async(name,body)=>{
    if(name==='scribe-mobile-upload'&&body.action==='pages'){
      refreshed.push(body);
      return {files:pages.map((page,index)=>({id:'f-'+index,url:'https://example.test/signed-'+index+'.png',order:index,name:'p'+index+'.png'}))};
    }
    return {};
  },library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  // 27 页：前 9 页来自原批次目录，后 18 页来自续传批次目录，链接都已过期。
  const pages=[...Array(27)].map((_item,index)=>({id:'cloud-f'+index,order:index+1,name:'page-'+(index+1)+'.png',type:'image/png',
    url:'https://example.test/aged-'+(index<9?'a':'b')+'-'+index+'.png',urlAt:aged,
    text:'Paragraph of page '+(index+1)+'.',
    paragraphs:[{text:'Paragraph of page '+(index+1)+'.',translation:'第 '+(index+1)+' 页译文。'}],
    sourceFileId:'f-'+index,pageIndex:index,cloud:true}));
  const state={docs:[{id:'cloud-many',title:'电脑上传文献（9 个文件）',cloudSessionId:'12121212-3434-5656-7878-909090909090',status:'reading',color:'new',pages:27,progress:0,lastPage:17,sourcePages:pages}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-many',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','7'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();await tick();
  const paper=w.document.querySelector('#paper');
  assert.match(paper.textContent,/第 18 \/ 27 页/,'the reader opens on the remembered page');
  const position=()=>w.document.querySelector('#paper .source-page-position').textContent;
  const next=()=>w.document.querySelector('#paper [data-source-next]');
  const prev=()=>w.document.querySelector('#paper [data-source-prev]');
  next().click();
  await tick();await tick();
  assert.match(position(),/第 19 \/ 27 页/,'next page must advance even when the links were aged and re-signed');
  prev().click();
  await tick();await tick();
  assert.match(position(),/第 18 \/ 27 页/,'previous page must go back');
  prev().click();await tick();await tick();
  assert.match(position(),/第 17 \/ 27 页/);
  assert.ok(refreshed.length>=1,'aged links are re-signed, but that must not block page turning');
  const saved=JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs[0];
  assert.equal(saved.lastPage,16,'the current page is persisted for the next visit');
  assert.equal(saved.sourcePages.length,27,'no page may be dropped while re-signing');
  assert.match(w.document.querySelector('#paper').textContent,/第 17 页译文。|第 17 页/,'the page body follows the page turn');
  dom.window.close();
});

test('page turning still works when the browser refuses to save local state',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  w.__scribeCloud={callFunction:async()=>({}),library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const page=(index)=>({id:'cloud-f'+index,order:index+1,name:'page-'+(index+1)+'.png',type:'image/png',url:'https://example.test/'+index+'.png',urlAt:Date.now(),text:'Paragraph of page '+(index+1)+'.',paragraphs:[{text:'Paragraph of page '+(index+1)+'.',translation:'第 '+(index+1)+' 页译文。'}],sourceFileId:'f-'+index,pageIndex:index,cloud:true});
  const state={docs:[{id:'cloud-full',title:'存储已满的文献',status:'reading',color:'new',pages:5,progress:0,lastPage:0,sourcePages:[0,1,2,3,4].map(page)}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-full',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  // 模拟配额写满：之后所有写入都会失败（用原型补丁，和 cloud-library 的拦截方式一致）。
  const proto=Object.getPrototypeOf(w.localStorage);
  const originalSet=proto.setItem;
  let blocked=false;
  proto.setItem=function(name,value){if(blocked&&name==='scribe-local-v1')throw new Error('QuotaExceededError');return originalSet.call(this,name,value);};
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
  await tick();await tick();
  blocked=true;
  let threw=false;
  try{w.localStorage.setItem('scribe-local-v1','{}');}catch(error){threw=true;}
  assert.equal(threw,true,'the test must actually block writes');
  const position=()=>w.document.querySelector('#paper .source-page-position').textContent;
  assert.match(position(),/第 1 \/ 5 页/);
  w.document.querySelector('#paper [data-source-next]').click();
  await tick();await tick();
  assert.match(position(),/第 2 \/ 5 页/,'下一頁 must still turn when the local write fails');
  w.document.querySelector('#paper [data-source-next]').click();
  await tick();await tick();
  assert.match(position(),/第 3 \/ 5 页/);
  w.document.querySelector('#paper [data-source-prev]').click();
  await tick();await tick();
  assert.match(position(),/第 2 \/ 5 页/);
  assert.match(w.document.querySelector('#paper').textContent,/本机存储空间不足/,'the user is told the progress could not be saved');
  assert.match(w.document.querySelector('#paper').textContent,/第 2 页译文。/,'the page body follows the turn');
  dom.window.close();
});

test('redeeming a code from another library really switches the device over',async()=>{
  const oldKey='1'.repeat(64),newKey='2'.repeat(64),calls=[];
  const cloudDocs=[{id:'cloud-real',title:'真实书库文献',pages:27,sourcePages:[{id:'p1',order:1,name:'p1.png',type:'image/png',url:'https://example.test/p1.png',text:'Real page.'}]}];
  const cloud={callFunction:async(name,body)=>{
    calls.push([name,JSON.parse(JSON.stringify(body))]);
    if(name==='scribe-beta')return {mask:'SCRIBE-****-4F2A',label:'内测用户 A',libraryKey:newKey};
    if(name==='scribe-library'&&body.action==='validate')return {libraryId:'lib-real'};
    if(name==='scribe-library'&&body.action==='sync'){
      if(body.libraryKey===oldKey)return {entries:[],documents:[],conflicts:[]};
      return {entries:[{kind:'doc',entry_id:'cloud-real',value:cloudDocs[0],revision:1,deleted:false}],documents:cloudDocs,conflicts:[]};
    }
    return {};
  }};
  // 这台设备原本连着另一个（旧的）书库，本机还有一份旧文献。
  const dom=new JSDOM(BETA_DOM,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.localStorage.setItem('scribe-library-key',oldKey);
  w.localStorage.setItem('scribe-local-v1',JSON.stringify({docs:[{id:'cloud-old',title:'旧书库文献',pages:9,sourcePages:[{id:'o1',order:1,name:'o1.png',type:'image/png',url:'https://example.test/o1.png',text:'Old page.'}]}],cards:[],deletedDocs:[],minutes:0,settings:{}}));
  await betaPage(w,cloud);
  assert.equal(calls.filter(([name,body])=>name==='scribe-library'&&body.action==='create').length,0);
  w.document.querySelector('#betaInput-upload').value='SCRIBE-ABCD-4F2A';
  w.document.querySelector('#betaRedeem-upload').click();
  await tick();await tick();await tick();
  assert.equal(w.localStorage.getItem('scribe-library-key'),newKey,'设备必须切到内测码所属的书库');
  const session=JSON.parse(w.localStorage.getItem('scribe-beta-session'));
  assert.equal(session.libraryKey,newKey);
  const pulled=calls.filter(([name,body])=>name==='scribe-library'&&body.action==='sync'&&body.libraryKey===newKey);
  assert.ok(pulled.length>=1,'切换后必须拉取新书库的数据');
  const saved=JSON.parse(w.localStorage.getItem('scribe-local-v1'));
  assert.deepEqual(saved.docs.map(doc=>doc.id),['cloud-real'],'界面显示的是新书库的文献');
  assert.equal(saved.docs[0].pages,27);
  const backup=JSON.parse(w.localStorage.getItem('scribe-last-workspace'));
  assert.equal(backup.libraryKey,oldKey,'切换前会留一份可回滚的备份');
  dom.window.close();

  // 另一种情况：内测码绑定的就是本机现有书库 —— 必须原地保留，不能清数据。
  const dom2=new JSDOM(BETA_DOM,{url:'https://scribe.test',runScripts:'outside-only'}),w2=dom2.window;
  const sameCalls=[];
  const keepKey='3'.repeat(64);
  w2.localStorage.setItem('scribe-library-key',keepKey);
  w2.localStorage.setItem('scribe-local-v1',JSON.stringify({docs:[{id:'cloud-mine',title:'我的 27 页文献',pages:27,sourcePages:[{id:'m1',order:1,name:'m1.png',type:'image/png',url:'https://example.test/m1.png',text:'My page.'}]}],cards:[{id:'card-1',type:'word',term:'inherit'}],deletedDocs:[],minutes:412,settings:{}}));
  await betaPage(w2,{callFunction:async(name,body)=>{
    sameCalls.push([name,JSON.parse(JSON.stringify(body))]);
    if(name==='scribe-beta')return {mask:'SCRIBE-****-4F2A',label:'',libraryKey:keepKey,reused:true};
    return {};
  }});
  w2.document.querySelector('#betaInput-upload').value='SCRIBE-ABCD-4F2A';
  w2.document.querySelector('#betaRedeem-upload').click();
  await tick();await tick();await tick();
  assert.equal(w2.localStorage.getItem('scribe-library-key'),keepKey,'绑定到本机书库时钥匙不变');
  const kept=JSON.parse(w2.localStorage.getItem('scribe-local-v1'));
  assert.deepEqual(kept.docs.map(doc=>doc.id),['cloud-mine'],'绑定不能清掉本机文献');
  assert.equal(kept.cards.length,1);
  assert.equal(kept.minutes,412);
  assert.equal(sameCalls.filter(([name,body])=>name==='scribe-library'&&body.action==='validate').length,0,'绑定本机书库时不应该走切换流程');
  dom2.window.close();
});

test('each clicked word is looked up immediately and in parallel with earlier ones',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const requests=[],settle=[];
  w.__scribeCloud={callFunction:async(name,body)=>{
    if(name==='scribe-study'&&body.action==='define'){
      requests.push(body.words[0].word);
      // 挂起：模拟正在思考的模型，看看第二张卡会不会被第一张卡挡住。
      return await new Promise(resolve=>settle.push(()=>resolve({words:[{word:body.words[0].word,phonetic:'/'+body.words[0].word+'/',gloss:'简释',meaning:body.words[0].word+' 的语境释义'}]})));
    }
    return {};
  },library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const paragraph='Students accumulate symbolic capital during seminars.';
  const state={docs:[{id:'cloud-words',title:'点词测试',status:'reading',color:'new',pages:1,progress:0,lastPage:0,sourcePages:[{id:'cp1',order:1,name:'p1.png',type:'image/png',url:'https://example.test/p1.png',text:paragraph,paragraphs:[{text:paragraph,translation:'学生在研讨课上积累符号资本。'}],sourceFileId:'f1',pageIndex:0,cloud:true}]}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-words',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','h'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();
  const word=term=>[...w.document.querySelectorAll('#paper .word')].find(item=>item.textContent===term);
  const click=element=>element.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
  click(word('accumulate'));
  await tick();await tick();
  assert.deepEqual(requests,['accumulate'],'点一下就应该立刻发出查询，不需要再点第二次');
  click(word('capital'));
  await tick();await tick();
  assert.deepEqual(requests,['accumulate','capital'],'第二张卡不能被第一张卡挡住，两个查询要并行');
  assert.equal(settle.length,2,'两个查询都在进行中');
  settle[1]();// 后点的词先回来也要能正确落到自己的卡片上
  await tick();await tick();
  const cards=()=>JSON.parse(w.localStorage.getItem('scribe-local-v1')).cards;
  const capital=cards().find(card=>card.term==='capital');
  assert.equal(capital.translation,'capital 的语境释义','后点的词先返回时也要写回自己的卡片');
  assert.equal(capital.phonetic,'/capital/');
  assert.equal(cards().find(card=>card.term==='accumulate').translation,'','先点的词还没返回，不能被顶替');
  settle[0]();
  await tick();await tick();
  const accumulate=cards().find(card=>card.term==='accumulate');
  assert.equal(accumulate.translation,'accumulate 的语境释义','先点的词返回后同样要写回自己的卡片');
  assert.equal(accumulate.phonetic,'/accumulate/');
  assert.equal(requests.length,2,'同一张卡不会因为渲染而重复请求');
  dom.window.close();
});

test('clicking a word that is already selected still adds it in one click',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  const requests=[];
  w.__scribeCloud={callFunction:async(name,body)=>{if(name==='scribe-study'&&body.action==='define')requests.push(body.words[0].word);return {words:[{word:'capital',phonetic:'/ˈkæpɪtl/',gloss:'资本',meaning:'资本；此处指符号资本'}]};},library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const paragraph='Students accumulate symbolic capital during seminars.';
  const state={docs:[{id:'cloud-sel',title:'选中点词',status:'reading',color:'new',pages:1,progress:0,lastPage:0,sourcePages:[{id:'cp1',order:1,name:'p1.png',type:'image/png',url:'https://example.test/p1.png',text:paragraph,paragraphs:[{text:paragraph,translation:'学生在研讨课上积累符号资本。'}],sourceFileId:'f1',pageIndex:0,cloud:true}]}],cards:[],deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-sel',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','i'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();
  const target=[...w.document.querySelectorAll('#paper .word')].find(item=>item.textContent==='capital');
  // 模拟“这个词此刻正被选中”的点击：旧逻辑会把它当成划选而忽略掉。
  const selection=w.getSelection(),range=w.document.createRange();
  range.selectNodeContents(target);selection.removeAllRanges();selection.addRange(range);
  assert.equal(w.getSelection().toString().trim(),'capital');
  target.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
  await tick();await tick();
  assert.deepEqual(requests,['capital'],'选中状态下点词也要一次就发起查询');
  const card=JSON.parse(w.localStorage.getItem('scribe-local-v1')).cards.find(item=>item.term==='capital');
  assert.ok(card,'一次点击就要建卡');
  assert.equal(card.translation,'资本；此处指符号资本');
  assert.equal(w.getSelection().toString().trim(),'','处理完点词后清掉选区，避免菜单残留');
  dom.window.close();
});

test('captured words are re-marked right after a page render and the clicked word flashes',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const dom=new JSDOM(html,{url:'https://scribe.test',runScripts:'outside-only'}),w=dom.window;
  w.structuredClone=structuredClone;w.TextEncoder=TextEncoder;w.scrollTo=()=>{};
  w.setTimeout=()=>0;w.setInterval=()=>0;w.fetch=()=>new Promise(()=>{});
  w.__scribeCloud={callFunction:async(name,body)=>name==='scribe-study'&&body.action==='define'?{words:[{word:body.words[0].word,phonetic:'/'+body.words[0].word+'/',gloss:'简释',meaning:'语境释义'}]}:{},library:{call:async()=>({sessions:[]}),sync:async()=>{}}};
  const first='The first page mentions nothing of interest.',second='A second page about memory and attention.';
  const page=(index,text)=>({id:'pg'+index,order:index+1,name:'p'+(index+1)+'.png',type:'image/png',url:'https://example.test/'+index+'.png',urlAt:Date.now(),text,paragraphs:[{text,translation:'第 '+(index+1)+' 页译文。'}],sourceFileId:'f'+index,pageIndex:index,cloud:true});
  const state={docs:[{id:'cloud-mark',title:'标记测试',status:'reading',color:'new',pages:2,progress:0,lastPage:0,sourcePages:[page(0,first),page(1,second)]}],
    cards:[{id:'card-1',type:'word',term:'memory',meaning:'记忆',phonetic:'/ˈmeməri/',translation:'记忆',gloss:'记忆',context:second,source:'标记测试',note:'',due:true}],
    deletedDocs:[],minutes:0,reviewed:0,filter:'all',tab:'all',kind:'all',activeDocId:'cloud-mark',settings:{auto:true,timer:true,glossary:''}};
  w.localStorage.setItem('scribe-local-v1',JSON.stringify(state));
  w.localStorage.setItem('scribe-library-key','j'.repeat(64));
  for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/type=["']module["']|\bsrc=/.test(match[1]))w.eval(match[2]);
  await tick();await tick();await tick();
  const find=(term)=>[...w.document.querySelectorAll('#paper .word')].find(item=>item.textContent===term);
  assert.ok(find('first'),'the first page renders');
  w.document.querySelector('#paper [data-source-next]').click();
  await tick();await tick();await tick();
  const memory=find('memory');
  assert.ok(memory,'the second page renders after the page turn');
  assert.equal(memory.classList.contains('captured'),true,'已收藏的词在翻页后立刻高亮，不需要再点一次');
  memory.dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
  await tick();
  assert.equal(memory.classList.contains('word-flash'),true,'点词时正文里那个词会闪动提示');
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
