import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {transform} from 'esbuild';

test('anonymous creation stays closed even with the old temporary override',async()=>{
  const source=(await readFile(new URL('../supabase/functions/src/scribe-library.ts',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');
  const {code}=await transform(source,{loader:'ts',target:'es2022'});let handler;
  new Function('Deno','database','json','readJsonLimited',code)({env:{get:()=> 'false'},serve:fn=>{handler=fn;}},()=>({}),(body,status=200)=>Response.json(body,{status}),req=>req.json());
  const response=await handler(new Request('https://test.invalid',{method:'POST',body:JSON.stringify({action:'create',betaRequired:false})}));
  assert.equal(response.status,403);assert.match((await response.json()).error,/不开放注册/);
});

test('mandatory account bootstrap replaces beta and temporary open-create paths',async()=>{
  const bridge=await readFile(new URL('../src/cloud-bridge.js',import.meta.url),'utf8');
  const vault=await readFile(new URL('../public/storage-vault.js',import.meta.url),'utf8');
  const beta=await readFile(new URL('../supabase/functions/scribe-beta/index.ts',import.meta.url),'utf8');
  const backend=await readFile(new URL('../supabase/functions/scribe-library/index.ts',import.meta.url),'utf8');
  assert.match(bridge,/requireAccount\(cloud\)/);assert.match(bridge,/activateAccount\(user.id\)/);assert.match(vault,/window.__scribeAccessReady/);
  assert.doesNotMatch(bridge,/installBeta|BETA_REQUIRED/);assert.doesNotMatch(backend,/SCRIBE_BETA_REQUIRED/);assert.match(beta,/机制已停用/);
});
