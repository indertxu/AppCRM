-- =====================================================================
-- 74_client_api_keys.sql — API keys for client documents: make sure the
-- table, its workspace (tenant) and the storage bucket are all in place
-- =====================================================================
-- Settings › Client page › API keys writes here; the manage-users function
-- (/functions/v1/manage-users/api/...) reads it to check the x-api-key header.
--   · creates client_api_keys if it is missing, adds any missing column
--   · keys get their workspace automatically (and old keys without one take
--     the workspace of whoever made them) — without it GET /clients is empty
--   · the private bucket "client-files" the files live in
-- Nothing is deleted. Safe to run more than once. Shows a check at the end.
-- =====================================================================
begin;
set local search_path = public, extensions;

create table if not exists public.client_api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null default 'API key',
  prefix text,
  key_hash text not null,
  access text not null default 'read',
  client_ids uuid[],
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now()
);
alter table public.client_api_keys add column if not exists tenant_id uuid;
alter table public.client_api_keys add column if not exists prefix text;
alter table public.client_api_keys add column if not exists access text not null default 'read';
alter table public.client_api_keys add column if not exists expires_at timestamptz;
alter table public.client_api_keys add column if not exists last_used_at timestamptz;
alter table public.client_api_keys add column if not exists revoked_at timestamptz;
alter table public.client_api_keys add column if not exists created_by uuid default auth.uid();
alter table public.client_api_keys add column if not exists created_at timestamptz not null default now();
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'client_api_keys' and column_name = 'client_ids') then
    alter table public.client_api_keys add column client_ids uuid[];
  end if;
end $$;
create index if not exists client_api_keys_hash on public.client_api_keys (key_hash);

-- every new key belongs to the workspace of whoever makes it
do $$ begin
  if to_regprocedure('public.set_tenant_id()') is not null then
    drop trigger if exists trg_set_tenant on public.client_api_keys;
    create trigger trg_set_tenant before insert on public.client_api_keys for each row execute function set_tenant_id();
  end if;
end $$;

-- keys made before that: the maker's workspace (or the only workspace there is)
update public.client_api_keys k set tenant_id = p.tenant_id
  from public.profiles p
 where k.tenant_id is null and p.id = k.created_by and p.tenant_id is not null;
do $$ declare n int; t uuid; begin
  select count(distinct tenant_id), min(tenant_id::text)::uuid into n, t from public.profiles where tenant_id is not null;
  if n = 1 then update public.client_api_keys set tenant_id = t where tenant_id is null; end if;
end $$;

-- who may see / make keys: people of the same workspace (only the hash is stored)
alter table public.client_api_keys enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'client_api_keys') then
    create policy tenant_all on public.client_api_keys for all to authenticated
      using (tenant_id = public.current_tenant()) with check (tenant_id is null or tenant_id = public.current_tenant());
  end if;
end $$;
grant select, insert, update, delete on public.client_api_keys to authenticated;

-- the private bucket the client files are stored in
do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('client-files', 'client-files', false) on conflict (id) do nothing;
  end if;
end $$;

notify pgrst, 'reload schema';
commit;

-- the check: every key, whether it has a workspace and whether it still works
select prefix, name, access, tenant_id is not null as has_workspace,
       case when revoked_at is not null then 'revoked'
            when expires_at is not null and expires_at < now() then 'expired'
            else 'active' end as state,
       expires_at::date as expires, last_used_at
  from public.client_api_keys order by created_at desc;
