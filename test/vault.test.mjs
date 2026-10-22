import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';

const vault=await readFile(new URL('../public/storage-vault.js',import.meta.url),'utf8');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const PAGE='<!doctype html><html><head></head><body><script type="scribe/boot">window.seen=localStorage.getItem("scribe-local-v1");window.order=(window.order||[]).concat("a");</script><script type="scribe/boot">window.order=window.order.concat("b");</script></body></html>';

function boot(factory,prepare){
  const dom=new JSDOM(PAGE,{url:'https://scribe.test',runScripts:'dangerously'}),w=dom.window;
  if(factory)w.indexedDB=factory;
  prepare?.(w);
  w.eval(vault);
  return {dom,w,done:w.__scribeBoot};
}
const nativeKeys=w=>Array.from({length:w.localStorage.length},(_,index)=>w.localStorage.key(index));

test('existing localStorage data moves into IndexedDB before page scripts run, then frees localStorage',async()=>{
  const factory=new IDBFactory(),state=JSON.stringify({docs:[{id:'real',title:'My long-used book'}],cards:[{id:'k1',term:'agency'}]});
  const {w,done}=boot(factory,w=>{w.localStorage.setItem('scribe-local-v1',state);w.localStorage.setItem('scribe-library-key','a'.repeat(64));});
  await done;
  assert.equal(w.seen,state,'page scripts see the migrated data synchronously');
  assert.deepEqual([...w.order],['a','b'],'boot scripts keep document order');
  assert.equal(w.__scribeVault.info.mode,'indexeddb');
  assert.ok(!nativeKeys(w).includes('scribe-local-v1'),'old copy removed from localStorage after a confirmed IndexedDB write');
  assert.equal(w.localStorage.getItem('scribe-library-key'),'a'.repeat(64),'small credentials stay where they were');
  const again=boot(factory);await again.done;
  assert.equal(again.w.seen,state,'data survives a reload from IndexedDB alone');
});

test('writes far larger than the localStorage quota succeed and persist across reloads',async()=>{
  const factory=new IDBFactory(),{w,done}=boot(factory);await done;
  const big=JSON.stringify({docs:[{id:'pdf',sourcePages:[{text:'x'.repeat(12*1024*1024)}]}]});
  assert.doesNotThrow(()=>w.localStorage.setItem('scribe-local-v1',big));
  assert.doesNotThrow(()=>w.localStorage.setItem('scribe-sync-pending',JSON.stringify({pdf:{print:'p'}})));
  assert.equal(w.localStorage.getItem('scribe-local-v1').length,big.length);
  w.__scribeVault.flush();await wait(80);
  const again=boot(factory);await again.done;
  assert.equal(again.w.seen.length,big.length);
  again.w.localStorage.removeItem('scribe-local-v1');again.w.__scribeVault.flush();await wait(80);
  const third=boot(factory);await third.done;
  assert.equal(third.w.seen,null,'removeItem is persisted too');
});

test('without IndexedDB the page still boots on plain localStorage and prefers that data next time',async()=>{
  const state=JSON.stringify({docs:[{id:'fallback'}]});
  const {w,done}=boot(null,w=>{w.indexedDB=undefined;w.localStorage.setItem('scribe-local-v1',state);});
  await done;
  assert.equal(w.seen,state);
  assert.equal(w.__scribeVault.info.mode,'localstorage');
  assert.equal(w.localStorage.getItem('scribe-vault-fallback'),'1');
});

test('unfinished review sessions are persisted in IndexedDB and restored with their library boundary',async()=>{
  const factory=new IDBFactory(),first=boot(factory);await first.done;
  const session=JSON.stringify({version:1,library:'test-library',day:'2026-10-22',queue:['card-b'],results:[{cardId:'card-a',rating:'good'}],waiting:[]});
  first.w.localStorage.setItem('scribe-review-session-v1',session);first.w.__scribeVault.flush();await wait(80);
  assert.ok(!nativeKeys(first.w).includes('scribe-review-session-v1'));
  const again=boot(factory);await again.done;
  assert.equal(again.w.localStorage.getItem('scribe-review-session-v1'),session);
  first.dom.window.close();again.dom.window.close();
});
