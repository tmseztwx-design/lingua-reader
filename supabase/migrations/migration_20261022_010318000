-- Additive production upgrade. Back up DB + storage first; do not replay historical bootstraps.
begin;
alter table public.scribe_cloud_sessions add column if not exists upload_manifest jsonb;
alter table public.scribe_cloud_sessions add column if not exists expected_file_count integer;
alter table public.scribe_cloud_sessions add column if not exists updated_at timestamptz not null default now();
alter table public.scribe_cloud_files add column if not exists client_file_id uuid;

-- Keep every legacy page. Repair ambiguous duplicate order positions without dropping data.
with ranked as (
  select id, row_number() over(partition by session_id order by queue_order,created_at,id)-1 as position
  from public.scribe_cloud_files
) update public.scribe_cloud_files f set queue_order=r.position from ranked r where f.id=r.id and f.queue_order<>r.position;
alter table public.scribe_cloud_files add constraint scribe_file_order_unique
  unique(session_id,queue_order) deferrable initially immediate;

-- Exact PDF originals are separate from OCR pages. Parts <=32 MiB also fit Enter's 50 MiB TUS limit.
create table public.scribe_source_assets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.scribe_cloud_sessions(id) on delete cascade,
  queue_order integer not null check(queue_order>=0),
  source_id uuid not null,
  original_name text not null,
  original_size bigint not null check(original_size>0),
  part_index integer not null check(part_index>=0),
  part_count integer not null check(part_count>0 and part_index<part_count),
  name text not null,
  size bigint not null check(size>0 and size<=52428800),
  mime text not null default 'application/pdf',
  storage_path text not null unique,
  uploaded_at timestamptz,
  created_at timestamptz not null default now(),
  unique(session_id,queue_order), unique(session_id,source_id,part_index)
);
alter table public.scribe_source_assets enable row level security;
revoke all on public.scribe_source_assets from public,anon,authenticated;
grant all on public.scribe_source_assets to service_role;
create index scribe_sessions_active_idx on public.scribe_cloud_sessions(library_id,created_at desc) where deleted_at is null;
create index scribe_sessions_changed_idx on public.scribe_cloud_sessions(library_id,updated_at,id);
create index scribe_entries_changed_idx on public.scribe_library_entries(library_id,updated_at,kind,entry_id);
create index scribe_files_claim_idx on public.scribe_cloud_files(ocr_status,retry_at,lease_until,session_id,queue_order) where uploaded_at is not null;
alter table public.scribe_word_cache add column if not exists library_id uuid references public.scribe_libraries(id) on delete cascade;
create index scribe_word_cache_library_idx on public.scribe_word_cache(library_id,updated_at);

create or replace function public.scribe_touch_session() returns trigger
language plpgsql set search_path=public as $$
begin
  if tg_table_name='scribe_cloud_sessions' then new.updated_at=clock_timestamp(); return new; end if;
  update scribe_cloud_sessions set updated_at=clock_timestamp() where id=coalesce(new.session_id,old.session_id);
  if tg_op='UPDATE' and old.session_id<>new.session_id then
    update scribe_cloud_sessions set updated_at=clock_timestamp() where id=old.session_id;
  end if;
  return coalesce(new,old);
end $$;
create trigger scribe_session_touch before update on public.scribe_cloud_sessions for each row execute function public.scribe_touch_session();
create trigger scribe_page_touch after insert or update or delete on public.scribe_cloud_files for each row execute function public.scribe_touch_session();
create trigger scribe_source_touch after insert or update or delete on public.scribe_source_assets for each row execute function public.scribe_touch_session();

