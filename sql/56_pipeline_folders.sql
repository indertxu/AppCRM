-- =====================================================================
-- 56_pipeline_folders.sql — folders and sub-folders for pipelines
-- =====================================================================
-- Settings → Pipelines can group pipelines in folders, and folders in
-- folders (e.g. Sales › Direct / Cross-sell / Upsell, Consultancy › per product).
--   * new table pipeline_folders (name, parent folder, order)
--   * pipelines.folder_id: the folder a pipeline is in (empty = top level)
-- Deleting a folder deletes its sub-folders; their pipelines go back to the
-- top level (never deleted). Same rules of who sees / edits as pipelines.
-- Run 55_pipeline_saves_fast.sql first. Safe to run more than once.
-- Undo: alter table public.pipelines drop column folder_id; drop table public.pipeline_folders;
-- =====================================================================
begin;
set local search_path = public, extensions;

create table if not exists public.pipeline_folders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null default 'New folder',
  parent_id uuid references public.pipeline_folders(id) on delete cascade,
  sort_order int,
  created_at timestamptz not null default now()
);
create index if not exists pipeline_folders_tenant on public.pipeline_folders (tenant_id);
create index if not exists pipeline_folders_parent on public.pipeline_folders (parent_id);

alter table public.pipelines add column if not exists folder_id uuid references public.pipeline_folders(id) on delete set null;
create index if not exists pipelines_folder on public.pipelines (folder_id);

-- the company is filled in on its own, like on pipelines
drop trigger if exists trg_set_tenant on public.pipeline_folders;
create trigger trg_set_tenant before insert on public.pipeline_folders for each row execute function set_tenant_id();

-- same rules as pipelines (copied); if pipelines has none, the company's own rows only
alter table public.pipeline_folders enable row level security;
do $$
declare p record; n int := 0;
begin
  for p in select * from pg_policies where schemaname = 'public' and tablename = 'pipelines' loop
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pipeline_folders' and policyname = p.policyname) then
      n := n + 1; continue;
    end if;
    begin
      execute format('create policy %I on public.pipeline_folders as %s for %s to %s %s %s',
        p.policyname, p.permissive, p.cmd, array_to_string(p.roles, ', '),
        case when p.qual is not null then 'using (' || p.qual || ')' else '' end,
        case when p.with_check is not null then 'with check (' || p.with_check || ')' else '' end);
      n := n + 1;
    exception when others then
      raise notice 'rule % not copied: %', p.policyname, sqlerrm;
    end;
  end loop;
  if n = 0 and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'pipeline_folders') then
    create policy tenant_isolation on public.pipeline_folders for all to authenticated
      using (tenant_id = (select public.current_tenant())) with check (tenant_id = (select public.current_tenant()));
  end if;
end $$;
grant select, insert, update, delete on public.pipeline_folders to authenticated;

notify pgrst, 'reload schema';
commit;

select (select count(*) from pg_policies where tablename = 'pipeline_folders') as folder_rules,
       (select count(*) from information_schema.columns where table_name = 'pipelines' and column_name = 'folder_id') as pipelines_have_folder;
