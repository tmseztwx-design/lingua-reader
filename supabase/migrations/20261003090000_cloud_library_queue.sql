-- Durable background work and private cross-device libraries.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table public.scribe_libraries (
  id uuid primary key default gen_random_uuid(),
  access_hash text not null unique,
  created_at timestamptz not null default now()
);
create table public.scribe_library_entries (
  library_id uuid not null references public.scribe_libraries(id) on delete cascade,
  kind text not null check (kind in ('doc','card','preferences')),
  entry_id text not null,
  value jsonb,
  deleted boolean not null default false,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (library_id, kind, entry_id)
);
create table public.scribe_runtime_settings (
  id boolean primary key default true check (id),
  worker_secret text not null default replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')
);
insert into public.scribe_runtime_settings(id) values(true) on conflict do nothing;
alter table public.scribe_libraries enable row level security;
alter table public.scribe_library_entries enable row level security;
alter table public.scribe_runtime_settings enable row level security;
revoke all on public.scribe_libraries,public.scribe_library_entries,public.scribe_runtime_settings from anon,authenticated;
grant all on public.scribe_libraries,public.scribe_library_entries,public.scribe_runtime_settings to service_role;
alter table public.scribe_cloud_sessions add column library_id uuid references public.scribe_libraries(id);
alter table public.scribe_cloud_sessions add column deleted_at timestamptz;
alter table public.scribe_cloud_files add column attempts integer not null default 0;
alter table public.scribe_cloud_files add column lease_id uuid;
alter table public.scribe_cloud_files add column lease_until timestamptz;
alter table public.scribe_cloud_files add column retry_at timestamptz;
create index scribe_library_sessions_idx on public.scribe_cloud_sessions(library_id);

-- Revision checks prevent a stale/offline device from overwriting newer data.
create or replace function public.scribe_write_entry(p_library uuid, p_kind text, p_id text,
  p_value jsonb, p_deleted boolean, p_revision bigint)
returns jsonb language plpgsql security definer set search_path=public as $$
declare row public.scribe_library_entries; changed boolean := false;
begin
  if p_revision = 0 then
    insert into scribe_library_entries(library_id,kind,entry_id,value,deleted)
      values(p_library,p_kind,p_id,p_value,p_deleted) on conflict do nothing returning * into row;
    changed := found;
  else
    update scribe_library_entries set value=p_value,deleted=p_deleted,revision=revision+1,updated_at=now()
      where library_id=p_library and kind=p_kind and entry_id=p_id and revision=p_revision
        and (not deleted or p_deleted) returning * into row;
    changed := found;
  end if;
  if not changed then
    select * into row from scribe_library_entries where library_id=p_library and kind=p_kind and entry_id=p_id;
  end if;
  if changed and p_kind='doc' and p_id like 'cloud-%' then
    update scribe_cloud_sessions set deleted_at=case when p_deleted then now()
      when p_value->>'deletedAt' is not null then (p_value->>'deletedAt')::timestamptz else null end
      where library_id=p_library and 'cloud-'||id::text=p_id;
  end if;
  return jsonb_build_object('accepted',changed,'entry',to_jsonb(row));
end $$;

-- Claims and leases are stored in Postgres, not an Edge Function's memory.
create or replace function public.scribe_claim_page()
returns jsonb language plpgsql security definer set search_path=public as $$
declare row public.scribe_cloud_files;
begin
  -- An interrupted final attempt becomes an explicit, retryable error.
  update scribe_cloud_files set ocr_status='error',ocr_error='识别任务中断，请重试这一页。',lease_id=null,lease_until=null
    where ocr_status='processing' and lease_until<now() and attempts>=3;
  update scribe_cloud_sessions s set ocr_status='partial',ocr_completed_at=now()
    where s.ocr_status='processing' and exists(select 1 from scribe_cloud_files f where f.session_id=s.id and f.ocr_status='error')
      and not exists(select 1 from scribe_cloud_files f where f.session_id=s.id and f.uploaded_at is not null and f.ocr_status in ('pending','retry','processing'));
  select f.* into row from scribe_cloud_files f join scribe_cloud_sessions s on s.id=f.session_id
    where s.completed_at is not null and s.deleted_at is null and f.uploaded_at is not null and f.attempts<3
      and ((f.ocr_status in ('pending','retry') and (f.retry_at is null or f.retry_at<=now()))
        or (f.ocr_status='processing' and f.lease_until<now()))
    order by s.completed_at,f.queue_order,f.created_at limit 1 for update of f skip locked;
  if not found then return null; end if;
  update scribe_cloud_files set ocr_status='processing',attempts=attempts+1,
    lease_id=gen_random_uuid(),lease_until=now()+interval '3 minutes',ocr_error=null
    where id=row.id returning * into row;
  update scribe_cloud_sessions set ocr_status='processing',ocr_completed_at=null where id=row.session_id;
  return to_jsonb(row);
