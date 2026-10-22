import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {runUploadPool,retry,uploadSummary,transferSigned,uploadCloudFile} from '../src/upload-engine.js';
import {localEntries,applyEntries} from '../src/sync-state.js';
import {IDBFactory} from 'fake-indexeddb';
import {transform} from 'esbuild';
import {fileRangeTransport} from '../src/pdf-range.js';
import {downloadOriginal} from '../src/original-download.js';
import {captureActivity,applyActivity} from '../src/study-counters.js';
import {JSDOM} from 'jsdom';
import * as uploadEngine from '../src/upload-engine.js';

test('activity journal retains in-flight increments and does not recount cloud totals',()=>{
  const originalStorage=globalThis.localStorage,values=new Map();
  globalThis.localStorage={getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)};
  try{
    captureActivity('library-A',{minutes:100,reviewed:10});
    const snapshot=captureActivity('library-A',{minutes:110,reviewed:12});
    assert.equal(snapshot.request.minutes,10);
    const next={};applyActivity(snapshot,{minutes:130,reviewed:14},{minutes:115,reviewed:13},next);
    assert.equal(next.minutes,135);assert.equal(next.reviewed,15);
    const subsequent=captureActivity('library-A',next);
    assert.equal(subsequent.request.minutes,15);assert.equal(subsequent.request.reviewed,3);
    assert.equal(captureActivity('library-A',next).request.minutes,15);
    assert.equal(captureActivity('library-B',{minutes:0,reviewed:0}).request.minutes,0);
  }finally{globalThis.localStorage=originalStorage;}
});

