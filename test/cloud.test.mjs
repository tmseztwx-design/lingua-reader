import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {localEntries,fingerprint,applyEntries} from '../src/sync-state.js';

test('remote book refresh preserves reading progress and independent cards; trash and tombstones do not resurrect',()=>{
  const state={docs:[{id:'cloud-a',progress:37,lastPage:2}],deletedDocs:[],cards:[{id:'c1',note:'my note'}],settings:{auto:true}};
  const generated=[{id:'cloud-a',pages:4,progress:0,sourcePages:[{text:'actual page',url:'new URL'}],processingState:'ready'}];
  const next=applyEntries(state,[],generated);
  assert.equal(next.docs[0].progress,37);assert.equal(next.docs[0].lastPage,2);
  assert.equal(next.docs[0].sourcePages[0].text,'actual page');assert.equal(next.cards[0].note,'my note');
  const deleted=applyEntries(next,[{kind:'doc',entry_id:'cloud-a',deleted:false,value:{id:'cloud-a',deletedAt:'2026-10-03'}}],generated);
  assert.equal(deleted.docs.length,0);assert.equal(deleted.deletedDocs.length,1);
  const purged=applyEntries(deleted,[{kind:'doc',entry_id:'cloud-a',deleted:true,value:null}],generated);
  assert.equal(purged.docs.length,0);assert.equal(purged.deletedDocs.length,0);
  assert.equal(purged.cards.length,1);
});

test('rotating private image URLs are not counted as user edits; notes are',()=>{
  const a={value:{id:'d1',sourcePages:[{url:'old',text:'page'}]}};
  const b={value:{id:'d1',sourcePages:[{url:'new',text:'page'}]}};
  assert.equal(fingerprint(a),fingerprint(b));
  b.value.note='new note';assert.notEqual(fingerprint(a),fingerprint(b));
  assert.equal(localEntries({docs:[{id:'1'}],cards:[{id:'1'}]}).size,3);
});

test('PostgreSQL queue survives lost workers, preserves selected order, bounds retries and protects revisions',async()=>{
  const db=new PGlite();
  await db.exec('create role anon;create role authenticated;create role service_role;create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');
  await db.exec(await readFile(new URL('../supabase/migrations/migration_20261003_055025000',import.meta.url),'utf8'));
  const migration=await readFile(new URL('../supabase/migrations/20261003090000_cloud_library_queue.sql',import.meta.url),'utf8');
  await db.exec(migration.slice(0,migration.indexOf('-- The scheduled worker')).replace(/create extension[^;]+;/g,''));
  const library=(await db.query("insert into scribe_libraries(access_hash) values('private') returning id")).rows[0].id;
  const session=(await db.query("insert into scribe_cloud_sessions(token,expires_at,completed_at,library_id) values('expired-upload-link',now()-interval '1 day',now(),$1) returning id",[library])).rows[0].id;
  // Completion/upload speed is deliberately reversed; the queue claims confirmed order.
  await db.query("insert into scribe_cloud_files(session_id,queue_order,name,uploaded_at) values($1,2,'third',now()),($1,0,'first',now()),($1,1,'second',now())",[session]);
  const claim=async()=> (await db.query('select scribe_claim_page() as file')).rows[0].file;
  const finish=async(file,error=null)=> (await db.query('select scribe_finish_page($1,$2,$3,$4) as accepted',[file.id,file.lease_id,'recognized original',error])).rows[0].accepted;
  const first=await claim(),second=await claim();assert.equal(first.name,'first');assert.equal(second.name,'second');
  assert.notEqual(first.id,second.id);await finish(second);
  await db.query("update scribe_cloud_files set lease_until=now()-interval '1 second' where id=$1",[first.id]);
  const recovered=await claim();assert.equal(recovered.id,first.id);assert.equal(recovered.attempts,2);
  assert.equal(await finish(first),false,'late worker must not replace the recovered worker');
  assert.equal(await finish(recovered),true);
  const third=await claim();assert.equal(third.name,'third');await finish(third,'blurred page');
  assert.equal(await claim(),null,'backoff prevents immediate repeated charges');
  for(let attempt=2;attempt<=3;attempt++){
    await db.query("update scribe_cloud_files set retry_at=now()-interval '1 second' where id=$1",[third.id]);
    const retried=await claim();assert.equal(retried.attempts,attempt);await finish(retried,'blurred page');
  }
  assert.equal(await claim(),null);
  assert.equal((await db.query('select ocr_status from scribe_cloud_sessions where id=$1',[session])).rows[0].ocr_status,'partial');
  const write=async(revision,value,deleted=false)=> (await db.query("select scribe_write_entry($1,'doc',$2,$3,$4,$5) as result",[library,'cloud-'+session,value,deleted,revision])).rows[0].result;
  assert.equal((await write(0,{id:'cloud-'+session,progress:20})).accepted,true);
  const newer=await write(1,{id:'cloud-'+session,progress:40});assert.equal(newer.entry.revision,2);
  const stale=await write(1,{id:'cloud-'+session,progress:5});assert.equal(stale.accepted,false);assert.equal(stale.entry.value.progress,40);
  await write(2,{id:'cloud-'+session,deletedAt:new Date().toISOString()});
  assert.equal((await db.query('select * from scribe_cleanup_candidates()')).rows.length,0,'30-day retention');
  await write(3,null,true);
  assert.equal((await db.query('select * from scribe_cleanup_candidates()')).rows.length,1,'explicit purge selects originals');
  assert.equal((await write(4,{id:'cloud-'+session})).accepted,false,'permanently purged originals cannot be restored');
  const activeSession=(await db.query("insert into scribe_cloud_sessions(token,expires_at,library_id) values('active',now()+interval '1 day',$1) returning id",[library])).rows[0].id;
  const other=(await db.query("insert into scribe_libraries(access_hash) values('different') returning id")).rows[0].id;
  await db.query("insert into scribe_library_entries(library_id,kind,entry_id,deleted) values($1,'doc',$2,true)",[other,'cloud-'+activeSession]);
  assert.equal((await db.query('select * from scribe_cleanup_candidates()')).rows.some(row=>row.id===activeSession),false,'another library cannot delete originals by guessing a book id');
  await db.close();
});