end $$;

create or replace function public.scribe_finish_page(p_id uuid,p_lease uuid,p_text text,p_error text)
returns boolean language plpgsql security definer set search_path=public as $$
declare row public.scribe_cloud_files; pending boolean; failed boolean;
begin
  update scribe_cloud_files set
    ocr_status=case when p_error is null then 'complete' when attempts<3 then 'retry' else 'error' end,
    ocr_text=case when p_error is null then p_text else ocr_text end,ocr_error=p_error,
    page_count=case when p_error is null then 1 else 0 end,
    retry_at=case when p_error is not null then now()+interval '30 seconds'*attempts else null end,
    lease_until=null,lease_id=null,ocr_completed_at=now()
    where id=p_id and lease_id=p_lease returning * into row;
  if not found then return false; end if;
  select bool_or(ocr_status in ('pending','retry','processing')),bool_or(ocr_status='error')
    into pending,failed from scribe_cloud_files where session_id=row.session_id and uploaded_at is not null;
  update scribe_cloud_sessions set ocr_status=case when pending then 'processing' when failed then 'partial' else 'complete' end,
    ocr_completed_at=case when pending then null else now() end where id=row.session_id;
  return true;
end $$;

revoke all on function public.scribe_write_entry(uuid,text,text,jsonb,boolean,bigint) from public,anon,authenticated;
revoke all on function public.scribe_claim_page() from public,anon,authenticated;
revoke all on function public.scribe_finish_page(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.scribe_write_entry(uuid,text,text,jsonb,boolean,bigint) to service_role;
grant execute on function public.scribe_claim_page() to service_role;
grant execute on function public.scribe_finish_page(uuid,uuid,text,text) to service_role;

create or replace function public.scribe_cleanup_candidates()
returns setof public.scribe_cloud_sessions language plpgsql security definer set search_path=public as $$
declare candidate public.scribe_cloud_sessions;
begin
  for candidate in select s.* from scribe_cloud_sessions s
    left join scribe_library_entries e on e.library_id=s.library_id and e.kind='doc' and e.entry_id='cloud-'||s.id::text
    where s.deleted_at<now()-interval '30 days' or e.deleted=true
    order by s.deleted_at nulls last limit 20 for update of s skip locked
  loop
    -- Claim deletion before touching Storage. Restore racing with cleanup either
    -- wins first (and fails this predicate), or sees a newer permanent tombstone.
    perform 1 from scribe_library_entries where library_id=candidate.library_id and kind='doc'
      and entry_id='cloud-'||candidate.id::text for update;
    if exists(select 1 from scribe_cloud_sessions s left join scribe_library_entries e
      on e.library_id=s.library_id and e.kind='doc' and e.entry_id='cloud-'||s.id::text
      where s.id=candidate.id and (s.deleted_at<now()-interval '30 days' or e.deleted=true)) then
      insert into scribe_library_entries(library_id,kind,entry_id,value,deleted)
        values(candidate.library_id,'doc','cloud-'||candidate.id::text,null,true)
        on conflict(library_id,kind,entry_id) do update set value=null,deleted=true,
          revision=scribe_library_entries.revision+1,updated_at=now()
          where not scribe_library_entries.deleted;
      return next candidate;
    end if;
  end loop;
end;
$$;
revoke all on function public.scribe_cleanup_candidates() from public,anon,authenticated;
grant execute on function public.scribe_cleanup_candidates() to service_role;

-- The scheduled worker survives closed tabs, expired QR links and Edge restarts.
select cron.schedule('scribe-background-ocr','* * * * *', $$
  select net.http_post(
    url := 'https://spb-t4nu9v7279pycm5l.supabase.opentrust.net/functions/v1/scribe-queue',
    headers := jsonb_build_object('Content-Type','application/json','x-scribe-worker-key',
      (select worker_secret from public.scribe_runtime_settings where id=true)),
    body := '{}'::jsonb, timeout_milliseconds := 1000
  );
$$);
