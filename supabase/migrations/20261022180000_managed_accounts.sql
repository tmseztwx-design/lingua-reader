-- Closed enrollment: only service-side administrator actions can provision accounts.
-- Original libraries, documents, cards, uploads and beta records are deliberately retained.
create table if not exists public.scribe_accounts (
  id uuid primary key references auth.users(id) on delete restrict,
  username text not null unique check (username ~ '^[a-z0-9][a-z0-9_.-]{2,31}$'),
  display_name text not null default '',
  auth_email text not null unique,
  role text not null default 'member' check (role in ('owner','member')),
  library_id uuid not null unique references public.scribe_libraries(id),
  disabled boolean not null default false,
  credential_version integer not null default 1,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index if not exists scribe_one_owner on public.scribe_accounts(role) where role='owner';
create table if not exists public.scribe_account_sessions (
  token_hash text primary key check(token_hash ~ '^[0-9a-f]{64}$'),
  account_id uuid not null references public.scribe_accounts(id),
  credential_version integer not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now()+interval '12 hours'
);
create index if not exists scribe_sessions_account on public.scribe_account_sessions(account_id);
create index if not exists scribe_sessions_expiry on public.scribe_account_sessions(expires_at);
alter table public.scribe_cloud_sessions add column if not exists account_version integer;
create table if not exists public.scribe_account_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references public.scribe_accounts(id),
  target_id uuid references public.scribe_accounts(id),
  action text not null,
  created_at timestamptz not null default now()
);
create table if not exists public.scribe_login_limits (
  bucket text primary key,
  window_start timestamptz not null default now(),
  attempts integer not null default 0
);

create or replace function public.scribe_login_allowed(p_bucket text,p_limit integer)
returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  insert into scribe_login_limits(bucket,attempts) values(p_bucket,1)
  on conflict(bucket) do update set
    attempts=case when scribe_login_limits.window_start < now()-interval '15 minutes' then 1 else scribe_login_limits.attempts+1 end,
    window_start=case when scribe_login_limits.window_start < now()-interval '15 minutes' then now() else scribe_login_limits.window_start end
  returning attempts into n;
  return n<=p_limit;
end $$;

create or replace function public.scribe_create_account(p_id uuid,p_username text,p_name text,p_email text,p_actor uuid default null,p_owner boolean default false,p_library uuid default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare lib uuid; result scribe_accounts;
begin
  if p_owner then
    -- Serialize first-owner bootstrap; a public caller never receives EXECUTE rights.
    perform pg_advisory_xact_lock(22180000);
    if exists(select 1 from scribe_accounts where role='owner') then raise exception '管理员已初始化'; end if;
  elsif not exists(select 1 from scribe_accounts where id=p_actor and role='owner' and not disabled) then
    raise exception '需要管理员权限';
  end if;
  lib=p_library;
  if lib is null then
    insert into scribe_libraries(access_hash) values(replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','')) returning id into lib;
  end if;
  insert into scribe_accounts(id,username,display_name,auth_email,role,library_id)
    values(p_id,p_username,left(p_name,80),p_email,case when p_owner then 'owner' else 'member' end,lib) returning * into result;
  insert into scribe_account_audit(actor_id,target_id,action) values(coalesce(p_actor,p_id),p_id,case when p_owner then 'bootstrap_owner' else 'create_account' end);
  return to_jsonb(result);
end $$;

create or replace function public.scribe_account_library(p_token_hash text)
returns jsonb language sql security definer set search_path=public as $$
  select jsonb_build_object('id',a.library_id,'accountId',a.id,'username',a.username,'displayName',a.display_name,'role',a.role,'version',a.credential_version)
  from scribe_account_sessions s join scribe_accounts a on a.id=s.account_id
  where s.token_hash=p_token_hash and s.expires_at>now() and not a.disabled and s.credential_version=a.credential_version;
$$;

create or replace function public.scribe_issue_account_session(p_id uuid,p_hash text,p_version integer)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  -- Lock against disable/reset racing with successful password verification.
  perform 1 from scribe_accounts where id=p_id and not disabled and credential_version=p_version for update;
  if not found then return false; end if;
  delete from scribe_account_sessions where expires_at<now();
  insert into scribe_account_sessions(token_hash,account_id,credential_version) values(p_hash,p_id,p_version);
  update scribe_accounts set last_login_at=now() where id=p_id;
  return true;
end $$;

create or replace function public.scribe_manage_account(p_actor uuid,p_target uuid,p_action text)
returns boolean language plpgsql security definer set search_path=public as $$
declare target scribe_accounts;
begin
  if not exists(select 1 from scribe_accounts where id=p_actor and role='owner' and not disabled) then raise exception '需要管理员权限'; end if;
  select * into target from scribe_accounts where id=p_target for update;
  if not found then raise exception '账号不存在'; end if;
  if target.role='owner' then raise exception '不能停用或通过用户管理重置最高管理员'; end if;
  if p_action not in ('disable','enable','reset_password') then raise exception '操作无效'; end if;
  update scribe_accounts set credential_version=credential_version+1,
    disabled=case when p_action='disable' then true when p_action='enable' then false else disabled end where id=p_target;
  delete from scribe_account_sessions where account_id=p_target;
  insert into scribe_account_audit(actor_id,target_id,action) values(p_actor,p_target,p_action);
  return true;
end $$;

alter table public.scribe_accounts enable row level security;
alter table public.scribe_account_sessions enable row level security;
alter table public.scribe_account_audit enable row level security;
alter table public.scribe_login_limits enable row level security;
revoke all on public.scribe_accounts,public.scribe_account_sessions,public.scribe_account_audit,public.scribe_login_limits from anon,authenticated;
grant all on public.scribe_accounts,public.scribe_account_sessions,public.scribe_account_audit,public.scribe_login_limits to service_role;
grant usage,select on sequence public.scribe_account_audit_id_seq to service_role;
revoke all on function public.scribe_login_allowed(text,integer),public.scribe_create_account(uuid,text,text,text,uuid,boolean,uuid),public.scribe_account_library(text),public.scribe_issue_account_session(uuid,text,integer),public.scribe_manage_account(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.scribe_login_allowed(text,integer),public.scribe_create_account(uuid,text,text,text,uuid,boolean,uuid),public.scribe_account_library(text),public.scribe_issue_account_session(uuid,text,integer),public.scribe_manage_account(uuid,uuid,text) to service_role;
