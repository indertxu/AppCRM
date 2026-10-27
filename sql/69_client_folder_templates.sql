-- =====================================================================
-- 69_client_folder_templates.sql — standard folder structures for clients
-- =====================================================================
-- client_folder_templates: a named tree of folders, set up in Settings ›
-- Client page › Folder templates. From a client's Folders tab you add one;
-- only the folders the client is missing are created (client_folders).
-- tree: [{ "id": "...", "name": "01 Contract", "children": [ ... ] }, ...]
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

create table if not exists public.client_folder_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  name text not null,
  tree jsonb not null default '[]'::jsonb,
  is_default boolean not null default false,
  sort integer not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists client_folder_templates_t on public.client_folder_templates (tenant_id, sort);

drop trigger if exists trg_set_tenant on public.client_folder_templates;
create trigger trg_set_tenant before insert on public.client_folder_templates for each row execute function set_tenant_id();
select pg_temp.copy_policies('crm_options', 'client_folder_templates');
grant select, insert, update, delete on public.client_folder_templates to authenticated;

notify pgrst, 'reload schema';
commit;

select count(*) as policies from pg_policies where tablename = 'client_folder_templates';
