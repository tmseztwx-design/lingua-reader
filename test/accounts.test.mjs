import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {transform} from 'esbuild';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
const hashKey=async key=>createHash('sha256').update(key).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('all deployable edge functions parse after bundling',async()=>{
  for(const name of ['scribe-accounts','scribe-beta','scribe-library','scribe-mobile-upload','scribe-ocr','scribe-queue','scribe-study']){
    await transform(await readFile(new URL('../supabase/functions/'+name+'/index.ts',import.meta.url),'utf8'),{loader:'ts',target:'es2022'});
  }
});
async function inline(name){return (await readFile(new URL('../src/'+name,import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export\s+/gm,'');}

async function fixture(){
  const pg=new PGlite(),auth=new Map();let checks=0,handler;
  await pg.exec('create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create table scribe_libraries(id uuid primary key default gen_random_uuid(),access_hash text unique not null);create table scribe_cloud_sessions(id uuid primary key default gen_random_uuid(),library_id uuid);');
  await pg.exec(await readFile(new URL('../supabase/migrations/20261022180000_managed_accounts.sql',import.meta.url),'utf8'));
  function from(table){
    assert.match(table,/^scribe_[a-z_]+$/);let fields='*',where=[],values=[],order=[],limit='',del=false;
    const q={select(f){assert.match(f,/^[a-z_,*]+$/);fields=f;return this;},eq(k,v){assert.match(k,/^[a-z_]+$/);values.push(v);where.push(k+'=$'+values.length);return this;},order(k,o={}){assert.match(k,/^[a-z_]+$/);order.push(k+(o.ascending===false?' desc':' asc'));return this;},range(a,b){limit=' limit '+(b-a+1)+' offset '+a;return this;},limit(n){limit=' limit '+n;return this;},delete(){del=true;return this;},
      async run(one=false){try{const result=await pg.query((del?'delete from '+table:'select '+fields+' from '+table)+(where.length?' where '+where.join(' and '):'')+(order.length?' order by '+order.join(','):'')+limit,values);return {data:one?(result.rows[0]||null):result.rows};}catch(error){return {error};}},maybeSingle(){return this.run(true);},single(){return this.run(true);},then(a,b){return this.run().then(a,b);}};return q;
  }
  const service={from,async rpc(name,args){try{assert.match(name,/^scribe_[a-z_]+$/);const values=Object.values(args),result=await pg.query('select '+name+'('+values.map((_,i)=>'$'+(i+1)).join(',')+') as data',values);return {data:result.rows[0].data};}catch(error){return {error};}},auth:{admin:{
    async createUser({email,password}){const id=randomUUID();await pg.query('insert into auth.users values($1)',[id]);auth.set(email,{id,password});return {data:{user:{id}}};},
    async deleteUser(id){await pg.query('delete from auth.users where id=$1',[id]);for(const [k,v] of auth)if(v.id===id)auth.delete(k);return {};},
    async updateUserById(id,{password}){for(const value of auth.values())if(value.id===id)value.password=password;return {};},async signOut(){return {};}
  },async signInWithPassword({email,password}){checks++;const user=auth.get(email);return user?.password===password?{data:{user:{id:user.id},session:{access_token:'mock-auth-session'}}}:{data:{user:null,session:null},error:new Error('invalid')};}}};
  const libraryFor=async(db,key)=>typeof key==='string'&&/^[a-f0-9]{64}$/.test(key)?(await service.rpc('scribe_account_library',{p_token_hash:await hashKey(key)})).data:null;
  const source=(await readFile(new URL('../supabase/functions/src/scribe-accounts.ts',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'');
  const {code}=await transform(source,{loader:'ts',target:'es2022'});
  new Function('Deno','database','json','randomKey','hashKey','libraryFor','readJsonLimited','allRows',code)(
    {env:{get:name=>name==='SCRIBE_ADMIN_PASSWORD'?'Owner-test-password-2026!':undefined},serve:fn=>{handler=fn;}},()=>service,(body,status=200)=>Response.json(body,{status}),()=>randomBytes(32).toString('hex'),hashKey,libraryFor,req=>req.json(),async make=>(await make(0,499)).data);
  const call=async body=>{const response=await handler(new Request('https://test.invalid',{method:'POST',body:JSON.stringify(body)}));return {status:response.status,...await response.json()};};
  return {pg,call,libraryFor,checks:()=>checks};
}

test('accounts enforce owner-only provisioning, private libraries, revocation, migration and audit',async()=>{
  const f=await fixture();try{
    const {call,pg}=f;assert.equal((await call({action:'create',username:'anyone'})).status,401);assert.equal((await call({action:'signup'})).status,401);
    assert.equal((await call({action:'login',username:'admin',password:'incorrect-password'})).status,401);
    const owner=await call({action:'login',username:'admin',password:'Owner-test-password-2026!'});assert.equal(owner.status,200);assert.equal(owner.user.role,'owner');
    assert.match(owner.token,/^[a-f0-9]{64}$/);assert.notEqual((await pg.query('select token_hash from scribe_account_sessions')).rows[0].token_hash,owner.token);
    const one=await call({action:'create',token:owner.token,username:'reader01',displayName:'Reader <One>'}),two=await call({action:'create',token:owner.token,username:'reader02',password:'second-test-password!'});
    assert.equal(one.status,201);assert.equal(two.status,201);assert.notEqual(one.user.libraryId,two.user.libraryId);assert.ok(one.credentials.password.length>=12);
    assert.equal((await call({action:'create',token:owner.token,username:'reader01'})).status,409);assert.equal((await call({action:'create',token:owner.token,username:'evil',role:'owner'})).status,403);
    assert.equal((await call({action:'create',token:owner.token,username:'too-long',password:'字'.repeat(25)})).status,400,'never silently truncate passwords beyond Auth bcrypt byte limit');
    const login=await call({action:'login',username:'READER01',password:one.credentials.password});assert.equal(login.status,200);assert.equal((await f.libraryFor(null,login.token)).id,one.user.libraryId);
    assert.equal((await call({action:'list',token:login.token})).status,403);assert.equal((await call({action:'disable',token:owner.token,id:owner.user.id})).status,403);
    const list=await call({action:'list',token:owner.token});assert.equal(list.accounts.length,3);assert.doesNotMatch(JSON.stringify(list),/password|auth_email|token_hash/);
    assert.equal((await call({action:'disable',token:owner.token,id:one.user.id})).status,200);assert.equal((await call({action:'me',token:login.token})).status,401);
    assert.equal((await call({action:'login',username:'reader01',password:one.credentials.password})).status,401);
    assert.equal((await call({action:'enable',token:owner.token,id:one.user.id})).status,200);assert.equal((await call({action:'me',token:login.token})).status,401);
    const fresh=await call({action:'login',username:'reader01',password:one.credentials.password}),reset=await call({action:'resetPassword',token:owner.token,id:one.user.id});assert.equal(reset.status,200);
    assert.equal((await call({action:'me',token:fresh.token})).status,401);assert.equal((await call({action:'login',username:'reader01',password:one.credentials.password})).status,401);
    const current=await call({action:'login',username:'reader01',password:reset.credentials.password});assert.equal(current.status,200);assert.equal((await call({action:'logout',token:current.token})).status,200);assert.equal((await call({action:'me',token:current.token})).status,401);
    const key=randomBytes(32).toString('hex'),old=(await pg.query('insert into scribe_libraries(access_hash) values($1) returning id',[await hashKey(key)])).rows[0].id;
    assert.equal(await f.libraryFor(null,key),null,'legacy capability must not bypass login');
    const migrated=await call({action:'create',token:owner.token,username:'migrated',legacyLibraryKey:key});assert.equal(migrated.status,201);assert.equal(migrated.user.libraryId,old);
    assert.equal((await call({action:'create',token:owner.token,username:'duplicate-migration',legacyLibraryKey:key})).status,409);
    assert.ok((await call({action:'audit',token:owner.token})).events.some(e=>e.action==='reset_password'));
    await pg.exec("update scribe_account_sessions set expires_at=now()-interval '1 minute'");assert.equal((await call({action:'me',token:owner.token})).status,401);
    for(const table of ['scribe_accounts','scribe_account_sessions','scribe_account_audit','scribe_login_limits']){assert.equal((await pg.query("select has_table_privilege('anon',$1,'select') as yes",[table])).rows[0].yes,false);assert.equal((await pg.query('select relrowsecurity from pg_class where relname=$1',[table])).rows[0].relrowsecurity,true);}
    assert.equal((await pg.query("select has_function_privilege('anon','scribe_account_library(text)','execute') as yes")).rows[0].yes,false);
  }finally{await f.pg.close();}
});

test('durable login throttling stops managed password checks after the limit',async()=>{
  const f=await fixture();try{for(let i=0;i<30;i++)assert.equal((await f.call({action:'login',username:'unknown',password:'wrong-password!'})).status,401);
    assert.equal((await f.call({action:'login',username:'unknown',password:'wrong-password!'})).status,429);assert.equal(f.checks(),30);
  }finally{await f.pg.close();}
});

test('member login cannot open the console; login form has no registration or beta input',async()=>{
  const w=new JSDOM('<body><div class="shell">private content</div></body>',{url:'https://test.invalid',runScripts:'outside-only'}).window;
  try{w.eval(await inline('account-access.js')+';window.requireAccount=requireAccount;');
    const cloud={account:{me:async()=>null,login:async()=>({id:randomUUID(),role:'member'}),logout:async()=>{},clear(){}}};
    void w.requireAccount(cloud,{ownerOnly:true});await tick();assert.ok(w.document.documentElement.classList.contains('scribe-auth-locked'));
    assert.equal(w.document.querySelector('[href*="signup"]'),null);assert.equal(w.document.querySelector('[name="code"]'),null);
    w.document.querySelector('#accountUsername').value='reader01';w.document.querySelector('#accountPassword').value='test-password!';w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
    assert.match(w.document.querySelector('#accountLoginMessage').textContent,/没有控制台权限/);assert.equal(w.document.querySelector('#accountPassword').value,'');assert.equal(w.document.querySelector('#accountConsole'),null);
  }finally{w.close();}
});

test('cloud client ignores legacy keys, overrides supplied library identity and clears logout sessions',async()=>{
  const w=new JSDOM('<body></body>',{url:'https://test.invalid',runScripts:'outside-only'}).window;
  try{
    const token=randomBytes(32).toString('hex'),user={id:randomUUID(),role:'member'},calls=[];
    w.localStorage.setItem('scribe-library-key','a'.repeat(64));
    w.supabase={functions:{invoke:async(name,args)=>{calls.push({name,...args});return {data:args.body.action==='login'?{token,user}:{ok:true}};}}};
    w.eval(await inline('cloud-client.js')+';window.createCloud=createCloud;');
    const cloud=w.createCloud();await assert.rejects(cloud.callFunction('scribe-library',{action:'sync'}),error=>error.status===401);assert.equal(calls.length,0);
    await cloud.account.login('reader01','a synthetic test password');
    await cloud.callFunction('scribe-library',{action:'sync',libraryKey:'b'.repeat(64)});assert.equal(calls.at(-1).body.libraryKey,token);
    await cloud.account.me();assert.equal(calls.at(-1).body.token,token);
    assert.equal(w.sessionStorage.length,1);assert.equal(w.sessionStorage.getItem('scribe-account-token'),token);
    await cloud.account.logout();assert.equal(w.sessionStorage.getItem('scribe-account-token'),null);
  }finally{w.close();}
});

test('console creates one-time credentials, escapes names and controls reset/disable without saving passwords',async()=>{
  const w=new JSDOM('<body></body>',{url:'https://test.invalid/?admin=1',runScripts:'outside-only'}).window;
  try{w.confirm=()=>true;w.eval(await inline('account-access.js')+';const esc=escapeAccount;'+await inline('account-console.js')+';window.installAccountConsole=installAccountConsole;');
    const owner={id:randomUUID(),username:'admin',role:'owner'},member={id:randomUUID(),username:'reader01',displayName:'<script>unsafe</script>',role:'member'},calls=[];
    const cloud={account:{me:async()=>owner},callFunction:async(name,body)=>{assert.equal(name,'scribe-accounts');calls.push(body);return body.action==='list'?{accounts:[owner,member]}:body.action==='audit'?{events:[]}:['create','resetPassword'].includes(body.action)?{credentials:{username:'reader01',password:'test-secret-password!'}}:{ok:true};}};
    await w.installAccountConsole(cloud);assert.equal(w.document.querySelectorAll('#accountRows script').length,0);
    w.document.querySelector('#newUsername').value='reader01';w.document.querySelector('form').dispatchEvent(new w.Event('submit',{cancelable:true}));await tick();await tick();
    assert.match(w.document.querySelector('#accountCredentials').textContent,/test-secret-password/);assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);
    w.document.querySelector('#dismissCredentials').click();assert.equal(w.document.querySelector('#accountCredentials').textContent,'');
    w.document.querySelector('[data-account-action="disable"]').click();await tick();await tick();assert.ok(calls.some(c=>c.action==='disable'&&c.id===member.id));
    w.document.querySelector('[data-account-action="resetPassword"]').click();await tick();await tick();assert.ok(calls.some(c=>c.action==='resetPassword'));
  }finally{w.close();}
});

test('vault waits for login, isolates account caches and keeps unassigned legacy data',async()=>{
  const w=new JSDOM('<script type="scribe/boot">window.privateBoot=true;</script>',{url:'https://test.invalid',runScripts:'dangerously'}).window;
  try{w.indexedDB=new IDBFactory();let unlock;w.__scribeAccessReady=new Promise(resolve=>{unlock=resolve;});
    w.localStorage.setItem('scribe-local-v1',JSON.stringify({docs:[{id:'legacy'}],cards:[]}));w.eval(await readFile(new URL('../public/storage-vault.js',import.meta.url),'utf8'));await w.__scribeVault.ready;assert.equal(w.privateBoot,undefined);
    const first=randomUUID(),second=randomUUID();await w.__scribeVault.activateAccount(first);assert.equal(JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs.length,0);
    w.localStorage.setItem('scribe-local-v1',JSON.stringify({docs:[{id:'only-first'}],cards:[]}));const pending=w.__scribeVault.flush();await w.__scribeVault.activateAccount(second);await pending;assert.equal(JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs.length,0);
    await w.__scribeVault.activateAccount(first);assert.equal(JSON.parse(w.localStorage.getItem('scribe-local-v1')).docs[0].id,'only-first');assert.equal((await w.__scribeVault.legacyData()).docs[0].id,'legacy');unlock();await w.__scribeBoot;assert.equal(w.privateBoot,true);
  }finally{w.close();}
});