-- Reserve the entire confirmed list in one transaction, before any bytes are transferred.
-- Repeated requests are idempotent; no late/fast photo can change its page position.
create or replace function public.scribe_prepare_upload(p_session uuid,p_manifest jsonb)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s scribe_cloud_sessions; item jsonb; position integer; file_id uuid; ext text; bytes bigint:=0;
begin
  select * into s from scribe_cloud_sessions where id=p_session for update;
  if not found or s.deleted_at is not null or s.completed_at is not null or s.expires_at<=now() then raise exception '上传窗口已结束'; end if;
  if s.upload_manifest is not null then
    if s.upload_manifest<>p_manifest then raise exception '本批顺序已锁定，不能替换清单'; end if;
    return jsonb_build_object('ok',true,'count',s.expected_file_count);
  end if;
  if jsonb_typeof(p_manifest->'files') is distinct from 'array' or jsonb_typeof(p_manifest->'originals') is distinct from 'array' then raise exception '上传清单格式错误'; end if;
  if jsonb_array_length(p_manifest->'files') not between 1 and 2000 or jsonb_array_length(p_manifest->'originals')>2000 then raise exception '单批支持 1–2000 页'; end if;
  for item,position in select value,(ordinality-1)::integer from jsonb_array_elements(p_manifest->'files') with ordinality loop
    if (item->>'size')::bigint not between 1 and 52428800 or length(item->>'name') not between 1 and 160 then raise exception '文件大小或名称不正确'; end if;
    bytes:=bytes+(item->>'size')::bigint;
    ext:=lower(substring(item->>'name' from '\.[a-zA-Z0-9]+$'));
    if ext is null or ext not in ('.pdf','.doc','.docx','.jpg','.jpeg','.png','.heic','.heif','.txt') then raise exception '不支持的文件类型'; end if;
    if exists(select 1 from scribe_cloud_files where session_id=p_session and queue_order=position and (name<>item->>'name' or size<>(item->>'size')::bigint)) then raise exception '队列位置已有其他文件'; end if;
    file_id:=gen_random_uuid();
    if not exists(select 1 from scribe_cloud_files where session_id=p_session and queue_order=position) then
      insert into scribe_cloud_files(id,session_id,queue_order,name,size,mime,storage_path,client_file_id)
        values(file_id,p_session,position,item->>'name',(item->>'size')::bigint,item->>'mime',p_session::text||'/'||file_id::text||ext,(item->>'clientId')::uuid);
    end if;
    update scribe_cloud_files set client_file_id=(item->>'clientId')::uuid where session_id=p_session and queue_order=position and client_file_id is null;
  end loop;
  if (select count(*) from scribe_cloud_files where session_id=p_session)<>jsonb_array_length(p_manifest->'files') then raise exception '清单与已有文件数量不一致'; end if;
  for item,position in select value,(ordinality-1)::integer from jsonb_array_elements(p_manifest->'originals') with ordinality loop
    if (item->>'size')::bigint not between 1 and 52428800 or (item->>'parts')::integer not between 1 and 2000 or (item->>'originalSize')::bigint<=0 then raise exception '原始文件分片无效'; end if;
    bytes:=bytes+(item->>'size')::bigint; file_id:=gen_random_uuid();
    insert into scribe_source_assets(id,session_id,queue_order,source_id,original_name,original_size,part_index,part_count,name,size,mime,storage_path)
      values(file_id,p_session,position,(item->>'sourceId')::uuid,item->>'originalName',(item->>'originalSize')::bigint,(item->>'part')::integer,(item->>'parts')::integer,item->>'name',(item->>'size')::bigint,'application/pdf',p_session::text||'/original-'||file_id::text||'.pdf');
  end loop;
  if bytes>5368709120 then raise exception '单批总量不能超过 5 GiB，请分批导入'; end if;
  if exists(select 1 from scribe_source_assets where session_id=p_session group by source_id
    having count(*)<>max(part_count) or min(part_index)<>0 or max(part_index)<>max(part_count)-1
      or sum(size)<>max(original_size) or min(original_size)<>max(original_size) or min(part_count)<>max(part_count)) then raise exception '原始文件分片不完整'; end if;
  update scribe_cloud_sessions set upload_manifest=p_manifest,expected_file_count=jsonb_array_length(p_manifest->'files') where id=p_session;
  return jsonb_build_object('ok',true,'count',jsonb_array_length(p_manifest->'files'));
end $$;