test('paginated backend reads all 1501 rows and JSON byte limits reject oversize payloads',async()=>{
  const source=(await readFile(new URL('../supabase/functions/_shared/cloud.ts',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export\s+/gm,'');
  const {code}=await transform(source,{loader:'ts',target:'es2022'});
  const {allRows,readJsonLimited}=new Function(code+';return {allRows,readJsonLimited};')();
  const rows=Array.from({length:1501},(_,index)=>({id:index})),queries=[];
  const result=await allRows(async(from,to)=>{queries.push([from,to]);return {data:rows.slice(from,to+1)};});
  assert.equal(result.length,1501);assert.equal(queries.length,4);assert.equal(result.at(-1).id,1500);
  assert.deepEqual(await readJsonLimited(new Request('https://test.invalid',{method:'POST',body:'{"ok":true}'}),50),{ok:true});
  await assert.rejects(readJsonLimited(new Request('https://test.invalid',{method:'POST',body:'{"text":"中文中文中文"}'}),20),error=>error.status===413);
});

test('PDF range reads request slices without reading the entire file into UI memory',async()=>{
  const file=new File([new Uint8Array(1024*1024)],'book.pdf');
  file.arrayBuffer=()=>{throw new Error('Whole-file read is forbidden');};
  class Transport{constructor(size,initial){this.length=size;this.initial=initial;}onDataRange(begin,chunk){this.received={begin,size:chunk.length};}}
  let failed;const transport=fileRangeTransport(file,Transport,error=>{failed=error;});
  transport.requestDataRange(65536,131072);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(failed,undefined);assert.deepEqual(transport.received,{begin:65536,size:65536});assert.equal(transport.initial.length,0);
  transport.abort();transport.requestDataRange(0,100);await new Promise(resolve=>setImmediate(resolve));assert.equal(transport.received.begin,65536);
});

test('original PDF download streams pieces in source order and validates bytes',async()=>{
  const oldWindow=globalThis.window,oldFetch=globalThis.fetch;
  const written=[];let closed=false,aborted=false;
  globalThis.window={showSaveFilePicker:async()=>({createWritable:async()=>({write:async blob=>written.push(await blob.text()),close:async()=>{closed=true;},abort:async()=>{aborted=true;}})})};
  globalThis.fetch=async url=>new Response(url.endsWith('one')?'ABC':'DEF');
  const cloud={library:{ensureLibrary:async()=>'test-only-key'},callFunction:async()=>({sources:[
    {sourceId:'original',part:1,partSize:3,url:'https://storage.test/two'},
    {sourceId:'original',part:0,partSize:3,url:'https://storage.test/one'},
  ]})};
  try{
    await downloadOriginal(cloud,{cloudSessionId:'batch',originalSources:[{id:'original',name:'book.pdf',size:6,parts:2}]});
    assert.equal(written.join(''),'ABCDEF');assert.equal(closed,true);assert.equal(aborted,false);
  }finally{globalThis.window=oldWindow;globalThis.fetch=oldFetch;}
});

test('translation batching never removes paragraphs beyond 80, including an AI failure',async()=>{
  const source=(await readFile(new URL('../supabase/functions/_shared/ocr-core.ts',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export\s+/gm,'');
  const {code}=await transform(source,{loader:'ts',target:'es2022'});
  const logs={warn(){},log(){},error(){}};
  const factory=new Function('Deno','fetch','console',code+';return {translateParagraphs};');
  const core=factory({env:{get:()=>''}},()=>{throw new Error('No network should be used without AI credentials');},logs);
  const text=Array.from({length:180},(_,index)=>`Original paragraph ${index+1}.`).join('\n\n');
  const result=await core.translateParagraphs(text,'synthetic');
  assert.equal(result.length,180);assert.equal(result[179].text,'Original paragraph 180.');
  assert.equal(result[179].translation,'');
  const saved=result.map((row,index)=>({...row,translation:index<80?'已翻译':''}));
  const again=await core.translateParagraphs(text,'synthetic',saved);
  assert.equal(again.length,180);assert.equal(again[0].translation,'已翻译');assert.equal(again[179].text,result[179].text);
});

test('TUS resumes from confirmed offset after a lost chunk response and never leaks credentials to another origin',async()=>{
  const originalFetch=globalThis.fetch,OriginalXHR=globalThis.XMLHttpRequest;
  const chunk=6*1024*1024,file=new File([new Uint8Array(chunk*2+23)],'large.pdf',{type:'application/pdf'});
  let serverOffset=0,lost=false,creations=0;const offsets=[],heads=[],checkpoints=[];
  globalThis.fetch=async(url,options)=>{
    if(options.method==='POST'){creations++;return new Response('',{status:201,headers:{Location:'/storage/v1/upload/resumable/synthetic'}});}
    assert.equal(options.method,'HEAD');heads.push(serverOffset);return new Response(null,{status:200,headers:{'Upload-Offset':String(serverOffset)}});
  };
  globalThis.XMLHttpRequest=class{
    upload={};headers={};open(method,url){assert.equal(method,'PATCH');this.url=url;}
    setRequestHeader(key,value){this.headers[key]=value;}
    getResponseHeader(){return String(serverOffset);}
    send(body){offsets.push(Number(this.headers['Upload-Offset']));assert.equal(Number(this.headers['Upload-Offset']),serverOffset);serverOffset+=body.size;
      if(!lost){lost=true;this.onerror();}else{this.status=204;this.onload();}}
  };
  try{
    const signed={resumableUrl:'https://storage.test/storage/v1/upload/resumable',uploadToken:'object-scoped-signature',path:'private/object.pdf'};
    await transferSigned(signed,file,()=>{}, {save:async url=>checkpoints.push(url)});
    assert.equal(serverOffset,file.size);assert.equal(creations,1);assert.deepEqual(offsets,[0,chunk,chunk*2]);assert.deepEqual(heads,[chunk]);
    assert.equal(checkpoints.length,1);
    await assert.rejects(transferSigned(signed,file,()=>{},{url:'https://evil.test/storage/v1/upload/resumable/stolen'}),/不安全/);
  }finally{globalThis.fetch=originalFetch;globalThis.XMLHttpRequest=OriginalXHR;}
});

test('registration retry does not retransfer the already delivered original',async()=>{
  const OriginalXHR=globalThis.XMLHttpRequest;let puts=0,registrations=0;
  globalThis.XMLHttpRequest=class{upload={};open(){puts++;}setRequestHeader(){}send(){this.status=200;this.onload();}};
  try{
    await uploadCloudFile(async(name,body)=>{
      if(body.action==='sign')return {fileId:'same-id',uploadUrl:'https://storage.test/signed'};
      if(++registrations===1)throw new Error('lost registration response');return {ok:true};
    },'token',new File(['bytes'],'page.jpg'),0);
    assert.equal(puts,1);assert.equal(registrations,2);
  }finally{globalThis.XMLHttpRequest=OriginalXHR;}
});

test('500 uploads stay ordered despite reversed completion, bound concurrency and retry only failures',async()=>{
  const items=Array.from({length:500},(_,index)=>({file:{name:`page-${index}`,size:100},state:''}));
  let active=0,peak=0;const completed=[];
  await assert.rejects(runUploadPool(items,async(item,index,onProgress)=>{
    active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,index%3));active--;
    if(index===17||index===250)throw new Error('synthetic offline');
    onProgress(100);completed.push(index);
  },{concurrency:3}),/2 个文件暂未送达/);
  assert.equal(peak,3);assert.equal(active,0);assert.equal(completed.length,498);
  assert.equal(items[17].state,'error');assert.equal(items[250].state,'error');
  const retried=[];await runUploadPool(items,async(item,index)=>retried.push(index));
  assert.deepEqual(retried,[17,250]);assert.deepEqual(items.map(item=>item.file.name),Array.from({length:500},(_,index)=>`page-${index}`));
  assert.equal(uploadSummary(items).percent,100);
});

test('transient retries are bounded; permission and size failures are not retried',async()=>{
  let attempts=0;
  assert.equal(await retry(()=>{if(++attempts<3)throw new Error('offline');return 'ok';},{wait:async()=>{}}),'ok');
  assert.equal(attempts,3);
  for(const status of [401,403,413,415]){
    attempts=0;await assert.rejects(retry(()=>{attempts++;throw Object.assign(new Error('denied'),{status});},{wait:async()=>{}}));assert.equal(attempts,1);
  }
});

test('cloud metadata does not duplicate canonical pages, and delta sync preserves cached pages',()=>{
  const state={docs:[{id:'cloud-a',cloudSessionId:'a',progress:15,sourcePages:[{text:'private OCR',paragraphs:[{translation:'译文'}]}]}],cards:[]};
  const entry=localEntries(state).get('doc:cloud-a');
  assert.equal(entry.value.sourcePages,undefined);
  const next=applyEntries(state,[{kind:'doc',entry_id:'cloud-a',value:{...entry.value,progress:20}}],[]);
  assert.equal(next.docs[0].sourcePages[0].text,'private OCR');assert.equal(next.docs[0].progress,20);
  const restored=applyEntries({...state,docs:[],deletedDocs:[{...state.docs[0],deletedAt:'2026-10-01'}]},[{kind:'doc',entry_id:'cloud-a',value:entry.value}],[]);
  assert.equal(restored.docs[0].deletedAt,undefined,'restoring must not retain the previous trash timestamp');
  assert.equal(restored.deletedDocs.length,0);assert.equal(restored.docs[0].sourcePages[0].text,'private OCR');
});

test('binary staging restores queues after reload without keeping all Files in UI memory',async()=>{
  globalThis.indexedDB=new IDBFactory();
  const store=await import('../src/upload-store.js');
  const files=Array.from({length:50},(_,index)=>new File([new Uint8Array(1024)],`page-${index}.jpg`,{type:'image/jpeg'}));
  const {items,sources}=await store.prepareSelection(files);
  assert.equal(items.length,50);assert.ok(items.every(item=>!(item.file instanceof Blob)));
  items[3].state='uploaded';items.reverse();
  await store.saveDraft('test-library',items,{sources,locked:true});
  const draft=await store.readDraft('test-library');
  assert.equal(draft.locked,true);assert.equal(draft.items[0].file.name,'page-49.jpg');
  const restored=await store.loadFile(draft.items[0]);assert.equal(restored.size,1024);assert.equal(restored.type,'image/jpeg');
  const noMime=await store.stageFile(new File(['JPEG bytes'],'camera.jpg'));
  assert.equal((await store.loadFile(noMime)).type,'image/jpeg','an empty OS MIME must not become a forbidden octet-stream upload');
  await store.discardItems([noMime]);
  await store.clearDraft('test-library',items,sources);
  assert.equal(await store.readDraft('test-library'),undefined);await assert.rejects(store.loadFile(items[0]),/暂存文件已不可用/);
});

test('streamed PDF staging preserves exact original parts and fails atomically instead of skipping pages',async()=>{
  const store=await import('../src/upload-store.js');
  const original=new File(['exact-PDF-bytes'],'book.pdf',{type:'application/pdf'});
  const {items,sources}=await store.prepareSelection([original],{explode:async(file,progress,onPage)=>{
    for(let page=1;page<=28;page++)await onPage(new File(['jpeg'],`page-${page}.jpg`,{type:'image/jpeg'}),page,28);
  }});
  assert.equal(items.length,28);assert.equal(sources.length,1);
  assert.equal(await (await store.loadFile(sources[0])).text(),await original.text());
  const manifest=store.manifestOf(items,sources);assert.equal(manifest.files.length,28);assert.equal(manifest.originals[0].originalName,'book.pdf');
  await assert.rejects(store.prepareSelection([original],{explode:async(file,progress,onPage)=>{await onPage(new File(['jpeg'],'one.jpg'),1,2);throw new Error('bad page 2');}}),/bad page 2/);
  await store.clearDraft('pdf',items,sources);
});

async function database(seed){
  const db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  const base=await readFile(new URL('../supabase/migrations/migration_20261013_142714000',import.meta.url),'utf8');
  await db.exec(base.replace(/create extension[^;]+;/g,''));
  const functions=await readFile(new URL('../supabase/migrations/migration_20261013_142725000',import.meta.url),'utf8');
  await db.exec(functions.slice(0,functions.indexOf('-- 关闭标签页')));
  if(seed)await seed(db);
  await db.exec(await readFile(new URL('../supabase/migrations/20261021150000_upload_integrity.sql',import.meta.url),'utf8'));
  return db;
}
test('schema upgrade keeps legacy text/cards, repairs duplicate order without dropping pages, and never expires finished books',async()=>{
  let session,library;
  const db=await database(async db=>{
    library=(await db.query("insert into scribe_libraries(access_hash) values('legacy') returning id")).rows[0].id;
    session=(await db.query("insert into scribe_cloud_sessions(library_id,token,completed_at,expires_at) values($1,'legacy-link',now(),now()-interval '60 days') returning id",[library])).rows[0].id;
    await db.query("insert into scribe_cloud_files(session_id,queue_order,name,ocr_text,uploaded_at) values($1,0,'first.jpg','first original',now()),($1,0,'second.jpg','second original',now())",[session]);
    await db.query("insert into scribe_library_entries(library_id,kind,entry_id,value) values($1,'card','card-1','{\"note\":\"private note\"}')",[library]);
  });
  try{
    const rows=(await db.query('select queue_order,ocr_text from scribe_cloud_files where session_id=$1 order by queue_order',[session])).rows;
    assert.deepEqual(rows.map(row=>row.queue_order),[0,1]);assert.deepEqual(new Set(rows.map(row=>row.ocr_text)),new Set(['first original','second original']));
    assert.equal((await db.query("select value from scribe_library_entries where entry_id='card-1'")).rows[0].value.note,'private note');
    assert.equal((await db.query('select * from scribe_cleanup_candidates()')).rows.length,0,'a completed book is not an expired temporary upload');
    await db.query("insert into scribe_cloud_sessions(library_id,token,expires_at) values($1,'unfinished',now()-interval '31 days')",[library]);
    assert.equal((await db.query('select * from scribe_cleanup_candidates()')).rows.length,1,'abandoned uploads eventually become cleanup candidates');
  }finally{await db.close();}
});
test('PostgreSQL confirms every page/original, rejects mismatched retries, atomically reorders and isolates private tables',async()=>{
  const db=await database();
  try{
    const library=(await db.query("insert into scribe_libraries(access_hash) values('private') returning id")).rows[0].id;
    const create=async token=>(await db.query("insert into scribe_cloud_sessions(token,expires_at,library_id) values($1,now()+interval '1 day',$2) returning id",[token,library])).rows[0].id;
    const session=await create('batch');
    const manifest={files:Array.from({length:28},(_,index)=>({name:`page-${index}.jpg`,size:4,mime:'image/jpeg'})),originals:[{name:'source.pdf',size:8,sourceId:crypto.randomUUID(),originalName:'book.pdf',originalSize:8,part:0,parts:1}]};
    const prepare=()=>db.query('select scribe_prepare_upload($1,$2) as result',[session,JSON.stringify(manifest)]);
    await prepare();await prepare();assert.equal((await db.query('select count(*)::int n from scribe_cloud_files')).rows[0].n,28);
    await assert.rejects(db.query('select scribe_prepare_upload($1,$2)',[session,JSON.stringify({...manifest,files:manifest.files.toReversed()})]),/顺序已锁定/);
    await db.query('update scribe_cloud_files set uploaded_at=now() where session_id=$1 and queue_order<>17',[session]);
    await assert.rejects(db.query('select scribe_finalize_upload($1)',[session]),/未完整送达/);
    await db.query('update scribe_cloud_files set uploaded_at=now() where session_id=$1',[session]);
    await assert.rejects(db.query('select scribe_finalize_upload($1)',[session]),/未完整送达/);
    await db.query('update scribe_source_assets set uploaded_at=now() where session_id=$1',[session]);
    assert.equal((await db.query('select scribe_finalize_upload($1) result',[session])).rows[0].result.fileCount,28);
    await db.query('select scribe_finalize_upload($1)',[session]);
    const ids=(await db.query('select id from scribe_cloud_files where session_id=$1 order by queue_order',[session])).rows.map(row=>row.id).reverse();
    await db.query('select scribe_reorder_pages($1,$2)',[session,ids]);
    assert.deepEqual((await db.query('select id from scribe_cloud_files where session_id=$1 order by queue_order',[session])).rows.map(row=>row.id),ids);
    const duplicate=[...ids];duplicate[0]=duplicate[1];await assert.rejects(db.query('select scribe_reorder_pages($1,$2)',[session,duplicate]),/不一致/);
    const second=await create('append');
    await db.query("select scribe_reserve_page($1,0,'extra.jpg',4,'image/jpeg')",[second]);
    await db.query('update scribe_cloud_files set uploaded_at=now() where session_id=$1',[second]);
    await db.query('select scribe_finalize_upload($1)',[second]);
    assert.equal((await db.query('select scribe_absorb_upload($1,$2,$3) result',[library,second,session])).rows[0].result.pages,29);
    assert.equal((await db.query('select count(*)::int n from scribe_cloud_files where session_id=$1',[session])).rows[0].n,29);
    assert.equal((await db.query('select count(*)::int n from scribe_source_assets where session_id=$1',[session])).rows[0].n,1);
    for(const table of ['scribe_source_assets','scribe_study_counters']){
      assert.equal((await db.query('select relrowsecurity from pg_class where relname=$1',[table])).rows[0].relrowsecurity,true);
      assert.equal((await db.query("select has_table_privilege('anon',$1,'select') allowed",[table])).rows[0].allowed,false);
    }
    const deviceA=crypto.randomUUID(),deviceB=crypto.randomUUID();
    const merge=(device,minutes,reviewed)=>db.query('select scribe_merge_counters($1,$2,100,10,$3,$4) totals',[library,device,minutes,reviewed]);
    await merge(deviceA,20,2);await merge(deviceA,20,2);const totals=(await merge(deviceB,30,4)).rows[0].totals;
    assert.equal(totals.minutes,150);assert.equal(totals.reviewed,16);
    assert.equal((await merge(deviceA,10,1)).rows[0].totals.minutes,150,'stale devices cannot decrement counters');
    assert.equal((await db.query('select scribe_merge_counters($1,$2,150,16,0,0) totals',[library,crypto.randomUUID()])).rows[0].totals.minutes,150,'a new device starting with cloud totals cannot count history twice');
  }finally{await db.close();}
});

test('desktop uses the new staged pool, prevents double submit and does not rebuild rows on progress',async()=>{
  const store=await import('../src/upload-store.js');
  const dom=new JSDOM('<div id="upload"><div class="notice"></div><div id="drop"><input id="fileInput"><span class="tiny muted"></span></div><div id="fileRow"><span id="fileName"></span><span id="fileMeta"></span></div><button id="process"></button></div><div id="steps"></div>',{url:'https://upload.test',runScripts:'outside-only'});
  const w=dom.window;w.TextEncoder=TextEncoder;Object.defineProperty(w,'crypto',{value:globalThis.crypto});
  w.__scribeUploads={...uploadEngine,...store};
  let created=0,active=0,peak=0,firstRow;const uploaded=[],calls=[];
  w.__scribeCloud={callFunction:async(name,body)=>{calls.push(body);return{};},library:{
    call:async()=>{await new Promise(resolve=>setTimeout(resolve,10));return {uploadVersion:2};},
    createSession:async()=>{created++;return {token:'synthetic-batch',sessionId:'synthetic-id'};},
    upload:async(token,file,index,onProgress)=>{
      active++;peak=Math.max(peak,active);firstRow??=w.document.querySelector('#computerQueue>div');
      onProgress(50);assert.equal(w.document.querySelector('#computerQueue>div'),firstRow);
      await new Promise(resolve=>setTimeout(resolve,index%3+1));active--;uploaded.push([file.name,index]);
    },sync:async()=>{},awaitBatch:async()=>{throw new Error('Synthetic pause after cloud submission');},
  }};
  const until=async predicate=>{for(let n=0;n<600;n++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('UI condition timed out');};
  try{
    w.eval(await readFile(new URL('../public/import-queue.js',import.meta.url),'utf8'));w.document.dispatchEvent(new w.Event('DOMContentLoaded'));
    const input=w.document.querySelector('#fileInput');await until(()=>!input.disabled);
    Object.defineProperty(input,'files',{value:Array.from({length:120},(_,index)=>new File(['text'],`page-${index}.txt`,{type:'text/plain'}))});
    input.dispatchEvent(new w.Event('change',{bubbles:true}));await until(()=>w.document.querySelectorAll('#computerQueue>div').length===120);
    w.document.querySelector('[aria-label="下移"]').click();
    const button=w.document.querySelector('#process');button.click();button.click();
    await until(()=>/Synthetic pause/.test(w.document.querySelector('#computerQueueHint').textContent));
    assert.equal(created,1);assert.equal(uploaded.length,120);assert.equal(peak,3);assert.equal(active,0);
    const manifest=calls.find(call=>call.action==='prepare').manifest;
    assert.equal(manifest.files[0].name,'page-1.txt');assert.equal(manifest.files[1].name,'page-0.txt');
    assert.equal(uploaded.find(([name])=>name==='page-1.txt')[1],0);assert.equal(calls.filter(call=>call.action==='complete').length,1);
    assert.equal(await store.readDraft('desktop:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('local'))),n=>n.toString(16).padStart(2,'0')).join('')),undefined);
  }finally{dom.window.close();}
});
