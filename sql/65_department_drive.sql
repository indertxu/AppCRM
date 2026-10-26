-- =====================================================================
-- 65_department_drive.sql — Management › Department: a shared directory
-- =====================================================================
-- One directory per department (dept_key of org_departments):
--   dept_folders   folders and sub-folders, with a colour and an order
--   dept_items     what's inside: uploaded files, links and notes
--   dept_pins      each person's pinned folders / items (quick access)
-- Files live in the private Storage bucket "dept-files", under
-- <tenant id>/<department>/…, and are opened with short-lived links.
-- Copies the access rules of crm_options. Nothing is deleted.
-- Safe to run more than once.
-- =====================================================================
begin;
set local search_path = public, extensions;

create or replace function pg_temp.copy_policies(src text, dst text) returns int language plpgsql as $$
declare p record; n int := 0;
begin
  execute format('alter table public.%I enable row level security', dst);
  for p in select * from pg_policies where schemaname = 'public' and tablename = src loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst and policyname = p.policyname) then n := n + 1; continue; end if;
    begin
      execute format('create policy %I on public.%I as %s for %s to %s %s %s',
        p.policyname, dst, p.permissive, p.cmd, array_to_string(p.roles, ', '),
        case when p.qual is not null then 'using (' || p.qual || ')' else '' end,
        case when p.with_check is not null then 'with check (' || p.with_check || ')' else '' end);
      n := n + 1;
    exception when others then
      raise notice 'policy % not copied to %: %', p.policyname, dst, sqlerrm;
    end;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = dst) then
    execute format('create policy tenant_all on public.%I for all to authenticated using (tenant_id = current_tenant()) with check (tenant_id = current_tenant())', dst);
  end if;
  return n;
end $$;

create or replace function pg_temp.tenant_table(t text) returns void language plpgsql as $$
begin
  execute format('drop trigger if exists trg_set_tenant on public.%I', t);
  execute format('create trigger trg_set_tenant before insert on public.%I for each row execute function set_tenant_id()', t);
  perform pg_temp.copy_policies('crm_options', t);
  execute format('grant select, insert, update, delete on public.%I to authenticated', t);
end $$;

-- ---------- folders ----------
create table if not exists public.dept_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  dept_key text not null,
  parent_id uuid references public.dept_folders(id) on delete cascade,
  name text not null,
  color text,
  sort integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dept_folders_tree on public.dept_folders (tenant_id, dept_key, parent_id);
select pg_temp.tenant_table('dept_folders');

-- ---------- items: files, links, notes ----------
create table if not exists public.dept_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  dept_key text not null,
  folder_id uuid references public.dept_folders(id) on delete cascade,   -- null = the top of the directory
  kind text not null default 'file' check (kind in ('file', 'link', 'note')),
  name text not null,
  storage_path text,          -- files
  mime text,
  size_bytes bigint,
  url text,                   -- links
  body text,                  -- notes (and an optional description for files / links)
  tags text[] not null default '{}',
  created_by uuid default auth.uid(),
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists dept_items_folder on public.dept_items (tenant_id, dept_key, folder_id);
select pg_temp.tenant_table('dept_items');

-- ---------- pins (per person) ----------
create table if not exists public.dept_pins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  user_id uuid not null default auth.uid(),
  dept_key text not null,
  folder_id uuid references public.dept_folders(id) on delete cascade,
  item_id uuid references public.dept_items(id) on delete cascade,
  sort integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists dept_pins_one on public.dept_pins (user_id, coalesce(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(item_id, '00000000-0000-0000-0000-000000000000'::uuid));
select pg_temp.tenant_table('dept_pins');

-- ---------- storage: private bucket, each company only reaches its own folder ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('dept-files', 'dept-files', false, 104857600)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "dept-files: read own company"   on storage.objects;
drop policy if exists "dept-files: upload own company" on storage.objects;
drop policy if exists "dept-files: change own company" on storage.objects;
drop policy if exists "dept-files: delete own company" on storage.objects;
create policy "dept-files: read own company" on storage.objects for select to authenticated
  using (bucket_id = 'dept-files' and (storage.foldername(name))[1] = public.current_tenant()::text);
create policy "dept-files: upload own company" on storage.objects for insert to authenticated
  with check (bucket_id = 'dept-files' and (storage.foldername(name))[1] = public.current_tenant()::text);
create policy "dept-files: change own company" on storage.objects for update to authenticated
  using (bucket_id = 'dept-files' and (storage.foldername(name))[1] = public.current_tenant()::text)
  with check (bucket_id = 'dept-files' and (storage.foldername(name))[1] = public.current_tenant()::text);
create policy "dept-files: delete own company" on storage.objects for delete to authenticated
  using (bucket_id = 'dept-files' and (storage.foldername(name))[1] = public.current_tenant()::text);

notify pgrst, 'reload schema';
commit;

select
  (select count(*) from pg_policies where tablename in ('dept_folders', 'dept_items', 'dept_pins')) as rules,
  (select count(*) from storage.buckets where id = 'dept-files') as bucket;