-- Older clients without manifests still use serialized reservations.
create or replace function public.scribe_reserve_page(p_session uuid,p_order integer,p_name text,p_size bigint,p_mime text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s scribe_cloud_sessions; f scribe_cloud_files; file_id uuid:=gen_random_uuid(); ext text;
begin
  select * into s from scribe_cloud_sessions where id=p_session for update;
  if not found or s.deleted_at is not null or s.completed_at is not null or s.expires_at<=now() then raise exception '上传窗口已结束'; end if;
  if p_order not between 0 and 1999 or p_size not between 1 and 52428800 then raise exception '文件大小或顺序错误'; end if;
  select * into f from scribe_cloud_files where session_id=p_session and queue_order=p_order;
  if found then
    if f.name<>p_name or f.size<>p_size then raise exception '这个队列位置已有其他文件'; end if;
    return to_jsonb(f);
  end if;
  if s.upload_manifest is not null then raise exception '文件不在已确认的清单中'; end if;
  ext:=lower(substring(p_name from '\.[a-zA-Z0-9]+$'));
  insert into scribe_cloud_files(id,session_id,queue_order,name,size,mime,storage_path)
    values(file_id,p_session,p_order,p_name,p_size,p_mime,p_session::text||'/'||file_id::text||ext) returning * into f;
  return to_jsonb(f);
end $$;

-- Finalization locks the same session row as reservations. It cannot race a new page.
create or replace function public.scribe_finalize_upload(p_session uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare s scribe_cloud_sessions; total integer; delivered integer;
begin
  select * into s from scribe_cloud_sessions where id=p_session for update;
  if not found or s.deleted_at is not null then raise exception '上传通道不可用'; end if;
  if s.completed_at is not null then return jsonb_build_object('ok',true,'fileCount',s.file_count); end if;
  if s.expires_at<=now() then raise exception '上传通道已过期'; end if;
  select count(*),count(uploaded_at) into total,delivered from scribe_cloud_files where session_id=p_session;
  if total=0 or total<>delivered or (s.expected_file_count is not null and total<>s.expected_file_count)
    or exists(select 1 from scribe_source_assets where session_id=p_session and uploaded_at is null) then raise exception '还有文件或原始 PDF 分片未完整送达，不能开始处理'; end if;
  update scribe_cloud_sessions set file_count=total,completed_at=now(),ocr_status='processing' where id=p_session;
  return jsonb_build_object('ok',true,'fileCount',total);
end $$;

create or replace function public.scribe_reorder_pages(p_session uuid,p_ids uuid[])
returns void language plpgsql security definer set search_path=public as $$
begin
  perform 1 from scribe_cloud_sessions where id=p_session for update;
  if cardinality(p_ids)<>(select count(*) from scribe_cloud_files where session_id=p_session)
    or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x)
    or exists(select 1 from unnest(p_ids) x where not exists(select 1 from scribe_cloud_files where session_id=p_session and id=x)) then raise exception '页面顺序与文献不一致'; end if;
  set constraints scribe_file_order_unique deferred;
  update scribe_cloud_files f set queue_order=position-1 from unnest(p_ids) with ordinality as x(id,position) where f.session_id=p_session and f.id=x.id;
end $$;

-- Cross-device analytics are monotonic per-device counters, not last-write-wins totals.
alter table public.scribe_libraries add column if not exists minutes_baseline numeric not null default 0;
alter table public.scribe_libraries add column if not exists reviewed_baseline bigint not null default 0;
create or replace function public.scribe_absorb_upload(p_library uuid,p_source uuid,p_target uuid)
returns jsonb language plpgsql security definer set search_path=public as $$
declare src scribe_cloud_sessions; dst scribe_cloud_sessions; base integer; added integer; total integer; asset_base integer;
begin
  if p_source=p_target then raise exception '不能合并到同一批'; end if;
  perform 1 from scribe_cloud_sessions where id in(p_source,p_target) order by id for update;
  select * into src from scribe_cloud_sessions where id=p_source and library_id=p_library and deleted_at is null and completed_at is not null;
  if not found then raise exception '新批次不存在或尚未完成上传'; end if;
  select * into dst from scribe_cloud_sessions where id=p_target and library_id=p_library and deleted_at is null and completed_at is not null;
  if not found then raise exception '目标文献不存在或尚未完成上传'; end if;
  select coalesce(max(queue_order)+1,0),count(*) into base,total from scribe_cloud_files where session_id=p_target;
  select count(*) into added from scribe_cloud_files where session_id=p_source;
  if added=0 or total+added>2000 then raise exception '合并后必须在 1–2000 页以内'; end if;
  update scribe_cloud_files set session_id=p_target,queue_order=base+queue_order where session_id=p_source;
  select coalesce(max(queue_order)+1,0) into asset_base from scribe_source_assets where session_id=p_target;
  update scribe_source_assets set session_id=p_target,queue_order=asset_base+queue_order where session_id=p_source;
  total:=total+added;
  update scribe_cloud_sessions set file_count=total,expected_file_count=total,
    title=regexp_replace(title,'（\s*\d+\s*(个文件|页)\s*）\s*$','（'||total::text||' \1）'),
    ocr_status=case when exists(select 1 from scribe_cloud_files where session_id=p_target and ocr_status in('pending','retry','processing')) then 'processing'
      when exists(select 1 from scribe_cloud_files where session_id=p_target and ocr_status='error') then 'partial' else 'complete' end
    where id=p_target;
  insert into scribe_library_entries(library_id,kind,entry_id,value,deleted)
    values(p_library,'doc','cloud-'||p_source::text,null,true)
    on conflict(library_id,kind,entry_id) do update set value=null,deleted=true,revision=scribe_library_entries.revision+1,updated_at=now();
  delete from scribe_cloud_sessions where id=p_source;
  return jsonb_build_object('ok',true,'into',p_target,'pages',total,'added',added);
end $$;

create table public.scribe_study_counters (
  library_id uuid not null references public.scribe_libraries(id) on delete cascade,
  device_id uuid not null,
  initial_minutes numeric not null default 0 check(initial_minutes>=0),
  initial_reviewed bigint not null default 0 check(initial_reviewed>=0),
  minutes numeric not null default 0 check(minutes>=0),
  reviewed bigint not null default 0 check(reviewed>=0),
  updated_at timestamptz not null default now(),
  primary key(library_id,device_id)
);
alter table public.scribe_study_counters enable row level security;
revoke all on public.scribe_study_counters from public,anon,authenticated;
grant all on public.scribe_study_counters to service_role;
create or replace function public.scribe_merge_counters(p_library uuid,p_device uuid,p_initial_minutes numeric,p_initial_reviewed bigint,p_minutes numeric,p_reviewed bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare result jsonb; prior_minutes numeric; prior_reviewed bigint;
begin
  perform 1 from scribe_libraries where id=p_library for update;
  if not exists(select 1 from scribe_study_counters where library_id=p_library and device_id=p_device) then
    select coalesce(sum(minutes),0),coalesce(sum(reviewed),0) into prior_minutes,prior_reviewed from scribe_study_counters where library_id=p_library;
    -- A new device may start with already-synced totals. Seed only the missing floor,
    -- otherwise importing a backup/new browser would count the same history twice.
    update scribe_libraries set minutes_baseline=greatest(minutes_baseline,p_initial_minutes-prior_minutes),reviewed_baseline=greatest(reviewed_baseline,p_initial_reviewed-prior_reviewed) where id=p_library;
  end if;
  insert into scribe_study_counters(library_id,device_id,initial_minutes,initial_reviewed,minutes,reviewed)
    values(p_library,p_device,p_initial_minutes,p_initial_reviewed,p_minutes,p_reviewed)
    on conflict(library_id,device_id) do update set minutes=greatest(scribe_study_counters.minutes,excluded.minutes),reviewed=greatest(scribe_study_counters.reviewed,excluded.reviewed),updated_at=now();
  select jsonb_build_object('minutes',l.minutes_baseline+coalesce(sum(c.minutes),0),'reviewed',l.reviewed_baseline+coalesce(sum(c.reviewed),0)) into result from scribe_libraries l left join scribe_study_counters c on c.library_id=l.id where l.id=p_library group by l.id;
  return result;
end $$;

-- A cancelled/expired unfinished upload must not leak storage forever. Never expire
-- completed documents just because their QR token expired. Keep the existing 30-day policy.
create or replace function public.scribe_cleanup_candidates()
returns setof public.scribe_cloud_sessions language plpgsql security definer set search_path=public as $$
declare candidate public.scribe_cloud_sessions;
begin
  for candidate in select s.* from scribe_cloud_sessions s left join scribe_library_entries e
    on e.library_id=s.library_id and e.kind='doc' and e.entry_id='cloud-'||s.id::text
    where s.deleted_at<now()-interval '30 days' or e.deleted=true
      or (s.completed_at is null and s.expires_at<now()-interval '30 days')
    order by s.deleted_at nulls last limit 20 for update of s skip locked
  loop
    if candidate.library_id is not null then
      insert into scribe_library_entries(library_id,kind,entry_id,value,deleted)
        values(candidate.library_id,'doc','cloud-'||candidate.id::text,null,true)
        on conflict(library_id,kind,entry_id) do update set value=null,deleted=true,revision=scribe_library_entries.revision+1,updated_at=now()
          where not scribe_library_entries.deleted;
    end if;
    return next candidate;
  end loop;
end $$;

revoke all on function public.scribe_prepare_upload(uuid,jsonb),public.scribe_reserve_page(uuid,integer,text,bigint,text),public.scribe_finalize_upload(uuid),public.scribe_reorder_pages(uuid,uuid[]),public.scribe_absorb_upload(uuid,uuid,uuid),public.scribe_merge_counters(uuid,uuid,numeric,bigint,numeric,bigint) from public,anon,authenticated;
grant execute on function public.scribe_prepare_upload(uuid,jsonb),public.scribe_reserve_page(uuid,integer,text,bigint,text),public.scribe_finalize_upload(uuid),public.scribe_reorder_pages(uuid,uuid[]),public.scribe_absorb_upload(uuid,uuid,uuid),public.scribe_merge_counters(uuid,uuid,numeric,bigint,numeric,bigint) to service_role;
commit;
